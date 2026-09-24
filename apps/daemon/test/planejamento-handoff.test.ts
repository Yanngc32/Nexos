import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { abrirPlano, criarPlano, listarHandoffs, salvarCard, salvarRoteiro } from "../src/planejamento.ts";
import { montarHandoff, pedidoAoManager, prontidao } from "../src/planejamento-handoff.ts";
import { addProfile } from "../src/profiles.ts";
import { threadHead } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const P = "/projetos/handoff";

function planoPronto(home: string) {
  const { slug } = criarPlano(P, home, { titulo: "Login novo" });
  salvarRoteiro(P, home, slug, {
    expectedRev: 1,
    etapas: [
      { id: "api", titulo: "API", status: "concluida" },
      { id: "tela", titulo: "Tela", status: "em_andamento" },
      { id: "vazia", titulo: "Vazia" },
    ],
  });
  salvarCard(P, home, slug, { expectedRev: 0, id: "jwt", tipo: "decisao", titulo: "JWT", etapa: "api", corpo: "Porque é stateless." });
  salvarCard(P, home, slug, { expectedRev: 0, id: "hono", tipo: "sugestao", titulo: "Hono", etapa: "api", fonte: "https://hono.dev" });
  salvarCard(P, home, slug, { expectedRev: 0, id: "form", tipo: "requisito", titulo: "Formulário", etapa: "tela", corpo: "E-mail e senha." });
  salvarCard(P, home, slug, { expectedRev: 0, id: "sso", tipo: "ambiguidade", titulo: "SSO?", etapa: "tela" });
  salvarCard(P, home, slug, { expectedRev: 0, id: "solta", tipo: "nota", titulo: "Solta" });
  return slug;
}

describe("prontidão", () => {
  it("ambiguidade aberta bloqueia; etapa sem card e não concluída avisam", () => {
    const home = tempHome();
    const p = prontidao(abrirPlano(P, home, planoPronto(home)));
    expect(p.bloqueios.map((b) => b.ref)).toEqual(["sso"]);
    expect(p.avisos.map((a) => `${a.tipo}:${a.ref}`)).toEqual(["etapa-sem-card:vazia", "etapa-nao-concluida:tela", "etapa-nao-concluida:vazia"]);
  });

  it("roteiro vazio avisa", () => {
    const home = tempHome();
    const { slug } = criarPlano(P, home);
    expect(prontidao(abrirPlano(P, home, slug)).avisos.map((a) => a.tipo)).toEqual(["roteiro-vazio"]);
  });
});

describe("rascunho", () => {
  it("é determinístico e traz etapas, requisitos, decisões com porquê, fonte, abertas e como trabalhar", () => {
    const home = tempHome();
    const plano = abrirPlano(P, home, planoPronto(home));
    const t = montarHandoff(plano);
    expect(montarHandoff(plano)).toBe(t);
    expect(t).toMatch(/^# Implementação: Login novo/);
    expect(t).toContain("1. **API** (`api`) — concluída\n   - Decisão: JWT (`cards/jwt.md`)\n   - Sugestão: Hono (`cards/hono.md`)");
    expect(t).toContain("## Cards fora das etapas\n\n- Nota: Solta");
    expect(t).toContain("### JWT (`cards/jwt.md`)\n\nPorque é stateless.");
    expect(t).toContain("Fonte: https://hono.dev");
    expect(t).toContain("**SSO?** (`cards/sso.md`) — sem decisão");
    expect(t).toContain("## Como trabalhar");
  });

  it("pedido ao Manager avisa das ambiguidades abertas", () => {
    const home = tempHome();
    const plano = abrirPlano(P, home, planoPronto(home));
    expect(pedidoAoManager(plano)).toContain("nexo_plano_handoff");
    expect(pedidoAoManager(plano, 2)).toContain("2 ambiguidades continuam abertas");
  });
});

describe("rotas do envio", () => {
  it("rascunho + enviar: grava o handoff e cria a conversa de implementação", async () => {
    const home = tempHome();
    addProfile({ id: "s1", engine: "stub" }, home, { skipBinCheck: true });
    const slug = planoPronto(home);
    const app = createApp(home, "tk");
    const h = { authorization: "Bearer tk", "content-type": "application/json" };
    const q = `projectPath=${encodeURIComponent(P)}`;

    const r = (await (await app.request(`/v1/planejamento/${slug}/handoff/rascunho?${q}`, { headers: h })).json()) as {
      texto: string;
      prontidao: { bloqueios: unknown[] };
      pedido: string;
    };
    expect(r.texto).toContain("# Implementação: Login novo");
    expect(r.prontidao.bloqueios).toHaveLength(1);
    expect(r.pedido).toContain("uma ambiguidade continua aberta");

    expect((await app.request(`/v1/planejamento/${slug}/handoff/enviar?${q}`, { method: "POST", headers: h, body: JSON.stringify({ texto: "x" }) })).status).toBe(400);
    const res = await app.request(`/v1/planejamento/${slug}/handoff/enviar?${q}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ texto: "# Faça isso", profileId: "s1" }),
    });
    expect(res.status).toBe(201);
    const { threadId, handoff } = (await res.json()) as { threadId: string; handoff: string };
    expect(threadHead(threadId, home)).toMatchObject({ preview: "Implementação: Login novo" });
    expect(listarHandoffs(P, home, slug).map((x) => [x.nome, x.texto])).toEqual([[handoff, "# Faça isso\n"]]);
  });
});
