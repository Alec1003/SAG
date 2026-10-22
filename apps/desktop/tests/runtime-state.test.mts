import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStableApiPort, resolveStableWebPort } from "../src/runtime-state.ts";

test("reuses the persisted web port when the preferred port becomes free later", async (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sag-runtime-state-"));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const stateFile = path.join(userDataDir, "desktop-runtime.json");
  const secretKey = "s".repeat(96);
  writeFileSync(stateFile, JSON.stringify({ secretKey }));

  const firstPort = await resolveStableWebPort(
    userDataDir,
    32100,
    async (port) => port === 32101,
  );
  assert.equal(firstPort, 32101);

  const checkedOnRestart: number[] = [];
  const secondPort = await resolveStableWebPort(
    userDataDir,
    32100,
    async (port) => {
      checkedOnRestart.push(port);
      return true;
    },
  );

  assert.equal(secondPort, 32101);
  assert.deepEqual(checkedOnRestart, [32101]);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    secretKey,
    webPort: 32101,
  });
});

test("waits for a transiently-busy persisted port to free instead of drifting", async (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sag-runtime-state-"));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const stateFile = path.join(userDataDir, "desktop-runtime.json");
  const secretKey = "s".repeat(96);
  writeFileSync(stateFile, JSON.stringify({ secretKey, webPort: 32100 }));

  // The prior instance still holds the socket for the first two checks, then
  // releases it (the common quit->relaunch race).
  let checks = 0;
  const sleeps: number[] = [];
  const resolved = await resolveStableWebPort(
    userDataDir,
    40000,
    async () => {
      checks += 1;
      return checks > 2;
    },
    { reusePollMs: 5, sleep: async (ms) => { sleeps.push(ms); } },
  );

  assert.equal(resolved, 32100);
  assert.equal(checks, 3);
  assert.deepEqual(sleeps, [5, 5]);
  // Origin must not drift: the persisted port is unchanged.
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    secretKey,
    webPort: 32100,
  });
});

test("fails without suggesting an ineffective port override when the persisted port stays busy", async (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sag-runtime-state-"));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const stateFile = path.join(userDataDir, "desktop-runtime.json");
  const secretKey = "s".repeat(96);
  writeFileSync(stateFile, JSON.stringify({ secretKey, webPort: 32100 }));

  await assert.rejects(
    resolveStableWebPort(
      userDataDir,
      40000,
      async () => false, // never frees
      { reuseAttempts: 2, sleep: async () => {} },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /held by another process/);
      assert.doesNotMatch(error.message, /SAG_DESKTOP_WEB_PORT/);
      return true;
    },
  );

  // No silent drift: the persisted origin is left untouched for a later retry.
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    secretKey,
    webPort: 32100,
  });
});

test("selects a nearby API port on first launch when 8000 is already taken", async (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sag-runtime-state-"));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const stateFile = path.join(userDataDir, "desktop-runtime.json");
  const secretKey = "s".repeat(96);
  writeFileSync(stateFile, JSON.stringify({ secretKey, webPort: 32100 }));

  const apiPort = await resolveStableApiPort(
    userDataDir,
    8000,
    async (port) => port === 8001,
  );

  assert.equal(apiPort, 8001);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    secretKey,
    webPort: 32100,
    apiPort: 8001,
  });
});

test("reuses the persisted API port and does not suggest SAG_DESKTOP_API_PORT", async (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sag-runtime-state-"));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const stateFile = path.join(userDataDir, "desktop-runtime.json");
  const secretKey = "s".repeat(96);
  writeFileSync(stateFile, JSON.stringify({ secretKey, webPort: 32100, apiPort: 8001 }));

  const checked: number[] = [];
  const apiPort = await resolveStableApiPort(
    userDataDir,
    8000,
    async (port) => {
      checked.push(port);
      return true;
    },
  );

  assert.equal(apiPort, 8001);
  assert.deepEqual(checked, [8001]);

  await assert.rejects(
    resolveStableApiPort(
      userDataDir,
      8000,
      async () => false,
      { reuseAttempts: 2, sleep: async () => {} },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /held by another process/);
      assert.doesNotMatch(error.message, /SAG_DESKTOP_API_PORT/);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    secretKey,
    webPort: 32100,
    apiPort: 8001,
  });
});

test("persisting the web origin keeps a previously chosen API port", async (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "sag-runtime-state-"));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const stateFile = path.join(userDataDir, "desktop-runtime.json");
  const secretKey = "s".repeat(96);
  writeFileSync(stateFile, JSON.stringify({ secretKey, apiPort: 8001 }));

  const webPort = await resolveStableWebPort(
    userDataDir,
    32100,
    async (port) => port === 32100,
  );

  assert.equal(webPort, 32100);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    secretKey,
    webPort: 32100,
    apiPort: 8001,
  });
});
