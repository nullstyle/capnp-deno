import type { PeerRuntime } from "./peer_runtime.ts";

const HELP_LINES = [
  "commands:",
  "  <text>               send a chat message to all connected peers",
  "  /say <text>          send a chat message to all connected peers",
  "  /connect <url>       connect to another peer",
  "  /disconnect <target> disconnect an outbound peer",
  "  /name <next-name>    rename this local peer",
  "  /peers               show connected peers",
  "  /listen              show the local listen URL",
  "  /help                show this help",
  "  /quit                close connections and exit",
] as const;

export async function handlePeerCommand(
  runtime: PeerRuntime,
  line: string,
): Promise<boolean> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (!trimmed.startsWith("/")) {
    await runtime.broadcast(trimmed);
    return true;
  }

  if (trimmed === "/help") {
    printPeerHelp(runtime);
    return true;
  }
  if (trimmed === "/peers") {
    for (const peerLine of runtime.renderPeers()) {
      runtime.print(peerLine);
    }
    return true;
  }
  if (trimmed === "/listen") {
    runtime.print(`listening on ${runtime.listenUrl}`);
    return true;
  }
  if (trimmed === "/quit" || trimmed === "/exit") {
    return false;
  }
  if (trimmed.startsWith("/connect ")) {
    const url = trimmed.slice("/connect ".length).trim();
    if (url.length === 0) {
      runtime.print("usage: /connect https://127.0.0.1:4444/p2p");
      return true;
    }
    await runtime.connect(url).catch(() => {});
    return true;
  }
  if (trimmed.startsWith("/name ")) {
    const nextName = trimmed.slice("/name ".length).trim();
    if (nextName.length === 0) {
      runtime.print("usage: /name <next-name>");
      return true;
    }
    await runtime.renameLocal(nextName);
    return true;
  }
  if (trimmed.startsWith("/disconnect ")) {
    const target = trimmed.slice("/disconnect ".length).trim();
    if (target.length === 0) {
      runtime.print("usage: /disconnect <url-or-name>");
      return true;
    }
    await runtime.disconnectPeer(target);
    return true;
  }
  if (trimmed.startsWith("/say ")) {
    const message = trimmed.slice("/say ".length).trim();
    await runtime.broadcast(message);
    return true;
  }

  runtime.print(`unknown command: ${trimmed}`);
  runtime.print("type /help to see available commands");
  return true;
}

function printPeerHelp(runtime: Pick<PeerRuntime, "print">): void {
  for (const line of HELP_LINES) {
    runtime.print(line);
  }
}
