# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Initial development release.

### Added
- Cap'n Proto RPC client and server with WASM-backed serialization.
- Transport adapters: TCP, WebSocket, MessagePort.
- Connection pooling with warmup, health checks, and idle eviction.
- Circuit breaker with configurable thresholds and cooldown.
- Reconnecting client with exponential backoff and capability remapping.
- Middleware pipeline for frame-level interception (logging, metrics, size limits, introspection).
- Promise pipelining for single-step transforms.
- Frame validation with configurable limits (size, depth, traversal, segments).
- OpenTelemetry observability integration.
- Code generator (`capnpc-deno`) for TypeScript bindings from Cap'n Proto schemas.
