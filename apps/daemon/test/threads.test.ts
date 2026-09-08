import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createThread, appendEvent, readThread, listThreads, removeThread } from "../src/threads.ts";
import { addProfile } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

describe("threads", () => {
  it("grava meta e recarrega igual", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    appendEvent({ ts: "2026-01-01T00:00:00.000Z", type: "user", threadId: t.id, text: "oi" }, home);
    const events = readThread(t.id, home);
    expect(events[0]?.type).toBe("thread_meta");
    expect(events[1]?.type).toBe("user");
    expect(listThreads("/proj", home)).toHaveLength(1);
  });

  it("append é visível depois de reload", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    appendEvent({ ts: "t", type: "assistant", threadId: t.id, text: "resp" }, home);
    expect(readThread(t.id, home).at(-1)).toMatchObject({ type: "assistant", text: "resp" });
  });

  it("removeThread apaga o jsonl", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    removeThread(t.id, home);
    expect(listThreads("/proj", home)).toHaveLength(0);
  });

  it("threadId com .. não escreve fora do home", () => {
    const home = tempHome();
    const fora = join(home, "..", "escapou.jsonl");
    expect(() =>
      appendEvent({ ts: "t", type: "user", threadId: "../escapou", text: "x" }, home),
    ).toThrow(/slug inválido/);
    expect(existsSync(fora)).toBe(false);
  });
});
