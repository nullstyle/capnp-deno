export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4443;
export const DEFAULT_PATH = "/p2p";
export const DEFAULT_NAME = "anon";
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 5_000;

export const DEMO_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJAPT8CQA2YR2WMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjAzMDYyMDI4MzFaFw0zNjAzMDMyMDI4MzFaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALlXSSsKwSGpvQ+SeIKGFMp0jtjOao01JxQ+m7mmWI3GCtzXUkiO9LTViChl
cguAffMymjvilMTCT4zRvnxeU0iXGl7B334zYSynAjr/xw3bva7XDxEe16OMzAmF
uaaXBnmL0QYkeMmesQYN/Yjkz+XMnPgKWCHCHkqgym3KNIbpQYeavIkNVukSYsTu
1R7tgPmLBpytl2NFgl0JDr5JAEep7Y66G+NnnrNl9fRQK+SFGUUHA2Xgojm6WATC
faZacjNNPneH0wZGSJdyqYgEK7xil2GMVNczpJLuN44jQpEu4KFLiKKovNU+UOKf
ZWj15mH49IHmq4URaYDsolGBiHMCAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQA0fRrpIdZrM9DZfoXUBtJum32z
VwcyUZFDXCQwmnFIOkjJSEH8v6bczVWnQWqBKYUYtYxMb8GDqY5S9BfPLfc7Kbpd
ovV5PknWxd9aqn0qgPkoKNTCkwW/ZUhN+bG9W19YobTXQifhSjwgwZaFboszEH9h
BGyzZLNi+bUjTo+LwNhlKMREipnvxCwftBkiKYK0lTPOd6HzEs2XkDu1fX8bo/7C
xGoI5k5K/huAwQmGl3g89HfqHj2dyIGGHuYn/r0BKzHVgqdVHNKm4XZEnYzDq3qR
Bwby8pMvIW1OIUxjnQ2BCiqsZXiPvT1uFt3jaIvUSUFwD8iDgWiQcaHO2vGX
-----END CERTIFICATE-----`;

export const DEMO_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC5V0krCsEhqb0P
kniChhTKdI7YzmqNNScUPpu5pliNxgrc11JIjvS01YgoZXILgH3zMpo74pTEwk+M
0b58XlNIlxpewd9+M2EspwI6/8cN272u1w8RHtejjMwJhbmmlwZ5i9EGJHjJnrEG
Df2I5M/lzJz4Clghwh5KoMptyjSG6UGHmryJDVbpEmLE7tUe7YD5iwacrZdjRYJd
CQ6+SQBHqe2OuhvjZ56zZfX0UCvkhRlFBwNl4KI5ulgEwn2mWnIzTT53h9MGRkiX
cqmIBCu8YpdhjFTXM6SS7jeOI0KRLuChS4iiqLzVPlDin2Vo9eZh+PSB5quFEWmA
7KJRgYhzAgMBAAECggEAMDfPJ02C9VkNgLGgfISZgBpW13zMJ7R+WDv5k5D9VNUD
GnVCSPI4I5ux8qCBzRA+tDij+5R1E8NhoscmgYCgti/pgmF53YFMdKt2XxcQGEDk
1knI97FIdJo6sveBVx/PZWvEk46Fhh6s+2BEZ4rvs19KLxWx3AZ+jvfJ8ko65CX1
rVZppTHr54VI8o2jMyEw5Pw08GH3VsBjbHX4HLLfycHs1jk/aK+LETIiGSUZPoF8
vgvX2h/kjyhnL9JtkXaEi2HxAx1hBfZxivYlPHETTwOGUiBN4zX7h4drDe4DYSqX
qTs5HfU7EO/YF2H+KgCi7D2Arse8GRv3HqKzUWk50QKBgQDgPvVHEY08xyZOEsb3
XwCkzg8iZYWXOD40NEhbJ1I82puI76JzfpHt4zI1kEr2kTfZXHVVnhK46QBl9FT8
0A4102C1zoMJVIDs2zZGPb2n/pbce81ugW3/LQ1ow5+f1sg9qMvVIuATFBI1XmFy
H/xMgzyjFBXnZW6EznqZAruazwKBgQDTlgAh9gzsUO4lVagYWv2lZMscJrd0dfxf
O64qMgzyn2PB65saBp5R/+aWNdjowa23EmQgOQTLc05BVpUAQM9+cNK7kvinaSsD
2TBX1xQKAExbDJBxtVt7Ns7Xa1XSPzDm1vFbYBkBlnypJX+KiveqUB6118Cv7mMj
PTay+MLRHQKBgAF258srBi0bb9iarsn2yN5KqjajSxgNufpFTSOrQhI7q0BdsEXo
0bMoBK/s3VB26lJ1FB8XBTBH9US1L8jm4vDfDIajbp+k+aKSW+xhgteSBhIyjMjn
93vvI2NHw8cbc/tTGuGtdKErRGMs1p4UL2Wghcja3LnCI9KiNpLBPdBpAoGBAK7f
7SAkkq3Gfe3Ri+sFWVqXod+UiE/zLDExzFMHpvfokLS4HCs4iSXQ0S4ZNzu4x/Dl
fGe9eJ8GoAkUnHXnGxev/BwX7ve+zlSR74jKNL/HW1RtX/z7Ha8Kr44QIpBwteQ0
hqs1E7XiQQoz+ePx05yqN5enyJQf/UQk1c66F5ppAoGBAMOuYpNL9OGnoj/NL3RZ
/3Z2hq2+SgGNnjhdf9KSApwnjBrzCJLEp3H/otK/ZBmSJMUeKM+EPAEnfo8YsHuP
PtzWuVYRC9U7/xEE6sg61SJZVdRJoQTBlzg0EcROCv4jiDsVLpYwLZ5TpysOkCiA
6wigTj6gBUMtoScXH2AKBLuL
-----END PRIVATE KEY-----`;

export const DEMO_CERT_HASH = new Uint8Array([
  66,
  119,
  121,
  40,
  16,
  62,
  67,
  57,
  166,
  164,
  122,
  15,
  185,
  83,
  56,
  186,
  5,
  233,
  58,
  131,
  178,
  126,
  88,
  58,
  98,
  21,
  151,
  72,
  31,
  103,
  107,
  89,
]);

export interface WebTransportTlsMaterial {
  certPem: string;
  keyPem: string;
  certHash: Uint8Array;
  certHashHex: string;
}

export function parsePort(raw: string, flagName: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`invalid ${flagName}: ${raw}`);
  }
  return parsed;
}

export function normalizePath(path: string): string {
  if (path.length === 0 || path === "/") return DEFAULT_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function formatUrl(host: string, port: number, path: string): string {
  return `https://${host}:${port}${normalizePath(path)}`;
}

export function createConnectOptions(certHash: Uint8Array) {
  return {
    webTransport: {
      serverCertificateHashes: [{
        algorithm: "sha-256",
        value: new Uint8Array(certHash),
      }],
    },
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    streamOpenTimeoutMs: DEFAULT_STREAM_OPEN_TIMEOUT_MS,
  };
}

export function createServerOptions(
  path: string,
  certPem: string,
  keyPem: string,
) {
  return {
    path: normalizePath(path),
    cert: certPem,
    key: keyPem,
  };
}

export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseHexBytes(raw: string): Uint8Array {
  const normalized = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (normalized.length !== 64) {
    throw new Error(
      `expected 32-byte SHA-256 hex value, got ${raw.length} characters`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = normalized.slice(i * 2, i * 2 + 2);
    bytes[i] = Number.parseInt(byte, 16);
  }
  return bytes;
}

export async function loadTlsMaterial(options: {
  certFile?: string;
  keyFile?: string;
  certHashHex?: string;
}): Promise<WebTransportTlsMaterial> {
  const certPem = options.certFile
    ? await Deno.readTextFile(options.certFile)
    : DEMO_CERT_PEM;
  const keyPem = options.keyFile
    ? await Deno.readTextFile(options.keyFile)
    : DEMO_KEY_PEM;
  const certHash = options.certHashHex
    ? parseHexBytes(options.certHashHex)
    : new Uint8Array(DEMO_CERT_HASH);
  return {
    certPem,
    keyPem,
    certHash,
    certHashHex: formatHex(certHash),
  };
}

export function formatPeerEndpoint(
  host: string,
  port: number,
  path: string,
): string {
  return `${host}:${port}${normalizePath(path)}`;
}
