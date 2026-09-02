import { describe, it, expect } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { createThread, readThread } from "../src/threads.ts";
import { getLive, postMessage, switchThread } from "../src/session.ts";
import { StubEngine } from "../src/engines/stub.ts";
import { tempHome } from "./helpers.ts";
import { saveConfig } from "../src/config.ts";

describe("session", () => {
  it("grava user antes da resposta e não vaza key", () => {
    const home = tempHome();
    addProfile(
      { id: "api-1", engine: "api", api: { provider: "anthropic", model: "x" } },
      home,
      { apiKey: "sk-secret-não-vazar" },
    );
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    return postMessage(t.id, "oi", home).then(() => {
      const raw = JSON.stringify(readThread(t.id, home));
      expect(raw).not.toContain("sk-secret");
      const types = readThread(t.id, home).map((e) => e.type);
      expect(types).toEqual(["thread_meta", "user", "assistant"]);
    });
  });

  it("QUOTA não cria switched", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2"] });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "QUOTA", home);
    expect(readThread(t.id, home).some((e) => e.type === "switched")).toBe(false);
  });

  it("switch confirmed injeta pack com a user msg", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    await switchThread(t.id, { profileId: "p2", confirmed: true, reason: "user" }, home);
    const events = readThread(t.id, home);
    expect(events.some((e) => e.type === "switched")).toBe(true);
    const live = getLive(t.id);
    expect(live?.engine).toBeInstanceOf(StubEngine);
    expect((live?.engine as StubEngine).lastStart?.contextPack).toContain("User: oi");
  });

  it("switch sem confirmed throw", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await expect(
      switchThread(t.id, { profileId: "p2", confirmed: false, reason: "user" }, home),
    ).rejects.toThrow(/confirmed/);
  });
});
