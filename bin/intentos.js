#!/usr/bin/env node
// Runs the TypeScript CLI directly (Node >= 22.6 strips types natively).
import("../src/cli.ts").catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(2);
});
