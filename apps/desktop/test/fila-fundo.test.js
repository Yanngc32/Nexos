import { describe, expect, it } from "vitest";
import { ESPERA_SEM_RETRATO_MS, conversasProntas } from "../fila-fundo.js";

const base = (o = {}) => ({
  filas: { aberta: [{ text: "x" }], b: [{ text: "1" }], vazia: [] },
  atual: "aberta",
  agentes: [],
  ultimoEnvio: new Map(),
  enviando: new Set(),
  agora: 100_000,
  ...o,
});

describe("conversasProntas (fila das conversas não abertas)", () => {
  it("manda nas outras conversas com fila e turno parado; a aberta e a vazia ficam de fora", () => {
    expect(conversasProntas(base())).toEqual(["b"]);
  });

  it("com vários chats na tela, nenhum deles entra (cada um anda pelo SSE dele)", () => {
    const filas = { aberta: [{ text: "x" }], b: [{ text: "1" }], c: [{ text: "2" }] };
    expect(conversasProntas(base({ filas, atual: undefined, abertas: ["aberta", "b"] }))).toEqual(["c"]);
  });

  it("espera turno em voo, pergunta pendente e envio em curso", () => {
    expect(conversasProntas(base({ agentes: [{ threadId: "b", busy: true }] }))).toEqual([]);
    expect(conversasProntas(base({ agentes: [{ threadId: "b", aguardando: true }] }))).toEqual([]);
    expect(conversasProntas(base({ enviando: new Set(["b"]) }))).toEqual([]);
  });

  it("turno que acabou mal segura a fila", () => {
    for (const lastTerminal of ["error", "quota", "auth"]) {
      expect(conversasProntas(base({ agentes: [{ threadId: "b", lastTerminal }] }))).toEqual([]);
    }
    expect(conversasProntas(base({ agentes: [{ threadId: "b", lastTerminal: "done" }] }))).toEqual(["b"]);
  });

  it("depois de mandar, só manda o próximo quando um turno começou depois e acabou (ou sem retrato, após a espera)", () => {
    const ultimoEnvio = new Map([["b", 90_000]]);
    // retrato ainda é do turno velho: espera
    expect(conversasProntas(base({ ultimoEnvio, agentes: [{ threadId: "b", startedAt: 80_000, lastTerminal: "done" }] }))).toEqual([]);
    // turno novo começou depois do envio e acabou
    expect(conversasProntas(base({ ultimoEnvio, agentes: [{ threadId: "b", startedAt: 91_000, lastTerminal: "done" }] }))).toEqual(["b"]);
    // sem retrato: só depois da espera
    expect(conversasProntas(base({ ultimoEnvio, agora: 90_000 + ESPERA_SEM_RETRATO_MS - 1 }))).toEqual([]);
    expect(conversasProntas(base({ ultimoEnvio, agora: 90_000 + ESPERA_SEM_RETRATO_MS }))).toEqual(["b"]);
  });
});
