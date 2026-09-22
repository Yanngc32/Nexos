import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, vi } from "vitest";
import { saveTypesafeApiKey } from "../src/typesafe.ts";
import { addProfile, engineEnv, getProfile, markReady, rememberContextWindow, updateProfile } from "../src/profiles.ts";
import { activeAgentId, createThread, readThread, threadUsage } from "../src/threads.ts";
import { lerSessaoClaude } from "../src/claude-session.ts";
import {
  abortThread,
  agentSnapshots,
  busyThreads,
  clearThread,
  getLive,
  limitsOf,
  perfilEmUso,
  pingUsoDeTodasAsContas,
  postMessage,
  retomarTurnoPendente,
  sessionBus,
  switchThread,
} from "../src/session.ts";
import { janelaDaConta, modeloDoMotor } from "../src/session.ts";
import { StubEngine } from "../src/engines/stub.ts";
import type { Profile, ThreadEvent } from "@nexos/shared";

const ts0 = "2026-01-01T00:00:00.000Z";
import { saveAgent } from "../src/agents.ts";
import { globalMemoriaPath, memoriaPath } from "../src/memoria.ts";
import { construirIndice } from "../src/repo-map-indice.ts";
import { deadCred, liveCred, tempHome } from "./helpers.ts";
import { loadConfig, saveConfig } from "../src/config.ts";

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
    process.env.NEXOS_CLAUDE_BIN = join(
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
      delete process.env.NEXOS_CLAUDE_BIN;
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

  it("turno que fecha em auth para de contar como ocupado, mas segue retomável", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    await postMessage(t.id, "AUTH", home);

    // O `pendingTurn` sobrevive de propósito — é dele que a troca de conta tira o texto
    // pra reenviar. Só o indicador de atividade é que não pode ficar aceso por causa dele.
    expect(getLive(t.id)?.pendingTurn).not.toBeNull();
    expect(getLive(t.id)?.lastTerminal).toBe("auth");
    expect(agentSnapshots().find((a) => a.threadId === t.id)?.busy).toBe(false);
    expect(busyThreads()).not.toContain(t.id);
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
      modulos: {
        rtk: false,
        caveman: true,
        cavemanNivel: "ultra",
        repoMapResumos: false,
        repoMapProfileId: "",
        quadroTarefas: true,
        coletaDesign: true,
      },
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

  it("quadro de tarefas ligado por padrão injeta o bloco", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj-quadro", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).toContain("# Quadro de tarefas");
    expect(engine.lastStart?.contextPack).toContain("MAIS DE UM pedido");
    expect(engine.lastStart?.contextPack).toContain("UM card por pedido");
    expect(engine.lastStart?.contextPack).not.toContain("Antes de começar qualquer trabalho");
  });

  it("quadro de tarefas desligado não injeta o bloco", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    saveConfig(home, { modulos: { ...loadConfig(home).modulos, quadroTarefas: false } });
    const t = createThread({ projectPath: "/proj-sem-quadro", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).not.toContain("# Quadro de tarefas");
  });

  it("sessionId do motor grava no live, no disco, e /clear apaga", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj-sessao", profileId: "p1" }, home);
    await postMessage(t.id, "SESSIONID", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastResume).toBe("stub-session-01");
    expect(lerSessaoClaude(t.id, home)).toEqual({ profileId: "p1", sessionId: "stub-session-01" });
    await clearThread(t.id, home);
    expect(lerSessaoClaude(t.id, home)).toBeUndefined();
  });

  it("índice do repo map construído: injeta a árvore e o lembrete de usar nexo_mapa_simbolos", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const projeto = tempHome();
    construirIndice(projeto, home);
    const t = createThread({ projectPath: projeto, profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).toContain("nexo_mapa_simbolos");
  });

  it("sem índice construído: não injeta o lembrete", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: tempHome(), profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.contextPack).not.toContain("nexo_mapa_simbolos");
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

  it("conversa sem projeto roda o turno normal, com cwd de fallback (chat geral)", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    expect(engine.lastStart?.projectPath).toBeUndefined();
    const types = readThread(t.id, home).map((e) => e.type);
    expect(types).toEqual(["thread_meta", "user", "assistant"]);
  });

  it("conversa sem projeto lê MEMORIA.md global, com o rótulo 'Memória geral', sem repo map", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    writeFileSync(globalMemoriaPath(home), "fato global", "utf8");
    const t = createThread({ profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const engine = getLive(t.id)?.engine as StubEngine;
    const pack = engine.lastStart?.contextPack ?? "";
    expect(pack).toContain("# Memória geral\nfato global");
    expect(pack).not.toContain("Repo map");
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

describe("pingUsoDeTodasAsContas", () => {
  it("ignora contas api/stub e conta claude sem login — não trava, não tenta pingar", async () => {
    const home = tempHome();
    addProfile({ id: "s1", engine: "stub" }, home);
    addProfile(
      { id: "a1", engine: "api", api: { provider: "anthropic", model: "x" } },
      home,
      { apiKey: "sk-x" },
    );
    addProfile({ id: "c-sem-login", engine: "claude" }, home, { skipBinCheck: true });
    await expect(pingUsoDeTodasAsContas(home)).resolves.toBeUndefined();
    expect(limitsOf("s1")).toBeUndefined();
    expect(limitsOf("a1")).toBeUndefined();
    expect(limitsOf("c-sem-login")).toBeUndefined();
  });

  it("conta codex NUNCA é pingada — o turno seria cobrado esperando um `limits` que não existe", async () => {
    /*
     * `parse-codex.ts` não emite `limits` (o `codex exec --json` não reporta
     * janela de uso), então pingar conta codex gastava um turno de verdade por
     * conta a cada 30 minutos pra sempre receber nada. O binário sentinela
     * abaixo grava um arquivo se for chamado: se ele existir no fim, voltamos a
     * queimar quota à toa.
     */
    const home = tempHome();
    addProfile({ id: "cx-ping", engine: "codex" }, home, { skipBinCheck: true });
    // credencial viva de verdade (`auth.json` no CODEX_HOME do perfil): sem ela o
    // motor recusa antes de spawnar, e o teste passaria sem provar nada
    const codexHome = engineEnv(getProfile("cx-ping", home)!, home).CODEX_HOME!;
    writeFileSync(join(codexHome, "auth.json"), liveCred(), "utf8");
    markReady("cx-ping", home);
    const marca = join(home, "pingou-codex");
    const sentinela = join(home, "sentinela.mjs");
    // shebang + bit de execução: sem os dois o spawn falha calado e o teste
    // passaria por não ter rodado nada — que é o oposto do que ele afirma
    writeFileSync(
      sentinela,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marca)}, "1");\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    process.env.NEXOS_CODEX_BIN = sentinela;
    try {
      await pingUsoDeTodasAsContas(home);
      expect(existsSync(marca), "o motor codex não pode nem ser iniciado").toBe(false);
    } finally {
      delete process.env.NEXOS_CODEX_BIN;
    }
  }, 10_000);

  it("conta claude com credencial válida é pingada num motor descartável (sem gravar thread)", async () => {
    const home = tempHome();
    addProfile({ id: "c-ping", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("c-ping", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(join(dir, ".credentials.json"), liveCred(), "utf8");
    process.env.NEXOS_CLAUDE_BIN = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
    try {
      await pingUsoDeTodasAsContas(home);
      // a fixture não emite `limits`, então o ponto aqui é: terminou sozinho (não travou até o
      // timeout de 60s) e a conta virou "ready" pelo mesmo caminho de uma conversa de verdade.
      expect(getProfile("c-ping", home)?.status).toBe("ready");
    } finally {
      delete process.env.NEXOS_CLAUDE_BIN;
    }
  }, 10_000);
});

describe("perfilEmUso", () => {
  it("false antes de qualquer conversa abrir; true depois que uma conversa abriu (mesmo turno já ocioso)", async () => {
    const home = tempHome();
    // id exclusivo desta suíte: `lives` é estado de módulo, compartilhado entre os testes deste
    // arquivo — reusar "p1" pegaria carona na conversa aberta por outro teste.
    addProfile({ id: "peu-1", engine: "stub" }, home);
    expect(perfilEmUso("peu-1")).toBe(false);
    const t = createThread({ projectPath: "/proj", profileId: "peu-1" }, home);
    await postMessage(t.id, "oi", home);
    expect(perfilEmUso("peu-1")).toBe(true);
    expect(perfilEmUso("outro-perfil-qualquer")).toBe(false);
  });
});

describe("postMessage: roteamento por typesafe.ai", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Esforço vem de um Score (escala ordenada): índice em CLAUDE_EFFORT_LEVELS. */
  function respostaEsforco(nivel: number, confidence = 0.9) {
    return new Response(
      JSON.stringify({
        model: "jev-1.0",
        answers: {
          which_effort: { type: "score", score: nivel, confidence, legend: {}, probabilities: { [nivel]: confidence } },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function respostaModeloEsforco(model: string, nivel: number, confidence = 0.9) {
    return new Response(
      JSON.stringify({
        model: "jev-1.0",
        answers: {
          which_model: { type: "choice", choice: model, confidence, probabilities: { [model]: confidence } },
          which_effort: { type: "score", score: nivel, confidence, legend: {}, probabilities: { [nivel]: confidence } },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function respostaModelo(choice: string, confidence = 0.9) {
    return new Response(
      JSON.stringify({
        model: "jev-1.0",
        answers: {
          which_model: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function respostaFake(choice: string, confidence = 0.9) {
    return new Response(
      JSON.stringify({
        model: "jev-1.0",
        answers: {
          which_agent: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("modo desligado (padrão): nunca chama a API, thread segue sem agente", async () => {
    const home = tempHome();
    addProfile({ id: "rot-1", engine: "stub" }, home);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = createThread({ projectPath: "/proj", profileId: "rot-1" }, home);
    await postMessage(t.id, "revisa esse PR", home);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readThread(t.id, home).some((e) => e.type === "roteamento")).toBe(false);
  });

  it("thread com agentId explícito na criação: nunca roteia, mesmo em modo automatico", async () => {
    const home = tempHome();
    addProfile({ id: "rot-2", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-2" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const t = createThread({ projectPath: "/proj", profileId: "rot-2", agentId: "revisor" }, home);
    await postMessage(t.id, "oi", home);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("modo automatico + escolha de agente: atribui e marca aplicado", async () => {
    const home = tempHome();
    addProfile({ id: "rot-3", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-3", description: "Revisa PRs" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor")));
    const t = createThread({ projectPath: "/proj", profileId: "rot-3" }, home);
    await postMessage(t.id, "revisa esse PR", home);

    const events = readThread(t.id, home);
    const roteamento = events.find((e) => e.type === "roteamento");
    expect(roteamento).toMatchObject({ tipo: "agente", alvo: "revisor", aplicado: true });
    expect(events.find((e) => e.type === "agent_assigned")).toMatchObject({ agentId: "revisor" });
  });

  it("modo perguntar + escolha de agente: só sugere, não atribui, e SEGURA o turno", async () => {
    const home = tempHome();
    addProfile({ id: "rot-4", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-4" }, home);
    saveConfig(home, { typesafe: { modo: "perguntar" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor")));
    const t = createThread({ projectPath: "/proj", profileId: "rot-4" }, home);
    await postMessage(t.id, "revisa esse PR", home);

    const events = readThread(t.id, home);
    expect(events.find((e) => e.type === "roteamento")).toMatchObject({ tipo: "agente", aplicado: false });
    expect(events.some((e) => e.type === "agent_assigned")).toBe(false);
    // O turno NÃO pode ter rodado: responder antes de decidir sairia do agente errado.
    expect(events.some((e) => e.type === "assistant")).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["thread_meta", "roteamento", "user"]);
  });

  it("retomarTurnoPendente despacha a mensagem que ficou parada", async () => {
    const home = tempHome();
    addProfile({ id: "rot-10", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-10" }, home);
    saveConfig(home, { typesafe: { modo: "perguntar" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor")));
    const t = createThread({ projectPath: "/proj", profileId: "rot-10" }, home);
    await postMessage(t.id, "revisa esse PR", home);
    expect(readThread(t.id, home).some((e) => e.type === "assistant")).toBe(false);

    await retomarTurnoPendente(t.id, home);
    expect(readThread(t.id, home).some((e) => e.type === "assistant")).toBe(true);
  });

  it("modo automatico aplica na hora e NÃO segura o turno", async () => {
    const home = tempHome();
    addProfile({ id: "rot-11", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-11" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor", 0.95)));
    const t = createThread({ projectPath: "/proj", profileId: "rot-11" }, home);
    await postMessage(t.id, "revisa esse PR", home);

    const events = readThread(t.id, home);
    expect(events.some((e) => e.type === "agent_assigned")).toBe(true);
    expect(events.some((e) => e.type === "assistant")).toBe(true);
  });

  it("escolha de time NUNCA aplica sozinha, mesmo em modo automatico", async () => {
    const home = tempHome();
    addProfile({ id: "rot-5", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-5" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("time:time-feature")));
    const t = createThread({ projectPath: "/proj", profileId: "rot-5" }, home);
    await postMessage(t.id, "implementa e revisa", home);

    const events = readThread(t.id, home);
    expect(events.find((e) => e.type === "roteamento")).toMatchObject({ tipo: "time", alvo: "time-feature", aplicado: false });
    expect(events.some((e) => e.type === "agent_assigned")).toBe(false);
  });

  it("avalia a cada mensagem, mas não repete atribuição de quem já está tocando", async () => {
    const home = tempHome();
    addProfile({ id: "rot-6", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-6" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const fetchMock = vi.fn(async () => respostaFake("revisor"));
    vi.stubGlobal("fetch", fetchMock);
    const t = createThread({ projectPath: "/proj", profileId: "rot-6" }, home);
    await postMessage(t.id, "revisa esse PR", home);
    await postMessage(t.id, "mais uma coisa", home);

    // Uma chamada por mensagem (é por prompt agora)...
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // ...mas a 2ª escolheu quem já estava: nada de evento novo.
    const events = readThread(t.id, home);
    expect(events.filter((e) => e.type === "agent_assigned")).toHaveLength(1);
    expect(events.filter((e) => e.type === "roteamento")).toHaveLength(1);
  });

  it("modelo automático: escolhe por complexidade e injeta como override do turno", async () => {
    const home = tempHome();
    addProfile({ id: "auto-1", engine: "stub" }, home);
    updateProfile("auto-1", home, { model: "auto" });
    saveAgent({ id: "revisor", name: "Revisor", profileId: "auto-1", model: "haiku" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    // Um agente com modelo próprio e a conta em "auto": a lista de candidatos sai daí.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        // A pergunta de modelo não leva `agente_atual`; a de roteamento leva.
        const ehModelo = body.state.agente_atual === undefined;
        return ehModelo ? respostaModelo("haiku", 0.9) : respostaFake("automatico", 0.9);
      }),
    );
    const t = createThread({ projectPath: "/proj", profileId: "auto-1" }, home);
    const vistos: { type: string; model?: string; fallback?: boolean }[] = [];
    const onEv = (ev: { type: string; model?: string }) => vistos.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "traduz essa frase", home);
    } finally {
      sessionBus.off(t.id, onEv);
    }
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toEqual({ model: "haiku" });
    expect(vistos.find((e) => e.type === "modelo_auto")).toMatchObject({ model: "haiku", fallback: false });
  });

  it("modelo automático com typesafe fora do ar: cai no fallback e avisa", async () => {
    const home = tempHome();
    addProfile({ id: "auto-2", engine: "stub" }, home);
    updateProfile("auto-2", home, { model: "auto" });
    saveAgent({ id: "revisor", name: "Revisor", profileId: "auto-2", model: "haiku" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("sem rede");
      }),
    );
    const t = createThread({ projectPath: "/proj", profileId: "auto-2" }, home);
    const vistos: { type: string; model?: string; fallback?: boolean }[] = [];
    const onEv = (ev: { type: string; model?: string }) => vistos.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "qualquer coisa", home);
    } finally {
      sessionBus.off(t.id, onEv);
    }
    // Override vazio: quem resolve o "auto" vira o fallback lá no profileFlags.
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toEqual({});
    expect(vistos.find((e) => e.type === "modelo_auto")).toMatchObject({
      model: "sonnet",
      fallback: true,
      motivo: "indisponivel",
    });
  });

  it("modelo automático com confiança baixa cai no fallback (dúvida = modelo mais capaz)", async () => {
    const home = tempHome();
    addProfile({ id: "auto-4", engine: "stub" }, home);
    updateProfile("auto-4", home, { model: "auto" });
    saveAgent({ id: "revisor", name: "Revisor", profileId: "auto-4", model: "haiku" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        const ehModelo = body.state.agente_atual === undefined;
        // Empate: escolheu o barato, mas sem convicção nenhuma.
        return ehModelo ? respostaModelo("haiku", 0.15) : respostaFake("automatico", 0.9);
      }),
    );
    const t = createThread({ projectPath: "/proj", profileId: "auto-4" }, home);
    const vistos: { type: string; model?: string; fallback?: boolean }[] = [];
    const onEv = (ev: { type: string; model?: string }) => vistos.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "por que isso quebra?", home);
    } finally {
      sessionBus.off(t.id, onEv);
    }
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toEqual({});
    expect(vistos.find((e) => e.type === "modelo_auto")).toMatchObject({
      model: "sonnet",
      fallback: true,
      motivo: "confianca-baixa",
      sugerido: "haiku",
    });
  });

  it("esforço automático: escolhe e aplica como override, independente do modelo", async () => {
    const home = tempHome();
    addProfile({ id: "esf-1", engine: "stub" }, home);
    // Modelo FIXO, esforço em auto: só a pergunta de esforço deve ser feita.
    updateProfile("esf-1", home, { model: "sonnet", effort: "auto" });
    saveAgent({ id: "revisor", name: "Revisor", profileId: "esf-1" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const corpos: { questions: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { questions: Record<string, unknown>; state: { agente_atual?: string } };
        corpos.push(body);
        if (body.state.agente_atual !== undefined) return respostaFake("automatico", 0.9);
        return respostaEsforco(2, 0.9); // high
      }),
    );
    const t = createThread({ projectPath: "/proj", profileId: "esf-1" }, home);
    const vistos: { type: string; effort?: string }[] = [];
    const onEv = (ev: { type: string; effort?: string }) => vistos.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "investiga esse deadlock", home);
    } finally {
      sessionBus.off(t.id, onEv);
    }

    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toMatchObject({ effort: "high" });
    expect(vistos.find((e) => e.type === "esforco_auto")).toMatchObject({ effort: "high", fallback: false });
    // Modelo fixo: a pergunta de modelo não foi feita.
    const daExecucao = corpos.find((b) => b.questions.which_effort);
    expect(daExecucao?.questions.which_model).toBeUndefined();
  });

  it("modelo e esforço em auto vão na MESMA chamada", async () => {
    const home = tempHome();
    addProfile({ id: "esf-2", engine: "stub" }, home);
    updateProfile("esf-2", home, { model: "auto", effort: "auto" });
    saveAgent({ id: "revisor", name: "Revisor", profileId: "esf-2", model: "haiku" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const corpos: { questions: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { questions: Record<string, unknown>; state: { agente_atual?: string } };
        corpos.push(body);
        if (body.state.agente_atual !== undefined) return respostaFake("automatico", 0.9);
        return respostaModeloEsforco("haiku", 0, 0.9); // low
      }),
    );
    const t = createThread({ projectPath: "/proj", profileId: "esf-2" }, home);
    await postMessage(t.id, "renomeia essa variável", home);

    const daExecucao = corpos.filter((b) => b.questions.which_model || b.questions.which_effort);
    // Uma chamada só, com as duas perguntas juntas.
    expect(daExecucao).toHaveLength(1);
    expect(daExecucao[0].questions.which_model).toBeDefined();
    expect(daExecucao[0].questions.which_effort).toBeDefined();
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toMatchObject({ model: "haiku", effort: "low" });
  });

  it("agente atribuído pelo roteamento NÃO rebaixa a permissão escolhida na conta", async () => {
    const home = tempHome();
    addProfile({ id: "perm-1", engine: "stub" }, home);
    updateProfile("perm-1", home, { permissionMode: "bypassPermissions" });
    // implementador declara acceptEdits — que não libera comando de shell.
    saveAgent({ id: "implementador", name: "Implementador", profileId: "perm-1", permissionMode: "acceptEdits" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("implementador", 0.95)));
    const t = createThread({ projectPath: "/proj", profileId: "perm-1" }, home);
    await postMessage(t.id, "roda o build", home);

    expect(activeAgentId(readThread(t.id, home))).toBe("implementador");
    // A escolha da pessoa continua valendo, apesar do agente atribuído sozinho.
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toMatchObject({
      permissionMode: "bypassPermissions",
    });
  });

  it("agente ESCOLHIDO na criação mantém a permissão dele (você adotou a config)", async () => {
    const home = tempHome();
    addProfile({ id: "perm-2", engine: "stub" }, home);
    updateProfile("perm-2", home, { permissionMode: "bypassPermissions" });
    saveAgent({ id: "explorador", name: "Explorador", profileId: "perm-2", permissionMode: "plan" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const fetchMock = vi.fn(async () => respostaFake("implementador", 0.95));
    vi.stubGlobal("fetch", fetchMock);
    const t = createThread({ projectPath: "/proj", profileId: "perm-2", agentId: "explorador" }, home);
    await postMessage(t.id, "oi", home);

    // Nem roteia (escolha explícita) nem sobrepõe permissão.
    expect(fetchMock).not.toHaveBeenCalled();
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toEqual({});
  });

  it("conta sem permissão definida segue usando a do agente", async () => {
    const home = tempHome();
    addProfile({ id: "perm-3", engine: "stub" }, home);
    saveAgent({ id: "implementador", name: "Implementador", profileId: "perm-3", permissionMode: "acceptEdits" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("implementador", 0.95)));
    const t = createThread({ projectPath: "/proj", profileId: "perm-3" }, home);
    await postMessage(t.id, "implementa", home);
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toEqual({});
  });

  it("conta com modelo fixo não chama escolha de modelo", async () => {
    const home = tempHome();
    addProfile({ id: "auto-3", engine: "stub" }, home);
    updateProfile("auto-3", home, { model: "opus" });
    saveAgent({ id: "revisor", name: "Revisor", profileId: "auto-3" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const fetchMock = vi.fn(async () => respostaFake("automatico", 0.9));
    vi.stubGlobal("fetch", fetchMock);
    const t = createThread({ projectPath: "/proj", profileId: "auto-3" }, home);
    await postMessage(t.id, "oi", home);
    // Só a chamada de roteamento; nenhuma de modelo.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((getLive(t.id)?.engine as StubEngine).lastOverrides).toEqual({});
  });

  it("avaliação que não muda nada não vira evento, mas AVISA pelo SSE", async () => {
    const home = tempHome();
    addProfile({ id: "rot-12", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-12" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    // Confiança abaixo do limiar: decide, mas não troca.
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor", 0.45)));
    const t = createThread({ projectPath: "/proj", profileId: "rot-12" }, home);

    const vistos: { type: string; mudou?: boolean; motivo?: string }[] = [];
    const onEv = (ev: { type: string; mudou?: boolean; motivo?: string }) => vistos.push(ev);
    sessionBus.on(t.id, onEv);
    try {
      await postMessage(t.id, "algo ambíguo", home);
    } finally {
      sessionBus.off(t.id, onEv);
    }

    // Nada gravado: histórico não leva uma linha "segue igual" por mensagem...
    expect(readThread(t.id, home).some((e) => e.type === "roteamento")).toBe(false);
    // ...mas a tela precisa saber que a avaliação (paga) aconteceu.
    const aviso = vistos.find((e) => e.type === "roteamento");
    expect(aviso).toMatchObject({ mudou: false, motivo: "abaixo-do-limiar" });
  });

  it("histerese: confiança abaixo do limiar não troca o agente", async () => {
    const home = tempHome();
    addProfile({ id: "rot-7", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-7" }, home);
    saveAgent({ id: "explorador", name: "Explorador", profileId: "rot-7" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const t = createThread({ projectPath: "/proj", profileId: "rot-7" }, home);

    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor", 0.95)));
    await postMessage(t.id, "revisa esse PR", home);
    expect(readThread(t.id, home).find((e) => e.type === "agent_assigned")).toMatchObject({ agentId: "revisor" });

    // Mensagem ambígua: aponta outro agente, mas sem convicção — mantém o atual.
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("explorador", 0.45)));
    await postMessage(t.id, "não funcionou", home);
    const events = readThread(t.id, home);
    expect(events.filter((e) => e.type === "agent_assigned")).toHaveLength(1);
    expect(activeAgentId(events)).toBe("revisor");
  });

  it("sai de agente só-leitura com confiança baixa (ficar garantiria falhar)", async () => {
    const home = tempHome();
    addProfile({ id: "rot-13", engine: "stub" }, home);
    // explorador só lê (modo plano); implementador edita.
    saveAgent({ id: "explorador", name: "Explorador", profileId: "rot-13", permissionMode: "plan" }, home);
    saveAgent({ id: "implementador", name: "Implementador", profileId: "rot-13" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const t = createThread({ projectPath: "/proj", profileId: "rot-13" }, home);

    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("explorador", 0.95)));
    await postMessage(t.id, "mapeia o código", home);
    expect(activeAgentId(readThread(t.id, home))).toBe("explorador");

    // 0.46 ficaria abaixo do limiar normal (0.70) — mas sair de quem só lê basta 0.40.
    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("implementador", 0.46)));
    await postMessage(t.id, "vamos resolver isso ai", home);
    expect(activeAgentId(readThread(t.id, home))).toBe("implementador");
  });

  it("agente que edita mantém a histerese normal (0.46 não troca)", async () => {
    const home = tempHome();
    addProfile({ id: "rot-14", engine: "stub" }, home);
    saveAgent({ id: "implementador", name: "Implementador", profileId: "rot-14" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-14" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const t = createThread({ projectPath: "/proj", profileId: "rot-14" }, home);

    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("implementador", 0.95)));
    await postMessage(t.id, "implementa isso", home);
    expect(activeAgentId(readThread(t.id, home))).toBe("implementador");

    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("revisor", 0.46)));
    await postMessage(t.id, "hmm", home);
    expect(activeAgentId(readThread(t.id, home))).toBe("implementador");
  });

  it("troca de agente no meio da conversa quando a confiança é alta", async () => {
    const home = tempHome();
    addProfile({ id: "rot-8", engine: "stub" }, home);
    saveAgent({ id: "explorador", name: "Explorador", profileId: "rot-8" }, home);
    saveAgent({ id: "implementador", name: "Implementador", profileId: "rot-8" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    const t = createThread({ projectPath: "/proj", profileId: "rot-8" }, home);

    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("explorador", 0.95)));
    await postMessage(t.id, "mapeia o código do checkout", home);
    expect(activeAgentId(readThread(t.id, home))).toBe("explorador");

    vi.stubGlobal("fetch", vi.fn(async () => respostaFake("implementador", 0.93)));
    await postMessage(t.id, "agora implementa a correção", home);
    expect(activeAgentId(readThread(t.id, home))).toBe("implementador");
  });

  it("manda o histórico e o agente atual como contexto da decisão", async () => {
    const home = tempHome();
    addProfile({ id: "rot-9", engine: "stub" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "rot-9" }, home);
    saveConfig(home, { typesafe: { modo: "automatico" } });
    saveTypesafeApiKey("k", home);
    type EstadoEnviado = {
      state: { conversa: { quem: string; texto: string }[]; mensagem_nova: string; agente_atual: string };
    };
    const corpos: EstadoEnviado[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        corpos.push(JSON.parse(init.body) as EstadoEnviado);
        return respostaFake("revisor", 0.95);
      }),
    );
    const t = createThread({ projectPath: "/proj", profileId: "rot-9" }, home);
    await postMessage(t.id, "primeira", home);
    await postMessage(t.id, "segunda", home);

    // 1ª mensagem: sem histórico e sem agente ainda.
    expect(corpos[0].state).toMatchObject({ conversa: [], mensagem_nova: "primeira", agente_atual: "nenhum" });
    // 2ª: já leva o que passou e quem está tocando.
    expect(corpos[1].state.mensagem_nova).toBe("segunda");
    expect(corpos[1].state.agente_atual).toBe("revisor");
    expect(corpos[1].state.conversa.some((f) => f.quem === "usuario" && f.texto === "primeira")).toBe(true);
  });
});
