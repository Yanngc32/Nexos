import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { saveAgent } from "../src/agents.ts";
import {
  apagarRegra,
  dispararPrePush,
  fireHook,
  listarRegras,
  resetHooksForTest,
  saveRegra,
  sincronizarHooksDoProjeto,
} from "../src/hooks.ts";
import { consumirVeredito, registrarVeredito, resetVereditoForTest } from "../src/veredito.ts";
import { getTeam, saveTeam } from "../src/teams.ts";
import { listRuns, resetRunsForTest } from "../src/runs.ts";
import { tempHome } from "./helpers.ts";

function base(): string {
  resetRunsForTest();
  resetHooksForTest();
  resetVereditoForTest();
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  saveAgent({ id: "memoria", name: "Memória", profileId: "p1" }, home);
  saveAgent({ id: "seguranca", name: "Segurança", profileId: "p1" }, home);
  return home;
}

/** Espera até a fila de microtasks/timers do run em voo esvaziar. */
async function tick(vezes = 5): Promise<void> {
  for (let i = 0; i < vezes; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Repositório git falso — só o suficiente pra `sincronizarHooksDoProjeto` não pular. */
function repo(): string {
  const dir = tempHome();
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

describe("saveRegra / apagarRegra", () => {
  it("cria regra global e regra de projeto", () => {
    const home = base();
    const global = saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria" }, home);
    const projeto = saveRegra(
      { escopo: { tipo: "projeto", projectPath: "/proj" }, evento: "git.post-commit", agentId: "memoria" },
      home,
    );
    expect(listarRegras(home).map((r) => r.id).sort()).toEqual([global.id, projeto.id].sort());
  });

  it("recusa evento fora dos três conhecidos", () => {
    const home = base();
    expect(() =>
      saveRegra({ escopo: { tipo: "global" }, evento: "run.done", agentId: "memoria" }, home),
    ).toThrow(/evento inválido/);
  });

  it("recusa branch em git.post-commit", () => {
    const home = base();
    expect(() =>
      saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", branch: "main", agentId: "memoria" }, home),
    ).toThrow(/branch não se aplica/);
  });

  it("recusa agente inexistente", () => {
    const home = base();
    expect(() =>
      saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "fantasma" }, home),
    ).toThrow(/agente não existe/);
  });

  it("bloqueante só pega em git.pre-push — ignorado (não gravado) noutro evento", () => {
    const home = base();
    const r = saveRegra(
      { escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria", bloqueante: true },
      home,
    );
    expect(r.bloqueante).toBeUndefined();
  });

  it("nome e descrição são opcionais, com teto de tamanho", () => {
    const home = base();
    const r = saveRegra(
      { escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria", nome: "Memória", descricao: "escreve depois do commit" },
      home,
    );
    expect(r.nome).toBe("Memória");
    expect(r.descricao).toBe("escreve depois do commit");
    expect(() =>
      saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria", nome: "x".repeat(61) }, home),
    ).toThrow(/passa de 60/);
  });

  it("atualiza preservando campos não enviados", () => {
    const home = base();
    const criada = saveRegra(
      { escopo: { tipo: "projeto", projectPath: "/proj" }, evento: "git.pre-push", branch: "main", agentId: "memoria" },
      home,
    );
    const atualizada = saveRegra({ id: criada.id, agentId: "seguranca" }, home);
    expect(atualizada.agentId).toBe("seguranca");
    expect(atualizada.branch).toBe("main");
    expect(atualizada.evento).toBe("git.pre-push");
  });

  it("apagar regra inexistente lança 404", () => {
    const home = base();
    expect(() => apagarRegra("hr-inexistente", home)).toThrow(/não existe/);
  });

  it("aceita teamId em vez de agentId — time de verdade, não embrulhado", () => {
    const home = base();
    saveTeam({ id: "revisao", name: "Revisão", topology: "pipeline", members: [{ agentId: "memoria" }, { agentId: "seguranca" }] }, home);
    const r = saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", teamId: "revisao" }, home);
    expect(r.teamId).toBe("revisao");
    expect(r.agentId).toBeUndefined();
  });

  it("recusa agentId e teamId juntos", () => {
    const home = base();
    saveTeam({ id: "revisao", name: "Revisão", topology: "pipeline", members: [{ agentId: "memoria" }] }, home);
    expect(() =>
      saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria", teamId: "revisao" }, home),
    ).toThrow(/não os dois/);
  });

  it("recusa teamId de time que não existe", () => {
    const home = base();
    expect(() =>
      saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", teamId: "fantasma" }, home),
    ).toThrow(/time não existe/);
  });

  it("recusa regra sem agentId nem teamId", () => {
    const home = base();
    expect(() => saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit" }, home)).toThrow(
      /agentId ou teamId obrigatório/,
    );
  });

  it("trocar de agentId pra teamId numa edição apaga o agentId antigo (e vice-versa)", () => {
    const home = base();
    saveTeam({ id: "revisao", name: "Revisão", topology: "pipeline", members: [{ agentId: "memoria" }] }, home);
    const criada = saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria" }, home);
    const trocada = saveRegra({ id: criada.id, teamId: "revisao" }, home);
    expect(trocada.teamId).toBe("revisao");
    expect(trocada.agentId).toBeUndefined();
    const devolta = saveRegra({ id: criada.id, agentId: "seguranca" }, home);
    expect(devolta.agentId).toBe("seguranca");
    expect(devolta.teamId).toBeUndefined();
  });
});

describe("fireHook", () => {
  it("sem regra nenhuma casando não dispara", () => {
    const home = base();
    expect(fireHook("git.post-commit", "/proj", home)).toEqual({ disparado: false });
  });

  it("evento fora do padrão <categoria>.<nome> é recusado", () => {
    const home = base();
    expect(() => fireHook("git post-commit", "/proj", home)).toThrow(/evento inválido/);
  });

  it("regra global dispara em QUALQUER projeto", async () => {
    const home = base();
    saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria" }, home);
    expect(fireHook("git.post-commit", "/qualquer/projeto", home)).toEqual({ disparado: true });
    await tick();
    expect(getTeam("hook-memoria", home)).toBeTruthy();
  });

  it("regra com teamId roda o time DE VERDADE, sem embrulhar num time oculto", async () => {
    const home = base();
    saveTeam({ id: "revisao", name: "Revisão", topology: "pipeline", members: [{ agentId: "memoria" }] }, home);
    saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", teamId: "revisao" }, home);
    expect(fireHook("git.post-commit", "/proj-time", home)).toEqual({ disparado: true });
    await tick();
    expect(listRuns(home, "/proj-time").some((r) => r.teamId === "revisao")).toBe(true);
    expect(getTeam("hook-revisao", home)).toBeUndefined();
  });

  it("regra de projeto só dispara NAQUELE projeto", async () => {
    const home = base();
    saveRegra({ escopo: { tipo: "projeto", projectPath: "/proj-a" }, evento: "git.post-commit", agentId: "memoria" }, home);
    expect(fireHook("git.post-commit", "/proj-b", home)).toEqual({ disparado: false });
    expect(fireHook("git.post-commit", "/proj-a", home)).toEqual({ disparado: true });
    await tick();
  });

  it("branch filtra: só dispara quando bate (ou a regra não tem branch)", async () => {
    const home = base();
    saveRegra(
      { escopo: { tipo: "global" }, evento: "git.post-push", branch: "main", agentId: "memoria" },
      home,
    );
    expect(fireHook("git.post-push", "/proj", home, "outra")).toEqual({ disparado: false });
    expect(fireHook("git.post-push", "/proj", home, "main")).toEqual({ disparado: true });
    await tick();
  });

  it("coalesce: fire em cima de fire em voo não dispara dois runs, só agenda um re-run", async () => {
    const home = base();
    saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria" }, home);
    const primeiro = fireHook("git.post-commit", "/proj", home);
    const segundo = fireHook("git.post-commit", "/proj", home);
    expect(primeiro).toEqual({ disparado: true });
    expect(segundo).toEqual({ disparado: false });
    await tick(20);
  });

  it("agente apagado depois de configurado: loga o erro, não derruba o processo, libera pra próxima tentativa", async () => {
    const home = base();
    // Grava a regra direto no arquivo apontando pra um agente que não existe, contornando a
    // validação de `saveRegra` (que recusaria) — é o cenário real de "agente apagado depois de a
    // regra já estar configurada".
    writeFileSync(
      join(home, "hooks.json"),
      JSON.stringify({
        rules: [{ id: "hr-x", escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "fantasma" }],
      }),
      "utf8",
    );
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = fireHook("git.post-commit", "/proj", home);
      expect(r).toEqual({ disparado: true });
      await tick(10);
      expect(erro).toHaveBeenCalledWith(expect.stringContaining("nexo hook"), expect.stringMatching(/agente não existe/));
      expect(fireHook("git.post-commit", "/proj", home)).toEqual({ disparado: true });
    } finally {
      erro.mockRestore();
    }
  });
});

describe("dispararPrePush", () => {
  it("sem regra bloqueante: aprova por padrão e ainda dispara as não-bloqueantes em segundo plano", async () => {
    const home = base();
    saveRegra(
      { escopo: { tipo: "global" }, evento: "git.pre-push", agentId: "memoria" }, // bloqueante ausente = false
      home,
    );
    const r = await dispararPrePush("/proj", "main", home);
    expect(r).toEqual({ aprovado: true, motivo: "sem regra bloqueante" });
    await tick();
    expect(getTeam("hook-memoria", home)).toBeTruthy();
  });

  it("regra bloqueante sem chamar nexo_veredito: reprova por padrão (falha fechada)", async () => {
    const home = base();
    saveRegra(
      { escopo: { tipo: "global" }, evento: "git.pre-push", agentId: "seguranca", bloqueante: true },
      home,
    );
    const r = await dispararPrePush("/proj", "main", home);
    expect(r.aprovado).toBe(false);
    expect(r.motivo).toMatch(/não declarou veredito/);
  });

  it("duas regras bloqueantes: para na primeira reprovação, a segunda nem roda", async () => {
    const home = base();
    saveRegra({ escopo: { tipo: "global" }, evento: "git.pre-push", agentId: "memoria", bloqueante: true }, home);
    saveRegra({ escopo: { tipo: "global" }, evento: "git.pre-push", agentId: "seguranca", bloqueante: true }, home);
    const r = await dispararPrePush("/proj", "main", home);
    expect(r.aprovado).toBe(false);
    expect(getTeam("hook-memoria", home)).toBeTruthy();
    expect(getTeam("hook-seguranca", home)).toBeUndefined();
  });

  it("branch que não bate a regra bloqueante: não entra na decisão (aprova por padrão)", async () => {
    const home = base();
    saveRegra(
      { escopo: { tipo: "global" }, evento: "git.pre-push", branch: "main", agentId: "seguranca", bloqueante: true },
      home,
    );
    const r = await dispararPrePush("/proj", "outra-branch", home);
    expect(r).toEqual({ aprovado: true, motivo: "sem regra bloqueante" });
  });
});

describe("veredito (registrarVeredito/consumirVeredito via ferramenta)", () => {
  it("consumir apaga o veredito — uma segunda leitura vira default reprovado", () => {
    registrarVeredito("r-x", true, "tudo certo");
    expect(consumirVeredito("r-x")).toEqual({ aprovado: true, motivo: "tudo certo" });
    expect(consumirVeredito("r-x")).toEqual({ aprovado: false, motivo: "agente não declarou veredito" });
  });
});

describe("sincronizarHooksDoProjeto", () => {
  it("instala só os eventos que alguma regra (global ou do projeto) pede", () => {
    const home = base();
    const dir = repo();
    saveRegra({ escopo: { tipo: "projeto", projectPath: dir }, evento: "git.post-commit", agentId: "memoria" }, home);
    sincronizarHooksDoProjeto(dir, home);
    expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(true);
    expect(existsSync(join(dir, ".git", "hooks", "post-push"))).toBe(false);
  });

  it("regra global instala em projeto que não tinha regra própria nenhuma", () => {
    const home = base();
    const dir = repo();
    saveRegra({ escopo: { tipo: "global" }, evento: "git.pre-push", agentId: "memoria" }, home);
    sincronizarHooksDoProjeto(dir, home);
    expect(readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8")).toContain("nexo hook fire git.pre-push");
  });

  it("remover a única regra de um evento tira a linha do script (chamado de novo depois de apagar)", () => {
    const home = base();
    const dir = repo();
    const r = saveRegra(
      { escopo: { tipo: "projeto", projectPath: dir }, evento: "git.post-commit", agentId: "memoria" },
      home,
    );
    expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(true);
    apagarRegra(r.id, home);
    const conteudo = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(conteudo.trim()).toBe("");
  });

  it("silencioso fora de um repositório git", () => {
    const home = base();
    const dir = tempHome(); // sem .git
    expect(() => sincronizarHooksDoProjeto(dir, home)).not.toThrow();
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("regra GLOBAL não quebra se UM projeto conhecido tiver .git/hooks quebrado — sincroniza os outros mesmo assim", () => {
    const home = base();
    const bom = repo();
    // `.git/hooks` é um ARQUIVO em vez de pasta — installGitHookScript tenta escrever dentro
    // dele e lança ENOTDIR. Sem o try/catch em `sincronizarHooksGlobal`, isso derrubava a
    // regra INTEIRA (e o `PUT /v1/config` de quem ligou um módulo, ex. grafoAuto).
    const quebrado = tempHome();
    mkdirSync(join(quebrado, ".git"), { recursive: true });
    writeFileSync(join(quebrado, ".git", "hooks"), "não é pasta", "utf8");
    // registra os dois como "conhecidos" (sem endpoint aqui: escreve config.json direto)
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ repos: [bom, quebrado] }),
      "utf8",
    );
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        saveRegra({ escopo: { tipo: "global" }, evento: "git.post-commit", agentId: "memoria" }, home),
      ).not.toThrow();
      expect(existsSync(join(bom, ".git", "hooks", "post-commit"))).toBe(true);
      expect(erro).toHaveBeenCalledWith(expect.stringContaining("sincronizar hooks"), expect.anything());
    } finally {
      erro.mockRestore();
    }
  });
});
