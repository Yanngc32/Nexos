import { describe, it, expect } from "vitest";
import { lerEventos } from "../sse.js";

/*
 * O laço parece trivial e não é: o `read()` corta onde quiser, então um evento
 * pode chegar partido entre duas leituras. Estes testes existem porque essa
 * lógica estava copiada em três lugares e nenhum tinha cobertura.
 */

/** Resposta falsa que entrega os pedaços na ordem, do jeito que o read() faria. */
function resposta(...pedacos) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader: () => ({
        async read() {
          if (i >= pedacos.length) return { done: true };
          return { value: enc.encode(pedacos[i++]), done: false };
        },
      }),
    },
  };
}

async function coletar(res) {
  const vistos = [];
  await lerEventos(res, (ev) => vistos.push(ev));
  return vistos;
}

describe("lerEventos", () => {
  it("um evento por bloco", async () => {
    const res = resposta('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n');
    expect(await coletar(res)).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("evento partido entre duas leituras chega inteiro", async () => {
    const res = resposta('data: {"ty', 'pe":"a","x":1}\n\n');
    expect(await coletar(res)).toEqual([{ type: "a", x: 1 }]);
  });

  it("separador partido entre leituras não perde o evento", async () => {
    const res = resposta('data: {"type":"a"}\n', '\ndata: {"type":"b"}\n\n');
    expect(await coletar(res)).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("vários eventos numa leitura só", async () => {
    const res = resposta('data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n');
    expect(await coletar(res)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("bloco sem linha data: é ignorado, não quebra", async () => {
    const res = resposta(': heartbeat\n\ndata: {"type":"a"}\n\n');
    expect(await coletar(res)).toEqual([{ type: "a" }]);
  });

  it("outros campos do bloco não atrapalham a linha data:", async () => {
    const res = resposta('event: status\nid: 7\ndata: {"type":"a"}\n\n');
    expect(await coletar(res)).toEqual([{ type: "a" }]);
  });

  it("bloco incompleto no fim do stream é descartado, não parseado pela metade", async () => {
    const res = resposta('data: {"type":"a"}\n\ndata: {"incom');
    expect(await coletar(res)).toEqual([{ type: "a" }]);
  });

  it("corpo vazio não entrega nada e termina", async () => {
    expect(await coletar(resposta())).toEqual([]);
  });

  it("multibyte partido entre leituras não vira caractere quebrado", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('data: {"t":"ção"}\n\n');
    const corte = 12;
    let i = 0;
    const pedacos = [bytes.slice(0, corte), bytes.slice(corte)];
    const res = {
      body: {
        getReader: () => ({
          async read() {
            if (i >= pedacos.length) return { done: true };
            return { value: pedacos[i++], done: false };
          },
        }),
      },
    };
    expect(await coletar(res)).toEqual([{ t: "ção" }]);
  });

  it("JSON inválido estoura em vez de passar batido", async () => {
    const res = resposta("data: {isso não é json}\n\n");
    await expect(coletar(res)).rejects.toThrow();
  });
});
