#!/usr/bin/env node
// Syntax-checks every module under src/ and scripts/.
//
// This used to be a hand-maintained list of `node --check` calls in package.json, which
// silently stopped covering src/domain/validation.js and src/domain/demo-transcript.js
// once they were added. Walking the tree means a new module is covered the moment it
// exists, with nothing to remember.
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["src", "scripts"];
const EXTENSIONS = [".js", ".mjs"];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(path);
    } else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      yield path;
    }
  }
}

const files = [];
for (const root of ROOTS) {
  for await (const file of walk(join(rootDir, root))) files.push(file);
}
files.sort();

if (!files.length) {
  console.error("check: found no modules to check — is the working directory right?");
  process.exit(1);
}

const failures = [];
for (const file of files) {
  try {
    await run(process.execPath, ["--check", file]);
  } catch (error) {
    failures.push({ file: relative(rootDir, file), message: (error.stderr || error.message).trim() });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`\n✖ ${failure.file}\n${failure.message}`);
  }
  console.error(`\ncheck: ${failures.length} of ${files.length} module(s) failed to parse.`);
  process.exit(1);
}

console.log(`check: ${files.length} modules parsed cleanly.`);
