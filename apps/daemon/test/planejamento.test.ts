import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import {
  abrirPlano,
  apagarCard,
  canalPlanejamento,
  criarPlano,
  escreverHandoff,
  extrairRefs,
  fonteValida,
  idDeCard,
  listarHandoffs,
  listarPlanos,
  marcarEtapa,
  planejamentoBus,
  resolverRef,
  salvarCard,
  salvarLayout,
  salvarRoteiro,
  slugNovo,
  vincularThread,
  type EventoPlano,
} from "../src/planejamento.ts";

const P = "/projetos/plano";
const AGORA = new Date(2026, 8, 24, 14, 23);

function comEtapas(home: string) {
  const plano = criarPlano(P, home, { agora: AGORA });
  salvarRoteiro(P, home, plano.slug, {
    expectedRev: 1,
    etapas: [
      { id: "store", titulo: "Store", status: "concluida" },
      { id: "rotas", titulo: "Rotas" },
    ],
  });
  return plano.slug;
}

function erroDe(f: () => unknown): Error & { status?: number; atual?: unknown } {
  try {
    f();
  } catch (e) {
    return e as Error & { status?: number; atual?: unknown };
  }
  throw new Error("não lançou");
}

describe("regras puras", () => {
  it("fonte: URL http(s) ou arquivo relativo do projeto", () => {
    expect(fonteValida("https://hono.dev/docs")).toBe(true);
    expect(fonteValida("src/a.ts:12")).toBe(true);
    expect(fonteValida("apps\\daemon\\src\\http.ts")).toBe(true);
    expect(fonteValida("javascript:alert(1)")).toBe(false);
    expect(fonteValida("file:///c:/x")).toBe(false);
    expect(fonteValida("../fora.ts")).toBe(false);
    expect(fonteValida("C:\\abs\\x.ts")).toBe(false);
    expect(fonteValida("/abs/x.ts")).toBe(false);
    expect(fonteValida("")).toBe(false);
  });

  it("[[ref]] resolve por id ou título sem caixa/acento; ambíguo não resolve", () => {
    const cards = [
      { id: "banco", titulo: "Decisão do Banco" },
      { id: "a", titulo: "Duplicado" },
      { id: "b", titulo: "duplicado" },
    ];
    expect(extrairRefs("ver [[decisao do banco]] e [[banco]] e [[decisao do banco]]")).toEqual(["decisao do banco", "banco"]);
    expect(resolverRef("decisao  do BANCO", cards)).toBe("banco");
    expect(resolverRef("banco", cards)).toBe("banco");
    expect(resolverRef("Duplicado", cards)).toBeNull();
    expect(resolverRef("nada", cards)).toBeNull();
  });

  it("ids e slugs únicos", () => {
    expect(idDeCard("Revisão Otimista!", [])).toBe("revisao-otimista");
    expect(idDeCard("Revisão Otimista", ["revisao-otimista"])).toBe("revisao-otimista-2");
    expect(idDeCard("???", [])).toBe("card");
    expect(slugNovo(AGORA, [])).toBe("plano-20260924-1423");
    expect(slugNovo(AGORA, ["plano-20260924-1423"])).toBe("plano-20260924-1423-2");
  });
});

describe("plano", () => {
  it("nasce 'Sem nome', vazio, e aparece na lista", () => {
    const home = tempHome();
    const plano = criarPlano(P, home, { agora: AGORA });
    expect(plano.slug).toBe("plano-20260924-1423");
    expect(plano.roteiro).toMatchObject({ titulo: "Sem nome", rev: 1, etapas: [] });
    expect(plano.cards).toEqual([]);
    expect(listarPlanos(P, home)).toMatchObject([{ slug: plano.slug, titulo: "Sem nome", etapas: 0 }]);
    expect(listarPlanos("/outro", home)).toEqual([]);
  });

  it("slug inválido ou plano inexistente", () => {
    const home = tempHome();
    expect(erroDe(() => abrirPlano(P, home, "../fora")).status).toBe(400);
    expect(erroDe(() => abrirPlano(P, home, "nao-existe")).status).toBe(404);
  });

  it("thread do Manager fica gravada sem mudar o rev", () => {
    const home = tempHome();
    const { slug } = criarPlano(P, home, { agora: AGORA });
    vincularThread(P, home, slug, "th_1");
    expect(abrirPlano(P, home, slug).roteiro).toMatchObject({ threadId: "th_1", rev: 1 });
  });
});

describe("roteiro", () => {
  it("salva etapas com rev otimista; conflito devolve o atual", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    const plano = abrirPlano(P, home, slug);
    expect(plano.roteiro.rev).toBe(2);
    expect(plano.roteiro.etapas.map((e) => e.status)).toEqual(["concluida", "pendente"]);
    const e = erroDe(() => salvarRoteiro(P, home, slug, { expectedRev: 1, etapas: [] }));
    expect(e.status).toBe(409);
    expect((e.atual as { rev: number }).rev).toBe(2);
  });

  it("recusa etapa repetida, id inválido ou status desconhecido", () => {
    const home = tempHome();
    const { slug } = criarPlano(P, home, { agora: AGORA });
    const salvar = (etapas: unknown) => erroDe(() => salvarRoteiro(P, home, slug, { expectedRev: 1, etapas })).message;
    expect(salvar([{ id: "a", titulo: "A" }, { id: "a", titulo: "B" }])).toMatch(/repetida/);
    expect(salvar([{ id: "A B", titulo: "A" }])).toMatch(/inválido/);
    expect(salvar([{ id: "a", titulo: "A", status: "feito" }])).toMatch(/status/);
  });

  it("título muda pelo roteiro; etapas ficam", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    const r = salvarRoteiro(P, home, slug, { expectedRev: 2, titulo: "Tela de planejamento" });
    expect(r.titulo).toBe("Tela de planejamento");
    expect(r.etapas).toHaveLength(2);
    expect(readFileSync(join(abrirPlano(P, home, slug).dir, "roteiro.md"), "utf8")).toContain("1. [x] Store");
  });

  it("marcarEtapa troca só a etapa pedida", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    const r = marcarEtapa(P, home, slug, { etapa: "rotas", status: "em_andamento", expectedRev: 2 });
    expect(r.etapas.map((e) => e.status)).toEqual(["concluida", "em_andamento"]);
    expect(erroDe(() => marcarEtapa(P, home, slug, { etapa: "nada", status: "concluida", expectedRev: 3 })).message).toMatch(/roteiro/);
  });
});

describe("cards", () => {
  it("cria com rev 1, atualiza campo a campo e recusa rev velho", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    const c = salvarCard(P, home, slug, { expectedRev: 0, tipo: "requisito", titulo: "Revisão otimista", etapa: "store", corpo: "a\r\nb" });
    expect(c).toMatchObject({ id: "revisao-otimista", rev: 1, corpo: "a\nb", links: [] });
    const c2 = salvarCard(P, home, slug, { expectedRev: 1, id: c.id, titulo: "Rev otimista" });
    expect(c2).toMatchObject({ rev: 2, tipo: "requisito", etapa: "store", titulo: "Rev otimista" });
    const e = erroDe(() => salvarCard(P, home, slug, { expectedRev: 1, id: c.id, titulo: "x" }));
    expect(e.status).toBe(409);
    expect((e.atual as { rev: number }).rev).toBe(2);
  });

  it("ordem é a de criação (card novo não empurra os antigos), e sobrevive a atualização", async () => {
    const home = tempHome();
    const slug = comEtapas(home);
    salvarCard(P, home, slug, { expectedRev: 0, id: "zeta", tipo: "nota", titulo: "Z" });
    await new Promise((r) => setTimeout(r, 5));
    salvarCard(P, home, slug, { expectedRev: 0, id: "alfa", tipo: "nota", titulo: "A" });
    salvarCard(P, home, slug, { expectedRev: 1, id: "zeta", titulo: "Z2" });
    expect(abrirPlano(P, home, slug).cards.map((c) => c.id)).toEqual(["zeta", "alfa"]);
  });

  it("criar com id que já existe é conflito, não sobrescrita", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    salvarCard(P, home, slug, { expectedRev: 0, id: "a", tipo: "nota", titulo: "A" });
    expect(erroDe(() => salvarCard(P, home, slug, { expectedRev: 0, id: "a", tipo: "nota", titulo: "B" })).status).toBe(409);
  });

  it("regras por tipo: sugestão sem fonte, ambiguidade nasce aberta, etapa fora do roteiro", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    expect(erroDe(() => salvarCard(P, home, slug, { expectedRev: 0, tipo: "sugestao", titulo: "S" })).message).toMatch(/fonte/);
    expect(salvarCard(P, home, slug, { expectedRev: 0, tipo: "ambiguidade", titulo: "A" }).status).toBe("aberta");
    expect(erroDe(() => salvarCard(P, home, slug, { expectedRev: 0, tipo: "nota", titulo: "N", etapa: "nada" })).message).toMatch(/roteiro/);
    expect(erroDe(() => salvarCard(P, home, slug, { expectedRev: 0, tipo: "coisa", titulo: "N" })).message).toMatch(/tipo/);
  });

  it("links: só pra card existente e nunca pra si", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    salvarCard(P, home, slug, { expectedRev: 0, id: "a", tipo: "nota", titulo: "A" });
    expect(erroDe(() => salvarCard(P, home, slug, { expectedRev: 0, id: "b", tipo: "nota", titulo: "B", links: ["x"] })).message).toMatch(/não existe/);
    expect(erroDe(() => salvarCard(P, home, slug, { expectedRev: 1, id: "a", links: ["a"] })).message).toMatch(/si mesmo/);
    expect(salvarCard(P, home, slug, { expectedRev: 0, id: "b", tipo: "nota", titulo: "B", links: ["a", "a"] }).links).toEqual(["a"]);
  });

  it("apagar limpa links de quem apontava e a posição no canvas", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    salvarCard(P, home, slug, { expectedRev: 0, id: "a", tipo: "nota", titulo: "A" });
    salvarCard(P, home, slug, { expectedRev: 0, id: "b", tipo: "nota", titulo: "B", links: ["a"] });
    salvarLayout(P, home, slug, { posicoes: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } });
    apagarCard(P, home, slug, { id: "a", expectedRev: 1 });
    const plano = abrirPlano(P, home, slug);
    expect(plano.cards.map((c) => [c.id, c.links, c.rev])).toEqual([["b", [], 2]]);
    expect(plano.layout.posicoes).toEqual({ b: { x: 3, y: 4 } });
    expect(erroDe(() => apagarCard(P, home, slug, { id: "a", expectedRev: 1 })).status).toBe(404);
  });

  it("card malformado vai pra invalidos sem derrubar o plano; etapa removida vira 'sem etapa'", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    salvarCard(P, home, slug, { expectedRev: 0, id: "ok", tipo: "nota", titulo: "Ok", etapa: "rotas" });
    const dir = abrirPlano(P, home, slug).dir;
    writeFileSync(join(dir, "cards", "quebrado.md"), "sem bloco", "utf8");
    writeFileSync(join(dir, "cards", "outro.md"), '```json\r\n{"id":"errado"}\r\n```\r\n', "utf8");
    salvarRoteiro(P, home, slug, { expectedRev: 2, etapas: [{ id: "store", titulo: "Store" }] });
    const plano = abrirPlano(P, home, slug);
    expect(plano.cards.map((c) => c.id)).toEqual(["ok"]);
    expect(plano.cards[0]!.etapa).toBe("rotas");
    expect(plano.invalidos.map((i) => i.arquivo).sort()).toEqual(["outro.md", "quebrado.md"]);
    // editar outro campo não trava por causa da etapa que sumiu
    expect(salvarCard(P, home, slug, { expectedRev: 1, id: "ok", titulo: "Ok 2" }).etapa).toBeUndefined();
    // e dá pra apagar o inválido pela tela
    apagarCard(P, home, slug, { id: "quebrado", expectedRev: 0 });
    expect(existsSync(join(dir, "cards", "quebrado.md"))).toBe(false);
  });
});

describe("layout e handoff", () => {
  it("layout descarta lixo e guarda a vista", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    const l = salvarLayout(P, home, slug, { posicoes: { a: { x: 1, y: 2 }, "B!": { x: 1, y: 1 }, c: { x: "1" } }, vista: { x: 0, y: 0, escala: 0.8 } });
    expect(l).toEqual({ posicoes: { a: { x: 1, y: 2 } }, vista: { x: 0, y: 0, escala: 0.8 } });
    expect(abrirPlano(P, home, slug).layout).toEqual(l);
  });

  it("handoff nunca sobrescreve: numera por dia", () => {
    const home = tempHome();
    const slug = comEtapas(home);
    expect(escreverHandoff(P, home, slug, "um", "tela", AGORA).nome).toBe("2026-09-24-01.md");
    expect(escreverHandoff(P, home, slug, "dois", "tela", AGORA).nome).toBe("2026-09-24-02.md");
    expect(listarHandoffs(P, home, slug).map((h) => [h.nome, h.texto])).toEqual([
      ["2026-09-24-01.md", "um\n"],
      ["2026-09-24-02.md", "dois\n"],
    ]);
  });
});

describe("eventos", () => {
  it("cada escrita emite no canal do projeto com origem e alvo", () => {
    const home = tempHome();
    const evs: EventoPlano[] = [];
    const ouvir = (e: EventoPlano) => evs.push(e);
    planejamentoBus.on(canalPlanejamento(P), ouvir);
    try {
      const slug = comEtapas(home);
      salvarCard(P, home, slug, { expectedRev: 0, id: "a", tipo: "nota", titulo: "A" }, "agente");
      expect(evs.map((e) => [e.alvo, e.origem, e.id])).toEqual([
        ["plano", "tela", undefined],
        ["roteiro", "tela", undefined],
        ["card", "agente", "a"],
      ]);
    } finally {
      planejamentoBus.off(canalPlanejamento(P), ouvir);
    }
  });
});
