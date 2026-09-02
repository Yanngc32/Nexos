import { EventEmitter } from "node:events";
import type { EngineEvent, EngineKind, Profile, SwitchReason, ThreadEvent } from "@nexo/shared";
import { loadConfig } from "./config.ts";
import { ApiEngine } from "./engines/api.ts";
import { claudeEngine, codexEngine } from "./engines/cli.ts";
import { StubEngine } from "./engines/stub.ts";
import type { Engine } from "./engines/types.ts";
import { getProfile } from "./profiles.ts";
import { pack } from "./packer.ts";
import { assertSwitch, suggestFallback } from "./router.ts";
import { spawnCwd } from "./sandbox.ts";
import { activeProfileId, appendEvent, readThread } from "./threads.ts";

const TOKEN_CAP = 8000;
const CONTINUE = "Continue de onde parou.";

export type SessionEvent = EngineEvent & {
  threadId: string;
  suggestedProfileId?: string;
  chatOnly?: boolean;
};

type Live = {
  engine: Engine;
  profileId: string;
  assistantBuf: string;
  retryCount: number;
  pendingQuota: boolean;
  lastTerminal: "done" | "quota" | "error" | null;
};

const lives = new Map<string, Live>();
export const sessionBus = new EventEmitter();

function emit(threadId: string, ev: SessionEvent): void {
  sessionBus.emit(threadId, ev);
  sessionBus.emit("*", ev);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createEngine(profile: Profile, projectPath: string, home: string): Engine {
  const cwd = spawnCwd(projectPath);
  switch (profile.engine) {
    case "stub":
      return new StubEngine(cwd);
    case "api":
      return new ApiEngine({ home, profileId: profile.id });
    case "claude":
      return claudeEngine(home, profile.id);
    case "codex":
      return codexEngine(home, profile.id);
  }
}

export function engineKindOf(profileId: string, home: string): EngineKind {
  const p = getProfile(profileId, home);
  if (!p) throw new Error(`perfil não existe: ${profileId}`);
  return p.engine;
}

async function ensureLive(threadId: string, home: string, profile?: Profile): Promise<Live> {
  const events = readThread(threadId, home);
  const meta = events.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") throw new Error("thread sem meta");
  const profileId = profile?.id ?? activeProfileId(events);
  const p = profile ?? getProfile(profileId, home);
  if (!p) throw new Error(`perfil não existe: ${profileId}`);
  if (p.status !== "ready") {
    const err = new Error("perfil unauthenticated — rode nexo login");
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  const existing = lives.get(threadId);
  if (existing && existing.profileId === p.id) return existing;

  const packed = pack(events, loadConfig(home).pack, TOKEN_CAP);
  if (packed.trimmed) {
    appendEvent(
      {
        ts: nowIso(),
        type: "context_trimmed",
        threadId,
        keptMessages: packed.trimmed.keptMessages,
        droppedMessages: packed.trimmed.droppedMessages,
      },
      home,
    );
  }
  const engine = createEngine(p, meta.projectPath, home);
  const live: Live = {
    engine,
    profileId: p.id,
    assistantBuf: "",
    retryCount: 0,
    pendingQuota: false,
    lastTerminal: null,
  };
  lives.set(threadId, live);
  await engine.start(
    { threadId, projectPath: meta.projectPath, profileId: p.id, contextPack: packed.text },
    (ev) => onEngineEvent(threadId, home, ev),
  );
  return live;
}

function onEngineEvent(threadId: string, home: string, ev: EngineEvent): void {
  const live = lives.get(threadId);
  if (!live) return;
  if (ev.type === "text") {
    live.assistantBuf += ev.text;
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "tool") {
    appendEvent({ ts: nowIso(), type: "tool", threadId, name: ev.name, summary: ev.summary }, home);
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "done") {
    if (live.assistantBuf) {
      appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
    }
    live.assistantBuf = "";
    live.retryCount = 0;
    live.lastTerminal = "done";
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "quota") {
    live.pendingQuota = true;
    live.lastTerminal = "quota";
    const suggestedProfileId = suggestFallback(live.profileId, home);
    const suggested = suggestedProfileId ? getProfile(suggestedProfileId, home) : undefined;
    emit(threadId, {
      type: "quota",
      threadId,
      suggestedProfileId,
      chatOnly: suggested?.engine === "api",
    });
    return;
  }
  if (ev.type === "error") {
    live.lastTerminal = "error";
    emit(threadId, { ...ev, threadId });
  }
}

export async function postMessage(threadId: string, text: string, home: string): Promise<void> {
  await withLocked(threadId, async () => {
    appendEvent({ ts: nowIso(), type: "user", threadId, text }, home);
    const live = await ensureLive(threadId, home);
    await dispatch(threadId, home, live, text);
  });
}

async function waitTerminal(live: Live, ms = 30_000): Promise<void> {
  if (live.lastTerminal) return;
  const start = Date.now();
  while (!live.lastTerminal) {
    if (Date.now() - start > ms) throw new Error("engine timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function dispatch(threadId: string, home: string, live: Live, text: string): Promise<void> {
  live.lastTerminal = null;
  await live.engine.send(text);
  await waitTerminal(live);
  const after = lives.get(threadId);
  if (!after) return;
  if (after.lastTerminal === "error" && after.retryCount < 1) {
    after.retryCount += 1;
    await after.engine.abort();
    lives.delete(threadId);
    const again = await ensureLive(threadId, home);
    again.retryCount = after.retryCount;
    again.lastTerminal = null;
    await again.engine.send(text);
    await waitTerminal(again);
    if (again.lastTerminal === "error") {
      appendEvent(
        { ts: nowIso(), type: "error", threadId, message: "motor morreu", profileId: again.profileId },
        home,
      );
    }
  }
}

export async function switchThread(
  threadId: string,
  input: { profileId: string; confirmed: boolean; reason: SwitchReason },
  home: string,
): Promise<void> {
  await withLocked(threadId, async () => {
    assertSwitch(input);
    const next = getProfile(input.profileId, home);
    if (!next) throw new Error(`perfil não existe: ${input.profileId}`);
    if (next.status !== "ready") {
      const err = new Error("perfil unauthenticated");
      (err as Error & { status: number }).status = 409;
      throw err;
    }
    const events = readThread(threadId, home);
    const from = activeProfileId(events);
    const live = lives.get(threadId);
    const resume = Boolean(live?.assistantBuf);
    if (live) {
      if (live.assistantBuf) {
        appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
        live.assistantBuf = "";
      }
      await live.engine.abort();
      lives.delete(threadId);
    }
    const switched: ThreadEvent = {
      ts: nowIso(),
      type: "switched",
      threadId,
      fromProfileId: from,
      toProfileId: input.profileId,
      reason: input.reason,
      ...(resume ? { resume: true } : {}),
    };
    appendEvent(switched, home);
    const started = await ensureLive(threadId, home, next);
    if (resume) await started.engine.send(CONTINUE);
  });
}

export function getLive(threadId: string): Live | undefined {
  return lives.get(threadId);
}

async function withLocked(threadId: string, fn: () => Promise<void>): Promise<void> {
  const { withThreadLock } = await import("./lock.ts");
  await withThreadLock(threadId, fn);
}
