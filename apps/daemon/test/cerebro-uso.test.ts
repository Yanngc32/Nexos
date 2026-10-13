import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@nexos/shared";
import {
  capacidadeDaChamada,
  contarConversa,
  esquecerUsoDoCerebro,
  gravarUsoDoCerebro,
  ligarContadorDoCerebro,
  aoMudarUsoDoCerebro,
  registrarDisparo,
  relatorioDeUso,
  ultimosDisparos,
  tipoDaConversa,
  varrerConversas,
} from "../src/cerebro-uso.ts";
import { addProfile } from "../src/profiles.ts";
import { appendEvent, createThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const agora = Date.now();
const casa = () => {
  const home = tempHome();
  addProfile({ id: "p", engine: "claude" }, home, { skipBinCheck: true });
  return home;
};
const iso = (msAtras: number) => new Date(agora - msAtras).toISOString();
const tool = (threadId: string, name: string, input: unknown, msAtras = 1000): ThreadEvent =>
  ({ ts: iso(msAtras), type: "tool", threadId, name, summary: name, id: `t-${Math.random()}`, input }) as ThreadEvent;

afterEach(() => esquecerUsoDoCerebro());

describe("capacidadeDaChamada", () => {
  it("reconhece ferramenta nexo_*, skill, subagente, delegação, ToolSearch e MCP externo; ignora nativas", () => {
    expect(capacidadeDaChamada("mcp__nexo__nexo_perguntar", {})).toEqual({ tipo: "ferramenta", nome: "nexo_perguntar" });
    expect(capacidadeDaChamada("nexo_tarefa_listar", {})).toEqual({ tipo: "ferramenta", nome: "nexo_tarefa_listar" });
    expect(capacidadeDaChamada("Skill", { skill: "caveman" })).toEqual({ tipo: "skill", nome: "caveman" });
    expect(capacidadeDaChamada("Agent", { subagent_type: "Explore", description: "achar X" })).toEqual({ tipo: "agente", nome: "Explore", nota: "achar X" });
    expect(capacidadeDaChamada("Task", {})).toEqual({ tipo: "agente", nome: "general-purpose" });
    expect(capacidadeDaChamada("mcp__nexo__nexo_delegar", { agentId: "revisor", pedido: "x" })).toEqual({ tipo: "delegar", nome: "agente/revisor" });
    expect(capacidadeDaChamada("mcp__nexo__nexo_delegar", { teamId: "qa", pedido: "x" })).toEqual({ tipo: "delegar", nome: "time/qa" });
    expect(capacidadeDaChamada("ToolSearch", { query: "select:nexo_plano_ler" })).toEqual({ tipo: "ferramenta", nome: "ToolSearch", nota: "select:nexo_plano_ler" });
    expect(capacidadeDaChamada("mcp__github__search_issues", {})).toEqual({ tipo: "mcp-externo", nome: "github/search_issues" });
    expect(capacidadeDaChamada("mcp_tool_call", { server: "github", name: "search" })).toEqual({ tipo: "mcp-externo", nome: "github/search" });
    expect(capacidadeDaChamada("Bash", { command: "ls" })).toBeNull();
    expect(capacidadeDaChamada("Read", {})).toBeNull();
  });

  it("tipo da conversa: supervisor = time, passo = run, oculta/DS = oculta, resto = chat", () => {
    expect(tipoDaConversa({ mcpRunId: "r1", runId: "r1" })).toBe("time");
    expect(tipoDaConversa({ runId: "r1" })).toBe("run");
    expect(tipoDaConversa({ oculta: true })).toBe("oculta");
    expect(tipoDaConversa({ semRoteamento: true })).toBe("oculta");
    expect(tipoDaConversa({})).toBe("chat");
  });
});

describe("contador de uso", () => {
  it("varre conversas, separa por tipo e projeto, calcula 7/30 dias e não conta duas vezes", async () => {
    const home = casa();
    const projeto = join(home, "proj");
    const chat = createThread({ projectPath: projeto, profileId: "p" }, home);
    appendEvent(tool(chat.id, "mcp__nexo__nexo_perguntar", { texto: "?" }), home);
    appendEvent(tool(chat.id, "mcp__nexo__nexo_perguntar", { texto: "?" }, 10 * 86_400_000), home);
    appendEvent(tool(chat.id, "Skill", { skill: "caveman" }), home);
    appendEvent(tool(chat.id, "Bash", { command: "ls" }), home);
    // fora de 30 dias: não entra no relatório
    appendEvent(tool(chat.id, "Skill", { skill: "velha" }, 40 * 86_400_000), home);
    const run = createThread({ projectPath: projeto, profileId: "p", runId: "r1" }, home);
    appendEvent(tool(run.id, "Agent", { subagent_type: "Explore" }), home);
    const geral = createThread({ profileId: "p" }, home);
    appendEvent(tool(geral.id, "mcp__nexo__nexo_perguntar", {}), home);

    const v1 = await varrerConversas(home);
    expect(v1).toEqual({ conversas: 3, novos: 7 });
    // segunda varredura sem mudança: nada novo
    expect((await varrerConversas(home, { tudo: true })).novos).toBe(0);

    const r = relatorioDeUso(home);
    const perg = r.capacidades.find((c) => c.chave === "ferramenta:nexo_perguntar")!;
    expect(perg).toMatchObject({ tipo: "ferramenta", nome: "nexo_perguntar", usos7d: 2, usos30d: 3 });
    expect(perg.porConversa).toEqual({ chat: 3, run: 0, time: 0, oculta: 0 });
    expect(perg.porDia).toHaveLength(14);
    expect(perg.porDia.at(-1)).toBe(2);
    expect(perg.ultimos[0]).toMatchObject({ threadId: geral.id, tipo: "chat" });
    expect(r.capacidades.find((c) => c.chave === "agente:Explore")!.porConversa.run).toBe(1);
    expect(r.capacidades.find((c) => c.chave === "skill:velha")).toBeUndefined();
    expect(r.porConversa).toEqual({ chat: 4, run: 1, time: 0, oculta: 0 });
    // ordenado por usos 30d
    expect(r.capacidades[0]!.chave).toBe("ferramenta:nexo_perguntar");

    // filtro por projeto: o chat geral fica de fora
    const rp = relatorioDeUso(home, { projectPath: projeto });
    expect(rp.capacidades.find((c) => c.chave === "ferramenta:nexo_perguntar")!.usos30d).toBe(2);
    expect(relatorioDeUso(home, { projectPath: "" }).porConversa.chat).toBe(1);

    // persistido e relido do disco
    gravarUsoDoCerebro(home);
    expect(existsSync(join(home, "cerebro", "uso.json"))).toBe(true);
    esquecerUsoDoCerebro(home);
    expect(relatorioDeUso(home).capacidades.find((c) => c.chave === "ferramenta:nexo_perguntar")!.usos30d).toBe(3);
    const arquivo = JSON.parse(readFileSync(join(home, "cerebro", "uso.json"), "utf8")) as { cursores: Record<string, number> };
    expect(arquivo.cursores[chat.id]).toBe(5);
  });

  it("ouvinte ao vivo conta na hora, põe a conversa em dia na primeira vez e segue incrementando", () => {
    const home = casa();
    const projeto = join(home, "proj");
    const chat = createThread({ projectPath: projeto, profileId: "p" }, home);
    // gravado antes do ouvinte existir: entra quando a conversa aparece pela primeira vez
    appendEvent(tool(chat.id, "mcp__nexo__nexo_mapa_simbolos", {}), home);
    const desligar = ligarContadorDoCerebro();
    try {
      appendEvent(tool(chat.id, "mcp__nexo__nexo_perguntar", {}), home);
      appendEvent(tool(chat.id, "mcp__nexo__nexo_perguntar", {}), home);
      const r = relatorioDeUso(home, { projectPath: projeto });
      expect(r.capacidades.find((c) => c.chave === "ferramenta:nexo_perguntar")!.usos7d).toBe(2);
      expect(r.capacidades.find((c) => c.chave === "ferramenta:nexo_mapa_simbolos")!.usos7d).toBe(1);
      // varredura depois não duplica
      expect(contarConversa(chat.id, home)).toBe(0);
      expect(relatorioDeUso(home).capacidades.find((c) => c.chave === "ferramenta:nexo_perguntar")!.usos7d).toBe(2);
    } finally {
      desligar();
    }
  });

  it("disparo × uso: uso logo depois do disparo conta como 'após disparo'; janela fecha após 3 mensagens", () => {
    const home = casa();
    const chat = createThread({ projectPath: join(home, "proj"), profileId: "p" }, home);
    const desligar = ligarContadorDoCerebro();
    try {
      registrarDisparo(chat.id, { tipo: "skill", nome: "make-interfaces-feel-better" }, home);
      appendEvent(tool(chat.id, "Skill", { skill: "make-interfaces-feel-better" }), home);
      registrarDisparo(chat.id, { tipo: "agente", nome: "explorador" }, home);
      for (let i = 0; i < 3; i++) appendEvent({ ts: iso(500), type: "user", threadId: chat.id, text: "outra coisa" } as ThreadEvent, home);
      appendEvent(tool(chat.id, "Agent", { subagent_type: "explorador" }), home);
      const r = relatorioDeUso(home);
      expect(r.capacidades.find((c) => c.chave === "skill:make-interfaces-feel-better")).toMatchObject({ disparos7d: 1, usosAposDisparo7d: 1, usos7d: 1 });
      expect(r.capacidades.find((c) => c.chave === "agente:explorador")).toMatchObject({ disparos7d: 1, usosAposDisparo7d: 0, usos7d: 1 });
    } finally {
      desligar();
    }
  });

  it("linha do tempo dos disparos (mais novo primeiro, com usou) e eventos ao vivo", () => {
    const home = casa();
    const projeto = join(home, "proj");
    const chat = createThread({ projectPath: projeto, profileId: "p" }, home);
    const outro = createThread({ projectPath: join(home, "outro"), profileId: "p" }, home);
    const eventos: string[] = [];
    const desligarOuvinte = aoMudarUsoDoCerebro((ev) => eventos.push(`${ev.tipo}:${ev.chave}${ev.usou ? ":usou" : ""}`));
    const desligar = ligarContadorDoCerebro();
    try {
      registrarDisparo(chat.id, { tipo: "skill", nome: "caveman" }, home, iso(3000));
      registrarDisparo(outro.id, { tipo: "agente", nome: "revisor" }, home, iso(2000));
      registrarDisparo(chat.id, { tipo: "agente", nome: "explorador" }, home, iso(1000));
      appendEvent(tool(chat.id, "Skill", { skill: "caveman" }), home);
      const todos = ultimosDisparos(home);
      expect(todos.map((d) => d.chave)).toEqual(["agente:explorador", "agente:revisor", "skill:caveman"]);
      expect(todos[2]).toMatchObject({ threadId: chat.id, usou: true, tipo: "chat" });
      expect(todos[0]!.usou).toBeUndefined();
      expect(ultimosDisparos(home, { projectPath: projeto }).map((d) => d.chave)).toEqual(["agente:explorador", "skill:caveman"]);
      expect(ultimosDisparos(home, { max: 1 })).toHaveLength(1);
      expect(eventos).toEqual(["disparo:skill:caveman", "disparo:agente:revisor", "disparo:agente:explorador", "uso:skill:caveman:usou"]);
    } finally {
      desligar();
      desligarOuvinte();
    }
  });
});
