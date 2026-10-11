#!/usr/bin/env node
import { runKnowledgeCli } from "./herta-knowledge.js";

runKnowledgeCli(process.argv.slice(2), {
  cwd: process.cwd(),
  log: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
})
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
