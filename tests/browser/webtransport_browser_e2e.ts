import { serve, WebTransportTransport } from "../../src/advanced.ts";
import {
  Pinger,
  type Pinger as PingerService,
} from "../../examples/ping/gen/schema_types.ts";
import { assert, assertEquals } from "../test_utils.ts";

interface EsbuildModule {
  build(options: Record<string, unknown>): Promise<void>;
  stop?: () => void;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

interface BrowserPage {
  goto(url: string): Promise<unknown>;
  waitForFunction(
    expression: string,
    arg?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
}

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<BrowserInstance>;
  };
}

interface BrowserResult {
  ok: boolean;
  error?: string;
  callbackValue?: number;
  callbackBeforePingResolved?: boolean;
  pingResolved?: boolean;
}

interface BrowserWebTransportTlsMaterial {
  readonly certPem: string;
  readonly keyPem: string;
  readonly certHash: Uint8Array<ArrayBuffer>;
  cleanup(): Promise<void>;
}

function reserveTcpPort(): number {
  const listener = Deno.listen({
    transport: "tcp",
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

function decodePemBlock(
  pem: string,
  label: string,
): Uint8Array<ArrayBuffer> {
  const pattern = new RegExp(
    `-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`,
  );
  const match = pattern.exec(pem);
  if (!match) {
    throw new Error(`missing ${label} PEM block`);
  }
  const binary = atob(match[1].replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function createBrowserWebTransportTlsMaterial(): Promise<
  BrowserWebTransportTlsMaterial
> {
  const dir = await Deno.makeTempDir({
    prefix: "capnp-deno-browser-webtransport-cert-",
  });
  const certPath = `${dir}/cert.pem`;
  const keyPath = `${dir}/key.pem`;
  const output = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "7",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw new Error(`failed to generate browser WebTransport cert: ${stderr}`);
  }

  const certPem = await Deno.readTextFile(certPath);
  const keyPem = await Deno.readTextFile(keyPath);
  const certDer = decodePemBlock(certPem, "CERTIFICATE");
  const certHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", certDer),
  );

  return {
    certPem,
    keyPem,
    certHash,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

function importPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function importOptionalNpm<T>(specifier: string): Promise<T> {
  try {
    return await import(specifier) as T;
  } catch (error) {
    throw new Error(
      `browser WebTransport e2e requires ${specifier}; install/cache it before running with CAPNP_DENO_BROWSER_E2E=1`,
      { cause: error },
    );
  }
}

async function buildBrowserBundle(options: {
  workDir: string;
  webTransportUrl: string;
  certHash: Uint8Array;
}): Promise<string> {
  const esbuild = await importOptionalNpm<EsbuildModule>("npm:esbuild@0.28.1");
  const bundleDir = await Deno.makeTempDir({
    prefix: "capnp-deno-browser-webtransport-",
  });
  const entryPath = `${bundleDir}/browser_client.ts`;
  const shimPath = `${bundleDir}/capnp_rpc_shim.ts`;
  const outPath = `${bundleDir}/browser_client.js`;

  const rpcShim = `
export { annotateCapnpError, ProtocolError, SessionError } from "${
    importPath(`${options.workDir}/src/errors.ts`)
  }";
export { EMPTY_STRUCT_MESSAGE } from "${
    importPath(`${options.workDir}/src/rpc/wire.ts`)
  }";
export { RpcWireClient } from "${
    importPath(`${options.workDir}/src/rpc/rpc_wire_client.ts`)
  }";
export { createStreamSender } from "${
    importPath(`${options.workDir}/src/rpc/session/streaming.ts`)
  }";
export {
  createWebTransportCertificateHashOptions,
  WebTransportTransport,
} from "${importPath(`${options.workDir}/src/rpc/transports/webtransport.ts`)}";
export function createRpcServiceToken(options) {
  return Object.freeze({ ...options });
}
`;

  const browserEntry = `
import {
  createWebTransportCertificateHashOptions,
  RpcWireClient,
  WebTransportTransport,
} from "@nullstyle/capnp/rpc";
import {
  bootstrapPingerClient,
  createPongerServer,
  PingerInterfaceId,
} from "${importPath(`${options.workDir}/examples/ping/gen/schema_types.ts`)}";

globalThis.__capnpDenoResult = undefined;

try {
  if (typeof globalThis.WebTransport !== "function") {
    throw new Error("browser WebTransport is unavailable");
  }

  const certHash = new Uint8Array(${
    JSON.stringify(Array.from(options.certHash))
  });
  const transport = await WebTransportTransport.connect(${
    JSON.stringify(options.webTransportUrl)
  }, {
    webTransport: createWebTransportCertificateHashOptions(certHash),
    connectTimeoutMs: 4_000,
    streamOpenTimeoutMs: 4_000,
  });
  const clientTransport = new RpcWireClient(transport, {
    interfaceId: PingerInterfaceId,
    defaultTimeoutMs: 4_000,
  });
  const pinger = await bootstrapPingerClient(clientTransport, {
    timeoutMs: 4_000,
  });

  let pingResolved = false;
  let callbackValue = null;
  let callbackBeforePingResolved = false;
  const callback = clientTransport.exportCapability(createPongerServer({
    pong(params) {
      callbackValue = params.n;
      callbackBeforePingResolved = !pingResolved;
      return {};
    },
  }));

  try {
    await pinger.ping({ p: callback }, { timeoutMs: 4_000 });
    pingResolved = true;
  } finally {
    await clientTransport.release(callback, 1).catch(() => {});
    await clientTransport.close().catch(() => {});
  }

  globalThis.__capnpDenoResult = {
    ok: true,
    callbackValue,
    callbackBeforePingResolved,
    pingResolved,
  };
} catch (error) {
  globalThis.__capnpDenoResult = {
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
}
`;

  await Deno.writeTextFile(shimPath, rpcShim);
  await Deno.writeTextFile(entryPath, browserEntry);
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: outPath,
    alias: {
      "@nullstyle/capnp/rpc": shimPath,
      "@nullstyle/capnp/encoding": importPath(
        `${options.workDir}/src/encoding.ts`,
      ),
      "@nullstyle/capnp": shimPath,
    },
    logLevel: "silent",
  });
  esbuild.stop?.();
  return outPath;
}

Deno.test({
  name: "browser WebTransport generated callback e2e",
  ignore: Deno.env.get("CAPNP_DENO_BROWSER_E2E") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const playwright = await importOptionalNpm<PlaywrightModule>(
      "npm:playwright@1.61.1",
    );
    const workDir = Deno.cwd();
    const webTransportPort = reserveTcpPort();
    const httpPort = reserveTcpPort();
    const webTransportUrl = `https://127.0.0.1:${webTransportPort}/rpc`;
    const tls = await createBrowserWebTransportTlsMaterial();
    const bundlePath = await buildBrowserBundle({
      workDir,
      webTransportUrl,
      certHash: tls.certHash,
    });

    const server: PingerService = {
      async ping(ponger) {
        await ponger.pong(321);
      },
    };
    const listener = WebTransportTransport.listen({
      hostname: "127.0.0.1",
      port: webTransportPort,
      path: "/rpc",
      cert: tls.certPem,
      key: tls.keyPem,
    });
    const handle = serve(Pinger, listener, server);

    const abort = new AbortController();
    const httpServer = Deno.serve({
      hostname: "127.0.0.1",
      port: httpPort,
      signal: abort.signal,
      onListen: () => {},
    }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/client.js") {
        return new Response(await Deno.readTextFile(bundlePath), {
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response(
        '<!doctype html><script type="module" src="/client.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    });

    let browser: BrowserInstance | null = null;
    try {
      browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${httpPort}/`);
      await page.waitForFunction(
        "globalThis.__capnpDenoResult !== undefined",
        undefined,
        { timeout: 10_000 },
      );
      const result = await page.evaluate<BrowserResult>(
        "globalThis.__capnpDenoResult",
      );

      assert(result.ok, result.error ?? "browser e2e failed");
      assertEquals(result.callbackValue, 321);
      assertEquals(result.callbackBeforePingResolved, true);
      assertEquals(result.pingResolved, true);
    } finally {
      await browser?.close().catch(() => {});
      abort.abort();
      await httpServer.finished.catch(() => {});
      await handle.close();
      await tls.cleanup().catch(() => {});
    }
  },
});
