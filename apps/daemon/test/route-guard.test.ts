import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { tempHome } from "./helpers.ts";

/**
 * Toda rota `/v1/*` responde 401 sem bearer. Sem exceção que não esteja escrita
 * aqui embaixo.
 *
 * Este teste existe porque a autenticação do daemon depende de POSIÇÃO: o Hono
 * compõe as rotas na ordem de registro, então uma rota escrita acima do
 * `app.use("/v1/*", ...)` fica aberta. Não dá erro, não dá aviso, e o diff
 * parece certo — o meu tinha até um comentário dizendo "autenticada" ao lado de
 * uma rota que não era.
 *
 * O que aconteceu de verdade: `POST /v1/pair` subiu acima do middleware e virou
 * bypass completo. Duas requisições sem credencial nenhuma — pedir o código,
 * trocar pelo token — e o daemon era de quem pediu. Com CORS `*`, de uma página
 * web qualquer.
 *
 * Por isso a varredura é da TABELA de rotas, e não uma lista escrita à mão:
 * lista à mão só cobre o que alguém lembrou de adicionar, e o problema é
 * justamente a rota nova que ninguém lembrou.
 */

/** As únicas que podem responder sem bearer, e por quê. */
const LIBERADAS = new Map([
  ["/v1/health", "sonda de vida: não devolve nada além de { ok: true }"],
]);

/** Valor plausível pra cada parâmetro, só pra rota casar. */
const PARAMS: Record<string, string> = {
  id: "x",
  threadId: "t-1",
  runId: "r-1",
  name: "x",
};

function concretizar(caminho: string): string {
  return caminho
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg === "*" ? "x" : seg;
      const nome = seg.slice(1);
      return PARAMS[nome] ?? "x";
    })
    .join("/");
}

describe("guarda das rotas", () => {
  const app = createApp(tempHome(), "token-secreto");
  const v1 = app.routes.filter((r) => r.path.startsWith("/v1"));

  it("achou rotas pra checar — teste que não checa nada passa sempre", () => {
    expect(v1.length).toBeGreaterThan(30);
  });

  it("nenhuma rota /v1/* responde sem bearer", async () => {
    const abertas: string[] = [];
    for (const rota of v1) {
      if (rota.method === "ALL") continue; // é o próprio middleware
      const caminho = concretizar(rota.path);
      if (LIBERADAS.has(rota.path)) continue;
      const res = await app.request(`http://x${caminho}`, { method: rota.method });
      if (res.status !== 401) abertas.push(`${rota.method} ${rota.path} → ${res.status}`);
    }
    expect(abertas, "estas rotas respondem sem autenticação").toEqual([]);
  });

  it("as liberadas continuam liberadas de propósito", async () => {
    for (const [caminho] of LIBERADAS) {
      const res = await app.request(`http://x${caminho}`);
      expect(res.status, caminho).toBe(200);
    }
  });

  it("com o bearer certo elas deixam de responder 401", async () => {
    // prova que o 401 acima vem da falta de credencial, e não de a rota não existir
    const res = await app.request("http://x/v1/pair", {
      method: "POST",
      headers: { Authorization: "Bearer token-secreto" },
    });
    expect(res.status).toBe(200);
  });

  it("abrir pareamento é do desktop; só o resgate é sem auth", async () => {
    // o desenho inteiro depende disto: se dá pra ABRIR um pareamento sem
    // credencial, quem abriu conhece o código e o teto de 5 erros não protege
    // nada — não há o que adivinhar
    for (const metodo of ["POST", "GET", "DELETE"]) {
      const res = await app.request("http://x/v1/pair", { method: metodo });
      expect(res.status, `${metodo} /v1/pair`).toBe(401);
    }
    // e o resgate sem código válido nega, mas existe sem auth
    const resgate = await app.request("http://x/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo: "ZZZZZZ" }),
    });
    expect(resgate.status).toBe(403);
  });
});
