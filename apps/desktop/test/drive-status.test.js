import { describe, expect, it } from "vitest";
import { textoSyncEmAndamento } from "../drive-status.js";

describe("textoSyncEmAndamento", () => {
  const t0 = Date.parse("2026-09-24T12:00:00Z");
  const em = (min, pendentes) => textoSyncEmAndamento({ emAndamentoDesde: new Date(t0).toISOString(), pendentes }, t0 + min * 60_000);

  it("mostra há quanto tempo e quantos faltam", () => {
    expect(em(3, 120)).toEqual({ texto: "Sincronizando há 3 min, 120 arquivos pendentes.", longo: false });
    expect(em(0.2, 1).texto).toBe("Sincronizando há menos de 1 min, 1 arquivo pendente.");
  });

  it("acima de 10 min vira aviso em destaque", () => {
    const r = em(11, 40);
    expect(r.longo).toBe(true);
    expect(r.texto).toMatch(/^Sincronizando há 11 min, 40 arquivos pendentes\. Está demorando/);
  });

  it("motor antigo sem os campos: texto de sempre", () => {
    expect(textoSyncEmAndamento({ running: true })).toEqual({ texto: "Sincronizando…", longo: false });
  });
});
