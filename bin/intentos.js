#!/usr/bin/env node
// Runs the TypeScript CLI directly: Node >= 22.6 strips types natively and provides node:sqlite.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`error: IntentOS needs Node.js >= 22.6 (found ${process.versions.node}). Install a current LTS, e.g. \`nvm install 22 && nvm use 22\`.`);
  process.exit(2);
}
import("../src/cli.ts").catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(2);
});
