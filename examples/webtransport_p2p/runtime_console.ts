import type { PeerRuntime } from "./peer_runtime.ts";

async function* readInputLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        yield line;
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) {
      yield buffered.replace(/\r$/, "");
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runInteractiveConsole(
  runtime: PeerRuntime,
): Promise<void> {
  const encoder = new TextEncoder();
  const interactive = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
  if (interactive) {
    await Deno.stdout.write(encoder.encode("p2p> "));
  }
  for await (const line of readInputLines(Deno.stdin.readable)) {
    const keepRunning = await runtime.handleCommand(line);
    if (!keepRunning) return;
    if (interactive) {
      await Deno.stdout.write(encoder.encode("p2p> "));
    }
  }
}
