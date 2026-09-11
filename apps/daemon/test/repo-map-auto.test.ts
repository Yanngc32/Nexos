import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProfile } from "../src/profiles.ts";
import { getAgent, saveAgent } from "../src/agents.ts";
import { apagarRegra, listarRegras, resetHooksForTest, saveRegra } from "../src/hooks.ts";
import { AGENT_ID, desligarRepoMapResumos, gerarResumosSobDemanda, sincronizarRepoMapResumos } from "../src/repo-map-auto.ts";
import { arquivosParaResumir } from "../src/repo-map-enriquecimento.ts";
import { saveConfig } from "../src/config.ts";
import { resetRunsForTest } from "../src/runs.ts";
import { tempHome } from "./helpers.ts";

function base(): string {
  resetRunsForTest();
  resetHooksForTest();
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  return home;
}

const modulos = (patch: Partial<{ repoMapResumos: boolean; repoMapProfileId: string }>) => ({
  rtk: false,
  caveman: false,
  cavemanNivel: "full" as const,
  repoMapResumos: false,
  repoMapProfileId: "",
  ...patch,
});

describe("sincronizarRepoMapResumos", () => {
  it("módulo desligado: no-op, não cria agente nem regra", () => {
    const home = base();
    const r = sincronizarRepoMapResumos(home);
    expect(r.ok).toBe(true);
    expect(getAgent(AGENT_ID, home)).toBeUndefined();
    expect(listarRegras(home)).toEqual([]);
  });

  it("ligado sem conta configurada: reprova com motivo, não cria nada", () => {
    const home = base();
    saveConfig(home, { modulos: modulos({ repoMapResumos: true }) });
    const r = sincronizarRepoMapResumos(home);
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/conta configurada não existe/);
    expect(getAgent(AGENT_ID, home)).toBeUndefined();
  });

  it("ligado com conta inexistente: reprova", () => {
    const home = base();
    saveConfig(home, { modulos: modulos({ repoMapResumos: true, repoMapProfileId: "fantasma" }) });
    expect(sincronizarRepoMapResumos(home).ok).toBe(false);
  });

  it("ligado com conta válida: cria o agente e a regra global de git.post-commit", () => {
    const home = base();
    saveConfig(home, { modulos: modulos({ repoMapResumos: true, repoMapProfileId: "p1" }) });
    const r = sincronizarRepoMapResumos(home);
    expect(r.ok).toBe(true);
    expect(getAgent(AGENT_ID, home)?.profileId).toBe("p1");
    const regras = listarRegras(home);
    expect(regras.map((x) => x.evento)).toEqual(["git.post-commit"]);
    expect(regras.every((x) => x.agentId === AGENT_ID && x.escopo.tipo === "global")).toBe(true);
  });

  it("idempotente: rodar duas vezes não duplica regra", () => {
    const home = base();
    saveConfig(home, { modulos: modulos({ repoMapResumos: true, repoMapProfileId: "p1" }) });
    sincronizarRepoMapResumos(home);
    sincronizarRepoMapResumos(home);
    expect(listarRegras(home)).toHaveLength(1);
  });

  it("recria a regra que a pessoa apagou à mão", () => {
    const home = base();
    saveConfig(home, { modulos: modulos({ repoMapResumos: true, repoMapProfileId: "p1" }) });
    sincronizarRepoMapResumos(home);
    apagarRegra(listarRegras(home)[0]!.id, home);
    sincronizarRepoMapResumos(home);
    expect(listarRegras(home).map((x) => x.evento)).toEqual(["git.post-commit"]);
  });
});

describe("desligarRepoMapResumos", () => {
  it("apaga a regra gerenciada, mas deixa o agente", () => {
    const home = base();
    saveConfig(home, { modulos: modulos({ repoMapResumos: true, repoMapProfileId: "p1" }) });
    sincronizarRepoMapResumos(home);
    desligarRepoMapResumos(home);
    expect(listarRegras(home)).toEqual([]);
    expect(getAgent(AGENT_ID, home)).toBeTruthy();
  });

  it("não mexe numa regra alheia com o mesmo agentId de outro evento", () => {
    const home = base();
    saveAgent({ id: AGENT_ID, name: "custom", profileId: "p1" }, home);
    const alheia = saveRegra({ escopo: { tipo: "global" }, evento: "git.post-push", agentId: AGENT_ID }, home);
    desligarRepoMapResumos(home);
    expect(listarRegras(home).some((r) => r.id === alheia.id)).toBe(true);
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function tempProjetoGit(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexo-repomap-auto-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "conteudo\n", "utf8");
  git(dir, "add", "-A");
  return dir;
}

describe("gerarResumosSobDemanda", () => {
  it("sem repoMapProfileId configurado, recusa sem tentar nada", async () => {
    const home = base();
    const dir = tempProjetoGit();
    const r = await gerarResumosSobDemanda(dir, home);
    expect(r.ok).toBe(false);
    expect(r.texto).toMatch(/conta configurada não existe/);
  });

  it("funciona mesmo com o módulo desligado (repoMapResumos: false) — só precisa da conta", async () => {
    const home = base();
    const dir = tempProjetoGit();
    saveConfig(home, { modulos: modulos({ repoMapResumos: false, repoMapProfileId: "p1" }) });
    const r = await gerarResumosSobDemanda(dir, home);
    expect(r.ok).toBe(true);
    expect(r.texto).toMatch(/1 arquivo/);
    // garante o agente mesmo sem o módulo nunca ter sido sincronizado
    expect(getAgent(AGENT_ID, home)?.profileId).toBe("p1");
  });

  it("nada pendente: não dispara run nenhum", async () => {
    const home = base();
    const dir = tempProjetoGit();
    saveConfig(home, { modulos: modulos({ repoMapProfileId: "p1" }) });
    // marca o único arquivo como já resumido antes de pedir de novo
    const { gravarResumo } = await import("../src/repo-map-enriquecimento.ts");
    gravarResumo(dir, home, "a.ts", "conteudo\n", "resumo já feito");
    expect(arquivosParaResumir(dir, home)).toEqual([]);
    const r = await gerarResumosSobDemanda(dir, home);
    expect(r).toEqual({ ok: true, texto: "nada pra resumir — todo arquivo já está com resumo em dia" });
  });
});
