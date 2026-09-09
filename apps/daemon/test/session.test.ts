import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { addProfile, engineEnv, getProfile, markReady, rememberContextWindow } from "../src/profiles.ts";
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
import { janelaDaConta, modeloDoMotor } from "../src/session.ts";
import { StubEngine } from "../src/engines/stub.ts";
import type { Profile, ThreadEvent } from "@nexo/shared";

const ts0 = "2026-01-01T00:00:00.000Z";
import { saveAgent } from "../src/agents.ts";
import { memoriaPath } from "../src/memoria.ts";
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

  it("segunda mensagem na MESMA conta manda pack com a primeira e a resposta dela (regressão: motor não guarda conversa entre sends)", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "primeira", home);
    await postMessage(t.id, "segunda", home);
    const pack = (getLive(t.id)?.engine as StubEngine).lastStart?.contextPack ?? "";
    expect(pack).toContain("User: primeira");
    expect(pack).toContain("Assistant: echo:primeira");
    expect(pack).toContain("User: segunda");
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
      // o fixture do stub espelha o CLI real: nome sem sufixo de janela
      expect(totals.model).toBe("claude-sonnet-5");
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
    expect(engine.lastStart?.contextPack).toContain("# Agente: Revisor\nsó português");
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

  it("módulo caveman ligado injeta a diretiva no nível configurado, antes do agente", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    saveConfig(home, {
      modulos: { rtk: false, caveman: true, cavemanNivel: "ultra", grafoAuto: false, grafoAutoProfileId: "" },
    });
    saveAgent({ id: "rev", name: "Revisor", profileId: "p1", instructions: "só português" }, home);
    const t = createThread({ projectPath: "/proj-caveman", profileId: "p1", agentId: "rev" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    const pack = engine.lastStart?.contextPack ?? "";
    expect(pack).toContain("intensidade `ultra`");
    expect(pack.indexOf("# Módulo: Caveman")).toBeLessThan(pack.indexOf("# Agente: Revisor"));
  });

  it("módulo caveman desligado (padrão) não injeta nada", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj-sem-caveman", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).not.toContain("Caveman");
  });

  it("grafo construído: injeta o lembrete de usar nexo_grafo_perguntar antes de grepar", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const projeto = tempHome();
    mkdirSync(join(projeto, "graphify-out"), { recursive: true });
    writeFileSync(join(projeto, "graphify-out", "graph.json"), "{}", "utf8");
    const t = createThread({ projectPath: projeto, profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).toContain("nexo_grafo_perguntar");
  });

  it("sem grafo construído: não injeta o lembrete", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: tempHome(), profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).not.toContain("nexo_grafo_perguntar");
  });

  it("evento tool grava id+input, e tool_result grava separado com o mesmo id", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "TOOLRESULT", home);
    const events = readThread(t.id, home);
    const tool = events.find((e) => e.type === "tool");
    const result = events.find((e) => e.type === "tool_result");
    expect(tool && tool.type === "tool" ? tool.id : undefined).toBe("toolu_1");
    expect(tool && tool.type === "tool" ? tool.input : undefined).toEqual({ file_path: "a.ts" });
    expect(result && result.type === "tool_result" ? result.id : undefined).toBe("toolu_1");
    expect(result && result.type === "tool_result" ? result.result : undefined).toBe("conteúdo do arquivo");
  });

  it("input de tool com string longa é truncado antes de gravar (não incha o histórico pra sempre)", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "TOOLBIGINPUT", home);
    const tool = readThread(t.id, home).find((e) => e.type === "tool");
    const conteudo = tool && tool.type === "tool" ? (tool.input as { content?: string } | undefined)?.content : undefined;
    expect(conteudo?.length).toBeLessThanOrEqual(2001);
    expect(conteudo?.endsWith("…")).toBe(true);
  });

  it("MEMORIA.md do projeto abre o pack de QUALQUER conversa dele, mesmo sem agente", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    writeFileSync(memoriaPath("/proj-com-memoria", home), "usa RTK pra CLI", "utf8");
    const t = createThread({ projectPath: "/proj-com-memoria", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).toContain("# Memória do projeto\nusa RTK pra CLI");
  });

  it("agente E memória juntos: instrução do agente vem primeiro, memória depois", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    saveAgent({ id: "rev", name: "Revisor", profileId: "p1", instructions: "só português" }, home);
    writeFileSync(memoriaPath("/proj-dos-dois", home), "usa RTK pra CLI", "utf8");
    const t = createThread({ projectPath: "/proj-dos-dois", profileId: "p1", agentId: "rev" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    const pack = engine.lastStart?.contextPack ?? "";
    expect(pack.indexOf("# Agente: Revisor")).toBeLessThan(pack.indexOf("# Memória do projeto"));
  });

  it("MEMORIA.md atualizado pelo hook entre commit e commit vale já na próxima mensagem, sem trocar de conta", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj-vivo", profileId: "p1" }, home);
    await postMessage(t.id, "primeira", home);
    writeFileSync(memoriaPath("/proj-vivo", home), "fato novo", "utf8");
    await postMessage(t.id, "segunda", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).toContain("fato novo");
  });

  it("clearThread numa thread inexistente lança", async () => {
    await expect(clearThread("nao-existe", tempHome())).rejects.toThrow(/não existe/);
  });
});

/*
 * O teto do pack sai da janela do modelo, e a janela sai do NOME dele
 * (`contextWindowOf`). Quem escolhe o nome é isto — e é a única parte com
 * decisão de verdade, já que o motor de CLI não sobe em teste.
 */
describe("modeloDoMotor", () => {
  const perfil = (over = {}) => ({ id: "p", engine: "claude", createdAt: ts0, status: "ready", ...over }) as Profile;
  const uso = (model?: string) =>
    ({ ts: ts0, type: "usage", threadId: "t", input: 1, output: 1, cacheRead: 0, cacheCreate: 0, contextTokens: 2, ...(model ? { model } : {}) }) as ThreadEvent;

  it("o que já rodou na conversa ganha: o CLI é quem sabe o sufixo de janela", () => {
    const home = tempHome();
    const eventos = [uso("claude-opus-5[1m]")];
    expect(modeloDoMotor(perfil({ model: "sonnet" }), eventos, undefined, home)).toBe("claude-opus-5[1m]");
  });

  it("o ÚLTIMO turno ganha: trocar de conta no meio pode trocar o modelo", () => {
    const home = tempHome();
    const eventos = [uso("claude-sonnet-5"), uso("claude-opus-5[1m]")];
    expect(modeloDoMotor(perfil(), eventos, undefined, home)).toBe("claude-opus-5[1m]");
  });

  it("antes do primeiro turno vale o que a conta declara", () => {
    const home = tempHome();
    expect(modeloDoMotor(perfil({ model: "opus" }), [], undefined, home)).toBe("opus");
  });

  it("o modelo do agente vence o da conta, como em todo o resto", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    saveAgent({ id: "ag", name: "Ag", profileId: "p1", model: "haiku" }, home);
    expect(modeloDoMotor(perfil({ model: "opus" }), [], "ag", home)).toBe("haiku");
  });

  it("sem modelo em lugar nenhum é vazio, e o teto cai no piso", () => {
    const home = tempHome();
    expect(modeloDoMotor(perfil(), [uso()], undefined, home)).toBe("");
  });

  it("motor que não é claude não chuta janela: o sufixo [1m] é convenção do CLI dele", () => {
    const home = tempHome();
    for (const engine of ["stub", "codex", "api"] as const) {
      expect(modeloDoMotor(perfil({ engine, model: "opus" }), [uso("x[1m]")], undefined, home)).toBe("");
    }
  });
});

describe("janela da sessão", () => {
  it("a janela REPORTADA ganha da deduzida do nome, mesmo chegando antes", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    // o fixture USAGE manda window(980k) antes de session(model sem sufixo = 200k)
    await postMessage(t.id, "USAGE", home);
    expect(getLive(t.id)?.session?.contextWindow).toBe(980_000);
    expect(getLive(t.id)?.session?.model).toBe("claude-sonnet-5");
  });

  it("o evento window sai pro cliente: é o medidor de contexto da tela", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    const vistos: number[] = [];
    const onEv = (ev: { type: string; contextWindow?: number }) => {
      if (ev.type === "window" && ev.contextWindow) vistos.push(ev.contextWindow);
    };
    sessionBus.on(t.id, onEv);
    await postMessage(t.id, "USAGE", home);
    sessionBus.off(t.id, onEv);
    expect(vistos).toEqual([980_000]);
  });

  /*
   * A gravação, ponta a ponta pelo stub — que é o caminho que importa, porque a
   * janela e o nome do modelo chegam em LINHAS DIFERENTES do stream (o fixture
   * repete a ordem do CLI real: window antes de session) e a gravação só é
   * possível quando os dois já chegaram.
   */
  it("grava a janela reportada no perfil, sob a chave do modelo que rodou", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    expect(getProfile("p1", home)?.contextWindows).toBeUndefined();

    await postMessage(t.id, "USAGE", home);

    // 980k é o que o stream reportou; 200k era o palpite do nome, que perde
    expect(getProfile("p1", home)?.contextWindows).toEqual({ "claude-sonnet-5": 980_000 });
  });
});

/*
 * A precedência das fontes da janela. Isto existe porque o número gravado é o
 * que impede o PRIMEIRO turno depois de cada subida do daemon de voltar ao
 * palpite pelo nome — que subestimava em 5× (200k contra 980k reais) e fazia a
 * compactação disparar antes da hora.
 *
 * Testada direto, e não pelo stub, por dois motivos: o `windowByProfile` é do
 * módulo e não zera entre casos (não há como simular "daemon subiu de novo"), e
 * o motor `stub` não chuta janela nenhuma — só `claude` tem a convenção do
 * sufixo. Os ids aqui são distintos dos usados acima justamente pra não pegarem
 * carona no mapa em memória.
 */
describe("janelaDaConta: de onde vem o número", () => {
  const eventos = (model?: string) =>
    [
      {
        ts: ts0,
        type: "usage",
        threadId: "t",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheCreate: 0,
        contextTokens: 2,
        ...(model ? { model } : {}),
      },
    ] as ThreadEvent[];

  it("sem nada gravado, cai no palpite pelo nome", () => {
    const home = tempHome();
    const p = addProfile({ id: "jc-1", engine: "claude" }, home, { skipBinCheck: true });
    expect(janelaDaConta(p, eventos("claude-sonnet-5"), undefined, home)).toBe(200_000);
  });

  it("o gravado ganha do palpite: é ele que sobrevive à subida do daemon", () => {
    const home = tempHome();
    addProfile({ id: "jc-2", engine: "claude" }, home, { skipBinCheck: true });
    rememberContextWindow("jc-2", home, "claude-sonnet-5", 980_000);
    const p = getProfile("jc-2", home)!;
    expect(janelaDaConta(p, eventos("claude-sonnet-5"), undefined, home)).toBe(980_000);
  });

  it("é por MODELO: trocar de modelo não herda o número do antigo", () => {
    const home = tempHome();
    addProfile({ id: "jc-3", engine: "claude" }, home, { skipBinCheck: true });
    rememberContextWindow("jc-3", home, "claude-sonnet-5", 980_000);
    const p = getProfile("jc-3", home)!;
    // outro modelo, sem sufixo [1m]: volta ao palpite em vez de reusar 980k
    expect(janelaDaConta(p, eventos("claude-opus-5"), undefined, home)).toBe(200_000);
  });

  it("sem modelo conhecido devolve 0, e aí o teto cai no piso", () => {
    const home = tempHome();
    const p = addProfile({ id: "jc-4", engine: "claude" }, home, { skipBinCheck: true });
    expect(janelaDaConta(p, eventos(), undefined, home)).toBe(0);
  });
});
