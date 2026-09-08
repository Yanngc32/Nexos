import { describe, it, expect, vi } from "vitest";
import { createApiClient } from "../api.js";

/*
 * `req` é a função mais chamada do app e a que mais tem caso de borda: ela
 * re-tenta em falha de conexão e em 401, ambos sem efeito no servidor, porque
 * reiniciar o daemon troca porta e token. Antes isso só era exercitado em
 * produção — o motivo de o cliente receber `daemonInfo` e `fetchImpl` por
 * parâmetro é justamente poder testar esses caminhos aqui.
 */

/** Resposta mínima no formato que o cliente consome. */
function resposta({ status = 200, body = {}, statusText = "" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText,
    json: async () => body,
    blob: async () => "bytes",
  };
}

function motor({ port = 7432, token = "t1", ok = true } = {}) {
  return { port, token, ok };
}

/** Cliente com fetch e daemonInfo controlados; devolve também os espiões. */
function montar({ respostas = [], infos = [] } = {}) {
  const chamadas = [];
  const fetchImpl = vi.fn(async (url, opts) => {
    chamadas.push({ url, opts });
    const proxima = respostas.shift();
    if (typeof proxima === "function") return proxima();
    if (proxima instanceof Error) throw proxima;
    return proxima ?? resposta();
  });
  const daemonInfo = vi.fn(async () => {
    const proximo = infos.shift();
    if (proximo instanceof Error) throw proximo;
    return proximo ?? motor();
  });
  const vistos = [];
  const client = createApiClient({
    daemonInfo,
    fetchImpl,
    onInfo: (info) => vistos.push(info),
  });
  return { client, fetchImpl, daemonInfo, chamadas, vistos };
}

describe("montagem da requisição", () => {
  it("usa a porta padrão antes do primeiro aplicar", async () => {
    const { client, chamadas } = montar();
    await client.req("/v1/config");
    expect(chamadas[0].url).toBe("http://127.0.0.1:7432/v1/config");
  });

  it("porta e token vêm do que o motor informou", async () => {
    const { client, chamadas } = montar();
    client.aplicar(motor({ port: 9999, token: "abc" }));
    await client.req("/v1/config");
    expect(chamadas[0].url).toBe("http://127.0.0.1:9999/v1/config");
    expect(chamadas[0].opts.headers.authorization).toBe("Bearer abc");
    expect(chamadas[0].opts.headers["content-type"]).toBe("application/json");
  });

  it("cabeçalho de quem chama vence o padrão", async () => {
    const { client, chamadas } = montar();
    await client.req("/v1/x", { method: "POST", headers: { "content-type": "text/plain" } });
    expect(chamadas[0].opts.method).toBe("POST");
    expect(chamadas[0].opts.headers["content-type"]).toBe("text/plain");
  });

  it("porta e token não vazam pra fora do cliente", () => {
    const { client } = montar();
    expect(Object.keys(client).sort()).toEqual([
      "api",
      "aplicar",
      "headers",
      "renovarCredenciais",
      "req",
      "reqBlob",
    ]);
  });
});

describe("onInfo", () => {
  it("avisa a UI em toda aplicação de credencial", async () => {
    const { client, vistos } = montar({ infos: [motor({ ok: false })] });
    client.aplicar(motor({ ok: true }));
    await client.renovarCredenciais();
    expect(vistos.map((i) => i.ok)).toEqual([true, false]);
  });
});

describe("req: falha de conexão", () => {
  it("renova e re-tenta uma vez; a segunda passa", async () => {
    const { client, fetchImpl } = montar({
      respostas: [new TypeError("Failed to fetch"), resposta({ body: { a: 1 } })],
      infos: [motor({ port: 8000, token: "novo" })],
    });
    await expect(client.req("/v1/config")).resolves.toEqual({ a: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("re-tentativa usa a credencial nova, não a velha", async () => {
    const { client, chamadas } = montar({
      respostas: [new TypeError("nope"), resposta()],
      infos: [motor({ port: 8000, token: "novo" })],
    });
    await client.req("/v1/config");
    expect(chamadas[0].url).toContain(":7432");
    expect(chamadas[1].url).toContain(":8000");
    expect(chamadas[1].opts.headers.authorization).toBe("Bearer novo");
  });

  it("motor fora do ar e sem mudança: erro explicado, sem segunda tentativa", async () => {
    // token igual ao que o cliente já tem: nada mudou, então não há o que re-tentar
    const { client, fetchImpl } = montar({
      respostas: [new TypeError("nope")],
      infos: [motor({ token: "", ok: false })],
    });
    await expect(client.req("/v1/config")).rejects.toThrow(/motor não está respondendo/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("daemonInfo estourando conta como sem renovação", async () => {
    const { client } = montar({
      respostas: [new TypeError("nope")],
      infos: [new Error("ipc morreu")],
    });
    await expect(client.req("/v1/config")).rejects.toThrow(/motor não está respondendo/);
  });

  it("re-tentativa que também cai vira o mesmo erro explicado", async () => {
    const { client, fetchImpl } = montar({
      respostas: [new TypeError("nope"), new TypeError("de novo")],
      infos: [motor({ port: 8000, token: "novo" })],
    });
    await expect(client.req("/v1/config")).rejects.toThrow(/motor não está respondendo/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("req: 401", () => {
  it("renova e repete; a segunda passa", async () => {
    const { client, fetchImpl } = montar({
      respostas: [resposta({ status: 401 }), resposta({ body: { ok: true } })],
      infos: [motor({ token: "novo" })],
    });
    await expect(client.req("/v1/config")).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("se a repetição cai, o 401 original é que vira erro", async () => {
    const { client } = montar({
      respostas: [resposta({ status: 401, statusText: "Unauthorized" }), new TypeError("nope")],
    });
    await expect(client.req("/v1/config")).rejects.toThrow("Unauthorized");
  });
});

describe("req: resposta de erro", () => {
  it("usa o campo error do corpo", async () => {
    const { client } = montar({
      respostas: [resposta({ status: 400, body: { error: "projectPath obrigatório" } })],
    });
    await expect(client.req("/v1/threads")).rejects.toThrow("projectPath obrigatório");
  });

  it("sem corpo JSON, cai no statusText", async () => {
    const { client } = montar({
      respostas: [
        {
          status: 500,
          ok: false,
          statusText: "Internal Server Error",
          json: async () => {
            throw new Error("não é json");
          },
        },
      ],
    });
    await expect(client.req("/v1/x")).rejects.toThrow("Internal Server Error");
  });

  it("204 sem corpo não estoura", async () => {
    const { client } = montar({
      respostas: [
        {
          status: 204,
          ok: true,
          statusText: "",
          json: async () => {
            throw new Error("sem corpo");
          },
        },
      ],
    });
    await expect(client.req("/v1/x")).resolves.toEqual({});
  });
});

describe("reqBlob", () => {
  it("manda só o authorization, sem content-type", async () => {
    const { client, chamadas } = montar();
    await client.reqBlob("/v1/threads/t1/attachments/img.png");
    expect(chamadas[0].opts.headers).toEqual({ authorization: "Bearer " });
    expect(chamadas[0].opts.headers["content-type"]).toBeUndefined();
  });

  it("401 renova e repete", async () => {
    const { client, fetchImpl } = montar({
      respostas: [resposta({ status: 401 }), resposta()],
    });
    await expect(client.reqBlob("/v1/x")).resolves.toBe("bytes");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("erro traz o status, porque anexo não tem corpo de erro", async () => {
    const { client } = montar({ respostas: [resposta({ status: 404 })] });
    await expect(client.reqBlob("/v1/x")).rejects.toThrow("anexo 404");
  });

  it("não engole falha de conexão: anexo não re-tenta como o req", async () => {
    const { client } = montar({ respostas: [new TypeError("nope")] });
    await expect(client.reqBlob("/v1/x")).rejects.toThrow("nope");
  });
});

describe("renovarCredenciais", () => {
  it("credencial nova vale re-tentar, mesmo com o motor fora", async () => {
    const { client } = montar({ infos: [motor({ port: 8000, ok: false })] });
    await expect(client.renovarCredenciais()).resolves.toBe(true);
  });

  it("nada mudou e motor fora: não vale re-tentar", async () => {
    const { client } = montar({ infos: [motor({ ok: false })] });
    client.aplicar(motor({ ok: false }));
    await expect(client.renovarCredenciais()).resolves.toBe(false);
  });

  it("nada mudou mas motor de pé: vale", async () => {
    const { client } = montar({ infos: [motor({ ok: true })] });
    client.aplicar(motor({ ok: true }));
    await expect(client.renovarCredenciais()).resolves.toBe(true);
  });

  it("erro no IPC não propaga", async () => {
    const { client } = montar({ infos: [new Error("ipc morreu")] });
    await expect(client.renovarCredenciais()).resolves.toBe(false);
  });
});
