#!/usr/bin/env node
/**
 * Bundles the helper server into a single CommonJS file via esbuild.
 *
 * Output layout:
 *   dist/server.cjs        ← our code + express/cors/crypto-js bundled in
 *   dist/node_modules/playwright-core/  ← kept external (driver needs real files)
 *
 * The installer places dist/ alongside a portable node.exe and launches:
 *   node.exe server.cjs
 *
 * Why playwright-core is external:
 *   Playwright spawns a driver subprocess via spawn() using paths computed from
 *   its own __dirname. Bundling breaks those path computations. The only
 *   reliable way to ship playwright-core is to ship the whole package directory.
 */

import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });

// 1. Bundle our code (TypeScript → single CJS file)
console.log("Bundling server.ts...");
await build({
  entryPoints: [path.join(ROOT, "src", "server.ts")],
  bundle: true,
  outfile: path.join(DIST, "server.cjs"),
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["playwright-core"],
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

// 2. Copy playwright-core (entire package directory) as a sibling
console.log("Copying playwright-core...");
const pwSrc = path.join(ROOT, "node_modules", "playwright-core");
const pwDst = path.join(DIST, "node_modules", "playwright-core");
await copyDir(pwSrc, pwDst);

// 3. Drop in a VBS launcher that runs node.exe silently (no console window).
// Windows has no native way to start a Node process without a console window;
// WScript's Run with intWindowStyle=0 is the standard workaround.
const launchVbs = `' FillGST Helper silent launcher
' Double-clicked by Windows startup shortcut. Runs node.exe in the background
' with no visible console window.
Set oShell = CreateObject("WScript.Shell")
sDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
oShell.CurrentDirectory = sDir
oShell.Run """" & sDir & "\\node.exe"" """ & sDir & "\\server.cjs""", 0, False
`;
await fs.writeFile(path.join(DIST, "launch.vbs"), launchVbs, "utf-8");

// 4. Stop script — kills the running helper by port
const stopBat = `@echo off
rem FillGST Helper stop script
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :9876 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo FillGST Helper stopped.
`;
await fs.writeFile(path.join(DIST, "stop.bat"), stopBat, "utf-8");

console.log("\nBundle ready in dist/.");
console.log("Next: fetch portable Node and run `node scripts/build-installer.mjs`.");

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(s);
      await fs.symlink(link, d).catch(async () => {
        // Symlinks may fail on Windows; copy the resolved target instead
        const resolved = path.resolve(path.dirname(s), link);
        await fs.copyFile(resolved, d);
      });
    } else {
      await fs.copyFile(s, d);
    }
  }
}
