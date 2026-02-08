/**
 * Example demonstrating the warmupStats() API for inspecting warm-up results.
 *
 * This shows how to use warmupStats() to detect when warm-up connections fail,
 * which is important for production monitoring and alerting.
 */

import { RpcConnectionPool } from "../mod.ts";

// Simulated connection factory that fails occasionally
let attempt = 0;
function createConnection() {
  attempt++;
  // Simulate 50% failure rate during warmup
  if (attempt <= 5 && attempt % 2 === 1) {
    return Promise.reject(new Error(`Connection ${attempt} failed`));
  }
  return Promise.resolve({
    call: () => Promise.resolve(new Uint8Array()),
    close: () => Promise.resolve(),
  });
}

// Create a pool with minConnections=5 to trigger warm-up
const pool = new RpcConnectionPool(createConnection, {
  minConnections: 5,
  maxConnections: 10,
});

// Wait for warm-up to complete
await pool.whenReady();

// Check warm-up statistics
const stats = pool.warmupStats();
console.log("Warm-up Statistics:");
console.log(`  Requested: ${stats.requested}`);
console.log(`  Succeeded: ${stats.succeeded}`);
console.log(`  Failed: ${stats.failed}`);

// In production, you might alert if too many connections failed:
if (stats.failed > 0) {
  const failureRate = stats.failed / stats.requested;
  console.log(
    `\nWarning: ${
      (failureRate * 100).toFixed(1)
    }% of warm-up connections failed`,
  );

  if (failureRate > 0.5) {
    console.log("Alert: More than 50% of warm-up connections failed!");
    console.log("This may indicate a problem with the connection target.");
  }
}

// The pool still works even if some warm-up connections failed
console.log("\nPool stats after warm-up:");
console.log(`  Total connections: ${pool.stats.total}`);
console.log(`  Idle: ${pool.stats.idle}`);
console.log(`  Active: ${pool.stats.active}`);

// Clean up
await pool.close();
