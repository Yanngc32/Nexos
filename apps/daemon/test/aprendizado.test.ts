import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  definirModeloDaAnaliseParaTeste,
  FIM_DA_ANALISE,
  lerResposta,
  limparSegredos,
  PARADA_MS,
  varrerAprendizado,
} from "../src/aprendizado-analise.ts";
import { lerSinais, marcarSinal, pareceCorrecao, resetSinaisForTest, talvezMarcarMensagemSeguinte } from "../src/aprendizado-sinais.ts";
import {
  agirNoInstinto,
  aplicarAnalise,
  calcularConfianca,
  criarSkillDaArea,
  definirAprendizadoLigado,
  editarInstinto,
  escreverInstinto,
  lerInstinto,
  listarInstintos,
  montarBlocoDeAprendizados,
  normalizarArea,
  propostasDeSkill,
  renovarAprendizados,
  adiarProposta,
  resetInstintosForTest,
  resumoDoAprendizado,
  selecionarParaContexto,
  type Evidencia,
  type Instinto,
} from "../src/instintos.ts";
import { addProfile } from "../src/profiles.ts";
import { projectDir } from "../src/projeto-dir.ts";
import { getLive, postMessage } from "../src/session.ts";
import { StubEngine } from "../src/engines/stub.ts";
import { globalSkillsDir } from "../src/home.ts";
import { appendEvent, createThread, readThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const DIA = 24 * 60 * 60_000;

function ev(threadId: string, efeito: Evidencia["efeito"] = "confirma", data = new Date().toISOString()): Evidencia {
  return { threadId, data, tipo: "inject", trecho: "não, usa X", efeito };
}

function instinto(p: Partial<Instinto> = {}): Instinto {
  const agora = new Date().toISOString();
  return {
    id: "in-1",
    gatilho: "for commitar",
    acao: "Escrever em português.",
    area: "commits",
    evidencia: [ev("t1")],
    confianca: 0.3,
    escopo: "projeto",
    status: "candidato",
    editadoPelaPessoa: false,
    rejeicoes: 0,
    criadoEm: agora,
    atualizadoEm: agora,
    ...p,
  };
}

function cenario() {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  const t = createThread({ projectPath: "/proj-aprende", profileId: "p1" }, home).id;
  return { home, t, proj: "/proj-aprende" };
}

function falar(home: string, threadId: string, type: "user" | "assistant", text: string, ts = new Date().toISOString()) {
  appendEvent({ ts, type, threadId, text } as never, home);
}

afterEach(() => {
  resetInstintosForTest();
  resetSinaisForTest();
  definirModeloDaAnaliseParaTeste(null);
});

describe("formato e confiança", () => {
  it("área normalizada: minúsculas, sem acento, hífen, até 2 palavras", () => {
    expect(normalizarArea("Commits de Release")).toBe("commits-de");
    expect(normalizarArea("Configuração")).toBe("configuracao");
    expect(normalizarArea("  ")).toBe("geral");
  });

  it("frontmatter vai e volta", () => {
    const i = instinto({ skill: "x", status: "incorporado", editadoPelaPessoa: true, evidencia: [ev("t1"), ev("t2", "contradiz")] });
    const md = escreverInstinto(i);
    expect(md).toContain("Quando for commitar: Escrever em português.");
    expect(lerInstinto(md)).toEqual(i);
  });

  it("confiança pela contagem de conversas, +0,05 por confirmação extra, −0,1 por contradição/rejeição, −0,02 por semana", () => {
    const agora = Date.now();
    expect(calcularConfianca({ evidencia: [ev("a"), ev("b")], rejeicoes: 0 }, agora)).toBe(0.3);
    expect(calcularConfianca({ evidencia: ["a", "b", "c", "d"].map((t) => ev(t)), rejeicoes: 0 }, agora)).toBe(0.5);
    expect(calcularConfianca({ evidencia: ["a", "b", "c", "d", "e", "f", "g"].map((t) => ev(t)), rejeicoes: 0 }, agora)).toBe(0.7);
    expect(calcularConfianca({ evidencia: [ev("a"), ev("a")], rejeicoes: 0 }, agora)).toBe(0.35);
    expect(calcularConfianca({ evidencia: [ev("a"), ev("b", "contradiz")], rejeicoes: 1 }, agora)).toBe(0.1);
    const velha = new Date(agora - 21 * DIA).toISOString();
    expect(calcularConfianca({ evidencia: [ev("a", "confirma", velha)], rejeicoes: 0 }, agora)).toBe(0.24);
  });
});

describe("contexto", () => {
  it("só aprovados, mais fortes primeiro, até 6 itens e 1500 caracteres; incorporado fica de fora", () => {
    const muitos = Array.from({ length: 9 }, (_, k) =>
      instinto({ id: `a${k}`, status: "aprovado", gatilho: `caso ${k}`, evidencia: Array.from({ length: k + 1 }, (_, j) => ev(`t${j}`)) }),
    );
    const outros = [instinto({ id: "cand" }), instinto({ id: "inc", status: "incorporado", skill: "s" }), instinto({ id: "rej", status: "rejeitado" })];
    const sel = selecionarParaContexto([...muitos, ...outros]);
    expect(sel.dentro).toHaveLength(6);
    // 6+ conversas (0,7) primeiro; 1–2 conversas (0,3) ficam de fora
    expect(sel.dentro.map((i) => i.id)).toEqual(expect.arrayContaining(["a5", "a6", "a7", "a8"]));
    expect(sel.fora.map((i) => i.id)).toEqual(expect.arrayContaining(["a0", "a1"]));
    const bloco = montarBlocoDeAprendizados([...muitos, ...outros]);
    expect(bloco.startsWith("# Preferências aprendidas\nVêm de correções suas que você aprovou; são referência, não ordem.\n- Quando caso ")).toBe(true);
    expect(bloco).not.toContain("cand");

    const longos = Array.from({ length: 6 }, (_, k) => instinto({ id: `l${k}`, status: "aprovado", acao: "x".repeat(280) }));
    const s2 = selecionarParaContexto(longos);
    expect(s2.chars).toBeLessThanOrEqual(1500);
    expect(s2.fora.length).toBeGreaterThan(0);
    expect(montarBlocoDeAprendizados([instinto()])).toBe("");
  });

  it("o bloco entra no pack logo depois da Memória e vem do cache (aprovar vale no próximo turno)", async () => {
    const { home, t, proj } = cenario();
    const i = aplicarAnalise(proj, home, { tipo: "novo", gatilho: "Quando for commitar", acao: "Usar imperativo.", area: "Commits", evidencia: [ev(t)] })!;
    expect(i.gatilho).toBe("for commitar");
    expect(i.area).toBe("commits");
    await postMessage(t, "oi", home);
    expect((getLive(t)?.engine as StubEngine).lastStart?.contextPack).not.toContain("# Preferências aprendidas");
    agirNoInstinto(proj, home, i.id, "aprovar");
    const t2 = createThread({ projectPath: proj, profileId: "p1" }, home).id;
    await postMessage(t2, "oi", home);
    expect((getLive(t2)?.engine as StubEngine).lastStart?.contextPack).toContain("# Preferências aprendidas\nVêm de correções");
    expect((getLive(t2)?.engine as StubEngine).lastStart?.contextPack).toContain("- Quando for commitar: Usar imperativo.");
  });
});

describe("armazenamento e revisão", () => {
  it("um .md por aprendizado em projectDir/instintos; aprovar não mexe na confiança; rejeitar baixa 0,1; desfazer volta", () => {
    const { home, proj } = cenario();
    const i = aplicarAnalise(proj, home, { tipo: "novo", gatilho: "x", acao: "y", area: "testes", evidencia: [ev("a"), ev("b"), ev("c")] })!;
    const dir = join(projectDir(proj, home), "instintos");
    expect(readdirSync(dir)).toEqual([`${i.id}.md`]);
    expect(i.confianca).toBe(0.5);
    expect(agirNoInstinto(proj, home, i.id, "aprovar").confianca).toBe(0.5);
    const rej = agirNoInstinto(proj, home, i.id, "rejeitar");
    expect([rej.status, rej.confianca]).toEqual(["rejeitado", 0.4]);
    const volta = agirNoInstinto(proj, home, i.id, "desfazer-rejeicao", { statusAnterior: "aprovado" });
    expect([volta.status, volta.confianca]).toEqual(["aprovado", 0.5]);
    agirNoInstinto(proj, home, i.id, "rejeitar");
    const rec = agirNoInstinto(proj, home, i.id, "reconsiderar");
    expect([rec.status, rec.confianca]).toEqual(["candidato", 0.4]);
  });

  it("texto editado pela pessoa não é reescrito pela análise, que só soma evidência", () => {
    const { home, proj } = cenario();
    const i = aplicarAnalise(proj, home, { tipo: "novo", gatilho: "a", acao: "b", area: "css", evidencia: [ev("t1")] })!;
    // candidato sem edição: a análise pode refinar o texto
    expect(aplicarAnalise(proj, home, { tipo: "evidencia", id: i.id, gatilho: "a2", evidencia: [ev("t2")] })!.gatilho).toBe("a2");
    const ed = editarInstinto(proj, home, i.id, { gatilho: "Quando mexer em CSS", acao: "Usar tokens.", aprovar: true });
    expect([ed.gatilho, ed.status, ed.editadoPelaPessoa]).toEqual(["mexer em CSS", "aprovado", true]);
    const depois = aplicarAnalise(proj, home, { tipo: "evidencia", id: i.id, gatilho: "outra coisa", acao: "outra", evidencia: [ev("t3")] })!;
    expect([depois.gatilho, depois.acao, depois.evidencia.length]).toEqual(["mexer em CSS", "Usar tokens.", 3]);
    expect(() => editarInstinto(proj, home, i.id, { gatilho: "x".repeat(121) })).toThrow(/120/);
  });

  it("mudou em outro aparelho: expected velho é 409 com o atual", () => {
    const { home, proj } = cenario();
    const i = aplicarAnalise(proj, home, { tipo: "novo", gatilho: "a", acao: "b", area: "css", evidencia: [ev("t1")] })!;
    try {
      agirNoInstinto(proj, home, i.id, "aprovar", { expected: "2000-01-01T00:00:00.000Z" });
      expect.unreachable();
    } catch (e) {
      expect((e as { status: number }).status).toBe(409);
      expect((e as { atual: Instinto }).atual.id).toBe(i.id);
    }
  });

  it("cache renova sozinho o que outro aparelho sincronizou", async () => {
    const { home, proj } = cenario();
    expect(listarInstintos(proj, home)).toEqual([]);
    const { writeFileSync } = await import("node:fs");
    const dir = join(projectDir(proj, home), "instintos");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "in-x.md"), escreverInstinto(instinto({ id: "in-x" })));
    await renovarAprendizados(proj, home);
    expect(listarInstintos(proj, home).map((i) => i.id)).toEqual(["in-x"]);
  });
});

describe("sinais", () => {
  it("regex de correção em pt-BR", () => {
    for (const t of ["não, usa a lib de datas", "Na verdade era pra usar pnpm", "tá errado isso", "em vez de fetch usa ky", "eu disse sem emoji", "faz de novo", "volta o arquivo", "desfaz isso", "para de criar arquivo", "não era isso", "Nao era isso"]) {
      expect(pareceCorrecao(t), t).toBe(true);
    }
    for (const t of ["ok, segue", "perfeito, valeu", "agora faz a tela de login", "não sei ainda qual cor", "voltagem do circuito", ""]) {
      expect(pareceCorrecao(t), t).toBe(false);
    }
  });

  it("parar, inject e mock reprovado marcam; oculta, plano e chave desligada não", () => {
    const { home, t, proj } = cenario();
    expect(marcarSinal(home, { threadId: t, tipo: "parar" })).toBe(true);
    expect(marcarSinal(home, { threadId: t, tipo: "parar" })).toBe(false); // mesmo ponto, clique duplo
    expect(marcarSinal(home, { threadId: t, tipo: "inject", trecho: "usa X" })).toBe(true);
    const oculta = createThread({ projectPath: proj, profileId: "p1", oculta: true }, home).id;
    const manager = createThread({ projectPath: proj, profileId: "p1", planejamento: { slug: "p" } }, home).id;
    expect(marcarSinal(home, { threadId: oculta, tipo: "parar" })).toBe(false);
    expect(marcarSinal(home, { threadId: manager, tipo: "mock_reprovado", trecho: "x" })).toBe(false);
    definirAprendizadoLigado(proj, home, false);
    falar(home, t, "user", "oi");
    expect(marcarSinal(home, { threadId: t, tipo: "parar" })).toBe(false);
    expect(lerSinais(home).map((s) => s.tipo)).toEqual(["parar", "inject"]);
  });

  it("mensagem seguinte só conta logo depois da resposta e com cara de correção", () => {
    const { home, t } = cenario();
    falar(home, t, "user", "faz o commit");
    falar(home, t, "assistant", "feito: feat: add x");
    expect(talvezMarcarMensagemSeguinte(home, t, "valeu")).toBe(false);
    expect(talvezMarcarMensagemSeguinte(home, t, "não, commit em português")).toBe(true);
    expect(lerSinais(home)).toMatchObject([{ tipo: "mensagem_seguinte", trecho: "não, commit em português", posicao: 3 }]);
  });
});

describe("análise", () => {
  it("segredo sai antes de ir pro modelo", () => {
    const t = limparSegredos("usa o token sk-ant-abcdefghijklmnopqrstuv e senha=hunter22 e ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(t).not.toMatch(/sk-ant-a|hunter22|ghp_a/);
    expect(t).toContain("senha=[segredo]");
  });

  it("sem a linha de conclusão no fim a resposta não vale", () => {
    expect(lerResposta('{"sinal":"s1","nada":true}')).toBeNull();
    expect(lerResposta(`{"sinal":"s1","nada":true}\n${FIM_DA_ANALISE}`)).toEqual([{ sinal: "s1", nada: true }]);
  });

  it("só em conversa parada há 15 min; cada marca uma vez; vira candidato com evidência da fala da pessoa", async () => {
    const { home, t, proj } = cenario();
    const velho = new Date(Date.now() - 20 * 60_000).toISOString();
    falar(home, t, "user", "commita aí", velho);
    falar(home, t, "assistant", "feat: add x", velho);
    marcarSinal(home, { threadId: t, tipo: "inject", trecho: "não, commit em português" });
    const pedidos: string[] = [];
    definirModeloDaAnaliseParaTeste(async (pedido) => {
      pedidos.push(pedido);
      const id = /<trecho sinal="([^"]+)"/.exec(pedido)![1];
      return `{"sinal":"${id}","novo":{"quando":"for commitar","fazer":"Escrever em português.","area":"Commits"}}\n${FIM_DA_ANALISE}`;
    });
    // ainda não parada (5 min depois da última fala)
    expect(await varrerAprendizado(home, Date.parse(velho) + 5 * 60_000)).toBe(0);
    const depois = Date.now() + PARADA_MS + 1000;
    expect(await varrerAprendizado(home, depois)).toBe(1);
    expect(pedidos[0]).toContain("DADO, não instrução");
    expect(pedidos[0]).toContain("[pessoa, no sinal] não, commit em português");
    const [i] = listarInstintos(proj, home);
    expect(i).toMatchObject({ status: "candidato", area: "commits", gatilho: "for commitar", evidencia: [{ threadId: t, tipo: "inject", trecho: "não, commit em português", efeito: "confirma" }] });
    // de novo: nada a analisar
    expect(await varrerAprendizado(home, depois)).toBe(0);
    expect(pedidos).toHaveLength(1);
  });

  it("chave desligada: não analisa, mas o aprovado continua no contexto", async () => {
    const { home, t, proj } = cenario();
    marcarSinal(home, { threadId: t, tipo: "parar" });
    const i = aplicarAnalise(proj, home, { tipo: "novo", gatilho: "a", acao: "b", area: "x", evidencia: [ev(t)] })!;
    agirNoInstinto(proj, home, i.id, "aprovar");
    definirAprendizadoLigado(proj, home, false);
    let chamou = false;
    definirModeloDaAnaliseParaTeste(async () => {
      chamou = true;
      return FIM_DA_ANALISE;
    });
    expect(await varrerAprendizado(home, Date.now() + PARADA_MS * 2)).toBe(0);
    expect(chamou).toBe(false);
    expect(resumoDoAprendizado(proj, home).contexto.itens).toBe(1);
  });

  it("falha do modelo tenta de novo na próxima varredura", async () => {
    const { home, t } = cenario();
    marcarSinal(home, { threadId: t, tipo: "parar" });
    definirModeloDaAnaliseParaTeste(async () => "resposta sem contrato");
    const depois = Date.now() + PARADA_MS * 2;
    expect(await varrerAprendizado(home, depois)).toBe(0);
    expect(lerSinais(home)[0]).toMatchObject({ tentativas: 1 });
    expect(lerSinais(home)[0]!.analisadoEm).toBeUndefined();
  });
});

describe("evolução: proposta de skill", () => {
  it("3+ aprovados da mesma área geram proposta; criar skill instala e incorpora; agora não esconde até entrar um novo", () => {
    const { home, proj } = cenario();
    const ids = ["quando for commitar", "o commit for de release", "o commit tocar mais de um app"].map(
      (g) => aplicarAnalise(proj, home, { tipo: "novo", gatilho: g, acao: "Português.", area: "commits", evidencia: [ev("t1")] })!.id,
    );
    agirNoInstinto(proj, home, ids[0]!, "aprovar");
    agirNoInstinto(proj, home, ids[1]!, "aprovar");
    expect(resumoDoAprendizado(proj, home).propostas).toEqual([]);
    agirNoInstinto(proj, home, ids[2]!, "aprovar");
    const [prop] = resumoDoAprendizado(proj, home).propostas;
    expect(prop).toMatchObject({ area: "commits", atualizar: false, ids });
    expect(prop!.skill).toMatch(/^aprendizados-.+-commits$/);

    adiarProposta(proj, home, "commits");
    expect(resumoDoAprendizado(proj, home).propostas).toEqual([]);

    const r = criarSkillDaArea(proj, home, "commits");
    const skill = readFileSync(join(globalSkillsDir(home), r.skill, "SKILL.md"), "utf8");
    expect(skill).toContain(`name: ${r.skill}`);
    expect(skill).toContain("description: Preferências aprendidas sobre commits no projeto");
    expect(skill).toContain("- Quando for commitar: Português.");
    expect(listarInstintos(proj, home).every((i) => i.status === "incorporado" && i.skill === r.skill)).toBe(true);
    expect(resumoDoAprendizado(proj, home).contexto.itens).toBe(0);

    // área com skill: um aprovado novo vira "Atualizar skill"
    const novo = aplicarAnalise(proj, home, { tipo: "novo", gatilho: "x", acao: "y", area: "commits", evidencia: [ev("t9")] })!;
    agirNoInstinto(proj, home, novo.id, "aprovar");
    expect(resumoDoAprendizado(proj, home).propostas).toMatchObject([{ area: "commits", atualizar: true, ids: [novo.id] }]);
  });

  it("agora não volta a propor quando entra aprendizado novo na área", () => {
    const base = [1, 2, 3].map((k) => instinto({ id: `a${k}`, status: "aprovado" }));
    const cfg = { ligado: true, adiadas: { commits: ["a1", "a2", "a3"] } };
    expect(propostasDeSkill(base, cfg, "nexos")).toEqual([]);
    expect(propostasDeSkill([...base, instinto({ id: "a4", status: "aprovado" })], cfg, "nexos")).toHaveLength(1);
    expect(propostasDeSkill(base, { ligado: true, adiadas: {} }, "nexos")[0]!.skill).toBe("aprendizados-nexos-commits");
  });

  it("sem pasta de skill: falha não mexe nos aprendizados", () => {
    const { home, proj } = cenario();
    for (const g of ["a", "b"]) {
      const i = aplicarAnalise(proj, home, { tipo: "novo", gatilho: g, acao: "y", area: "css", evidencia: [ev("t1")] })!;
      agirNoInstinto(proj, home, i.id, "aprovar");
    }
    expect(() => criarSkillDaArea(proj, home, "css")).toThrow(/3/);
    expect(listarInstintos(proj, home).every((i) => i.status === "aprovado")).toBe(true);
    expect(existsSync(join(globalSkillsDir(home), "aprendizados-proj-aprende-css"))).toBe(false);
  });
});

describe("rotas", () => {
  it("parar turno em curso marca sinal; GET traz instintos, contexto e analisando", async () => {
    const { createApp } = await import("../src/http.ts");
    const { home, t, proj } = cenario();
    const app = createApp(home, "tk");
    const h = { authorization: "Bearer tk", "content-type": "application/json" };
    const q = `projectPath=${encodeURIComponent(proj)}`;
    const r = await app.request(`/v1/aprendizados?${q}`, { headers: h });
    expect(await r.json()).toMatchObject({ ligado: true, instintos: [], propostas: [], contexto: { itens: 0, maxItens: 6, maxChars: 1500 }, analisando: 0 });
    const off = await app.request(`/v1/aprendizados/config?${q}`, { method: "PUT", headers: h, body: JSON.stringify({ ligado: false }) });
    expect(await off.json()).toMatchObject({ ligado: false });
    const pend = await app.request(`/v1/aprendizados/pendentes?${q}`, { headers: h });
    expect(await pend.json()).toEqual({ pendentes: 0 });
    void readThread(t, home);
  });
});
