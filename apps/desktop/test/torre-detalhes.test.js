import { describe, expect, it } from "vitest";
import { torreEventos } from "../torre/eventos.js";
import { aplicarEventoAgente, feedVazio } from "../torre/feed.js";
import { DESLOCAMENTO_MS, avancarIdas, idasNovo } from "../torre/idas.js";

const T0 = 1_000_000;

describe("torre: detalhes dos sinais", () => {
  it("nexo_delegar: o objetivo vem de `pedido` e o tipo é o id do time", () => {
    const feed = feedVazio();
    aplicarEventoAgente(feed, { type: "tool", threadId: "a", id: "c1", name: "mcp__nexo__nexo_delegar", input: { teamId: "revisao", pedido: "revisar  o PR" } }, T0);
    expect(feed.chamadas.get("c1")).toMatchObject({ tipo: "revisao", descricao: "revisar o PR" });
  });

  it("delegou leva a descrição do explorador; travou leva há quanto tempo está sem sinal", () => {
    const antes = { em: T0, personagens: new Map([["conv:a", { torre: "", tipo: "mago", estado: "trabalhando", travado: false, sinalEm: T0 }]]), estrelas: new Map() };
    const depois = {
      em: T0 + 5 * 60_000,
      personagens: new Map([
        ["conv:a", { torre: "", tipo: "mago", estado: "trabalhando", travado: true, sinalEm: T0 }],
        ["exp:c1", { torre: "", tipo: "exp", pai: "conv:a", aberto: true, erro: false, descricao: "achar o bug" }],
      ]),
      estrelas: new Map(),
    };
    const ev = torreEventos(antes, depois);
    expect(ev).toContainEqual(expect.objectContaining({ tipo: "delegou", descricao: "achar o bug" }));
    expect(ev).toContainEqual(expect.objectContaining({ tipo: "travou", tempo: "5 min" }));
  });

  it("apagão (bloqueado): ninguém começa ida e quem estava fora volta", () => {
    const i = idasNovo();
    const magos = [{ chave: "conv:a", estado: "trabalhando" }];
    const sinais = [{ threadId: "a", andar: "biblioteca", gravando: false, em: T0 }];
    expect(avancarIdas(i, { magos, sinais, agora: T0, bloqueado: true }).size).toBe(0);
    avancarIdas(i, { magos, sinais, agora: T0 });
    expect(avancarIdas(i, { magos, sinais, agora: T0 + DESLOCAMENTO_MS + 10, bloqueado: true }).get("conv:a")?.fase).toBe("voltando");
  });
});
