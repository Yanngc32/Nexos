import { describe, it, expect } from "vitest";
import { FASE, EVENTOS, estadoInicial, transicionar, botaoPressionado } from "../inspector-estado.js";

describe("armar", () => {
  it("desligado -liga-> armando, ainda não pressionado", () => {
    const e = transicionar(estadoInicial(), { tipo: EVENTOS.LIGAR });
    expect(e.fase).toBe(FASE.ARMANDO);
    expect(botaoPressionado(e)).toBe(false);
  });

  it("armando -pronto-> ligado, agora sim pressionado", () => {
    const armando = transicionar(estadoInicial(), { tipo: EVENTOS.LIGAR });
    const ligado = transicionar(armando, { tipo: EVENTOS.PRONTO });
    expect(ligado.fase).toBe(FASE.LIGADO);
    expect(botaoPressionado(ligado)).toBe(true);
  });

  it("pronto fora de armando é ignorado", () => {
    const desligado = estadoInicial();
    expect(transicionar(desligado, { tipo: EVENTOS.PRONTO })).toEqual(desligado);
  });
});

describe("timeout de handshake", () => {
  it("armando -timeout-> erro, sem pressionar o botão", () => {
    const armando = transicionar(estadoInicial(), { tipo: EVENTOS.LIGAR });
    const erro = transicionar(armando, { tipo: EVENTOS.TIMEOUT });
    expect(erro.fase).toBe(FASE.ERRO);
    expect(botaoPressionado(erro)).toBe(false);
  });

  it("erro -liga-> armando de novo (retry)", () => {
    const erro = { fase: FASE.ERRO, selecionados: [] };
    expect(transicionar(erro, { tipo: EVENTOS.LIGAR }).fase).toBe(FASE.ARMANDO);
  });

  it("timeout fora de armando é ignorado", () => {
    const ligado = { fase: FASE.LIGADO, selecionados: [] };
    expect(transicionar(ligado, { tipo: EVENTOS.TIMEOUT })).toEqual(ligado);
  });
});

describe("re-armar após reload", () => {
  it("ligado -recarregou-> armando, descarta seleção antiga", () => {
    const ligadoComSelecao = { fase: FASE.LIGADO, selecionados: [{ seletor: "#a" }] };
    const e = transicionar(ligadoComSelecao, { tipo: EVENTOS.RECARREGOU });
    expect(e.fase).toBe(FASE.ARMANDO);
    expect(e.selecionados).toEqual([]);
  });

  it("armando -recarregou-> continua armando (reinicia o timeout, não é regressão)", () => {
    const armando = transicionar(estadoInicial(), { tipo: EVENTOS.LIGAR });
    expect(transicionar(armando, { tipo: EVENTOS.RECARREGOU }).fase).toBe(FASE.ARMANDO);
  });

  it("recarregou com o modo desligado é ignorado", () => {
    const desligado = estadoInicial();
    expect(transicionar(desligado, { tipo: EVENTOS.RECARREGOU })).toEqual(desligado);
  });
});

describe("remover", () => {
  it("remove o item no índice e mantém ligado", () => {
    const ligado = { fase: FASE.LIGADO, selecionados: [{ seletor: "#a" }, { seletor: "#b" }] };
    const e = transicionar(ligado, { tipo: EVENTOS.REMOVER, indice: 0 });
    expect(e.fase).toBe(FASE.LIGADO);
    expect(e.selecionados).toEqual([{ seletor: "#b" }]);
  });

  it("índice fora do array é ignorado", () => {
    const ligado = { fase: FASE.LIGADO, selecionados: [{ seletor: "#a" }] };
    expect(transicionar(ligado, { tipo: EVENTOS.REMOVER, indice: 5 })).toEqual(ligado);
    expect(transicionar(ligado, { tipo: EVENTOS.REMOVER, indice: -1 })).toEqual(ligado);
  });

  it("fora de ligado é ignorado", () => {
    const armando = { fase: FASE.ARMANDO, selecionados: [] };
    expect(transicionar(armando, { tipo: EVENTOS.REMOVER, indice: 0 })).toEqual(armando);
  });
});

describe("descartar", () => {
  it("qualquer fase -desliga-> desligado, zera seleção", () => {
    const ligadoComSelecao = { fase: FASE.LIGADO, selecionados: [{ seletor: "#a" }, { seletor: "#b" }] };
    expect(transicionar(ligadoComSelecao, { tipo: EVENTOS.DESLIGAR })).toEqual(estadoInicial());

    const erro = { fase: FASE.ERRO, selecionados: [] };
    expect(transicionar(erro, { tipo: EVENTOS.DESLIGAR })).toEqual(estadoInicial());
  });
});

describe("seleção", () => {
  it("chegando em ligado, acumula", () => {
    const ligado = { fase: FASE.LIGADO, selecionados: [] };
    const e = transicionar(ligado, { tipo: EVENTOS.SELECIONADO, dado: { seletor: "#cta" } });
    expect(e.selecionados).toEqual([{ seletor: "#cta" }]);
  });

  it("chegando fora de ligado (armando, erro, desligado) é ignorada", () => {
    for (const fase of [FASE.DESLIGADO, FASE.ARMANDO, FASE.ERRO]) {
      const estado = { fase, selecionados: [] };
      const evento = { tipo: EVENTOS.SELECIONADO, dado: { seletor: "#x" } };
      expect(transicionar(estado, evento)).toEqual(estado);
    }
  });
});
