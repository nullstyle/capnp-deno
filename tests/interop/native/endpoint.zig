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
    out_fd: c_int = 1,
    fn send(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        if (!self.live) return;
        var offset: usize = 0;
        while (offset < bytes.len) {
            const n = write(self.out_fd, bytes[offset..].ptr, bytes.len - offset);
            if (n <= 0) return error.NativeWriteFailed;
            offset += @intCast(n);
        }
    }
    fn readAll(out: []u8) !void {
        return readAllFd(0, out);
    }
    fn readAllFd(fd: c_int, out: []u8) !void {
        var offset: usize = 0;
        while (offset < out.len) {
            const n = read(fd, out[offset..].ptr, out.len - offset);
            if (n == 0 and offset == 0) return error.EndOfStream;
            if (n <= 0) return error.NativeReadFailed;
            offset += @intCast(n);
        }
    }
    fn receiveFd(fd: c_int, peer: *Peer) !void {
        var first: [8]u8 = undefined;
        try readAllFd(fd, &first);
        const count: usize = @as(usize, std.mem.readInt(u32, first[0..4], .little)) + 1;
        try require(count <= 512);
        const header_size = ((count + 2) & ~@as(usize, 1)) * 4;
        const header = try peer.allocator.alloc(u8, header_size);
        defer peer.allocator.free(header);
        @memcpy(header[0..8], &first);
        try readAllFd(fd, header[8..]);
        var size = header_size;
        for (0..count) |i| size += @as(usize, std.mem.readInt(u32, header[(i + 1) * 4 ..][0..4], .little)) * 8;
        try require(size <= 2 * 1024 * 1024);
        const frame = try peer.allocator.alloc(u8, size);
        defer peer.allocator.free(frame);
        @memcpy(frame[0..header_size], header);
        try readAllFd(fd, frame[header_size..]);
        try peer.handleFrame(frame);
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
fn forbiddenHold(_: *anyopaque, _: *Peer, _: g.Doubler.Hold.Params.Reader, _: *g.Doubler.Hold.Results.Builder, _: *const Caps) anyerror!void {
    return error.ExpectedDeferredHold;
}
fn forbiddenHoldStatus(_: *anyopaque, _: *Peer, _: g.Doubler.HoldStatus.Params.Reader, _: *g.Doubler.HoldStatus.Results.Builder, _: *const Caps) anyerror!void {
    return error.UnexpectedCallbackHoldStatus;
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
    hold_started: bool = false,
    hold_sender: ?g.Doubler.Hold.ReturnSender = null,
    hold_cap: ?g.Doubler.Client = null,

    fn hold(ctx: *anyopaque, peer: *Peer, params: g.Doubler.Hold.Params.Reader, caps: *const Caps, sender: g.Doubler.Hold.ReturnSender) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try require(!self.hold_started);
        const cap = try params.getCap();
        const resolved = try caps.resolveCapability(cap);
        try require(resolved == .imported);
        try @constCast(caps).retainCapability(cap);
        self.hold_started = true;
        self.hold_sender = sender;
        self.hold_cap = g.Doubler.Client.init(peer, resolved.imported.id);
    }
    fn holdStatus(ctx: *anyopaque, peer: *Peer, params: g.Doubler.HoldStatus.Params.Reader, result: *g.Doubler.HoldStatus.Results.Builder, _: *const Caps) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        if (try params.getRelease()) {
            const sender = self.hold_sender orelse return error.NoPendingHold;
            // Deferred native Zig handlers have no cancellation callback. The
            // wire Finish must already have retired this active answer; the
            // explicit probe now completes it late to drain caller ownership.
            try require(peer.stats().active_inbound_questions == 1);
            try sender.sendException("late native completion after cancellation");
            self.hold_sender = null;
            self.hold_cap.?.release();
            self.hold_cap = null;
        }
        try result.setStarted(self.hold_started);
        try result.setActive(self.hold_sender != null);
        try result.setCanceled(false);
    }

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
    var child = g.Doubler.Server{ .ctx = &state, .vtable = .{ .compute = compute, .fail = fail, .hold = forbiddenHold, .hold_deferred = ServerState.hold, .holdStatus = ServerState.holdStatus } };
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
    try require(state.hold_started and state.hold_sender == null and state.hold_cap == null);
    try require(peer.streaming.outstanding_calls == 0 and peer.streaming.outstanding_bytes == 0);
}

const ClientState = struct {
    client: ?g.Interop.Client = null,
    child: ?g.Doubler.Client = null,
    callback_id: u32 = 0,
    done: bool = false,
    next: u32 = 0,
    holding_release: bool = false,
    hold_canceled: bool = false,
    fn holdBuild(ctx: *anyopaque, params: *g.Doubler.Hold.Params.Builder) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try params.setCapCapability(.{ .id = self.callback_id });
    }
    fn holdReturn(ctx: *anyopaque, _: *Peer, response: g.Doubler.Hold.Response, _: *const Caps) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try require(!self.hold_canceled);
        try require(response == .exception and std.mem.eql(u8, response.exception.reason, "native pending cancellation"));
        self.hold_canceled = true;
    }
    fn holdStatusBuild(ctx: *anyopaque, params: *g.Doubler.HoldStatus.Params.Builder) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        try params.setRelease(self.holding_release);
    }
    fn holdStatusReturn(ctx: *anyopaque, _: *Peer, response: g.Doubler.HoldStatus.Response, _: *const Caps) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        const result = try response.unwrap();
        try require(try result.getStarted());
        try require(try result.getActive() == !self.holding_release);
        try require(try result.getCanceled() == self.holding_release);
        self.done = true;
    }
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
    var callback = g.Doubler.Server{ .ctx = &state, .vtable = .{ .compute = compute, .fail = fail, .hold = forbiddenHold, .holdStatus = forbiddenHoldStatus } };
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
    // invoke released its imported callback, so export a new reference for hold.
    state.callback_id = try g.Doubler.exportServer(peer, &callback);
    const pending = try state.child.?.callHold(&state, ClientState.holdBuild, ClientState.holdReturn);
    _ = try state.child.?.callHoldStatus(&state, ClientState.holdStatusBuild, ClientState.holdStatusReturn);
    try state.wait(peer, link);
    try require(!state.hold_canceled);
    try peer.cancelQuestion(pending, "native pending cancellation");
    try require(state.hold_canceled);
    state.holding_release = true;
    _ = try state.child.?.callHoldStatus(&state, ClientState.holdStatusBuild, ClientState.holdStatusReturn);
    try state.wait(peer, link);
    _ = try state.child.?.callCompute(&state, ClientState.computeBuild, ClientState.computeReturn);
    try state.wait(peer, link);
    try require(peer.stats().cancelled_questions == 0);
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

/// The port a bound listening socket holds (getsockname; sockaddr_in's
/// port field is big-endian at offset 2).
fn listenPort(handle: std.posix.socket_t) !u16 {
    var addr: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(std.posix.sockaddr.storage);
    const rc = std.posix.system.getsockname(handle, @ptrCast(&addr), &len);
    if (std.posix.errno(rc) != .SUCCESS) return error.NativeGetsockname;
    if (len < 4) return error.NativeGetsockname;
    const bytes: [*]const u8 = @ptrCast(&addr);
    return (@as(u16, bytes[2]) << 8) | bytes[3];
}

/// Per-connection pump state for the vatc host.
const VatcConn = struct {
    fd: std.posix.socket_t,
    peer: *Peer,
    link: *Link,
    fn pump(self: *VatcConn) void {
        while (true) {
            Link.receiveFd(@intCast(self.fd), self.peer) catch |err| {
                if (err == error.EndOfStream) return;
                std.debug.print("vatc pump error: {}\n", .{err});
                return;
            };
        }
    }
};

/// Two-connection VatC host for the cross-implementation three-vat
/// handoff: two TCP listeners, each accepted connection bound to its own
/// detached Peer, both Peers enrolled in one ProvisionIndex, and a Doubler
/// export published on the first peer as the handoff target. Prints
/// `VATC <port1> <port2> <export_id>` once both listeners are bound, then
/// pumps both sockets on separate threads until EOF (the parent stops us).
/// The Deno side plays VatB (Provide over connection 1) and VatA (Accept
/// over connection 2); the shared index serves the cross-connection Accept
/// natively, exactly as the vendor vatc test does in-process.
fn vatc(allocator: std.mem.Allocator, init: std.process.Init) !void {
    const address = try std.Io.net.IpAddress.parse("127.0.0.1", 0);
    const l1 = try rpc.transport.tcp.createListenSocket(init.io, address, 1, false);
    const l2 = try rpc.transport.tcp.createListenSocket(init.io, address, 1, false);
    defer rpc.transport.tcp.closeFd(init.io, .{ .handle = l1.socket.handle });
    defer rpc.transport.tcp.closeFd(init.io, .{ .handle = l2.socket.handle });

    var index = rpc.peer.ProvisionIndex.init(allocator, .{});
    index.disableThreadAffinity();
    defer index.deinit();

    // Connection 1's peer hosts the handoff target (a Doubler export).
    var peer1 = Peer.initDetached(allocator);
    peer1.disableThreadAffinity();
    defer peer1.deinit();
    var peer2 = Peer.initDetached(allocator);
    peer2.disableThreadAffinity();
    defer peer2.deinit();
    try peer1.attachProvisionIndex(&index);
    try peer2.attachProvisionIndex(&index);

    var state = ServerState{};
    var child = g.Doubler.Server{ .ctx = &state, .vtable = .{ .compute = compute, .fail = fail, .hold = forbiddenHold, .hold_deferred = ServerState.hold, .holdStatus = ServerState.holdStatus } };
    const target_id = try g.Doubler.exportServer(&peer1, &child);

    var link1 = Link{ .out_fd = undefined };
    var link2 = Link{ .out_fd = undefined };
    peer1.setSendFrameOverride(&link1, Link.send);
    peer2.setSendFrameOverride(&link2, Link.send);

    var listener1 = rpc.transport.tcp.Listener.initFd(
        allocator,
        init.io,
        .{ .handle = l1.socket.handle },
        .{},
    );
    var listener2 = rpc.transport.tcp.Listener.initFd(
        allocator,
        init.io,
        .{ .handle = l2.socket.handle },
        .{},
    );
    defer listener1.close();
    defer listener2.close();

    // Machine-readable on stdout BEFORE accepting (std.debug.print goes to
    // stderr): the driver waits for the line before it connects. The
    // ephemeral ports come from getsockname (IpAddress is a bare union).
    const port1 = try listenPort(l1.socket.handle);
    const port2 = try listenPort(l2.socket.handle);
    {
        var line_buf: [96]u8 = undefined;
        const line = std.fmt.bufPrint(&line_buf, "VATC {d} {d} {d}\n", .{ port1, port2, target_id }) catch unreachable;
        var off: usize = 0;
        while (off < line.len) {
            const n = write(1, line[off..].ptr, line.len - off);
            if (n <= 0) return error.NativeWriteFailed;
            off += @intCast(n);
        }
    }

    const conn1_fd = try listener1.acceptFd();
    const conn2_fd = try listener2.acceptFd();
    link1.out_fd = @intCast(conn1_fd.handle);
    link2.out_fd = @intCast(conn2_fd.handle);

    var conn1 = VatcConn{ .fd = @intCast(conn1_fd.handle), .peer = &peer1, .link = &link1 };
    var conn2 = VatcConn{ .fd = @intCast(conn2_fd.handle), .peer = &peer2, .link = &link2 };
    const t1 = try std.Thread.spawn(.{}, VatcConn.pump, .{&conn1});
    const t2 = try std.Thread.spawn(.{}, VatcConn.pump, .{&conn2});
    t1.join();
    t2.join();
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
    if (std.mem.eql(u8, mode, "server")) try serve(&peer, &link) else if (std.mem.eql(u8, mode, "client")) try consume(&peer, &link) else if (std.mem.eql(u8, mode, "vatc")) {
        try vatc(allocator.allocator(), init);
    } else return error.InvalidMode;
    std.debug.print("native Zig {s}: all checks passed\n", .{mode});
}
