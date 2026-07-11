/**
 * Shared runtime for generated Cap'n Proto _capnp.ts modules.
 *
 * INTERNAL barrel: re-exports everything (including private helpers) for use
 * inside this repository. The published `@nullstyle/capnp/encoding` surface
 * is the curated named-export list in `./mod.ts` — add public names there,
 * not here.
 *
 * @module
 */

export * from "./runtime_model.ts";
export * from "./runtime_message.ts";
export * from "./runtime_codec.ts";
export * from "./runtime_caps.ts";
