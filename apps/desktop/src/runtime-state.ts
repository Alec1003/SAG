import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface RuntimeStateFile {
  secretKey: string;
  webPort?: number;
  apiPort?: number;
}

type PortAvailability = (port: number) => Promise<boolean>;
type PersistedPortField = "webPort" | "apiPort";

function runtimeStateFile(userDataDir: string): string {
  return path.join(userDataDir, "desktop-runtime.json");
}

function isValidRuntimeState(value: unknown): value is RuntimeStateFile {
  if (!value || typeof value !== "object") return false;
  return typeof (value as RuntimeStateFile).secretKey === "string"
    && (value as RuntimeStateFile).secretKey.length >= 64;
}

function readRuntimeState(userDataDir: string): RuntimeStateFile | null {
  const file = runtimeStateFile(userDataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isValidRuntimeState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeRuntimeState(userDataDir: string, state: RuntimeStateFile): void {
  writeFileSync(
    runtimeStateFile(userDataDir),
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function persistRuntimeState(userDataDir: string, patch: RuntimeStateFile): void {
  const existing = readRuntimeState(userDataDir);
  writeRuntimeState(userDataDir, {
    secretKey: patch.secretKey,
    webPort: patch.webPort ?? existing?.webPort,
    apiPort: patch.apiPort ?? existing?.apiPort,
  });
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= 65535;
}

// The persisted port is the desktop app's stable browser origin. When it is busy
// at launch it is almost always our own just-exited instance still releasing the
// socket, so poll for it to free before giving up. ~5s total (20 * 250ms) covers
// a normal shutdown/relaunch race without noticeably delaying a cold start (the
// happy path returns on the first check).
const DEFAULT_REUSE_ATTEMPTS = 20;
const DEFAULT_REUSE_POLL_MS = 250;

export interface ResolveWebPortOptions {
  /** Extra availability checks after the first before treating the port as foreign-held. */
  reuseAttempts?: number;
  /** Delay between reuse attempts, in milliseconds. */
  reusePollMs?: number;
  /** Injectable sleep so tests stay fast and deterministic. */
  sleep?: (ms: number) => Promise<void>;
}

export type ResolveApiPortOptions = ResolveWebPortOptions;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reclaimPersistedPort(
  port: number,
  isAvailable: PortAvailability,
  attempts: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    if (await isAvailable(port)) return true;
    if (attempt >= attempts) return false;
    await sleep(pollMs);
  }
}

export function loadOrCreateRuntimeSecret(userDataDir: string): string {
  const existing = readRuntimeState(userDataDir);
  if (existing) return existing.secretKey;
  const secretKey = randomBytes(48).toString("hex");
  writeRuntimeState(userDataDir, { secretKey });
  return secretKey;
}

async function resolveStableRecordedPort(
  userDataDir: string,
  field: PersistedPortField,
  preferredPort: number,
  isAvailable: PortAvailability,
  options: ResolveWebPortOptions,
  heldError: (port: number) => Error,
  exhaustedError: (preferred: number) => Error,
): Promise<number> {
  const {
    reuseAttempts = DEFAULT_REUSE_ATTEMPTS,
    reusePollMs = DEFAULT_REUSE_POLL_MS,
    sleep = delay,
  } = options;
  const existing = readRuntimeState(userDataDir);
  const persisted = existing?.[field];
  if (isValidPort(persisted)) {
    if (
      await reclaimPersistedPort(
        persisted,
        isAvailable,
        reuseAttempts,
        reusePollMs,
        sleep,
      )
    ) {
      return persisted;
    }
    throw heldError(persisted);
  }

  for (
    let port = preferredPort;
    port < Math.min(65535, preferredPort + 100);
    port += 1
  ) {
    if (!(await isAvailable(port))) continue;
    const secretKey = existing?.secretKey ?? loadOrCreateRuntimeSecret(userDataDir);
    persistRuntimeState(userDataDir, { secretKey, [field]: port });
    return port;
  }
  throw exhaustedError(preferredPort);
}

export async function resolveStableWebPort(
  userDataDir: string,
  preferredPort: number,
  isAvailable: PortAvailability,
  options: ResolveWebPortOptions = {},
): Promise<number> {
  return resolveStableRecordedPort(
    userDataDir,
    "webPort",
    preferredPort,
    isAvailable,
    options,
    (port) => new Error(
      `Persisted desktop web port ${port} is held by another process. `
      + "Close whatever is using it and relaunch SAG.",
    ),
    (preferred) => new Error(`No available local port found near ${preferred}`),
  );
}

export async function resolveStableApiPort(
  userDataDir: string,
  preferredPort: number,
  isAvailable: PortAvailability,
  options: ResolveApiPortOptions = {},
): Promise<number> {
  return resolveStableRecordedPort(
    userDataDir,
    "apiPort",
    preferredPort,
    isAvailable,
    options,
    (port) => new Error(
      `Persisted desktop API port ${port} is held by another process. `
      + "Close whatever is using it and relaunch SAG.",
    ),
    (preferred) => new Error(
      `No available local API port found near ${preferred}. `
      + "Close the conflicting service and relaunch SAG.",
    ),
  );
}
