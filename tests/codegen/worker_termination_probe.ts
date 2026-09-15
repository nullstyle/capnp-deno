// Separate process: its parent enforces an eight-second OS deadline even if a
// Deno engine fails to stop an infinite worker and cannot exit by itself.
if (import.meta.main) {
  const shared = new SharedArrayBuffer(8);
  const counter = new BigInt64Array(shared);
  const url = URL.createObjectURL(
    new Blob([
      `self.onmessage = ({data}) => { const counter = new BigInt64Array(data); postMessage("ready"); while (true) Atomics.add(counter, 0, 1n); };`,
    ], { type: "text/javascript" }),
  );
  const worker = new Worker(url, { type: "module" });
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve();
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage(shared);
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const before = Atomics.load(counter, 0);
  worker.terminate();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const afterThree = Atomics.load(counter, 0);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const afterFour = Atomics.load(counter, 0);
  URL.revokeObjectURL(url);
  console.log(
    JSON.stringify({
      before: String(before),
      afterThree: String(afterThree),
      afterFour: String(afterFour),
    }),
  );
  if (before === 0n || afterThree !== afterFour) {
    throw new Error(
      "worker execution did not stop within Deno's termination grace",
    );
  }
}
