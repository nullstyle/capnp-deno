// Wire-level fixture construction for equivalent pointer encoding tests.
export function frame(segments: bigint[][]): Uint8Array {
  const header = 4 *
    (1 + segments.length + (segments.length % 2 === 0 ? 1 : 0));
  const out = new Uint8Array(
    header + segments.reduce((sum, segment) => sum + segment.length * 8, 0),
  );
  const view = new DataView(out.buffer);
  view.setUint32(0, segments.length - 1, true);
  let cursor = header;
  for (const [index, words] of segments.entries()) {
    view.setUint32(4 + index * 4, words.length, true);
    for (const word of words) {
      view.setBigUint64(cursor, word, true);
      cursor += 8;
    }
  }
  return out;
}
export function far(segment: number, offset: number, double = false): bigint {
  return 2n | (double ? 4n : 0n) | (BigInt(offset) << 3n) |
    (BigInt(segment) << 32n);
}
