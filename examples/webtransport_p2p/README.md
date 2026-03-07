# WebTransport P2P Example

`schema.capnp` now models a real long-running peer session:

- `PeerNode.connect(events)` registers a callback capability for the initial
  welcome
- `PeerNode.advertise(endpoint)` lets the serving peer open the return path
- `PeerNode.say(message)` sends chat to the remote peer
- `PeerNode.rename(name)` updates the local display name on the remote side
- `PeerEvents.system(...)` delivers the initial handshake message

Each process is both a server and an interactive client. You can connect to
other peers at startup or later with `/connect`, and the serving side will
automatically dial back once it learns the caller's advertised listen URL. Chat
then flows over ordinary peer RPC calls, so both sides can type plain text or
`/say ...`.

## Run From The Repository Root

Start peer A:

```sh
deno run --unstable-net --allow-net=127.0.0.1 examples/webtransport_p2p/peer.ts \
  --name alice --port 4443
```

Start peer B in a second terminal:

```sh
deno run --unstable-net --allow-net=127.0.0.1 examples/webtransport_p2p/peer.ts \
  --name bob --port 4444 --connect https://127.0.0.1:4443/p2p
```

Or use the Justfile shortcuts:

```sh
just --justfile examples/Justfile run-webtransport-p2p-a
just --justfile examples/Justfile run-webtransport-p2p-b
```

## Arguments

```sh
deno run --unstable-net --allow-net examples/webtransport_p2p/peer.ts \
  --name <peer-name> \
  --host <listen-host> \
  --port <listen-port> \
  --path <listen-path> \
  [--connect https://host:port/path]...
```

Commands once running:

```text
<text>                send a chat message to all connected peers
/say <text>           explicit chat command
/connect <url>        connect to another peer after startup
/disconnect <target>  disconnect an outbound peer by URL or remote name
/name <next-name>     rename the local peer
/peers                show connected peers
/listen               print the local listen URL
/help                 show the command list
/quit                 close connections and exit
```

## Notes

- The example embeds a local self-signed certificate and pins its SHA-256 hash.
- `--unstable-net` is required because Deno's WebTransport/QUIC APIs are still
  unstable.
- The CLI uses `jsr:@cliffy/command` for flag parsing and help output.
- To use your own TLS material, pass `--cert-file`, `--key-file`, and
  `--cert-hash`. That requires `--allow-read` in addition to `--allow-net`.
