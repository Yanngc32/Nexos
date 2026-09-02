import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadEvent } from "@nexo/shared";
import { ensureHome, threadPath } from "./home.ts";
import { assertSlug, newThreadId } from "./ids.ts";
import { getProfile } from "./profiles.ts";

function nowIso(): string {
  return new Date().toISOString();
}

export type CreatedThread = { id: string };

export function createThread(
  input: { projectPath: string; profileId: string; title?: string },
  home: string,
): CreatedThread {
  ensureHome(home);
  const profile = getProfile(input.profileId, home);
  if (!profile) throw new Error(`perfil não existe: ${input.profileId}`);
  const id = newThreadId();
  const meta: ThreadEvent = {
    ts: nowIso(),
    type: "thread_meta",
    threadId: id,
    projectPath: input.projectPath,
    profileId: input.profileId,
    ...(input.title ? { title: input.title } : {}),
  };
  appendEvent(meta, home);
  return { id };
}

export function appendEvent(event: ThreadEvent, home: string): void {
  const path = threadPath(event.threadId, home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function readThread(id: string, home: string): ThreadEvent[] {
  assertSlug(id);
  const path = threadPath(id, home);
  if (!existsSync(path)) throw new Error(`thread não existe: ${id}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ThreadEvent);
}

export function listThreads(projectPath: string, home: string): { id: string; projectPath: string; profileId: string }[] {
  ensureHome(home);
  const threadsDir = dirname(threadPath("placeholder", home));
  if (!existsSync(threadsDir)) return [];
  const out: { id: string; projectPath: string; profileId: string }[] = [];
  for (const file of readdirSync(threadsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const id = file.slice(0, -".jsonl".length);
    const events = readThread(id, home);
    const meta = events.find((e) => e.type === "thread_meta");
    if (!meta || meta.type !== "thread_meta") continue;
    if (meta.projectPath !== projectPath) continue;
    out.push({ id, projectPath: meta.projectPath, profileId: activeProfileId(events) });
  }
  return out;
}

export function activeProfileId(events: ThreadEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "switched") return e.toProfileId;
    if (e?.type === "thread_meta") return e.profileId;
  }
  throw new Error("thread sem profileId");
}
