import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { addProfile, engineEnv, getProfile, markReady } from "../src/profiles.ts";
import { createThread, readThread, threadUsage } from "../src/threads.ts";
import {
  abortThread,
  agentSnapshots,
  clearThread,
  getLive,
  limitsOf,
  postMessage,
  sessionBus,
  switchThread,
} from "../src/session.ts";
import { StubEngine } from "../src/engines/stub.ts";
import { saveAgent } from "../src/agents.ts";
import { deadCred, liveCred, tempHome } from "./helpers.ts";
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

  it("usage grava o contexto do último request, não o somado do turno", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "TOOLLOOP", home);
    const usage = readThread(t.id, home).find((e) => e.type === "usage");
    expect(usage?.type === "usage" ? usage.contextTokens : undefined).toBe(90_000);
    expect(usage?.type === "usage" ? usage.cacheRead : undefined).toBe(400_000);
  });

  it("QUOTA não cria switched", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2"] });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "QUOTA", home);
    expect(readThread(t.id, home).some((e) => e.type === "switched")).toBe(false);
    expect(readThread(t.id, home).some((e) => e.type === "error")).toBe(true);
  });

  it("switchMode auto troca sozinho e reenvia o turno", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2"], switchMode: "auto" });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const seen: { type: string; toProfileId?: string; suggestedProfileId?: string }[] = [];
    const onEv = (ev: { type: string; toProfileId?: string }) => seen.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "QUOTA", home);
      const switched = readThread(t.id, home).find((e) => e.type === "switched");
      expect(switched && switched.type === "switched" ? switched.toProfileId : "").toBe("p2");
      expect(seen.some((e) => e.type === "switched" && e.toProfileId === "p2")).toBe(true);
      // sem sugestão: quem decide é o daemon, o cliente não pergunta nada
      expect(seen.some((e) => e.type === "quota" && e.suggestedProfileId)).toBe(false);
      expect(getLive(t.id)?.profileId).toBe("p2");
      expect((getLive(t.id)?.engine as StubEngine).lastSend).toBe("QUOTA");
    } finally {
      sessionBus.off(t.id, onEv);
    }
  });

  it("troca manual reenvia o turno na conta nova", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    addProfile({ id: "p3", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2", "p3"], switchMode: "manual" });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "QUOTA", home);
    // o cliente aprovou a troca: p3 responde normal e precisa receber o pedido original
    const resumed = await switchThread(t.id, { profileId: "p3", confirmed: true, reason: "quota" }, home);
    expect(resumed).toBe(true);
    const live = getLive(t.id);
    expect(live?.profileId).toBe("p3");
    expect((live?.engine as StubEngine).lastSend).toBe("QUOTA");
    const sw = readThread(t.id, home).find((e) => e.type === "switched");
    expect(sw && sw.type === "switched" ? sw.resume : true).toBeUndefined();
  });

  it("troca com resposta parcial pede continuação", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2"], switchMode: "manual" });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "PARTQUOTA", home);
    await switchThread(t.id, { profileId: "p2", confirmed: true, reason: "quota" }, home);
    const live = getLive(t.id);
    expect(live?.profileId).toBe("p2");
    expect((live?.engine as StubEngine).lastSend).toBe("Continue de onde parou.");
    const sw = readThread(t.id, home).find((e) => e.type === "switched");
    expect(sw && sw.type === "switched" ? sw.resume : false).toBe(true);
    // o parcial da conta antiga fica no histórico, não se perde na troca
    const parcial = readThread(t.id, home).filter((e) => e.type === "assistant" && e.text === "par");
    expect(parcial).toHaveLength(1);
  });

  it("troca sem turno em voo não manda nada", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const resumed = await switchThread(t.id, { profileId: "p2", confirmed: true, reason: "user" }, home);
    expect(resumed).toBe(false);
    expect((getLive(t.id)?.engine as StubEngine).lastSend).toBeUndefined();
  });

  it("switchMode denied não troca nem sugere", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2"], switchMode: "denied" });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const seen: { type: string; suggestedProfileId?: string }[] = [];
    const onEv = (ev: { type: string; suggestedProfileId?: string }) => seen.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "QUOTA", home);
      expect(readThread(t.id, home).some((e) => e.type === "switched")).toBe(false);
      const quota = seen.find((e) => e.type === "quota");
      expect(quota?.suggestedProfileId).toBeUndefined();
      expect(getLive(t.id)?.profileId).toBe("p1");
    } finally {
      sessionBus.off(t.id, onEv);
    }
  });

  it("switchMode manual sugere e espera o cliente", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2"], switchMode: "manual" });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const seen: { type: string; suggestedProfileId?: string }[] = [];
    const onEv = (ev: { type: string; suggestedProfileId?: string }) => seen.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "QUOTA", home);
      expect(seen.some((e) => e.type === "quota" && e.suggestedProfileId === "p2")).toBe(true);
      expect(readThread(t.id, home).some((e) => e.type === "switched")).toBe(false);
    } finally {
      sessionBus.off(t.id, onEv);
    }
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

  it("retry crash uma vez e grava error no JSONL", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "CRASH", home);
    const events = readThread(t.id, home);
    expect(events.filter((e) => e.type === "user")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "switched")).toBe(false);
    expect(getLive(t.id)?.retryCount).toBe(1);
  });

  it("segunda crash sugere fallback sem switch", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: ["p1", "p2"] });
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const seen: { type: string; suggestedProfileId?: string }[] = [];
    const onEv = (ev: { type: string; suggestedProfileId?: string }) => seen.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "CRASH", home);
      expect(readThread(t.id, home).some((e) => e.type === "switched")).toBe(false);
      expect(seen.some((e) => e.type === "error" && e.suggestedProfileId === "p2")).toBe(true);
    } finally {
      sessionBus.off(t.id, onEv);
    }
  });

  it("pensamento vai pro bus e não entra no JSONL", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const seen: { type: string; tokens?: number }[] = [];
    const onEv = (ev: { type: string; tokens?: number }) => seen.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "THINK", home);
      expect(seen.some((e) => e.type === "thinking" && e.tokens === 42)).toBe(true);
      expect(readThread(t.id, home).map((e) => e.type)).toEqual(["thread_meta", "user", "assistant"]);
    } finally {
      sessionBus.off(t.id, onEv);
    }
  });

  it("usage vai pro JSONL e o agregado soma", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const seen: string[] = [];
    const onEv = (ev: { type: string }) => seen.push(ev.type);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "USAGE", home);
      await postMessage(t.id, "USAGE", home);
      expect(seen).toContain("usage");
      expect(seen).toContain("limits");
      expect(seen).toContain("session");
      const totals = threadUsage(t.id, home);
      expect(totals.turns).toBe(2);
      expect(totals.cacheCreate).toBe(80548);
      expect(totals.contextTokens).toBe(40376);
      expect(totals.costUsd).toBeCloseTo(0.8, 5);
      expect(totals.model).toBe("claude-opus-5[1m]");
      // limites são da conta, não da conversa
      expect(readThread(t.id, home).some((e) => e.type === "usage")).toBe(true);
      expect(limitsOf("p1")?.fiveHour?.utilization).toBe(0.38);
    } finally {
      sessionBus.off(t.id, onEv);
    }
  });

  it("falha de credencial não retenta e rebaixa o perfil", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("c1", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(join(dir, ".credentials.json"), liveCred(), "utf8");
    process.env.NEXO_CLAUDE_BIN = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "fake-claude.mjs",
    );
    const t = createThread({ projectPath: process.cwd(), profileId: "c1" }, home);
    const seen: { type: string; detail?: string }[] = [];
    const onEv = (ev: { type: string; detail?: string }) => seen.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "AUTH", home);
      const events = readThread(t.id, home);
      expect(events.filter((e) => e.type === "user")).toHaveLength(1);
      const err = events.find((e) => e.type === "error");
      expect(err && err.type === "error" ? err.message : "").toMatch(/precisa de login/);
      expect(getProfile("c1", home)?.status).toBe("unauthenticated");
      expect(getLive(t.id)?.retryCount).toBe(0);
      expect(seen.some((e) => e.type === "auth")).toBe(true);
      expect(seen.some((e) => e.type === "error")).toBe(false);
    } finally {
      sessionBus.off(t.id, onEv);
      delete process.env.NEXO_CLAUDE_BIN;
    }
  });

  it("perfil com credencial morta recusa mensagem com 409", async () => {
    const home = tempHome();
    addProfile({ id: "c2", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("c2", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(join(dir, ".credentials.json"), deadCred(), "utf8");
    markReady("c2", home);
    const t = createThread({ projectPath: process.cwd(), profileId: "c2" }, home);
    await expect(postMessage(t.id, "oi", home)).rejects.toThrow(/credencial vencida/);
    expect(getProfile("c2", home)?.status).toBe("unauthenticated");
  });

  it("abort grava assistant parcial e não espera o fim", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const pending = postMessage(t.id, "SLOW", home);
    await new Promise((r) => setTimeout(r, 50));
    await abortThread(t.id);
    await pending;
    const assistant = readThread(t.id, home).filter((e) => e.type === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ type: "assistant", text: "par" });
  });

  it("clearThread derruba a live: a próxima mensagem manda pack sem o que veio antes", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "primeira", home);
    const before = (getLive(t.id)?.engine as StubEngine).lastStart?.contextPack ?? "";
    expect(before).toContain("primeira");

    await clearThread(t.id, home);
    expect(getLive(t.id)).toBeUndefined();
    expect(readThread(t.id, home).some((e) => e.type === "cleared")).toBe(true);

    await postMessage(t.id, "terceira", home);
    const after = (getLive(t.id)?.engine as StubEngine).lastStart?.contextPack ?? "";
    expect(after).toContain("terceira");
    expect(after).not.toContain("primeira");
  });

  it("agentSnapshots mostra o turno em voo, com conta e rabo da saída", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const pending = postMessage(t.id, "SLOW", home);
    await new Promise((r) => setTimeout(r, 50));
    const emVoo = agentSnapshots().find((a) => a.threadId === t.id);
    expect(emVoo).toMatchObject({ profileId: "p1", busy: true, tail: "par" });
    expect(emVoo?.startedAt).toBeGreaterThan(0);
    await abortThread(t.id);
    await pending;
    expect(agentSnapshots().find((a) => a.threadId === t.id)?.busy).toBe(false);
  });

  it("duas conversas trabalham ao mesmo tempo, cada uma na sua conta", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    addProfile({ id: "p2", engine: "stub" }, home);
    const a = createThread({ projectPath: "/a", profileId: "p1" }, home);
    const b = createThread({ projectPath: "/b", profileId: "p2" }, home);
    const pa = postMessage(a.id, "SLOW", home);
    const pb = postMessage(b.id, "SLOW", home);
    await new Promise((r) => setTimeout(r, 50));
    const vivos = agentSnapshots().filter((x) => x.threadId === a.id || x.threadId === b.id);
    expect(vivos).toHaveLength(2);
    expect(vivos.every((x) => x.busy)).toBe(true);
    expect(new Set(vivos.map((x) => x.profileId))).toEqual(new Set(["p1", "p2"]));
    await abortThread(a.id);
    await abortThread(b.id);
    await Promise.all([pa, pb]);
  });

  it("instruções do agente abrem o context pack e o retrato diz de quem é a conversa", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    saveAgent({ id: "rev", name: "Revisor", profileId: "p1", instructions: "só português" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1", agentId: "rev" }, home);
    const pending = postMessage(t.id, "SLOW", home);
    await new Promise((r) => setTimeout(r, 50));
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack.startsWith("# Agente: Revisor\nsó português")).toBe(true);
    expect(engine.lastStart?.agentId).toBe("rev");
    expect(agentSnapshots().find((a) => a.threadId === t.id)?.agentId).toBe("rev");
    await abortThread(t.id);
    await pending;
  });

  it("conversa sem agente não ganha cabeçalho de instruções", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).not.toContain("# Agente:");
    expect(engine.lastStart?.agentId).toBeUndefined();
  });

  it("clearThread numa thread inexistente lança", async () => {
    await expect(clearThread("nao-existe", tempHome())).rejects.toThrow(/não existe/);
  });
});
