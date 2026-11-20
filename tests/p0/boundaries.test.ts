import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("clients only depend on the SDK and contracts", () => {
  for (const file of [
    "apps/cli/package.json",
    "apps/desktop/package.json",
    "apps/mobile/package.json",
    "packages/sdk/package.json",
  ]) {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.equal(deps["@pa/runtime"], undefined);
    assert.equal(deps["@pa/persistence"], undefined);
    assert.equal(deps["better-sqlite3"], undefined);
    assert.equal(deps["@langchain/openai"], undefined);
  }
});

test("desktop preload keeps the renderer isolated", () => {
  const main = fs.readFileSync("apps/desktop/src/main/main.ts", "utf8");
  const preload = fs.readFileSync("apps/desktop/src/main/preload.ts", "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(preload, /contextBridge/);
  assert.doesNotMatch(
    fs.readFileSync("apps/desktop/src/renderer/App.tsx", "utf8"),
    /localStorage/,
  );
});
