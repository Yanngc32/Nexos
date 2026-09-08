import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { destinoDaSkill, instalarSkill, origemDaSkill } from "../src/skill.ts";
import { ferramentasDeAutoria } from "../src/autoria.ts";
import { tempHome } from "./helpers.ts";

const skill = () => readFileSync(origemDaSkill(), "utf8");

describe("instalarSkill", () => {
  it("põe em ~/.claude/skills, escopo de usuário", () => {
    // usuário e não projeto: vale em todos de uma vez, e o Nexo não escreve
    // dentro do repositório de ninguém sem pedir
    const base = mkdtempSync(join(tmpdir(), "nexo-skill-"));
    const r = instalarSkill(base);
    expect(r.ok).toBe(true);
    expect(r.destino).toBe(join(base, ".claude", "skills", "nexo-times", "SKILL.md"));
    expect(readFileSync(r.destino, "utf8")).toBe(skill());
  });

  it("é idempotente: instalar de novo só sobrescreve", () => {
    const base = mkdtempSync(join(tmpdir(), "nexo-skill-"));
    instalarSkill(base);
    expect(instalarSkill(base).ok).toBe(true);
  });

  it("cria a árvore de pastas que não existe", () => {
    const base = mkdtempSync(join(tmpdir(), "nexo-skill-"));
    expect(existsSync(join(base, ".claude"))).toBe(false);
    expect(instalarSkill(base).ok).toBe(true);
  });
});

describe("a skill", () => {
  it("existe no repositório, com o cabeçalho que o CLI exige", () => {
    const t = skill();
    expect(t.startsWith("---\n")).toBe(true);
    expect(t).toMatch(/^name: nexo-times$/m);
    // é a `description` que decide se ele carrega a skill na hora certa
    expect(t).toMatch(/^description: .{40,}$/m);
  });

  it("não repete as regras que já estão nas descrições das ferramentas", () => {
    /*
     * A divisão é o desenho: regra mecânica (teto de membros, formato de id)
     * mora na ferramenta, que o modelo lê a cada turno; julgamento (quando vale
     * um time) mora aqui. Duplicar faria as duas divergirem, e a que envelhece
     * é sempre a que está longe do código.
     */
    const t = skill();
    expect(t).not.toMatch(/8 membros|minúsculas, números/);
    expect(t, "o julgamento é o conteúdo dela").toMatch(/vale a pena/i);
  });

  it("fala das mesmas ferramentas que o daemon serve — nome errado é skill inútil", async () => {
    const nomes = ferramentasDeAutoria(tempHome())().map((f) => f.name);
    const t = skill();
    for (const n of nomes) expect(t, n).toContain(n);
  });

  it("diz que criar não é rodar", () => {
    // o modelo não dispara run, e prometer resultado do que não rodou é o pior
    // jeito de a pessoa descobrir isso
    expect(skill()).toMatch(/não executa/i);
  });
});
