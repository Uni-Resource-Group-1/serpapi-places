#!/usr/bin/env node
// Copies the bundled geography JSON next to the compiled server output.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "server", "geo", "data");
const target = join(root, "dist", "server", "geo", "data");

if (!existsSync(source)) {
  console.error("Geography data is missing. Run `npm run geo:build` first.");
  process.exit(1);
}

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`Copied geography data to ${target}`);
