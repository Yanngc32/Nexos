import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { sessionBus } from "../src/bus.ts";
import { criarDs, estadoDs } from "../src/design-system.ts";
import { ferramentaDePrintDoDs, resetPrintForTest, responderPrint } from "../src/ds-print.ts";

afterEach(() => resetPrintForTest());

describe("nexo_ds_print", () => {
  it("some sem DS; sem card lista; card inexistente recusa; com card pede ao app e devolve a imagem", async () => {
    const home = tempHome();
    const proj = mkdtempSync(join(tmpdir(), "nexo-print-"));
    // sem DS: só dá pra listar, criar, ativar e gravar mock
    expect(ferramentaDePrintDoDs("t1", proj, home)().map((x) => x.name)).toEqual(["nexo_ds_listar", "nexo_ds_criar", "nexo_ds_ativar", "nexo_mock_salvar"]);
    criarDs(proj, home, { nome: "Teste" });
    const f = ferramentaDePrintDoDs("t1", proj, home)().find((x) => x.name === "nexo_ds_print");

    const lista = await f!.executar({});
    expect(lista.texto).toContain(`pasta: ${estadoDs(proj, home).ds!.pastaAbs}`);
    expect(lista.texto).toContain("KIT.md");
    expect(lista.texto).toContain("- fund-cores · fundamentos");
    expect(lista.texto).toContain("- core-botoes · core");
    expect((await f!.executar({ card: "nada" })).ok).toBe(false);

    const pedidos: Record<string, unknown>[] = [];
    const ouvir = (ev: Record<string, unknown>) => {
      if (ev.type !== "ds_print") return;
      pedidos.push(ev);
      responderPrint(String(ev.id), { ok: true, texto: "renderizado", imagem: { dataBase64: "AAAA", mimeType: "image/jpeg" } });
    };
    sessionBus.on("*", ouvir);
    try {
      const r = await f!.executar({ card: "core-botoes", tema: "claro" });
      expect(r).toMatchObject({ ok: true, imagem: { dataBase64: "AAAA" } });
      expect(pedidos[0]).toMatchObject({ threadId: "t1", projectPath: proj, card: "core-botoes", tema: "claro" });
    } finally {
      sessionBus.off("*", ouvir);
    }
    expect(responderPrint("nao-existe", { ok: true, texto: "" })).toBe(false);
  });

  it("agente cria um DS de mocks copiando o ativo, grava uma tela e volta pro oficial", async () => {
    const home = tempHome();
    const proj = mkdtempSync(join(tmpdir(), "nexo-mocks-"));
    criarDs(proj, home, { nome: "Teste do Prisma" });
    const ferr = () => Object.fromEntries(ferramentaDePrintDoDs("t1", proj, home)().map((x) => [x.name, x]));

    const criado = await ferr().nexo_ds_criar!.executar({ nome: "Mocks" });
    expect(criado.ok).toBe(true);
    expect(criado.texto).toContain("base ativo");
    const ds = estadoDs(proj, home).ds!;
    expect(ds.nome).toBe("Mocks");
    expect(ds.cards.length).toBeGreaterThan(0); // veio com os cards (e tokens) do oficial

    const tela = await ferr().nexo_ds_card_salvar!.executar({
      titulo: "Efeito da precificação",
      secao: "Telas",
      largura: "1",
      html: '<div class="k-bloco"><p class="k-rotulo">Antes × depois</p><div style="color:var(--color-text)">…</div></div>',
    });
    expect(tela.texto).toContain("Card criado: efeito-da-precificacao");
    expect(tela.texto).toContain("Sem avisos do lint");
    const card = estadoDs(proj, home).ds!.cards.find((c) => c.id === "efeito-da-precificacao")!;
    expect(card).toMatchObject({ secao: "telas", largura: "1" });

    const ruim = await ferr().nexo_ds_card_salvar!.executar({ id: "efeito-da-precificacao", titulo: "x", html: '<p style="color:#ff0000">x</p>' });
    expect(ruim.texto).toContain("Card atualizado");
    expect(ruim.texto).toContain("Avisos do lint");

    const lista = await ferr().nexo_ds_listar!.executar({});
    expect(lista.texto).toMatch(/mocks · Mocks · ATIVO/);
    const volta = await ferr().nexo_ds_ativar!.executar({ id: "teste-do-prisma" });
    expect(volta.texto).toContain('"Teste do Prisma"');
    expect(estadoDs(proj, home).ds!.cards.some((c) => c.id === "efeito-da-precificacao")).toBe(false);
  });
});
