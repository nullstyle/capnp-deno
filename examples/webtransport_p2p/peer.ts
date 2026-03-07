import { Command } from "jsr:@cliffy/command";
import { PeerRuntime, runInteractiveConsole } from "./runtime.ts";
import {
  DEFAULT_HOST,
  DEFAULT_NAME,
  DEFAULT_PATH,
  DEFAULT_PORT,
  loadTlsMaterial,
  parsePort,
} from "./shared.ts";

interface CliOptions {
  host: string;
  port: string;
  path: string;
  name: string;
  connect?: string[];
  certFile?: string;
  keyFile?: string;
  certHash?: string;
}

function normalizeConnectInputs(connect: string[] | undefined): string[] {
  if (!connect) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of connect) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

async function run(options: CliOptions): Promise<void> {
  const runtime = new PeerRuntime({
    name: options.name.trim() || DEFAULT_NAME,
    host: options.host.trim() || DEFAULT_HOST,
    port: parsePort(options.port, "--port"),
    path: options.path.trim() || DEFAULT_PATH,
    tls: await loadTlsMaterial({
      certFile: options.certFile,
      keyFile: options.keyFile,
      certHashHex: options.certHash,
    }),
  });

  await runtime.start();
  try {
    for (const url of normalizeConnectInputs(options.connect)) {
      await runtime.connect(url).catch(() => {});
    }
    await runInteractiveConsole(runtime);
  } finally {
    await runtime.close();
  }
}

await new Command()
  .name("webtransport-p2p")
  .description(
    "Interactive WebTransport peer node with handshake callbacks and reciprocal chat connections.",
  )
  .option(
    "--host <host:string>",
    "Host/interface to bind the local peer",
    { default: DEFAULT_HOST },
  )
  .option(
    "--port <port:string>",
    "Port to bind the local peer",
    { default: String(DEFAULT_PORT) },
  )
  .option(
    "--path <path:string>",
    "WebTransport path to serve and advertise",
    { default: DEFAULT_PATH },
  )
  .option(
    "--name <name:string>",
    "Display name for the local peer",
    { default: DEFAULT_NAME },
  )
  .option(
    "--connect <url:string>",
    "Peer URL to connect to at startup. Repeatable.",
    { collect: true },
  )
  .option(
    "--cert-file <path:string>",
    "Read the server TLS certificate PEM from a file",
  )
  .option(
    "--key-file <path:string>",
    "Read the server TLS private key PEM from a file",
  )
  .option(
    "--cert-hash <hex:string>",
    "Pinned SHA-256 certificate hash to trust when connecting to peers",
  )
  .example(
    "Run a listening peer",
    "deno run --unstable-net --allow-net=127.0.0.1 examples/webtransport_p2p/peer.ts --name alice --port 4443",
  )
  .example(
    "Run a second peer and connect to the first",
    "deno run --unstable-net --allow-net=127.0.0.1 examples/webtransport_p2p/peer.ts --name bob --port 4444 --connect https://127.0.0.1:4443/p2p",
  )
  .action(run)
  .parse(Deno.args);
