#!/usr/bin/env node
// Builds a Chrome Web Store-ready zip from dist/: manifest.json at the zip
// root, source maps excluded. Output: dist/phonon-reader-<version>.zip
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(PROJECT_ROOT, "dist");

const manifest = JSON.parse(
  fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"),
);
const version = manifest.version;
const outFile = path.join(DIST, `phonon-reader-${version}.zip`);

fs.rmSync(outFile, { force: true });

// zip with -X (no extra attrs); contents at the zip root so manifest.json is
// found where the Web Store expects it.
execFileSync("zip", ["-r", "-X", outFile, "."], {
  cwd: DIST,
  stdio: "ignore",
});

// Source maps are dev-only; rebuild the zip without them.
const entries = execFileSync("unzip", ["-Z1", outFile], {
  cwd: DIST,
  encoding: "utf8",
})
  .split("\n")
  .filter((name) => name.length > 0 && !name.endsWith(".map"));

fs.rmSync(outFile, { force: true });
execFileSync("zip", ["-r", "-X", outFile, ...entries], {
  cwd: DIST,
  stdio: "ignore",
});

const size = fs.statSync(outFile).size;
console.log(`Packaged ${outFile} (${(size / 1024).toFixed(1)} KB)`);