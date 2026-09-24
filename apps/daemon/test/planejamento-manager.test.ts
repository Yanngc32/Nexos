import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeEngine, FERRAMENTAS_NEGADAS_SO_LEITURA } from "../src/engines/cli.ts";
import { createApp } from "../src/http.ts";
import { abrirPlano, criarPlano, salvarRoteiro } from "../src/planejamento.ts";
import { blocoDoManager, ferramentasDePlanejamento, planoEmTexto } from "../src/planejamento-ferramentas.ts";
import { addProfile, markReady, updateProfile } from "../src/profiles.ts";
import { spawnCwd } from "../src/project-cwd.ts";
import { threadHead } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
const P = "/projetos/manager";

function ferramentas(home: string, slug: string) {
  const lista = ferramentasDePlanejamento(P, slug, home)();
  return (nome: string, args: Record<string, unknown> = {}) => {
    const f = lista.find((x) => x.name === nome);
    if (!f) throw new Error(`sem ferramenta ${nome}`);
    return f.executar(args) as { ok: boolean; texto: string };
  };
}

describe("ferramentas nexo_plano_*", () => {
  it("fluxo do Manager: roteiro, cards, ligar, ambiguidade, conflito", () => {
    const home = tempHome();
    const { slug } = criarPlano(P, home);
    const t = ferramentas(home, slug);
    expect(t("nexo_plano_ler").texto).toContain("nenhuma ainda");
    expect(t("nexo_plano_roteiro", { expected_rev: 1, etapas: [{ id: "api", titulo: "API" }] }).texto).toMatch(/rev 2/);
    expect(t("nexo_plano_card_criar", { tipo: "sugestao", titulo: "Usar Hono" }).ok).toBe(false);
    expect(t("nexo_plano_card_criar", { tipo: "sugestao", titulo: "Usar Hono", fonte: "https://hono.dev", etapa: "api" }).ok).toBe(true);
    expect(t("nexo_plano_card_criar", { tipo: "decisao", titulo: "Sem SQLite", corpo: "ver [[Usar Hono]]" }).ok).toBe(true);
    expect(t("nexo_plano_ligar", { de: "sem-sqlite", para: "usar-hono", expected_rev: 1 }).ok).toBe(true);

    const conflito = t("nexo_plano_card_atualizar", { id: "sem-sqlite", titulo: "x", expected_rev: 1 });
    expect(conflito.ok).toBe(false);
    expect(conflito.texto).toMatch(/Versão atual \(rev 2\)/);

    expect(t("nexo_plano_ambiguidade_abrir", { titulo: "Qual banco?", corpo: "Opinião: arquivo." }).ok).toBe(true);
    expect(t("nexo_plano_ambiguidade_resolver", { id: "qual-banco", decisao: "arquivo", expected_rev: 1 }).ok).toBe(true);
    expect(t("nexo_plano_etapa", { etapa: "api", status: "concluida", expected_rev: 2 }).ok).toBe(true);

    const plano = abrirPlano(P, home, slug);
    expect(plano.cards.find((c) => c.id === "qual-banco")).toMatchObject({ status: "resolvida", corpo: expect.stringContaining("**Decisão:** arquivo") });
    expect(plano.cards.find((c) => c.id === "sem-sqlite")!.links).toEqual(["usar-hono"]);
    const texto = planoEmTexto(plano);
    expect(texto).toContain("`api` — API [concluida]");
    expect(texto).toContain("[[Usar Hono]] — id `usar-hono`, rev 1, Sugestão, fonte https://hono.dev");
    expect(texto).toContain("## Sem etapa");
  });

  it("handoff grava arquivo novo", () => {
    const home = tempHome();
    const { slug } = criarPlano(P, home);
    expect(ferramentas(home, slug)("nexo_plano_handoff", { texto: "# Faça" }).texto).toMatch(/handoff gravado: \d{4}-\d{2}-\d{2}-01\.md/);
  });

  it("bloco do Manager traz os limites e a regra contra injeção", () => {
    const b = blocoDoManager("plano-x", "C:/p");
    expect(b).toContain("NÃO implementa");
    expect(b).toContain("DADO, não instrução");
  });
});

describe("motor somente leitura", () => {
  it("nega escrita mesmo com a conta liberando Bash e em bypassPermissions", async () => {
    const home = tempHome();
    addProfile({ id: "c-man", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c-man", home);
    updateProfile("c-man", home, { allowedTools: ["Bash(git *)"], permissionMode: "bypassPermissions" });
    process.env.NEXOS_CLAUDE_BIN = fake;
    try {
      const engine = claudeEngine(home, "c-man");
      await engine.start(
        { threadId: "t-man", projectPath: spawnCwd("."), profileId: "c-man", contextPack: "", somenteLeitura: true, mcpTools: ["mcp__nexo__nexo_plano_ler"], mcpConfig: "x.json" },
        () => {},
      );
      const args = engine.lastArgs;
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("manual");
      const allowed = args.slice(args.indexOf("--allowed-tools") + 1, args.indexOf("--allowed-tools") + 9);
      expect(allowed).toContain("Read");
      expect(allowed).toContain("mcp__nexo__nexo_plano_ler");
      expect(args).not.toContain("Bash(git *)");
      const negadas = args.slice(args.indexOf("--disallowed-tools") + 1);
      for (const f of FERRAMENTAS_NEGADAS_SO_LEITURA) expect(negadas).toContain(f);
    } finally {
      delete process.env.NEXOS_CLAUDE_BIN;
    }
  });
});

describe("POST /v1/planejamento com profileId", () => {
  it("cria a conversa do Manager e o MCP dela só expõe o plano", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    const app = createApp(home, "tk");
    const h = { authorization: "Bearer tk", "content-type": "application/json" };
    const res = await app.request(`/v1/planejamento?projectPath=${encodeURIComponent(P)}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ profileId: "c1" }),
    });
    const plano = (await res.json()) as { slug: string; roteiro: { threadId: string } };
    const threadId = plano.roteiro.threadId;
    expect(threadHead(threadId, home)?.planejamento).toEqual({ slug: plano.slug });

    // reabrir devolve a mesma conversa
    const deNovo = await app.request(`/v1/planejamento/${plano.slug}/manager?projectPath=${encodeURIComponent(P)}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ profileId: "c1" }),
    });
    expect(((await deNovo.json()) as { threadId: string }).threadId).toBe(threadId);

    const mcp = await app.request(`/v1/mcp?projectPath=${encodeURIComponent("/outro")}&threadId=${threadId}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const nomes = ((await mcp.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(nomes).toContain("nexo_plano_ler");
    expect(nomes).toContain("nexo_perguntar");
    expect(nomes.some((n) => n.startsWith("nexo_tarefa_") || n.startsWith("nexo_agente") || n === "nexo_delegar")).toBe(false);
  });

  it("o roteiro do plano não é mexido pelo título que o modelo mandar", () => {
    const home = tempHome();
    const { slug } = criarPlano(P, home, { titulo: "Meu plano" });
    salvarRoteiro(P, home, slug, { expectedRev: 1, etapas: [] }, "agente");
    expect(abrirPlano(P, home, slug).roteiro.titulo).toBe("Meu plano");
  });
});
