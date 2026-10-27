#!/usr/bin/env node
// Bundles the TypeScript sources into dist/ and copies the static assets
// (manifest, popup/offscreen HTML+CSS, icons) so dist/ can be loaded unpacked.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(PROJECT_ROOT, "dist");

const BUNDLE_OPTIONS = {
  entryPoints: {
    "background/service-worker": path.join(
      PROJECT_ROOT,
      "src/background/service-worker.ts",
    ),
    "content/page-reader": path.join(
      PROJECT_ROOT,
      "src/content/page-reader.ts",
    ),
    "content/overlay": path.join(PROJECT_ROOT, "src/content/overlay.ts"),
    "offscreen/offscreen": path.join(
      PROJECT_ROOT,
      "src/offscreen/offscreen.ts",
    ),
    "popup/popup": path.join(PROJECT_ROOT, "src/popup/popup.ts"),
  },
  outdir: DIST,
  bundle: true,
  format: "iife",
  target: "chrome116",
  sourcemap: "external",
  minify: false,
  logLevel: "info",
};

const STATIC_FILES = [
  {
    source: path.join(PROJECT_ROOT, "manifest.json"),
    destination: path.join(DIST, "manifest.json"),
  },
  {
    source: path.join(PROJECT_ROOT, "src/popup/popup.html"),
    destination: path.join(DIST, "popup/popup.html"),
  },
  {
    source: path.join(PROJECT_ROOT, "src/popup/popup.css"),
    destination: path.join(DIST, "popup/popup.css"),
  },
  {
    source: path.join(PROJECT_ROOT, "src/offscreen/offscreen.html"),
    destination: path.join(DIST, "offscreen/offscreen.html"),
  },
];

function copyIcons() {
  const iconsDir = path.join(PROJECT_ROOT, "icons");
  const destinationDir = path.join(DIST, "icons");
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(iconsDir)) {
    fs.copyFileSync(
      path.join(iconsDir, entry),
      path.join(destinationDir, entry),
    );
  }
}

function copyStaticFiles() {
  for (const file of STATIC_FILES) {
    fs.mkdirSync(path.dirname(file.destination), { recursive: true });
    fs.copyFileSync(file.source, file.destination);
  }
  copyIcons();
}

fs.rmSync(DIST, { recursive: true, force: true });

if (process.argv.includes("--watch")) {
  const context = await esbuild.context(BUNDLE_OPTIONS);
  await context.watch();
  copyStaticFiles();
  console.log("esbuild is watching for changes…");
} else {
  await esbuild.build(BUNDLE_OPTIONS);
  copyStaticFiles();
  console.log(`Build complete: ${DIST}`);
}
