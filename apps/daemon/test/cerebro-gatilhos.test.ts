import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@nexos/shared";
import { saveAgent } from "../src/agents.ts";
import { ajustarCapacidade, catalogoDoCerebro, esquecerCatalogo, type Capacidade } from "../src/cerebro-catalogo.ts";
import {
  BLOCO_MAX,
  casarGatilhos,
  esquecerDisparosForTest,
  gatilhoBate,
  lembreteDoCerebro,
  montarBlocoDoCerebro,
  sinaisDoHistorico,
  textoDoLembrete,
  TITULO_DO_BLOCO,
} from "../src/cerebro-gatilhos.ts";
import { esquecerUsoDoCerebro, relatorioDeUso } from "../src/cerebro-uso.ts";
import { globalSkillsDir } from "../src/home.ts";
import { addProfile } from "../src/profiles.ts";
import { appendEvent, createThread, readThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => {
  esquecerCatalogo();
  esquecerUsoDoCerebro();
  esquecerDisparosForTest();
});

function cap(id: string, extra: Partial<Capacidade> = {}): Capacidade {
  const [tipo, nome] = id.split(":") as [Capacidade["tipo"], string];
  return {
    id,
    tipo,
    nome,
    descricao: `descrição de ${nome}`,
    gatilhos: [],
    comoUsar: `use ${nome}`,
    escopo: "global",
    origem: "auto",
    ligada: true,
    usos7d: 0,
    usos30d: 0,
    disparos30d: 0,
    usosAposDisparo30d: 0,
    ...extra,
  };
}

describe("gatilhoBate", () => {
  it("casa por palavra inteira, sem acento e sem caixa; não casa dentro de outra palavra", () => {
    expect(gatilhoBate("Preciso de uma DECISÃO sua", "decisão")).toBe(true);
    expect(gatilhoBate("preciso de uma decisao sua", "decisão")).toBe(true);
    expect(gatilhoBate("a tela ficou fluida", "ui")).toBe(false);
    expect(gatilhoBate("melhora a UI do login", "ui")).toBe(true);
    expect(gatilhoBate("faz um mock da tela", "mock")).toBe(true);
    expect(gatilhoBate("o mockup", "mock")).toBe(false);
    expect(gatilhoBate("sobe o dev server aí", "dev server")).toBe(true);
  });
});

describe("casarGatilhos", () => {
  const itens = [
    cap("skill:make-interfaces-feel-better", { gatilhos: ["ui", "tela"] }),
    cap("agente:explorador", { gatilhos: ["onde fica"] }),
    cap("ferramenta:nexo_mock_salvar", { gatilhos: ["mock"] }),
    cap("ferramenta:nexo_perguntar", { gatilhos: ["decisão"] }),
    cap("ferramenta:nexo_navegador_abrir", { gatilhos: ["abre o site"] }),
    cap("skill:desligada", { gatilhos: ["ui"], ligada: false }),
  ];
  it("devolve até 3, as mais específicas primeiro, ignorando desligadas e as recém-disparadas", () => {
    const d = casarGatilhos("faz um mock da tela de login: onde fica o form? preciso de uma decisão", itens, { tipo: "chat" });
    expect(d).toHaveLength(3);
    expect(d.map((x) => x.id)).not.toContain("skill:desligada");
    // 4 bateram; o de gatilho mais curto ("mock") fica de fora
    expect(d.map((x) => x.id)).toEqual(["agente:explorador", "skill:make-interfaces-feel-better", "ferramenta:nexo_perguntar"]);
    const texto = textoDoLembrete(d);
    expect(texto.startsWith("[Cérebro] ")).toBe(true);
    expect(texto.split("\n")).toHaveLength(1);

    const ultimo = new Map([["ferramenta:nexo_mock_salvar", 2]]);
    expect(casarGatilhos("faz um mock", itens, { tipo: "chat" }, { indice: 5, ultimoDisparo: ultimo })).toEqual([]);
    expect(casarGatilhos("faz um mock", itens, { tipo: "chat" }, { indice: 12, ultimoDisparo: ultimo })).toHaveLength(1);
  });

  it("run não recebe lembrete de ferramenta que o run não tem; sinal de leitura acorda o explorador", () => {
    expect(casarGatilhos("abre o site", itens, { tipo: "run" })).toEqual([]);
    expect(casarGatilhos("abre o site", itens, { tipo: "chat" })).toHaveLength(1);
    const d = casarGatilhos("continua", itens, { tipo: "chat" }, { indice: 0, ultimoDisparo: new Map(), sinais: { leiturasSemSubagente: 9 } });
    expect(d).toEqual([{ id: "agente:explorador", gatilho: "varredura ampla no turno anterior", comoUsar: "use explorador" }]);
    expect(casarGatilhos("continua", itens, { tipo: "chat" }, { indice: 0, ultimoDisparo: new Map(), sinais: { leiturasSemSubagente: 3 } })).toEqual([]);
  });

  it("sinaisDoHistorico conta leituras desde a última mensagem e zera se houve subagente", () => {
    const ev = (type: string, name?: string): ThreadEvent => ({ ts: "t", type, threadId: "x", name, summary: "", text: "" }) as unknown as ThreadEvent;
    expect(sinaisDoHistorico([ev("user"), ev("tool", "Read"), ev("tool", "Grep"), ev("tool", "Bash"), ev("tool", "Edit")])).toEqual({ leiturasSemSubagente: 3 });
    expect(sinaisDoHistorico([ev("tool", "Read"), ev("user"), ev("tool", "Read"), ev("tool", "Agent")])).toEqual({ leiturasSemSubagente: 0 });
  });
});

describe("montarBlocoDoCerebro", () => {
  it("respeita o teto, nomeia nexo_cerebro na 1ª linha, põe regras curtas e filtra por tipo de conversa", () => {
    const itens: Capacidade[] = [
      cap("ferramenta:nexo_perguntar", { gatilhos: ["decisão"] }),
      cap("ferramenta:nexo_mock_salvar", { gatilhos: ["mock"] }),
      cap("ferramenta:nexo_navegador_abrir", { gatilhos: ["abre o site"] }),
      cap("skill:caveman", { gatilhos: ["curto"] }),
      cap("agente:explorador", { gatilhos: ["onde fica"] }),
      cap("ferramenta:sem_gatilho"),
      cap("ferramenta:ToolSearch", { gatilhos: ["x"] }),
    ];
    for (let i = 0; i < 40; i++) itens.push(cap(`skill:enche-${i}`, { gatilhos: [`gatilho ${i}`, "x".repeat(40)] }));
    const bloco = montarBlocoDoCerebro(itens, { tipo: "chat" });
    expect(bloco.startsWith(`${TITULO_DO_BLOCO}\n`)).toBe(true);
    expect(bloco.split("\n")[1]).toContain("nexo_cerebro");
    expect(bloco.length).toBeLessThanOrEqual(BLOCO_MAX);
    expect(bloco).toContain("`nexo_perguntar` com `opcoes`");
    expect(bloco).toContain("nexo_mock_salvar");
    expect(bloco).toContain("explorador");
    expect(bloco).not.toContain("sem_gatilho");
    expect(bloco).not.toContain("ToolSearch");

    const run = montarBlocoDoCerebro(itens, { tipo: "run" });
    expect(run).toContain("nexo_perguntar");
    expect(run).not.toContain("nexo_navegador_abrir");
    expect(run).not.toContain("nexo_mock_salvar");

    const manager = montarBlocoDoCerebro(itens, { tipo: "chat", planejamento: true });
    expect(manager).toContain("nexo_perguntar");
    expect(manager).not.toContain("explorador");
    expect(manager).not.toContain("caveman");

    expect(montarBlocoDoCerebro(itens, { tipo: "oculta" })).toBe("");
    expect(montarBlocoDoCerebro([cap("ferramenta:nexo_tarefa_listar", { gatilhos: ["e depois"] })], { tipo: "chat", quadroTarefas: false })).toBe("");
  });

  it("edição da pessoa no comoUsar ganha da regra curta", () => {
    const itens = [cap("ferramenta:nexo_perguntar", { gatilhos: ["decisão"], comoUsar: "pergunte do meu jeito", origem: "pessoa" })];
    const bloco = montarBlocoDoCerebro(itens, { tipo: "chat" });
    expect(bloco).toContain("pergunte do meu jeito");
    expect(bloco).not.toContain("com `opcoes`");
  });
});

describe("lembreteDoCerebro (com catálogo e contador de verdade)", () => {
  it("prefixa o lembrete, registra o disparo, e não repete a mesma capacidade por 10 mensagens", () => {
    const home = tempHome();
    addProfile({ id: "p", engine: "claude" }, home, { skipBinCheck: true });
    const projeto = join(home, "proj");
    mkdirSync(projeto, { recursive: true });
    const skill = join(globalSkillsDir(home), "make-interfaces-feel-better");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: make-interfaces-feel-better\ndescription: Acabamento de UI.\n---\n", "utf8");
    saveAgent({ id: "explorador", name: "Explorador", description: "Varre o código.", profileId: "p", subagente: true }, home);
    expect(catalogoDoCerebro(projeto, home).find((c) => c.id === "skill:make-interfaces-feel-better")!.gatilhos).toContain("ui");

    const chat = createThread({ projectPath: projeto, profileId: "p" }, home);
    const msg = (t: string) => appendEvent({ ts: new Date().toISOString(), type: "user", threadId: chat.id, text: t } as ThreadEvent, home);

    msg("melhora a ui do login");
    const l1 = lembreteDoCerebro(chat.id, "melhora a ui do login", readThread(chat.id, home), home);
    expect(l1).toMatch(/^\[Cérebro\] ui → Skill `make-interfaces-feel-better`/);
    expect(l1.endsWith("\n\n")).toBe(true);
    expect(relatorioDeUso(home).capacidades.find((c) => c.chave === "skill:make-interfaces-feel-better")).toMatchObject({ disparos7d: 1 });

    msg("e a tela de cadastro");
    expect(lembreteDoCerebro(chat.id, "e a tela de cadastro", readThread(chat.id, home), home)).toBe("");

    for (let i = 0; i < 10; i++) msg(`msg ${i}`);
    expect(lembreteDoCerebro(chat.id, "agora a ui do perfil", readThread(chat.id, home), home)).toContain("make-interfaces-feel-better");

    // capacidade desligada pela pessoa no projeto não dispara
    ajustarCapacidade("agente:explorador", { ligada: false }, { projectPath: projeto }, home);
    expect(lembreteDoCerebro(chat.id, "onde fica o login?", readThread(chat.id, home), home)).toBe("");

    // conversa oculta nunca recebe
    const oculta = createThread({ projectPath: projeto, profileId: "p", oculta: true }, home);
    expect(lembreteDoCerebro(oculta.id, "melhora a ui", readThread(oculta.id, home), home)).toBe("");
  });
});
