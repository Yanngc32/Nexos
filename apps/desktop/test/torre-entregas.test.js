import { describe, expect, it } from "vitest";
import {
  aplicarEventosNasEntregas,
  avancarEntregas,
  CAMINHADA_MS,
  ENTREGA_MS,
  ENTREGA_TOTAL_MS,
  entregasNovo,
  esvaziarEntregas,
  LEITURA_MS,
  SUBIDA_MS,
} from "../torre/entregas.js";
import { aplicarEventoAgente, aplicarRetrato, feedVazio, FERRAMENTAS_DE_SUBAGENTE, VOLTA_MS } from "../torre/feed.js";
import { torreModelo } from "../torre/modelo.js";
import { POSES } from "../torre/poses.js";

const T0 = 900_000;

describe("entregas", () => {
  it("explorador que voltou sobe, anda, entrega e some; o mago lê e depois segue", () => {
    const e = entregasNovo();
    aplicarEventosNasEntregas(e, [{ tipo: "voltou", chave: "conv:a", explorador: "exp:x", ok: true }], T0);
    const presentes = new Set(["conv:a", "exp:x"]);
    let r = avancarEntregas(e, T0 + 100, presentes);
    expect(r.portadores.get("exp:x")).toMatchObject({ destino: "conv:a", fase: "subindo", pose: "subindo-com-pergaminho", carga: "pergaminho" });
    expect(r.leitores.size).toBe(0);
    r = avancarEntregas(e, T0 + SUBIDA_MS + 10, presentes);
    expect(r.portadores.get("exp:x").fase).toBe("andando");
    r = avancarEntregas(e, T0 + SUBIDA_MS + CAMINHADA_MS + 10, presentes);
    expect(r.portadores.get("exp:x").fase).toBe("entregando");
    expect(r.leitores.get("conv:a")).toEqual({ pose: "lendo-entrega", ok: true });
    r = avancarEntregas(e, T0 + ENTREGA_TOTAL_MS + 1, presentes);
    expect(r.portadores.size).toBe(0);
    expect(r.leitores.has("conv:a")).toBe(true); // ainda lendo
    r = avancarEntregas(e, T0 + SUBIDA_MS + CAMINHADA_MS + ENTREGA_MS + LEITURA_MS + 20, presentes);
    expect(r.leitores.size).toBe(0);
  });

  it("com erro: pergaminho rasgado e o mago lê de cara feia", () => {
    const e = entregasNovo();
    aplicarEventosNasEntregas(e, [{ tipo: "voltou", chave: "conv:a", explorador: "exp:y", ok: false }], T0);
    const r = avancarEntregas(e, T0 + SUBIDA_MS + CAMINHADA_MS + 10, new Set(["conv:a", "exp:y"]));
    expect(r.portadores.get("exp:y").carga).toBe("pergaminhoRasgado");
    expect(r.leitores.get("conv:a").pose).toBe("lendo-entrega-ruim");
  });

  it("destino que sumiu cancela; esvaziar limpa tudo", () => {
    const e = entregasNovo();
    aplicarEventosNasEntregas(e, [{ tipo: "voltou", chave: "conv:a", explorador: "exp:x", ok: true }], T0);
    expect(avancarEntregas(e, T0 + 10, new Set(["exp:x"])).portadores.size).toBe(0);
    aplicarEventosNasEntregas(e, [{ tipo: "voltou", chave: "conv:b", explorador: "exp:z", ok: true }], T0);
    esvaziarEntregas(e);
    expect(e.ativas.size).toBe(0);
  });

  it("o feed segura o explorador tempo bastante pra viagem inteira", () => {
    expect(VOLTA_MS).toBeGreaterThanOrEqual(ENTREGA_TOTAL_MS);
  });

  it("delegação a time (nexo_delegar) também vira explorador, com o nome do time", () => {
    expect(FERRAMENTAS_DE_SUBAGENTE.has("mcp__nexo__nexo_delegar")).toBe(true);
    const f = feedVazio();
    aplicarRetrato(f, [{ threadId: "t1", projectPath: "C:/p", busy: true, aguardando: false, emEspera: 0, pendingQuota: false, passos: [], preview: "x" }], T0);
    aplicarEventoAgente(f, { type: "tool", threadId: "t1", name: "mcp__nexo__nexo_delegar", id: "d1", input: { teamId: "revisores", goal: "revisar o PR" } }, T0 + 1);
    const t = torreModelo(f, T0 + 2).torres[0];
    expect(t.exploradores[0]).toMatchObject({ id: "d1", rotulo: "revisores: revisar o PR" });
  });

  it("toda pose da entrega existe", () => {
    for (const p of ["subindo-com-pergaminho", "andando-com-pergaminho", "entregando", "lendo-entrega", "lendo-entrega-ruim"]) expect(POSES[p], p).toBeTruthy();
  });
});
