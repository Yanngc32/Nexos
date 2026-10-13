import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveAgent } from "../src/agents.ts";
import { catalogoDoCerebro, esquecerCatalogo } from "../src/cerebro-catalogo.ts";
import { consultarCatalogo, ferramentaDoCerebro } from "../src/cerebro-ferramenta.ts";
import { esquecerUsoDoCerebro } from "../src/cerebro-uso.ts";
import { globalSkillsDir } from "../src/home.ts";
import { definicoesDeFerramenta } from "../src/mcp.ts";
import { addProfile } from "../src/profiles.ts";
import { createThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => {
  esquecerCatalogo();
  esquecerUsoDoCerebro();
});

function casa(): { home: string; projeto: string } {
  const home = tempHome();
  addProfile({ id: "p", engine: "claude" }, home, { skipBinCheck: true });
  const projeto = join(home, "proj");
  mkdirSync(projeto, { recursive: true });
  writeFileSync(join(projeto, "DOC_TEC.md"), "# Doc\n\nArquitetura do motor e do desktop.\n", "utf8");
  const skill = join(globalSkillsDir(home), "make-interfaces-feel-better");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: make-interfaces-feel-better\ndescription: Acabamento de UI.\n---\n\n# UI\n\nregras de acabamento\n", "utf8");
  saveAgent({ id: "revisor", name: "Revisor", description: "Revisa diff por bugs.", profileId: "p", subagente: true, instructions: "revise com rigor" }, home);
  return { home, projeto };
}

describe("nexo_cerebro", () => {
  it("chega ao CLI sem adiamento (_meta anthropic/alwaysLoad) e consulta sem LLM", async () => {
    const { home, projeto } = casa();
    const t = createThread({ projectPath: projeto, profileId: "p" }, home);
    const [f] = ferramentaDoCerebro(t.id, projeto, home)();
    expect(f!.name).toBe("nexo_cerebro");
    expect(definicoesDeFerramenta([f!])[0]).toMatchObject({ name: "nexo_cerebro", _meta: { "anthropic/alwaysLoad": true } });

    const r = await f!.executar({ acao: "consultar", situacao: "sobe o dev server e confere a tela de login" });
    expect(r.ok).toBe(true);
    expect(r.texto).toContain("`ferramenta:nexo_servico_subir`");
    expect(r.texto).toContain("`skill:make-interfaces-feel-better`");
    expect(r.texto.split("\n- ").length - 1).toBeLessThanOrEqual(8);

    const nada = await f!.executar({ acao: "consultar", situacao: "zzz" });
    expect(nada.ok).toBe(true);
    expect(nada.texto).toContain("Nenhuma capacidade");

    expect((await f!.executar({ acao: "consultar" })).ok).toBe(false);
    expect((await f!.executar({ acao: "x" })).ok).toBe(false);
  });

  it("ler devolve SKILL.md, doc e agente; registrar grava como pessoa", async () => {
    const { home, projeto } = casa();
    const t = createThread({ projectPath: projeto, profileId: "p" }, home);
    const [f] = ferramentaDoCerebro(t.id, projeto, home)();

    expect((await f!.executar({ acao: "ler", id: "skill:make-interfaces-feel-better" })).texto).toContain("regras de acabamento");
    expect((await f!.executar({ acao: "ler", id: "doc:DOC_TEC.md" })).texto).toContain("Arquitetura do motor");
    expect((await f!.executar({ acao: "ler", id: "agente:revisor" })).texto).toContain("revise com rigor");
    expect((await f!.executar({ acao: "ler", id: "skill:nao-existe" })).ok).toBe(false);

    const reg = await f!.executar({ acao: "registrar", id: "agente:revisor", nota: "antes do PR" });
    expect(reg.ok).toBe(true);
    const cap = catalogoDoCerebro(projeto, home).find((c) => c.id === "agente:revisor")!;
    expect(cap.origem).toBe("pessoa");
    expect(cap.gatilhos).toContain("antes do pr");
    expect(cap.gatilhos).toContain("revisa");

    const nova = await f!.executar({ acao: "registrar", id: "doc:runbook", nota: "Como subir em produção.", campo: "descricao", tipo: "doc", nome: "Runbook", caminho: join(projeto, "DOC_TEC.md") });
    expect(nova.ok).toBe(true);
    expect(catalogoDoCerebro(projeto, home).find((c) => c.id === "doc:runbook")).toMatchObject({ nome: "Runbook", descricao: "Como subir em produção.", origem: "pessoa" });

    expect((await f!.executar({ acao: "registrar", id: "skill:sumida", nota: "x" })).texto).toContain("não existe");
  });

  it("num run, registrar pede confirmação e cancela sem 'sim'", async () => {
    const { home, projeto } = casa();
    const run = createThread({ projectPath: projeto, profileId: "p", runId: "r1" }, home);
    const [f] = ferramentaDoCerebro(run.id, projeto, home)();
    // sem ninguém pra responder, a pergunta fica pendente: resolvemos pelo módulo de perguntas
    const { responderPergunta } = await import("../src/perguntas.ts");
    const pedido = f!.executar({ acao: "registrar", id: "agente:revisor", nota: "no run" });
    await new Promise((r) => setTimeout(r, 20));
    expect(responderPergunta(run.id, "não")).toBe(true);
    const r = await pedido;
    expect(r.ok).toBe(false);
    expect(r.texto).toContain("cancelado");
    expect(catalogoDoCerebro(projeto, home).find((c) => c.id === "agente:revisor")!.gatilhos).not.toContain("no run");
  });

  it("consultarCatalogo: gatilho pesa mais que termo solto, e run não vê ferramenta de chat", () => {
    const { home, projeto } = casa();
    const itens = catalogoDoCerebro(projeto, home);
    const chat = consultarCatalogo("mock da tela", itens, { tipo: "chat" });
    expect(chat[0]!.id).toBe("ferramenta:nexo_mock_salvar");
    expect(consultarCatalogo("mock da tela", itens, { tipo: "run" }).map((c) => c.id)).not.toContain("ferramenta:nexo_mock_salvar");
  });
});
