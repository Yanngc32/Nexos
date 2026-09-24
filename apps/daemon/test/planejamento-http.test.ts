import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { tempHome } from "./helpers.ts";

const token = "test-token";
const P = encodeURIComponent("C:/proj/plano");

function cliente() {
  const app = createApp(tempHome(), token);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
}

describe("/v1/planejamento", () => {
  it("exige projectPath", async () => {
    const req = cliente();
    expect((await req("GET", "/v1/planejamento")).status).toBe(400);
    expect((await req("POST", "/v1/planejamento", {})).status).toBe(400);
  });

  it("fluxo: cria plano, roteiro, card, conflito 409 com atual, apaga", async () => {
    const req = cliente();
    const criado = await req("POST", `/v1/planejamento?projectPath=${P}`, {});
    expect(criado.status).toBe(201);
    const slug = criado.json.slug as string;
    expect((await req("GET", `/v1/planejamento?projectPath=${P}`)).json).toMatchObject([{ slug, titulo: "Sem nome" }]);

    const rot = await req("PUT", `/v1/planejamento/${slug}/roteiro?projectPath=${P}`, {
      expectedRev: 1,
      etapas: [{ id: "a", titulo: "A" }],
    });
    expect(rot.json).toMatchObject({ rev: 2, etapas: [{ id: "a", status: "pendente" }] });

    const marcada = await req("PUT", `/v1/planejamento/${slug}/etapas/a?projectPath=${P}`, { status: "concluida", expectedRev: 2 });
    expect(marcada.json.etapas[0].status).toBe("concluida");

    const card = await req("POST", `/v1/planejamento/${slug}/cards?projectPath=${P}`, { tipo: "nota", titulo: "Nota", etapa: "a" });
    expect(card.status).toBe(201);
    expect(card.json).toMatchObject({ id: "nota", rev: 1 });

    const velho = await req("PUT", `/v1/planejamento/${slug}/cards/nota?projectPath=${P}`, { titulo: "x", expectedRev: 0 });
    expect(velho.status).toBe(409);
    expect(velho.json.atual).toMatchObject({ id: "nota", rev: 1 });

    const invalido = await req("POST", `/v1/planejamento/${slug}/cards?projectPath=${P}`, { tipo: "sugestao", titulo: "S" });
    expect(invalido.status).toBe(400);
    expect(invalido.json.error).toMatch(/fonte/);

    expect((await req("DELETE", `/v1/planejamento/${slug}/cards/nota?projectPath=${P}&rev=1`)).json).toEqual({ ok: true });
    expect((await req("GET", `/v1/planejamento/${slug}?projectPath=${P}`)).json.cards).toEqual([]);
  });

  it("layout e handoff", async () => {
    const req = cliente();
    const slug = (await req("POST", `/v1/planejamento?projectPath=${P}`, {})).json.slug as string;
    expect((await req("PUT", `/v1/planejamento/${slug}/layout?projectPath=${P}`, { posicoes: { a: { x: 1, y: 2 } } })).json).toEqual({
      posicoes: { a: { x: 1, y: 2 } },
    });
    const h = await req("POST", `/v1/planejamento/${slug}/handoff?projectPath=${P}`, { texto: "faça" });
    expect(h.status).toBe(201);
    expect((await req("GET", `/v1/planejamento/${slug}/handoff?projectPath=${P}`)).json).toMatchObject([{ nome: h.json.nome, texto: "faça\n" }]);
  });

  it("plano inexistente é 404, slug inválido é 400", async () => {
    const req = cliente();
    expect((await req("GET", `/v1/planejamento/nao-existe?projectPath=${P}`)).status).toBe(404);
    expect((await req("GET", `/v1/planejamento/A_B?projectPath=${P}`)).status).toBe(400);
  });
});
