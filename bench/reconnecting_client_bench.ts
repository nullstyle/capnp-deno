import {
  ReconnectingRpcClientTransport,
  type RpcClientTransportLike,
  TransportError,
} from "../mod.ts";

const EMPTY = new Uint8Array();
const STEADY_PAYLOAD = new Uint8Array([0x11]);
const RETRY_PAYLOAD = new Uint8Array([0x22]);

function reconnectOptions() {
  return {
    policy: {
      shouldRetry: (_ctx: unknown) => true,
      nextDelayMs: (_ctx: unknown) => 0,
    },
    sleep: async (_delayMs: number) => {
      // Deterministic no-op for benchmarks.
    },
  };
}

let blackhole = 0;

const steadyClient: RpcClientTransportLike = {
  call: () => Promise.resolve(STEADY_PAYLOAD),
  close: () => Promise.resolve(),
};

const steadyTransport = new ReconnectingRpcClientTransport({
  connect: () => Promise.resolve(steadyClient),
  reconnect: reconnectOptions(),
});

// Pre-connect so the benchmark captures steady-state call overhead.
await steadyTransport.call({ capabilityIndex: 1 }, 0, EMPTY);

addEventListener("unload", () => {
  void steadyTransport.close();
});

async function runRetryWithRebootstrapOnce(): Promise<void> {
  let connectCount = 0;

  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };

  const client2: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 20 }),
    call: (capability) => {
      if (capability.capabilityIndex !== 20) {
        return Promise.reject(
          new Error(`expected bootstrap remap to capability 20`),
        );
      }
      return Promise.resolve(RETRY_PAYLOAD);
    },
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
  });

  try {
    const bootstrap = await transport.bootstrap();
    const response = await transport.call(bootstrap, 3, EMPTY);
    blackhole ^= response[0];
    blackhole ^= connectCount;
  } finally {
    await transport.close();
  }
}

async function runRetryWithRemapOnce(): Promise<void> {
  let connectCount = 0;

  const client1: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 10 }),
    call: () => Promise.reject(new TransportError("connection dropped")),
    close: () => Promise.resolve(),
  };

  const client2: RpcClientTransportLike = {
    bootstrap: () => Promise.resolve({ capabilityIndex: 20 }),
    call: (capability) => {
      if (capability.capabilityIndex !== 77) {
        return Promise.reject(
          new Error(`expected remapped non-bootstrap capability 77`),
        );
      }
      return Promise.resolve(RETRY_PAYLOAD);
    },
    close: () => Promise.resolve(),
  };

  const transport = new ReconnectingRpcClientTransport({
    connect: () => {
      connectCount += 1;
      return Promise.resolve(connectCount === 1 ? client1 : client2);
    },
    reconnect: reconnectOptions(),
    remapCapabilityOnReconnect: (_context) => ({ capabilityIndex: 77 }),
  });

  try {
    await transport.bootstrap();
    const response = await transport.call({ capabilityIndex: 99 }, 7, EMPTY);
    blackhole ^= response[0];
    blackhole ^= connectCount;
  } finally {
    await transport.close();
  }
}

Deno.bench({
  name: "reconnecting_rpc_client:steady_state_call",
  group: "reconnecting_rpc_client",
  baseline: true,
  n: 8_000,
  warmup: 300,
  async fn() {
    const response = await steadyTransport.call(
      { capabilityIndex: 1 },
      0,
      EMPTY,
    );
    blackhole ^= response[0];
  },
});

Deno.bench({
  name: "reconnecting_rpc_client:retry_with_rebootstrap",
  group: "reconnecting_rpc_client_retry",
  baseline: true,
  n: 1_200,
  warmup: 80,
  async fn() {
    await runRetryWithRebootstrapOnce();
  },
});

Deno.bench({
  name: "reconnecting_rpc_client:retry_with_remap",
  group: "reconnecting_rpc_client_retry",
  n: 1_200,
  warmup: 80,
  async fn() {
    await runRetryWithRemapOnce();
  },
});
