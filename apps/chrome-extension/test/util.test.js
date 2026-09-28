import { describe, expect, it } from "vitest";
import { criarLeitorSse, normalizarBase, resumoDaAcao, teclaParaCdp, urlPermitida } from "../src/util.js";

describe("criarLeitorSse", () => {
  it("junta pedaços e separa eventos por linha em branco", () => {
    const eventos = [];
    const alimentar = criarLeitorSse((e) => eventos.push(e));
    alimentar("event: ping\ndata: \n\nevent: comando\nda");
    alimentar('ta: {"acao":"ler"}\n\n: comentário\n\n');
    expect(eventos).toEqual([
      { event: "ping", data: "" },
      { event: "comando", data: '{"acao":"ler"}' },
    ]);
  });

  it("aceita CRLF", () => {
    const eventos = [];
    criarLeitorSse((e) => eventos.push(e))("event: ola\r\ndata: {}\r\n\r\n");
    expect(eventos).toEqual([{ event: "ola", data: "{}" }]);
  });
});

describe("urlPermitida / normalizarBase", () => {
  it("só http/https", () => {
    expect(urlPermitida("https://exemplo.com/a")).toBe("https://exemplo.com/a");
    expect(urlPermitida("chrome://settings")).toBeNull();
    expect(urlPermitida("javascript:alert(1)")).toBeNull();
    expect(urlPermitida("file:///C:/x")).toBeNull();
    expect(urlPermitida("sem esquema")).toBeNull();
  });

  it("endereço do motor vira origem limpa", () => {
    expect(normalizarBase("")).toBe("http://127.0.0.1:7432");
    expect(normalizarBase("127.0.0.1:7500/")).toBe("http://127.0.0.1:7500");
    expect(normalizarBase("https://maquina.tail.ts.net:7432/app/")).toBe("https://maquina.tail.ts.net:7432");
    expect(normalizarBase("ftp://x")).toBeNull();
  });
});

describe("teclaParaCdp", () => {
  it("tecla nomeada", () => {
    expect(teclaParaCdp("Enter")).toEqual({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" });
    expect(teclaParaCdp("Shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 });
  });

  it("atalho de edição manda o comando, sem texto", () => {
    const p = teclaParaCdp("Control+a");
    expect(p).toMatchObject({ key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] });
    expect(p.text).toBeUndefined();
  });

  it("letra solta digita", () => {
    expect(teclaParaCdp("x")).toMatchObject({ key: "x", code: "KeyX", text: "x" });
  });

  it("recusa o que não conhece", () => {
    expect(() => teclaParaCdp("Hyper+a")).toThrow(/modificador/);
    expect(() => teclaParaCdp("F13x")).toThrow(/desconhecida/);
    expect(() => teclaParaCdp("")).toThrow(/faltou/);
  });
});

describe("resumoDaAcao", () => {
  it("curto pro log do popup", () => {
    expect(resumoDaAcao({ acao: "abrir", url: "https://banco.com.br/extrato" })).toBe("abrir banco.com.br/extrato");
    expect(resumoDaAcao({ acao: "clicar", ref: "ref_17", real: true })).toBe("clicar ref_17 (real)");
  });
});
