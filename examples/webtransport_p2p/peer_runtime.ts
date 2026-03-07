import {
  type RpcPeer,
  type RpcStub,
  type WebTransportServeHandle,
  WT,
} from "@nullstyle/capnp";
import { PeerNode } from "./gen/mod.ts";
import type {
  ConnectResults,
  PeerEvents as PeerEventsService,
  PeerNode as PeerNodeService,
  PeerSummary,
} from "./gen/mod.ts";
import { handlePeerCommand } from "./runtime_commands.ts";
import {
  createConnectOptions,
  createServerOptions,
  formatUrl,
  type WebTransportTlsMaterial,
} from "./shared.ts";

interface InboundSession {
  id: string;
  name: string | null;
  endpoint: string;
  advertisedUrl: string | null;
  peer: RpcPeer;
}

interface OutboundConnection {
  url: string;
  remote: RpcStub<PeerNodeService>;
  remoteName: string;
}

export interface PeerRuntimeOptions {
  name: string;
  host: string;
  port: number;
  path: string;
  tls: WebTransportTlsMaterial;
}

function createPeerSummary(
  name: string,
  endpoint: string,
  direction: "inbound" | "outbound",
): PeerSummary {
  return { name, endpoint, direction };
}

function formatPeerSummary(summary: PeerSummary): string {
  return `${summary.name} (${summary.direction} ${summary.endpoint})`;
}

function trimOrFallback(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function createPeerNodeServer(
  runtime: PeerRuntime,
): new (peer: RpcPeer) => PeerNodeService {
  return class PeerNodeServer implements PeerNodeService {
    readonly #peer: RpcPeer;
    readonly #sessionId: string;

    constructor(peer: RpcPeer) {
      this.#peer = peer;
      this.#sessionId = runtime.prepareInbound(peer);
    }

    [Symbol.dispose](): void {
      void runtime.removeInbound(this.#sessionId, "transport closed");
    }

    async connect(events: PeerEventsService): Promise<ConnectResults> {
      return await runtime.attachInbound(
        this.#sessionId,
        this.#peer,
        events,
      );
    }

    async say(message: string): Promise<void> {
      await runtime.receiveInboundMessage(
        this.#sessionId,
        trimOrFallback(message, "(empty message)"),
      );
    }

    async rename(name: string): Promise<void> {
      await runtime.renameInbound(
        this.#sessionId,
        trimOrFallback(name, "anon"),
      );
    }

    listPeers(): Promise<PeerSummary[]> {
      return Promise.resolve(runtime.listPeerSummaries(this.#sessionId));
    }

    async disconnect(reason: string): Promise<void> {
      await runtime.removeInbound(
        this.#sessionId,
        trimOrFallback(reason, "remote requested disconnect"),
      );
    }

    async advertise(endpoint: string): Promise<void> {
      await runtime.advertiseInbound(
        this.#sessionId,
        trimOrFallback(endpoint, this.#peer.toString()),
      );
    }
  };
}

function createLocalPeerEvents(
  runtime: PeerRuntime,
  label: () => string,
): PeerEventsService {
  return {
    system: (message: string) => {
      runtime.print(`[remote ${label()}] ${message}`);
      return Promise.resolve();
    },
  };
}

export class PeerRuntime {
  readonly #host: string;
  readonly #port: number;
  readonly #path: string;
  readonly #tls: WebTransportTlsMaterial;
  #name: string;
  #server: WebTransportServeHandle | null = null;
  #closed = false;
  #nextInboundId = 0;
  readonly #inbound = new Map<string, InboundSession>();
  readonly #connecting = new Set<string>();
  readonly #outbound = new Map<string, OutboundConnection>();

  constructor(options: PeerRuntimeOptions) {
    this.#name = options.name;
    this.#host = options.host;
    this.#port = options.port;
    this.#path = options.path;
    this.#tls = options.tls;
  }

  get name(): string {
    return this.#name;
  }

  get listenUrl(): string {
    return formatUrl(this.#host, this.#port, this.#path);
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(): Promise<void> {
    if (this.#server) return Promise.resolve();
    this.#server = WT.serve(
      PeerNode,
      this.#host,
      this.#port,
      createPeerNodeServer(this),
      createServerOptions(this.#path, this.#tls.certPem, this.#tls.keyPem),
    );
    this.print(`listening on ${this.listenUrl}`);
    this.print(`server certificate pin sha256=${this.#tls.certHashHex}`);
    this.print("type /help for commands");
    return Promise.resolve();
  }

  async connect(url: string): Promise<void> {
    if (this.#closed) {
      throw new Error("peer runtime is closed");
    }
    if (this.#outbound.has(url)) {
      this.print(`already connected to ${url}`);
      return;
    }
    if (this.#connecting.has(url)) {
      this.print(`connection already in progress for ${url}`);
      return;
    }
    if (url === this.listenUrl) {
      this.print(`skipping self-connect to ${url}`);
      return;
    }

    let remote: RpcStub<PeerNodeService> | null = null;
    const label = { value: url };
    this.#connecting.add(url);
    try {
      remote = await WT.connect(
        PeerNode,
        url,
        createConnectOptions(this.#tls.certHash),
      );
      const result = await remote.connect(
        createLocalPeerEvents(this, () => label.value),
      );
      label.value = `${result.localName} @ ${url}`;
      this.#outbound.set(url, {
        url,
        remote,
        remoteName: result.localName,
      });
      await remote.rename(this.#name);
      await remote.advertise(this.listenUrl);
      this.print(`connected to ${label.value}`);
      if (result.peers.length > 0) {
        this.print("remote already knows:");
        for (const peer of result.peers) {
          this.print(`  ${formatPeerSummary(peer)}`);
        }
      }
    } catch (error) {
      this.#outbound.delete(url);
      await remote?.close().catch(() => {});
      this.print(`connect failed for ${url}: ${String(error)}`);
      throw error;
    } finally {
      this.#connecting.delete(url);
    }
  }

  async broadcast(message: string): Promise<void> {
    const text = trimOrFallback(message, "(empty message)");
    if (this.#outbound.size === 0) {
      this.print("no connected peers; use /connect <url> first");
      return;
    }

    this.print(`you: ${text}`);
    for (const connection of [...this.#outbound.values()]) {
      try {
        await connection.remote.say(text);
      } catch (error) {
        await this.removeOutbound(
          connection.url,
          `send failed: ${String(error)}`,
        );
      }
    }
  }

  async renameLocal(nextName: string): Promise<void> {
    const accepted = trimOrFallback(nextName, "anon");
    const previous = this.#name;
    if (accepted === previous) {
      this.print(`name is already ${accepted}`);
      return;
    }
    this.#name = accepted;
    this.print(`local name changed: ${previous} -> ${accepted}`);

    for (const connection of [...this.#outbound.values()]) {
      try {
        await connection.remote.rename(accepted);
      } catch (error) {
        await this.removeOutbound(
          connection.url,
          `rename propagation failed: ${String(error)}`,
        );
      }
    }
  }

  listPeerSummaries(excludeInboundId?: string): PeerSummary[] {
    const peers: PeerSummary[] = [];
    for (const session of this.#inbound.values()) {
      if (session.id === excludeInboundId || !session.name) continue;
      peers.push(
        createPeerSummary(
          session.name,
          session.advertisedUrl ?? session.endpoint,
          "inbound",
        ),
      );
    }
    for (const connection of this.#outbound.values()) {
      peers.push(
        createPeerSummary(connection.remoteName, connection.url, "outbound"),
      );
    }
    peers.sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.direction.localeCompare(right.direction) ||
      left.endpoint.localeCompare(right.endpoint)
    );
    return peers;
  }

  renderPeers(): string[] {
    const peers = this.listPeerSummaries();
    if (peers.length === 0) {
      return ["no connected peers"];
    }
    return peers.map((peer, index) =>
      `${index + 1}. ${formatPeerSummary(peer)}`
    );
  }

  async disconnectPeer(target: string): Promise<void> {
    const connection = this.findOutbound(target);
    if (!connection) {
      this.print(`no outbound peer matches ${target}`);
      return;
    }
    await this.removeOutbound(connection.url, "local operator disconnect");
  }

  prepareInbound(peer: RpcPeer): string {
    const sessionId = `inbound-${++this.#nextInboundId}`;
    this.print(`transport connected ${peer}`);
    this.#inbound.set(sessionId, {
      id: sessionId,
      name: null,
      endpoint: peer.toString(),
      advertisedUrl: null,
      peer,
    });
    return sessionId;
  }

  async attachInbound(
    sessionId: string,
    peer: RpcPeer,
    events: PeerEventsService,
  ): Promise<ConnectResults> {
    const session = this.requireInbound(sessionId);
    session.name = session.name ?? peer.toString();
    session.endpoint = peer.toString();

    this.print(
      `inbound session ready ${session.name} from ${session.endpoint}`,
    );
    await this.callEvent(
      events.system(`connected to ${this.#name} at ${this.listenUrl}`),
      `welcome callback for ${session.name}`,
    );

    return {
      localName: this.#name,
      peers: this.listPeerSummaries(sessionId),
    };
  }

  async advertiseInbound(sessionId: string, endpoint: string): Promise<void> {
    const session = this.requireInbound(sessionId);
    const advertisedUrl = trimOrFallback(endpoint, session.endpoint);
    session.advertisedUrl = advertisedUrl;
    this.print(
      `inbound endpoint ${
        session.name ?? session.endpoint
      } -> ${advertisedUrl}`,
    );

    const mirrored = this.#outbound.has(advertisedUrl) ||
      this.#connecting.has(advertisedUrl);
    if (advertisedUrl === this.listenUrl || mirrored) {
      return;
    }
    await this.connect(advertisedUrl).catch(() => {});
  }

  receiveInboundMessage(
    sessionId: string,
    message: string,
  ): Promise<void> {
    const session = this.requireInbound(sessionId);
    this.print(`${session.name ?? session.endpoint}: ${message}`);
    return Promise.resolve();
  }

  renameInbound(sessionId: string, nextName: string): Promise<void> {
    const session = this.requireInbound(sessionId);
    const previous = session.name ?? session.endpoint;
    session.name = nextName;
    this.print(`inbound rename ${previous} -> ${nextName}`);

    if (session.advertisedUrl) {
      const mirrored = this.#outbound.get(session.advertisedUrl);
      if (mirrored) {
        mirrored.remoteName = nextName;
      }
    }
    return Promise.resolve();
  }

  removeInbound(sessionId: string, reason: string): Promise<void> {
    const session = this.#inbound.get(sessionId);
    if (!session) return Promise.resolve();
    this.#inbound.delete(sessionId);
    const summary = createPeerSummary(
      session.name ?? session.endpoint,
      session.advertisedUrl ?? session.endpoint,
      "inbound",
    );
    this.print(
      `inbound session closed ${formatPeerSummary(summary)} (${reason})`,
    );
    return Promise.resolve();
  }

  handleCommand(line: string): Promise<boolean> {
    return handlePeerCommand(this, line);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const inbound = [...this.#inbound.values()];
    this.#inbound.clear();
    for (const session of inbound) {
      await session.peer.close().catch(() => {});
    }

    for (const url of [...this.#outbound.keys()]) {
      await this.removeOutbound(url, "local shutdown");
    }

    await this.#server?.close().catch(() => {});
    this.#server = null;
  }

  print(message: string): void {
    console.log(`[${this.#name}] ${message}`);
  }

  requireInbound(sessionId: string): InboundSession {
    const session = this.#inbound.get(sessionId);
    if (!session) {
      throw new Error(`unknown inbound session ${sessionId}`);
    }
    return session;
  }

  findOutbound(target: string): OutboundConnection | null {
    const trimmed = target.trim();
    if (trimmed.length === 0) return null;

    const byUrl = this.#outbound.get(trimmed);
    if (byUrl) return byUrl;

    const lowered = trimmed.toLowerCase();
    for (const connection of this.#outbound.values()) {
      if (connection.remoteName.toLowerCase() === lowered) {
        return connection;
      }
    }

    return null;
  }

  async removeOutbound(url: string, reason: string): Promise<void> {
    const connection = this.#outbound.get(url);
    if (!connection) return;

    this.#outbound.delete(url);
    this.print(
      `outbound session closed ${
        formatPeerSummary(
          createPeerSummary(connection.remoteName, connection.url, "outbound"),
        )
      } (${reason})`,
    );
    try {
      await connection.remote.disconnect(reason);
    } catch {
      // best-effort only
    }
    await connection.remote.close().catch(() => {});
  }

  async callEvent(
    promise: Promise<void>,
    context: string,
  ): Promise<void> {
    try {
      await promise;
    } catch (error) {
      this.print(`${context} failed: ${String(error)}`);
    }
  }
}
