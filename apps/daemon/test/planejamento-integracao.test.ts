import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.ts";
import { apagarCard as apagarCardDoDs, criarDs, salvarCardDaFerramenta } from "../src/design-system.ts";
import { abrirPlano, criarPlano, salvarCard, salvarRoteiro, validarAnexos } from "../src/planejamento.ts";
import {
  alvosDeAnexo,
  conversaDeOrigem,
  avaliarDesign,
  enviarAoQuadro,
  estadoDoDesign,
  marcarImplementacaoDaEtapa,
  pedidoDeConversa,
  resolverIntegracao,
} from "../src/planejamento-integracao.ts";
import { planoEmTexto } from "../src/planejamento-ferramentas.ts";
import { apagarTarefa, getQuadro, getTarefa, salvarTarefa } from "../src/tarefas.ts";
import { appendEvent, createThread, readThread, threadHead } from "../src/threads.ts";
import { addProfile } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

function projeto(): string {
  return mkdtempSync(join(tmpdir(), "nexo-plano-"));
}

function planoComEtapas(p: string, home: string): string {
  const { slug } = criarPlano(p, home, { titulo: "Login novo" });
  salvarRoteiro(p, home, slug, {
    expectedRev: 1,
    etapas: [
      { id: "tela", titulo: "Tela de login" },
      { id: "api", titulo: "Rota de sessão" },
    ],
  });
  return slug;
}

describe("anexos do card", () => {
  it("valida tipo e ids, e tira repetido", () => {
    expect(
      validarAnexos([
        { tipo: "ds", sistema: "oficial", card: "login" },
        { tipo: "ds", sistema: "oficial", card: "login" },
        { tipo: "tarefa", id: "tk-abc" },
      ]),
    ).toEqual([
      { tipo: "ds", sistema: "oficial", card: "login" },
      { tipo: "tarefa", id: "tk-abc" },
    ]);
    expect(() => validarAnexos([{ tipo: "arquivo", id: "x" }])).toThrow(/tipo de anexo/);
    expect(() => validarAnexos([{ tipo: "ds", sistema: "../x", card: "a" }])).toThrow(/sistema/);
  });

  it("card grava anexos, e editar outro campo não perde eles", () => {
    const home = tempHome();
    const p = projeto();
    const slug = planoComEtapas(p, home);
    const c = salvarCard(p, home, slug, { tipo: "nota", titulo: "N", anexos: [{ tipo: "tarefa", id: "tk-1" }], expectedRev: 0 });
    salvarCard(p, home, slug, { id: c.id, corpo: "mudou", expectedRev: c.rev });
    expect(abrirPlano(p, home, slug).cards[0]!.anexos).toEqual([{ tipo: "tarefa", id: "tk-1" }]);
  });

  it("resolve tela do DS e tarefa; alvo apagado aparece como não existe", () => {
    const home = tempHome();
    const p = projeto();
    const ds = criarDs(p, home, { nome: "Oficial" }).ds!;
    const tela = salvarCardDaFerramenta(p, home, { titulo: "Tela de login", secao: "Telas", html: "<div>login</div>" });
    const tarefa = salvarTarefa({ projectPath: p, titulo: "Fazer login", colunaId: getQuadro(p, home).colunas[0]!.id }, home);
    const slug = planoComEtapas(p, home);
    salvarCard(p, home, slug, {
      tipo: "requisito",
      titulo: "Login",
      etapa: "tela",
      anexos: [
        { tipo: "ds", sistema: ds.id, card: tela.id },
        { tipo: "tarefa", id: tarefa.id },
      ],
      expectedRev: 0,
    });

    const plano = abrirPlano(p, home, slug);
    const integ = resolverIntegracao(p, home, plano);
    expect(integ.anexos[`ds:${ds.id}/${tela.id}`]).toMatchObject({ existe: true, titulo: "Tela de login" });
    expect(integ.anexos[`ds:${ds.id}/${tela.id}`]!.arquivo).toMatch(/cards[\\/]tela-de-login\.html$/);
    expect(integ.anexos[`tarefa:${tarefa.id}`]).toMatchObject({ existe: true, titulo: "Fazer login", feita: false });
    // o que a implementação lê: título e caminho do .html da tela anexada
    expect(planoEmTexto(plano, integ)).toMatch(/tela [^ ]+ "Tela de login" — .*tela-de-login\.html/);

    apagarCardDoDs(p, home, tela.id);
    apagarTarefa(p, home, tarefa.id);
    const depois = resolverIntegracao(p, home, abrirPlano(p, home, slug));
    expect(depois.anexos[`ds:${ds.id}/${tela.id}`]!.existe).toBe(false);
    expect(depois.anexos[`tarefa:${tarefa.id}`]!.existe).toBe(false);
  });

  it("alvos: telas do DS (ativo primeiro) e tarefas do Quadro", () => {
    const home = tempHome();
    const p = projeto();
    criarDs(p, home, { nome: "Mocks" });
    salvarCardDaFerramenta(p, home, { titulo: "Mock A", html: "<div>a</div>" });
    criarDs(p, home, { nome: "Oficial" });
    salvarCardDaFerramenta(p, home, { titulo: "Botão", html: "<button>b</button>" });
    salvarTarefa({ projectPath: p, titulo: "T1", colunaId: getQuadro(p, home).colunas[0]!.id }, home);
    const a = alvosDeAnexo(p, home);
    expect(a.ds.map((d) => [d.nome, d.ativo])).toEqual([
      ["Oficial", true],
      ["Mocks", false],
    ]);
    expect(a.ds[0]!.cards.some((c) => c.titulo === "Botão")).toBe(true);
    expect(a.tarefas.map((t) => t.titulo)).toEqual(["T1"]);
  });
});

describe("envio pro Quadro", () => {
  it("uma tarefa por etapa, em cadeia, sob o marco do plano, com requisitos no checklist", () => {
    const home = tempHome();
    const p = projeto();
    const slug = planoComEtapas(p, home);
    salvarCard(p, home, slug, { tipo: "requisito", titulo: "Aceita e-mail", etapa: "tela", expectedRev: 0 });

    const envio = enviarAoQuadro(p, home, slug, { threadId: "t-impl" });
    expect(envio.tarefas.map((t) => [t.etapa, t.criada])).toEqual([
      ["tela", true],
      ["api", true],
    ]);
    const [t1, t2] = envio.tarefas.map((t) => getTarefa(p, home, t.tarefaId)!);
    expect(t1!.titulo).toBe("Tela de login");
    expect(t1!.checklist.map((i) => i.texto)).toEqual(["Aceita e-mail"]);
    expect(t1!.origem).toEqual({ plano: slug, etapa: "tela" });
    expect(t1!.threadId).toBe("t-impl");
    expect(t2!.dependeDe).toEqual([t1!.id]);
    expect(getQuadro(p, home).marcos.find((m) => m.id === t1!.marcoId)?.nome).toBe("Plano: Login novo");

    const plano = abrirPlano(p, home, slug);
    expect(plano.roteiro.etapas.map((e) => e.tarefaId)).toEqual([t1!.id, t2!.id]);
    expect(resolverIntegracao(p, home, plano).etapas.tela).toMatchObject({ existe: true, coluna: "A fazer", feita: false });
  });

  it("idempotente: reenviar não duplica, e etapa nova ganha tarefa dependendo da última", () => {
    const home = tempHome();
    const p = projeto();
    const slug = planoComEtapas(p, home);
    const primeiro = enviarAoQuadro(p, home, slug);
    const r = abrirPlano(p, home, slug).roteiro;
    // a tela manda só id/título/status: o vínculo com a tarefa não pode sumir
    salvarRoteiro(p, home, slug, {
      expectedRev: r.rev,
      etapas: [...r.etapas.map(({ id, titulo, status }) => ({ id, titulo, status })), { id: "deploy", titulo: "Deploy" }],
    });
    const segundo = enviarAoQuadro(p, home, slug);
    expect(segundo.tarefas.map((t) => t.criada)).toEqual([false, false, true]);
    expect(segundo.tarefas.slice(0, 2).map((t) => t.tarefaId)).toEqual(primeiro.tarefas.map((t) => t.tarefaId));
    expect(getTarefa(p, home, segundo.tarefas[2]!.tarefaId)!.dependeDe).toEqual([primeiro.tarefas[1]!.tarefaId]);
    expect(getQuadro(p, home).marcos.filter((m) => m.nome === "Plano: Login novo")).toHaveLength(1);
  });

  it("plano sem etapas recusa", () => {
    const home = tempHome();
    const p = projeto();
    const { slug } = criarPlano(p, home, {});
    expect(() => enviarAoQuadro(p, home, slug)).toThrow(/etapas/);
  });
});

describe("plano a partir de conversa", () => {
  it("transcrição com as falas, sem ferramentas; recusa chat geral e conversa de plano", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const p = projeto();
    const t = createThread({ projectPath: p, profileId: "p1", title: "Refazer login" }, home);
    appendEvent({ ts: "2026-09-24T10:00:00Z", type: "user", threadId: t.id, text: "quero login com Google" }, home);
    appendEvent({ ts: "2026-09-24T10:00:01Z", type: "tool", threadId: t.id, name: "Read", summary: "a.ts" }, home);
    appendEvent({ ts: "2026-09-24T10:00:02Z", type: "assistant", threadId: t.id, text: "Dá pra usar OAuth." }, home);
    const o = conversaDeOrigem(t.id, home);
    expect(o).toMatchObject({ projectPath: p, titulo: "Refazer login" });
    expect(o.transcricao).toBe("### Pessoa\nquero login com Google\n\n### Agente\nDá pra usar OAuth.");
    expect(pedidoDeConversa(o)).toContain("<conversa>");

    const geral = createThread({ profileId: "p1" }, home);
    expect(() => conversaDeOrigem(geral.id, home)).toThrow(/projeto/);
  });

  it("POST /v1/planejamento com deThreadId: plano no projeto da conversa, Manager com origem", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const p = projeto();
    const t = createThread({ projectPath: p, profileId: "p1", title: "Refazer login" }, home);
    appendEvent({ ts: "2026-09-24T10:00:00Z", type: "user", threadId: t.id, text: "quero login com Google" }, home);
    const app = createApp(home, "tk");
    const res = await app.request("/v1/planejamento", {
      method: "POST",
      headers: { authorization: "Bearer tk", "content-type": "application/json" },
      body: JSON.stringify({ deThreadId: t.id, profileId: "p1" }),
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { slug: string; projectPath: string; threadId: string; roteiro: { titulo: string } };
    expect(j.projectPath).toBe(p);
    expect(j.roteiro.titulo).toBe("Refazer login");
    const head = threadHead(j.threadId, home)!;
    expect(head.planejamento?.slug).toBe(j.slug);
    expect(head.origemThreadId).toBe(t.id);
  });
});

describe("implementação marca o plano", () => {
  it("etapa: em_andamento/feita move a tarefa do Quadro; dependência aberta segura a tarefa mas não a marca", () => {
    const home = tempHome();
    const p = projeto();
    const slug = planoComEtapas(p, home);
    const envio = enviarAoQuadro(p, home, slug);
    const [tTela, tApi] = envio.tarefas.map((t) => t.tarefaId);
    const col = (id: string) => getQuadro(p, home).colunas.find((c) => c.id === getTarefa(p, home, id)!.colunaId)!.nome;

    let rev = abrirPlano(p, home, slug).roteiro.rev;
    let r = marcarImplementacaoDaEtapa(p, home, slug, { etapa: "tela", estado: "em_andamento", expectedRev: rev });
    expect(r.roteiro.etapas[0]!.implementacao).toBe("em_andamento");
    expect(col(tTela!)).toBe("Fazendo");

    // api depende de tela, que ainda não está feita: a tarefa fica, a marca vale
    r = marcarImplementacaoDaEtapa(p, home, slug, { etapa: "api", estado: "feita", expectedRev: r.roteiro.rev });
    expect(r.roteiro.etapas[1]!.implementacao).toBe("feita");
    expect(r.quadro).toMatch(/não foi/);
    expect(col(tApi!)).toBe("A fazer");

    r = marcarImplementacaoDaEtapa(p, home, slug, { etapa: "tela", estado: "feita", expectedRev: r.roteiro.rev });
    expect(col(tTela!)).toBe("Feito");

    // roteiro reescrito (tela/Manager mandam só id/título/status) não perde a marca
    rev = r.roteiro.rev;
    const etapas = r.roteiro.etapas.map(({ id, titulo, status }) => ({ id, titulo, status }));
    salvarRoteiro(p, home, slug, { expectedRev: rev, etapas });
    expect(abrirPlano(p, home, slug).roteiro.etapas.map((e) => e.implementacao)).toEqual(["feita", "feita"]);

    r = marcarImplementacaoDaEtapa(p, home, slug, { etapa: "tela", estado: "pendente", expectedRev: rev + 1 });
    expect(r.roteiro.etapas[0]!.implementacao).toBeUndefined();
    expect(() => marcarImplementacaoDaEtapa(p, home, slug, { etapa: "tela", estado: "feita", expectedRev: 1 })).toThrow(/mudou/);
  });

  it("card: feito marca e desmarca", () => {
    const home = tempHome();
    const p = projeto();
    const slug = planoComEtapas(p, home);
    const c = salvarCard(p, home, slug, { tipo: "requisito", titulo: "R", expectedRev: 0 });
    const feito = salvarCard(p, home, slug, { id: c.id, feito: true, expectedRev: c.rev });
    expect(abrirPlano(p, home, slug).cards[0]!.feito).toBe(true);
    salvarCard(p, home, slug, { id: c.id, feito: false, expectedRev: feito.rev });
    expect(abrirPlano(p, home, slug).cards[0]!.feito).toBeUndefined();
  });

  it("conversa de implementação ganha as ferramentas do plano, menos gravar handoff", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const p = projeto();
    const slug = planoComEtapas(p, home);
    const t = createThread({ projectPath: p, profileId: "p1", handoff: { slug } }, home);
    const app = createApp(home, "tk");
    const res = await app.request(`/v1/mcp?projectPath=${encodeURIComponent(p)}&threadId=${t.id}`, {
      method: "POST",
      headers: { authorization: "Bearer tk", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const nomes = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
    expect(nomes).toEqual(expect.arrayContaining(["nexo_plano_ler", "nexo_plano_implementacao", "nexo_plano_card_atualizar", "nexo_plano_roteiro"]));
    expect(nomes).not.toContain("nexo_plano_handoff");
    // conversa comum não vê o plano
    const comum = createThread({ projectPath: p, profileId: "p1" }, home);
    const res2 = await app.request(`/v1/mcp?projectPath=${encodeURIComponent(p)}&threadId=${comum.id}`, {
      method: "POST",
      headers: { authorization: "Bearer tk", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const nomes2 = ((await res2.json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
    expect(nomes2.some((n) => n.startsWith("nexo_plano_"))).toBe(false);
  });
});

describe("aprovação do design da tela", () => {
  function comTela(home: string, p: string) {
    const slug = planoComEtapas(p, home);
    criarDs(p, home, { nome: "Mocks" });
    const tela = salvarCard(p, home, slug, { tipo: "tela", titulo: "Login", etapa: "tela", corpo: "spec", expectedRev: 0 });
    return { slug, tela };
  }
  const estado = (p: string, home: string, slug: string) => {
    const plano = abrirPlano(p, home, slug);
    return estadoDoDesign(plano.cards.find((c) => c.tipo === "tela")!, resolverIntegracao(p, home, plano));
  };

  it("sem mock → aguardando → reprovado; mock editado volta a aguardar; aprovado", () => {
    const home = tempHome();
    const p = projeto();
    const { slug, tela } = comTela(home, p);
    expect(estado(p, home, slug)).toBe("sem_mock");
    expect(() => avaliarDesign(p, home, slug, { id: tela.id, veredito: "aprovado", expectedRev: tela.rev })).toThrow(/mock/);

    const mock = salvarCardDaFerramenta(p, home, { titulo: "Login mock", html: "<div>v1</div>" });
    const comMock = salvarCard(p, home, slug, { id: tela.id, anexos: [{ tipo: "ds", sistema: "mocks", card: mock.id }], expectedRev: tela.rev });
    expect(estado(p, home, slug)).toBe("aguardando");

    expect(() => avaliarDesign(p, home, slug, { id: tela.id, veredito: "reprovado", expectedRev: comMock.rev })).toThrow(/mudar/);
    const r = avaliarDesign(p, home, slug, { id: tela.id, veredito: "reprovado", motivo: "botão maior", expectedRev: comMock.rev });
    expect(r.card.design).toMatchObject({ veredito: "reprovado", motivo: "botão maior", mock: `ds:mocks/${mock.id}` });
    expect(r.mensagem).toMatch(/REPROVADO[\s\S]*botão maior/);
    expect(estado(p, home, slug)).toBe("reprovado");

    // implementador refaz o mesmo card do DS: conteúdo novo, volta a aguardar
    salvarCardDaFerramenta(p, home, { id: mock.id, titulo: "Login mock", html: "<div>v2</div>" });
    expect(estado(p, home, slug)).toBe("aguardando");

    const atual = abrirPlano(p, home, slug).cards.find((c) => c.id === tela.id)!;
    avaliarDesign(p, home, slug, { id: tela.id, veredito: "aprovado", expectedRev: atual.rev });
    expect(estado(p, home, slug)).toBe("aprovado");
    expect(planoEmTexto(abrirPlano(p, home, slug), resolverIntegracao(p, home, abrirPlano(p, home, slug)))).toContain("DESIGN APROVADO");
  });

  it("rota: grava o veredito e manda o resultado pra conversa de implementação do plano", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const p = projeto();
    const { slug, tela } = comTela(home, p);
    const mock = salvarCardDaFerramenta(p, home, { titulo: "Login mock", html: "<div>v1</div>" });
    const comMock = salvarCard(p, home, slug, { id: tela.id, anexos: [{ tipo: "ds", sistema: "mocks", card: mock.id }], expectedRev: tela.rev });
    const app = createApp(home, "tk");
    const h = { authorization: "Bearer tk", "content-type": "application/json" };
    const envio = await app.request(`/v1/planejamento/${slug}/handoff/enviar?projectPath=${encodeURIComponent(p)}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ texto: "# mapa", profileId: "p1" }),
    });
    const { threadId } = (await envio.json()) as { threadId: string };
    expect(abrirPlano(p, home, slug).roteiro.implementacaoThreadId).toBe(threadId);

    const res = await app.request(`/v1/planejamento/${slug}/cards/${tela.id}/design?projectPath=${encodeURIComponent(p)}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ veredito: "reprovado", motivo: "cores erradas", expectedRev: comMock.rev }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { avisou: boolean }).avisou).toBe(true);
    await vi.waitFor(() =>
      expect(readThread(threadId, home).some((e) => e.type === "user" && e.text.includes("Design REPROVADO") && e.text.includes("cores erradas"))).toBe(true),
    );
  });
});
