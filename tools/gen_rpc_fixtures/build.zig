const std = @import("std");

// Local build graph for the RPC fixture generator. Mirrors the upstream
// `zig build gen-rpc-fixtures` step that was removed in capnp-zig 1f5f409,
// so downstream can still regenerate tests/fixtures/rpc_frames.ts without
// carrying patches in the vendored submodule.
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const vendor_root = b.path("../../vendor/capnp-zig");

    const core_module = b.createModule(.{
        .root_source_file = vendor_root.path(b, "src/lib_core.zig"),
        .target = target,
        .optimize = optimize,
    });
    core_module.addImport("capnpc-zig", core_module);
    core_module.addImport("capnpc-zig-core", core_module);

    const fixture_tool_module = b.createModule(.{
        .root_source_file = vendor_root.path(b, "tests/rpc/support/rpc_fixture_tool.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "capnpc-zig-core", .module = core_module },
        },
    });

    const exe = b.addExecutable(.{
        .name = "gen_rpc_fixtures",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "capnpc-zig-core", .module = core_module },
                .{ .name = "rpc-fixture-tool", .module = fixture_tool_module },
            },
        }),
    });

    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());

    const run_step = b.step("run", "Emit tests/fixtures/rpc_frames.ts on stdout");
    run_step.dependOn(&run_cmd.step);
}
