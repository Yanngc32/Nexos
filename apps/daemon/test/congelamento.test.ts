import { afterEach, describe, expect, it } from "vitest";
import { comecarAtividade, medirAtividade, resetAtividadesForTest, suspeitosDoCongelamento } from "../src/congelamento.ts";

describe("suspeitos do congelamento", () => {
  let t = 0;
  afterEach(() => resetAtividadesForTest());

  it("quem cobriu a janela do congelamento vem primeiro; quem começou depois fica de fora", () => {
    resetAtividadesForTest(() => t);
    t = 0;
    const rota = comecarAtividade("GET /v1/planejamento/x");
    t = 100;
    const curta = comecarAtividade("GET /health");
    t = 150;
    curta();
    // a rota síncrona segura o motor de 100 até 9 100
    t = 9100;
    rota();
    const depois = comecarAtividade("GET /v1/threads");
    t = 9200;
    depois();
    const s = suspeitosDoCongelamento(500, 9100);
    expect(s).toEqual([{ rotulo: "GET /v1/planejamento/x", ms: 9100, aberta: false }]);
  });

  it("atividade ainda aberta entra marcada; medirAtividade fecha mesmo com erro", () => {
    resetAtividadesForTest(() => t);
    t = 0;
    comecarAtividade("sync da biblioteca");
    expect(() =>
      medirAtividade("rotina", () => {
        t = 50;
        throw new Error("x");
      }),
    ).toThrow("x");
    t = 3000;
    const s = suspeitosDoCongelamento(10, 3000);
    expect(s[0]).toEqual({ rotulo: "sync da biblioteca", ms: 3000, aberta: true });
    expect(s.map((x) => x.rotulo)).toContain("rotina");
  });
});
