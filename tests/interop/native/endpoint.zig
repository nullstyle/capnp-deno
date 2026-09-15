// Native peer fixture: framing transport adapted from capnp-zig's
// tests/serialization/support/rpc_stream_endpoint.zig (MIT).
const std = @import("std");
const capnp = @import("capnpc-zig");
const g = @import("generated");
const rpc = capnp.rpc;
const Peer = rpc.peer.Peer;
const Caps = rpc.caps.table.InboundCapTable;
extern "c" fn alarm(c_uint) c_uint;
extern "c" fn read(c_int, [*]u8, usize) isize;
extern "c" fn write(c_int, [*]const u8, usize) isize;

fn require(ok: bool) !void {
    if (!ok) return error.NativeInteropMismatch;
}
const Link = struct {
    live: bool = true,
    fn send(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        if (!self.live) return;
        var offset: usize = 0;
        while (offset < bytes.len) {
            const n = write(1, bytes[offset..].ptr, bytes.len - offset);
            if (n <= 0) return error.NativeWriteFailed;
            offset += @intCast(n);
        }
    }
    fn readAll(out: []u8) !void {
        var offset: usize = 0;
        while (offset < out.len) {
            const n = read(0, out[offset..].ptr, out.len - offset);
            if (n == 0 and offset == 0) return error.EndOfStream;
            if (n <= 0) return error.NativeReadFailed;
            offset += @intCast(n);
        }
    }
    fn receive(_: *@This(), peer: *Peer) !void {
        var first: [8]u8 = undefined;
        try readAll(&first);
        const count: usize = @as(usize, std.mem.readInt(u32, first[0..4], .little)) + 1;
        try require(count <= 512);
        const header_size = ((count + 2) & ~@as(usize, 1)) * 4;
        const header = try peer.allocator.alloc(u8, header_size);
        defer peer.allocator.free(header);
        @memcpy(header[0..8], &first);
        try readAll(header[8..]);
        var size = header_size;
        for (0..count) |i| size += @as(usize, std.mem.readInt(u32, header[(i + 1) * 4 ..][0..4], .little)) * 8;
        try require(size <= 2 * 1024 * 1024);
        const frame = try peer.allocator.alloc(u8, size);
        defer peer.allocator.free(frame);
        @memcpy(frame[0..header_size], header);
        try readAll(frame[header_size..]);
        try peer.handleFrame(frame);
    }
};

fn compute(_: *anyopaque, _: *Peer, params: g.Doubler.Compute.Params.Reader, result: *g.Doubler.Compute.Results.Builder, _: *const Caps) anyerror!void {
    try result.setValue((try params.getValue()) * 2);
}
fn fail(_: *anyopaque, _: *Peer, _: g.Doubler.Fail.Params.Reader, _: *g.Doubler.Fail.Results.Builder, _: *const Caps) anyerror!void {
    return error.InteropExpectedFailure;
}
const ServerState = struct {
    child_id: u32 = 0,
    callback_client: ?g.Doubler.Client = null,
    callback_sender: ?g.Interop.Invoke.ReturnSender = null,
    callback_value: u32 = 0,
    sum: u64 = 0,
    count: u32 = 0,
    ack: ?g.Interop.Push.StreamReturnSender = null,
    barrier_seen: bool = false,

    fn echo(_: *anyopaque, _: *Peer, params: g.Interop.Echo.Params.Reader, result: *g.Interop.Echo.Results.Builder, _: *const Caps) anyerror!void {
        try result.setValue((try params.getValue()) + 1);
    }
    fn forbidden(_: *anyopaque, _: *Peer, _: g.Interop.Invoke.Params.Reader, _: *g.Interop.Invoke.Results.Builder, _: *const Caps) anyerror!void {
        return error.ExpectedDeferredInvoke;
    }
    fn invoke(ctx: *anyopaque, peer: *Peer, params: g.Interop.Invoke.Params.Reader, caps: *const Caps, sender: g.Interop.Invoke.ReturnSender) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        const cap = try params.getCap();
        const resolved = try caps.resolveCapability(cap);
        try require(resolved == .imported);
        try @constCast(caps).retainCapability(cap);
        self.callback_client = g.Doubler.Client.init(peer, resolved.imported.id);
        self.callback_sender = sender;
        self.callback_value = 21;
        _ = try self.callback_client.?.callCompute(self, buildCallback, callbackReturn);
    }
    fn buildCallback(ctx: *anyopaque, params: *g.Doubler.Compute.Params.Builder) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try params.setValue(self.callback_value);
    }
    fn callbackReturn(ctx: *anyopaque, _: *Peer, response: g.Doubler.Compute.Response, _: *const Caps) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.callback_value = try (try response.unwrap()).getValue();
        try self.callback_sender.?.sendResults(self, buildInvokeResult);
        self.callback_sender = null;
        self.callback_client.?.release();
        self.callback_client = null;
    }
    fn buildInvokeResult(ctx: *anyopaque, ret: *rpc.wire.protocol.ReturnBuilder) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        var payload = try ret.payloadTyped();
        var pointer = try payload.initContent();
        var result = g.Interop.Invoke.Results.Builder.wrap(try pointer.initStruct(1, 0));
        try result.setValue(self.callback_value);
    }
    fn child(ctx: *anyopaque, _: *Peer, _: g.Interop.Child.Params.Reader, result: *g.Interop.Child.Results.Builder, _: *const Caps) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try result.setCapCapability(.{ .id = self.child_id });
    }
    fn failRegular(_: *anyopaque, _: *Peer, _: g.Interop.Fail.Params.Reader, _: *g.Interop.Fail.Results.Builder, _: *const Caps) anyerror!void {
        return error.InteropExpectedFailure;
    }
    fn forbiddenPush(_: *anyopaque, _: *Peer, _: g.Interop.Push.Params.Reader, _: *const Caps) anyerror!void {
        return error.ExpectedDeferredPush;
    }
    fn push(ctx: *anyopaque, _: *Peer, params: g.Interop.Push.Params.Reader, _: *const Caps, ack: g.Interop.Push.StreamReturnSender) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try require((try params.getValue()) == self.count + 1);
        self.count += 1;
        self.sum += try params.getValue();
        self.ack = ack;
    }
    fn barrier(ctx: *anyopaque, _: *Peer, _: g.Interop.Barrier.Params.Reader, result: *g.Interop.Barrier.Results.Builder, _: *const Caps) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try require(self.count == 2);
        try result.setSum(self.sum);
        try result.setCount(self.count);
        self.barrier_seen = true;
    }
};
fn serve(peer: *Peer, link: *Link) !void {
    var state = ServerState{};
    var child = g.Doubler.Server{ .ctx = &state, .vtable = .{ .compute = compute, .fail = fail } };
    state.child_id = try g.Doubler.exportServer(peer, &child);
    var server = g.Interop.Server{ .ctx = &state, .vtable = .{
        .echo = ServerState.echo,
        .invoke = ServerState.forbidden,
        .invoke_deferred = ServerState.invoke,
        .child = ServerState.child,
        .fail = ServerState.failRegular,
        .push = ServerState.forbiddenPush,
        .push_deferred = ServerState.push,
        .barrier = ServerState.barrier,
    } };
    _ = try g.Interop.setBootstrap(peer, &server);
    while (true) {
        link.receive(peer) catch |err| {
            if (err == error.EndOfStream) break;
            return err;
        };
        if (peer.streaming.outstanding_calls == 3) {
            try require(state.count == 1 and !state.barrier_seen);
            try state.ack.?.send();
            try require(state.count == 2 and !state.barrier_seen);
            try state.ack.?.send();
        }
    }
    try require(state.barrier_seen and state.callback_sender == null);
    try require(peer.streaming.outstanding_calls == 0 and peer.streaming.outstanding_bytes == 0);
}

const ClientState = struct {
    client: ?g.Interop.Client = null,
    child: ?g.Doubler.Client = null,
    callback_id: u32 = 0,
    done: bool = false,
    next: u32 = 0,
    fn bootstrap(ctx: *anyopaque, _: *Peer, response: g.Interop.BootstrapResponse) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.client = try response.unwrap();
    }
    fn echoBuild(_: *anyopaque, params: *g.Interop.Echo.Params.Builder) anyerror!void {
        try params.setValue(41);
    }
    fn echoReturn(ctx: *anyopaque, _: *Peer, response: g.Interop.Echo.Response, _: *const Caps) anyerror!void {
        try require(try (try response.unwrap()).getValue() == 42);
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.done = true;
    }
    fn invokeBuild(ctx: *anyopaque, params: *g.Interop.Invoke.Params.Builder) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try params.setCapCapability(.{ .id = self.callback_id });
    }
    fn invokeReturn(ctx: *anyopaque, _: *Peer, response: g.Interop.Invoke.Response, _: *const Caps) anyerror!void {
        try require(try (try response.unwrap()).getValue() == 42);
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.done = true;
    }
    fn childReturn(ctx: *anyopaque, peer: *Peer, response: g.Interop.Child.Response, caps: *const Caps) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        const cap = try (try response.unwrap()).getCap();
        const resolved = try caps.resolveCapability(cap);
        try require(resolved == .imported);
        try @constCast(caps).retainCapability(cap);
        self.child = g.Doubler.Client.init(peer, resolved.imported.id);
        self.done = true;
    }
    fn computeBuild(_: *anyopaque, params: *g.Doubler.Compute.Params.Builder) anyerror!void {
        try params.setValue(21);
    }
    fn computeReturn(ctx: *anyopaque, _: *Peer, response: g.Doubler.Compute.Response, _: *const Caps) anyerror!void {
        try require(try (try response.unwrap()).getValue() == 42);
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.done = true;
    }
    fn failReturn(ctx: *anyopaque, _: *Peer, response: g.Doubler.Fail.Response, _: *const Caps) anyerror!void {
        try require(response == .exception and response.exception.kind() == .failed);
        try require(std.mem.eql(u8, response.exception.reason, "host call failed"));
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.done = true;
    }
    fn failRegularReturn(ctx: *anyopaque, _: *Peer, response: g.Interop.Fail.Response, _: *const Caps) anyerror!void {
        try require(response == .exception and response.exception.kind() == .failed);
        try require(std.mem.eql(u8, response.exception.reason, "host call failed"));
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.done = true;
    }
    fn pushBuild(ctx: *anyopaque, params: *g.Interop.Push.Params.Builder) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.next += 1;
        try params.setValue(self.next);
    }
    fn barrierReturn(ctx: *anyopaque, _: *Peer, response: g.Interop.Barrier.Response, _: *const Caps) anyerror!void {
        const result = try response.unwrap();
        try require(try result.getSum() == 3 and try result.getCount() == 2);
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.done = true;
    }
    fn wait(self: *@This(), peer: *Peer, link: *Link) !void {
        while (!self.done) try link.receive(peer);
        self.done = false;
    }
};
fn consume(peer: *Peer, link: *Link) !void {
    var state = ClientState{};
    var callback = g.Doubler.Server{ .ctx = &state, .vtable = .{ .compute = compute, .fail = fail } };
    state.callback_id = try g.Doubler.exportServer(peer, &callback);
    _ = try g.Interop.Client.fromBootstrap(peer, &state, ClientState.bootstrap);
    while (state.client == null) try link.receive(peer);
    const client = state.client.?;
    defer client.release();
    _ = try client.callEcho(&state, ClientState.echoBuild, ClientState.echoReturn);
    try state.wait(peer, link);
    _ = try client.callInvoke(&state, ClientState.invokeBuild, ClientState.invokeReturn);
    try state.wait(peer, link);
    _ = try client.callChild(&state, null, ClientState.childReturn);
    try state.wait(peer, link);
    _ = try state.child.?.callCompute(&state, ClientState.computeBuild, ClientState.computeReturn);
    try state.wait(peer, link);
    _ = try state.child.?.callFail(&state, null, ClientState.failReturn);
    try state.wait(peer, link);
    // A successful call on the same cap after the exception proves recovery.
    _ = try state.child.?.callCompute(&state, ClientState.computeBuild, ClientState.computeReturn);
    try state.wait(peer, link);
    state.child.?.release();
    _ = try client.callFail(&state, null, ClientState.failRegularReturn);
    try state.wait(peer, link);
    _ = try client.callEcho(&state, ClientState.echoBuild, ClientState.echoReturn);
    try state.wait(peer, link);
    var stream = g.Interop.StreamClient.init(client);
    try stream.callPush(&state, ClientState.pushBuild);
    try stream.callPush(&state, ClientState.pushBuild);
    _ = try stream.callBarrier(&state, null, ClientState.barrierReturn);
    try state.wait(peer, link);
    try require(stream.stream.in_flight == 0 and stream.stream.in_flight_bytes == 0);
}

pub fn main(init: std.process.Init) !void {
    _ = alarm(30);
    var allocator: std.heap.DebugAllocator(.{}) = .init;
    defer std.debug.assert(allocator.deinit() == .ok);
    var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, init.gpa);
    defer args.deinit();
    _ = args.next();
    const mode = args.next() orelse return error.MissingMode;
    var link = Link{};
    var peer = Peer.initDetached(allocator.allocator());
    peer.setSendFrameOverride(&link, Link.send);
    defer {
        link.live = false;
        peer.deinit();
    }
    if (std.mem.eql(u8, mode, "server")) try serve(&peer, &link) else if (std.mem.eql(u8, mode, "client")) try consume(&peer, &link) else return error.InvalidMode;
    std.debug.print("native Zig {s}: all checks passed\n", .{mode});
}
