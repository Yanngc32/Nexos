import { describe, it, expect, vi } from "vitest";
import { tempHome } from "./helpers.ts";
import { ferramentasDeMemoria, MCP_TOOLS_MEMORIA, type EventoMemoriaDaFerramenta } from "../src/memorias/ferramentas.ts";
import { lerMemoria } from "../src/memorias/nucleo.ts";

function ferramentas(home: string, threadId?: string, aoSalvar?: (ev: EventoMemoriaDaFerramenta) => void) {
  const lista = ferramentasDeMemoria(home, threadId, aoSalvar)();
  const pegar = (nome: string) => {
    const f = lista.find((x) => x.name === nome);
    if (!f) throw new Error(`sem ${nome}`);
    return (args: Record<string, unknown> = {}) => Promise.resolve(f.executar(args));
  };
  return { lista, list: pegar("memory_list"), propose: pegar("memory_propose"), status: pegar("memory_status"), secret: pegar("memory_secret_get") };
}

describe("ferramentas MCP de memória", () => {
  it("expõe as quatro, com os nomes do --allowed-tools", () => {
    const { lista } = ferramentas(tempHome());
    expect(lista.map((f) => f.name)).toEqual(["memory_list", "memory_propose", "memory_status", "memory_secret_get"]);
    expect(MCP_TOOLS_MEMORIA).toEqual(lista.map((f) => `mcp__nexo__${f.name}`));
    for (const f of lista) expect(f.inputSchema).toMatchObject({ type: "object" });
  });

  it("memory_list vazio, depois create e a lista mostra a revisão", async () => {
    const home = tempHome();
    const t = ferramentas(home);
    expect((await t.list()).texto).toBe("Nenhuma memória gravada ainda.");
    const c = await t.propose({ op: "create", rel_path: "deploy.md", title: "Deploy", hook: "quando publicar", body: "Via deploy.sh." });
    expect(c).toEqual({ ok: true, texto: "Criada: deploy.md (revisão 1)." });
    expect((await t.list()).texto).toBe("- deploy.md (revisão 1) — Deploy: quando publicar");
    expect((await t.list({ query: "café" })).texto).toContain('Nenhuma memória combina com "café"');
  });

  it("update com revisão certa sobe; revisão velha devolve a revisão atual e não grava", async () => {
    const home = tempHome();
    const t = ferramentas(home);
    await t.propose({ op: "create", rel_path: "deploy.md", title: "Deploy", hook: "quando publicar", body: "v1" });
    expect(await t.propose({ op: "update", rel_path: "deploy.md", body: "v2", expected_revision: 1 })).toEqual({ ok: true, texto: "Atualizada: deploy.md (revisão 2)." });
    const conflito = await t.propose({ op: "update", rel_path: "deploy.md", body: "v3", expected_revision: 1 });
    expect(conflito.ok).toBe(false);
    expect(conflito.texto).toContain("Revisão atual: 2");
    expect(conflito.texto).toContain("expected_revision = 2");
    expect(lerMemoria(home, "deploy.md")?.corpo.trim()).toBe("v2");
  });

  it("entrada inválida é recusada com motivo", async () => {
    const t = ferramentas(tempHome());
    expect((await t.propose({ op: "apagar", rel_path: "x.md" })).ok).toBe(false);
    expect((await t.propose({ op: "create" })).texto).toContain("rel_path");
    expect((await t.propose({ op: "create", rel_path: "x.md", secrets: "abc" })).texto).toContain("secrets");
    const semCorpo = await t.propose({ op: "create", rel_path: "x.md", title: "X", hook: "quando" });
    expect(semCorpo.ok).toBe(false);
    expect(semCorpo.texto).toContain("Não gravei x.md");
  });

  it("aoSalvar recebe cada gravação com op, origem agente e threadId", async () => {
    const eventos: EventoMemoriaDaFerramenta[] = [];
    const t = ferramentas(tempHome(), "t-1", (ev) => eventos.push(ev));
    await t.propose({ op: "create", rel_path: "a.md", title: "A", hook: "sempre", body: "corpo" });
    await t.propose({ op: "retire", rel_path: "a.md", expected_revision: 1 });
    await t.propose({ op: "update", rel_path: "nao-existe.md", body: "x", expected_revision: 1 });
    expect(eventos).toEqual([
      { relPath: "a.md", titulo: "A", op: "create", origem: "agente", threadId: "t-1" },
      { relPath: "a.md", titulo: "A", op: "retire", origem: "agente", threadId: "t-1" },
    ]);
  });

  it("aoSalvar que lança não derruba a gravação", async () => {
    const aoSalvar = vi.fn(() => {
      throw new Error("ui caiu");
    });
    const t = ferramentas(tempHome(), undefined, aoSalvar);
    expect((await t.propose({ op: "create", rel_path: "a.md", title: "A", hook: "sempre", body: "corpo" })).ok).toBe(true);
    expect(aoSalvar).toHaveBeenCalledOnce();
  });

  it("segredo: vai pro cofre, list/status nunca mostram o valor, secret_get devolve", async () => {
    const home = tempHome();
    const t = ferramentas(home);
    const c = await t.propose({
      op: "create",
      rel_path: "banco.md",
      title: "Banco",
      hook: "acesso ao banco",
      body: "Senha: {{secret:banco.senha}}",
      secrets: [{ name: "banco.senha", value: "hunter2-muito-longa" }],
    });
    expect(c.ok).toBe(true);
    expect(c.texto).toContain("Segredos no cofre: banco.senha");
    expect(c.texto).not.toContain("hunter2");
    const st = await t.status();
    expect(st.texto).toContain("1 ativa(s)");
    expect(st.texto).toContain("banco.senha");
    expect(st.texto).not.toContain("hunter2");
    expect((await t.list()).texto).not.toContain("hunter2");
    expect(await t.secret({ name: "banco.senha" })).toEqual({ ok: true, texto: "hunter2-muito-longa" });
    expect((await t.secret({ name: "outro" })).ok).toBe(false);
    expect((await t.secret({})).ok).toBe(false);
  });
});
