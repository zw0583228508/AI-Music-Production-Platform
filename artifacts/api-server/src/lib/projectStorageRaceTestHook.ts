import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type ProjectStorageRaceGate =
  | "export-reclaim"
  | "project-delete"
  | "source-upload-write";

export type ProjectStorageRaceEvent =
  | "project-delete-requested"
  | "source-upload-requested";

function hookDirectory(): string | null {
  if (process.env.NODE_ENV !== "test") return null;
  return process.env.TEST_PROJECT_STORAGE_RACE_DIR ?? null;
}

function safeSubject(subject: string): string {
  return subject.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hookPath(
  kind: "event" | "gate",
  name: string,
  subject: string,
  suffix = "",
): string | null {
  const directory = hookDirectory();
  if (!directory) return null;
  return join(
    directory,
    `${kind}-${name}-${safeSubject(subject)}${suffix}`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function signalProjectStorageRaceEvent(
  event: ProjectStorageRaceEvent,
  subject: string,
): Promise<void> {
  const path = hookPath("event", event, subject);
  if (path) await writeFile(path, "");
}

export async function waitForProjectStorageRaceGate(
  gate: ProjectStorageRaceGate,
  subject: string,
): Promise<void> {
  const enabledPath = hookPath("gate", gate, subject, ".enabled");
  const enteredPath = hookPath("gate", gate, subject, ".entered");
  const releasePath = hookPath("gate", gate, subject, ".release");
  if (
    !enabledPath ||
    !enteredPath ||
    !releasePath ||
    !await exists(enabledPath)
  ) {
    return;
  }

  await writeFile(enteredPath, "");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await exists(releasePath)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting to release ${gate} test gate`);
}