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
    expect(ferramentaDePrintDoDs("t1", proj, home)()).toEqual([]);
    criarDs(proj, home, { nome: "Teste" });
    const [f] = ferramentaDePrintDoDs("t1", proj, home)();
    expect(f!.name).toBe("nexo_ds_print");

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
});
