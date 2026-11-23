import { describe, expect, it } from "vitest";
import { PO_AWAITING_AUTHORIZATION_REASON, PO_MAX_OPS } from "../src/po/texto.ts";
import { caberTitulo, lerVeredito, normalizarTitulo, RESUMO_MAX_PO, TITULO_MAX_PO } from "../src/po/veredito.ts";

const ids = new Set(["tk-a", "tk-b", "tk-c"]);
const abrir = { fase: "abertura" as const, ids };
const fechar = { fase: "fechamento" as const, ids };

describe("lerVeredito: abertura", () => {
  it("OK exato é legível sem operação; texto qualquer é ilegível", () => {
    expect(lerVeredito("OK", abrir)).toEqual({ ops: [], legivel: true });
    expect(lerVeredito("  ok. ", abrir)).toEqual({ ops: [], legivel: true });
    expect(lerVeredito("Acho que está tudo certo, segue o plano.", abrir)).toEqual({ ops: [], legivel: false });
    expect(lerVeredito("", fechar).legivel).toBe(false);
  });

  it("ANDAMENTO com id do quadro e NOVA vira em andamento", () => {
    const v = lerVeredito("ANDAMENTO tk-a | o pedido retoma o login\nNOVA | Corrigir o build | pedido novo", abrir);
    expect(v.legivel).toBe(true);
    expect(v.ops).toEqual([
      { tipo: "iniciar", id: "tk-a", motivo: "o pedido retoma o login" },
      { tipo: "criar", titulo: "Corrigir o build", motivo: "pedido novo", status: "in_progress" },
    ]);
  });

  it("falha fechado: id fora do quadro, sem motivo, operação do fechamento", () => {
    const v = lerVeredito(
      [
        "ANDAMENTO tk-zzz | inventado",
        "ANDAMENTO tk-a",
        "CONCLUIR tk-a | não vale na abertura",
        "FEITA | Algo | não vale na abertura",
        "SEGURAR | não vale na abertura",
        "PENDENTE tk-b | não vale na abertura",
      ].join("\n"),
      abrir,
    );
    // Linhas com palavra-chave: legível, mas nada aplicável.
    expect(v).toEqual({ ops: [], legivel: true });
  });

  it("aceita marcação de lista e id entre colchetes; dedupe de linha repetida", () => {
    const v = lerVeredito("- ANDAMENTO [tk-b] | retoma\n* ANDAMENTO tk-b | de novo\n`NOVA | Igual | x`\nNOVA | igual | y", abrir);
    expect(v.ops).toEqual([
      { tipo: "iniciar", id: "tk-b", motivo: "retoma" },
      { tipo: "criar", titulo: "Igual", motivo: "x`", status: "in_progress" },
    ]);
  });
});

describe("lerVeredito: fechamento", () => {
  it("CONCLUIR, TITULO, PENDENTE com VOCÊ e BOTÃO, FEITA, NOVA com pai", () => {
    const v = lerVeredito(
      [
        "CONCLUIR tk-a | testes passaram",
        "TITULO tk-b | Login com Google | nome mais claro",
        "PENDENTE tk-c | falta a chave | VOCÊ: colar a chave no .env | RESPONDER",
        "FEITA | Atualizar o README | o agente editou",
        "NOVA tk-a | Publicar a versão | sobrou do pedido | VOCÊ: aprovar o deploy | BOTÃO",
      ].join("\n"),
      fechar,
    );
    expect(v.legivel).toBe(true);
    expect(v.ops).toEqual([
      { tipo: "concluir", id: "tk-a", motivo: "testes passaram" },
      { tipo: "renomear", id: "tk-b", titulo: "Login com Google", motivo: "nome mais claro" },
      { tipo: "justificar", id: "tk-c", motivo: "falta a chave", acaoVoce: "colar a chave no .env", tipoResposta: "responder" },
      { tipo: "criar", titulo: "Atualizar o README", motivo: "o agente editou", status: "completed" },
      {
        tipo: "criar",
        titulo: "Publicar a versão",
        motivo: "sobrou do pedido",
        status: "pending",
        parentId: "tk-a",
        acaoVoce: "aprovar o deploy",
        tipoResposta: "botao",
      },
    ]);
  });

  it("ANDAMENTO não vale no fechamento; RESUMO vai pro resumo", () => {
    const v = lerVeredito("ANDAMENTO tk-a | x\nNOVA | Migrar o banco | resta | RESUMO: trocar sqlite por postgres", fechar);
    expect(v.ops).toEqual([
      { tipo: "criar", titulo: "Migrar o banco", motivo: "resta", status: "pending", resumo: "trocar sqlite por postgres" },
    ]);
  });

  it("NOVA aguardando autorização sem VOCÊ ganha o botão de autorizar", () => {
    const v = lerVeredito(`NOVA | Rodar a migração | ${PO_AWAITING_AUTHORIZATION_REASON}: precisa de ok`, fechar);
    expect(v.ops[0]).toMatchObject({ tipo: "criar", status: "pending", tipoResposta: "botao", acaoVoce: "Autorizar: Rodar a migração" });
  });

  it(`teto de ${PO_MAX_OPS} operações`, () => {
    const linhas = Array.from({ length: PO_MAX_OPS + 3 }, (_, i) => `FEITA | Coisa ${i} | feito`);
    expect(lerVeredito(linhas.join("\n"), fechar).ops).toHaveLength(PO_MAX_OPS);
  });

  it("SEGURAR só com próxima mensagem na fila", () => {
    expect(lerVeredito("SEGURAR | a próxima contradiz", fechar).ops).toEqual([]);
    expect(lerVeredito("SEGURAR | a próxima contradiz", { ...fechar, temProximo: true }).ops).toEqual([
      { tipo: "segurar", motivo: "a próxima contradiz" },
    ]);
  });

  it("ETAPA do placar: CONCLUÍDA conclui, PENDENTE contesta, e não conta no teto", () => {
    const etapas = new Map<string, string | undefined>([
      ["e1", "tk-a"],
      ["e2", "tk-b"],
      ["e3", undefined],
    ]);
    const feitas = Array.from({ length: PO_MAX_OPS }, (_, i) => `FEITA | Item ${i} | ok`);
    const v = lerVeredito(
      [
        ...feitas,
        "ETAPA e1 | CONCLUÍDA | o diff mostra",
        "ETAPA e2 | PENDENTE | nada no git",
        "ETAPA e3 | CONCLUÍDA | sem card",
        "ETAPA e9 | CONCLUÍDA | etapa inventada",
      ].join("\n"),
      { ...fechar, etapas },
    );
    expect(v.ops.filter((o) => o.tipo === "criar")).toHaveLength(PO_MAX_OPS);
    expect(v.ops.slice(PO_MAX_OPS)).toEqual([
      { tipo: "concluir", id: "tk-a", motivo: "o diff mostra", etapa: "e1" },
      { tipo: "contestar", id: "tk-b", motivo: "nada no git", etapa: "e2" },
    ]);
    // Sem placar, ETAPA é ignorada.
    expect(lerVeredito("ETAPA e1 | CONCLUÍDA | x", fechar).ops).toEqual([]);
  });
});

describe("títulos", () => {
  it(`título acima de ${TITULO_MAX_PO} corta na palavra e o inteiro vai pro resumo`, () => {
    const longo = "Refatorar o módulo de autenticação inteiro para suportar login social com Google e GitHub";
    const r = caberTitulo(longo);
    expect(r.titulo.length).toBeLessThanOrEqual(TITULO_MAX_PO);
    expect(r.titulo.endsWith("…")).toBe(true);
    expect(r.resumo).toBe(longo);
    expect(caberTitulo("x".repeat(400)).resumo!.length).toBeLessThanOrEqual(RESUMO_MAX_PO);
    const v = lerVeredito(`NOVA | ${longo} | pedido`, abrir);
    expect(v.ops[0]).toMatchObject({ titulo: r.titulo, resumo: longo });
  });

  it("normalizarTitulo ignora acento, caixa e espaço", () => {
    expect(normalizarTitulo("  Configuração   do LOGIN ")).toBe("configuracao do login");
  });
});
