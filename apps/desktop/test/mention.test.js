import { describe, it, expect } from "vitest";
import { extrairMencoes } from "../mention.js";

describe("extrairMencoes", () => {
  it("sem menção nenhuma: ids vazio, goal é a mensagem", () => {
    expect(extrairMencoes("oi, tudo bem?")).toEqual({ ids: [], goal: "oi, tudo bem?" });
  });

  it("uma menção no meio: sai da lista e some do goal", () => {
    expect(extrairMencoes("confere @revisor isso aqui")).toEqual({
      ids: ["revisor"],
      goal: "confere isso aqui",
    });
  });

  it("menção no início da mensagem", () => {
    expect(extrairMencoes("@revisor confere isso")).toEqual({ ids: ["revisor"], goal: "confere isso" });
  });

  it("duas menções, mesma ordem em que apareceram", () => {
    expect(extrairMencoes("@revisor @escritor ajeita isso")).toEqual({
      ids: ["revisor", "escritor"],
      goal: "ajeita isso",
    });
  });

  it("mesma menção duas vezes não repete no id, mas some as duas do goal", () => {
    expect(extrairMencoes("@revisor confere, @revisor de novo por favor")).toEqual({
      ids: ["revisor"],
      goal: "confere, de novo por favor",
    });
  });

  it("mensagem só com a menção: sem texto sobrando, cai pra mensagem crua", () => {
    expect(extrairMencoes("@revisor")).toEqual({ ids: ["revisor"], goal: "@revisor" });
  });

  it("e-mail colado não é menção: falta o limite de palavra antes do @", () => {
    expect(extrairMencoes("me manda em nome@dominio.com por favor")).toEqual({
      ids: [],
      goal: "me manda em nome@dominio.com por favor",
    });
  });

  it("maiúscula não casa — id de agente/time é sempre minúsculo", () => {
    expect(extrairMencoes("@Revisor confere isso")).toEqual({ ids: [], goal: "@Revisor confere isso" });
  });

  it("id com número, - e _ é válido", () => {
    expect(extrairMencoes("roda o @time-2_beta agora")).toEqual({
      ids: ["time-2_beta"],
      goal: "roda o agora",
    });
  });

  it("vazio ou só espaço não quebra", () => {
    expect(extrairMencoes("")).toEqual({ ids: [], goal: "" });
    expect(extrairMencoes("   ")).toEqual({ ids: [], goal: "" });
  });
});
