import { describe, it, expect, vi } from "vitest";
import { criarFetchSse } from "../sse-ponte.js";
import { lerEventos } from "../sse.js";

function ponteFake() {
  const abertos = new Map();
  return {
    abertos,
    fechados: [],
    sseAbrir(url, headers, aoMsg) {
      const id = `s${abertos.size + 1}`;
      abertos.set(id, { url, headers, aoMsg });
      return id;
    },
    sseFechar(id) {
      this.fechados.push(id);
    },
  };
}

describe("criarFetchSse", () => {
  it("fora do Electron cai no fetch comum", async () => {
    const fetchImpl = vi.fn(async () => "res");
    expect(await criarFetchSse({ ponte: undefined, fetchImpl })("u", {})).toBe("res");
  });

  it("entrega um Response-like que o lerEventos lê, mesmo com evento partido entre pedaços", async () => {
    const ponte = ponteFake();
    const p = criarFetchSse({ ponte })("http://127.0.0.1:7432/v1/agents/events", { headers: { authorization: "x" } });
    const { aoMsg, headers } = ponte.abertos.get("s1");
    expect(headers).toEqual({ authorization: "x" });
    aoMsg({ inicio: true, status: 200 });
    const res = await p;
    expect(res.ok).toBe(true);
    const eventos = [];
    const lendo = lerEventos(res, (ev) => eventos.push(ev));
    aoMsg({ dado: 'data: {"type":"a"}\n\ndata: {"ty' });
    aoMsg({ dado: 'pe":"b"}\n\n' });
    aoMsg({ fim: true });
    await lendo;
    expect(eventos).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("abort fecha o stream no processo principal e rejeita como AbortError", async () => {
    const ponte = ponteFake();
    const ac = new AbortController();
    const p = criarFetchSse({ ponte })("u", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(ponte.fechados).toEqual(["s1"]);
  });

  it("falha antes de responder rejeita com o motivo", async () => {
    const ponte = ponteFake();
    const p = criarFetchSse({ ponte })("u", {});
    ponte.abertos.get("s1").aoMsg({ fim: true, erro: "ECONNREFUSED" });
    await expect(p).rejects.toThrow("ECONNREFUSED");
  });
});
