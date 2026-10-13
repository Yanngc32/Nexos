import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@nexos/shared";
import { saveAgent } from "../src/agents.ts";
import { ajustarCapacidade, catalogoDoCerebro, conteudoDaCapacidade, esquecerCatalogo, kpisDoCatalogo, removerAjuste } from "../src/cerebro-catalogo.ts";
import { esquecerUsoDoCerebro, varrerConversas } from "../src/cerebro-uso.ts";
import { globalSkillsDir } from "../src/home.ts";
import { memoriaPath } from "../src/memoria.ts";
import { addProfile } from "../src/profiles.ts";
import { projectDir } from "../src/projeto-dir.ts";
import { saveTeam } from "../src/teams.ts";
import { appendEvent, createThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => {
  esquecerCatalogo();
  esquecerUsoDoCerebro();
});

function casa(): { home: string; projeto: string } {
  const home = tempHome();
  addProfile({ id: "p", engine: "claude" }, home, { skipBinCheck: true });
  const projeto = join(home, "proj");
  mkdirSync(join(projeto, "docs", "specs"), { recursive: true });
  writeFileSync(join(projeto, "DOC_TEC.md"), "# Doc técnica\n\nComo o motor funciona por dentro.\n", "utf8");
  writeFileSync(join(projeto, "CHANGELOG.md"), "# changelog\n\n- coisa\n", "utf8");
  writeFileSync(join(projeto, "docs", "specs", "a.md"), "---\nx: 1\n---\n# Spec A\n\nDesenho da feature A.\n", "utf8");
  const skill = join(globalSkillsDir(home), "caveman");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: caveman\ndescription: Fala curta e direta.\n---\n\n# Caveman\n\ncorpo da skill\n", "utf8");
  return { home, projeto };
}

describe("catálogo do Cérebro", () => {
  it("monta a parte auto: ferramentas, skill, agente, time, memória e docs, com gatilhos curados", () => {
    const { home, projeto } = casa();
    saveAgent({ id: "explorador", name: "Explorador", description: "Varre código e devolve conclusão.", profileId: "p", subagente: true }, home);
    saveAgent({ id: "redator", name: "Redator", description: "Escreve textos.", profileId: "p" }, home);
    saveTeam({ id: "qa", name: "QA", description: "Revisa e testa.", topology: "pipeline", members: [{ agentId: "explorador" }, { agentId: "redator" }] }, home);
    mkdirSync(join(projectDir(projeto, home), "memoria"), { recursive: true });
    writeFileSync(memoriaPath(projeto, home), "# Memória\n\nEstado atual do projeto.\n", "utf8");

    const itens = catalogoDoCerebro(projeto, home);
    const por = (id: string) => itens.find((i) => i.id === id);

    const perg = por("ferramenta:nexo_perguntar")!;
    expect(perg).toMatchObject({ tipo: "ferramenta", nome: "nexo_perguntar", origem: "auto", ligada: true, escopo: "global", usos30d: 0 });
    expect(perg.descricao.length).toBeLessThanOrEqual(120);
    expect(perg.gatilhos).toContain("decisão");
    expect(perg.comoUsar).toContain("nexo_perguntar");
    expect(por("ferramenta:nexo_tarefa_salvar")).toBeDefined();
    expect(por("ferramenta:nexo_delegar")).toBeDefined();
    expect(por("ferramenta:nexo_servico_subir")).toBeDefined();

    expect(por("skill:caveman")).toMatchObject({ tipo: "skill", descricao: "Fala curta e direta.", comoUsar: "Skill `caveman`" });
    expect(por("skill:caveman")!.caminho).toMatch(/SKILL\.md$/);

    expect(por("agente:explorador")!.comoUsar).toContain("subagent_type=`explorador`");
    expect(por("agente:explorador")!.gatilhos).toContain("onde fica");
    expect(por("agente:redator")!.comoUsar).toContain("nexo_delegar com agentId=`redator`");
    expect(por("time:qa")).toMatchObject({ tipo: "time", nome: "QA", descricao: "Revisa e testa." });
    expect(por("time:qa")!.comoUsar).toContain("teamId=`qa`");

    expect(por("memoria:projeto")).toMatchObject({ tipo: "memoria", descricao: "Estado atual do projeto.", escopo: "projeto" });
    expect(por("doc:DOC_TEC.md")).toMatchObject({ tipo: "doc", descricao: "Como o motor funciona por dentro.", comoUsar: "Read DOC_TEC.md" });
    expect(por("doc:docs/specs/a.md")).toMatchObject({ descricao: "Desenho da feature A." });
    expect(por("doc:CHANGELOG.md")).toBeUndefined();

    const k = kpisDoCatalogo(itens);
    expect(k.total).toBe(itens.length);
    expect(k.pessoa).toBe(0);
    expect(k.nuncaUsadas).toBe(itens.length);

    // sem projeto: só o que é global (nada de doc/memória do projeto/tarefas)
    const geral = catalogoDoCerebro(undefined, home);
    expect(geral.find((i) => i.id === "doc:DOC_TEC.md")).toBeUndefined();
    expect(geral.find((i) => i.id === "ferramenta:nexo_tarefa_salvar")).toBeUndefined();
    expect(geral.find((i) => i.id === "ferramenta:nexo_perguntar")).toBeDefined();
  });

  it("ajuste da pessoa fica por cima do auto, não é sobrescrito, e some ao remover", () => {
    const { home, projeto } = casa();
    const antes = catalogoDoCerebro(projeto, home).find((i) => i.id === "ferramenta:nexo_perguntar")!;

    const depois = ajustarCapacidade("ferramenta:nexo_perguntar", { descricao: "Pergunta com botões.", gatilhos: ["Escolha", " decidir ", "escolha"] }, { projectPath: projeto }, home);
    expect(depois).toMatchObject({ origem: "pessoa", descricao: "Pergunta com botões.", gatilhos: ["escolha", "decidir"], comoUsar: antes.comoUsar });
    expect(existsSync(join(projectDir(projeto, home), "cerebro", "catalogo.json"))).toBe(true);

    // regenerar a parte auto não apaga a edição
    esquecerCatalogo();
    expect(catalogoDoCerebro(projeto, home).find((i) => i.id === "ferramenta:nexo_perguntar")).toMatchObject({ origem: "pessoa", descricao: "Pergunta com botões." });

    // desligar no projeto não muda a origem (continua auto se só mudou `ligada`)
    const off = ajustarCapacidade("skill:caveman", { ligada: false }, { projectPath: projeto }, home);
    expect(off).toMatchObject({ ligada: false, origem: "auto" });

    // ajuste global vale no projeto; o do projeto ganha
    ajustarCapacidade("skill:caveman", { descricao: "Global diz isto." }, { escopo: "global" }, home);
    expect(catalogoDoCerebro(projeto, home).find((i) => i.id === "skill:caveman")).toMatchObject({ descricao: "Global diz isto.", ligada: false, origem: "pessoa" });
    expect(catalogoDoCerebro(undefined, home).find((i) => i.id === "skill:caveman")).toMatchObject({ descricao: "Global diz isto.", ligada: true });

    expect(removerAjuste("ferramenta:nexo_perguntar", { projectPath: projeto }, home)).toBe(true);
    expect(removerAjuste("ferramenta:nexo_perguntar", { projectPath: projeto }, home)).toBe(false);
    expect(catalogoDoCerebro(projeto, home).find((i) => i.id === "ferramenta:nexo_perguntar")).toMatchObject({ origem: "auto", descricao: antes.descricao });
  });

  it("capacidade criada pela pessoa exige tipo, nome e descrição; doc exige caminho; valida tetos", () => {
    const { home, projeto } = casa();
    expect(() => ajustarCapacidade("doc:guia", { descricao: "x" }, { projectPath: projeto }, home)).toThrow(/tipo/);
    expect(() => ajustarCapacidade("doc:guia", { tipo: "doc", nome: "Guia", descricao: "x" }, { projectPath: projeto }, home)).toThrow(/caminho/);
    expect(() => ajustarCapacidade("skill:x", { tipo: "doc", nome: "x", descricao: "x" }, { projectPath: projeto }, home)).toThrow(/não bate/);
    expect(() => ajustarCapacidade("skill:x", { tipo: "skill", nome: "x", descricao: "a".repeat(121) }, { projectPath: projeto }, home)).toThrow(/120/);
    expect(() => ajustarCapacidade("lixo", {}, { projectPath: projeto }, home)).toThrow(/id inválido/);

    const guia = join(projeto, "GUIA.md");
    writeFileSync(guia, "# Guia\n\nComo rodar.\n", "utf8");
    const cap = ajustarCapacidade("doc:guia", { tipo: "doc", nome: "Guia de uso", descricao: "Como rodar o projeto.", caminho: guia, gatilhos: ["como rodo"] }, { projectPath: projeto }, home);
    expect(cap).toMatchObject({ tipo: "doc", nome: "Guia de uso", origem: "pessoa", escopo: "projeto", ligada: true, gatilhos: ["como rodo"] });
    expect(kpisDoCatalogo(catalogoDoCerebro(projeto, home)).pessoa).toBe(1);

    expect(conteudoDaCapacidade("doc:guia", projeto, home)?.texto).toContain("Como rodar.");
    expect(conteudoDaCapacidade("skill:caveman", projeto, home)?.texto).toContain("corpo da skill");
    expect(conteudoDaCapacidade("nada:x", projeto, home)).toBeNull();

    const arquivo = JSON.parse(readFileSync(join(projectDir(projeto, home), "cerebro", "catalogo.json"), "utf8")) as { itens: Record<string, { tipo: string }> };
    expect(arquivo.itens["doc:guia"]!.tipo).toBe("doc");
  });

  it("traz os usos do contador (delegação conta no agente alvo) e ordena por usos 30d", async () => {
    const { home, projeto } = casa();
    saveAgent({ id: "redator", name: "Redator", description: "Escreve.", profileId: "p" }, home);
    const chat = createThread({ projectPath: projeto, profileId: "p" }, home);
    const tool = (name: string, input: unknown): ThreadEvent =>
      ({ ts: new Date().toISOString(), type: "tool", threadId: chat.id, name, summary: name, input }) as ThreadEvent;
    appendEvent(tool("mcp__nexo__nexo_perguntar", {}), home);
    appendEvent(tool("mcp__nexo__nexo_perguntar", {}), home);
    appendEvent(tool("Skill", { skill: "caveman" }), home);
    appendEvent(tool("mcp__nexo__nexo_delegar", { agentId: "redator", pedido: "x" }), home);
    await varrerConversas(home);

    const itens = catalogoDoCerebro(projeto, home);
    expect(itens[0]).toMatchObject({ id: "ferramenta:nexo_perguntar", usos7d: 2, usos30d: 2 });
    expect(itens.find((i) => i.id === "skill:caveman")).toMatchObject({ usos7d: 1 });
    expect(itens.find((i) => i.id === "agente:redator")).toMatchObject({ usos7d: 1 });
    expect(itens.find((i) => i.id === "agente:redator")!.ultimoUso).toBeDefined();
    const k = kpisDoCatalogo(itens);
    expect(k.usadas7d).toBe(3);
    expect(k.nuncaUsadas).toBe(itens.length - 3);
  });
});
