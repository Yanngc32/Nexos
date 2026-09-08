import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globalSkillsDir } from "../src/home.ts";
import { addProfile } from "../src/profiles.ts";
import { listSkills } from "../src/skills.ts";
import { tempHome } from "./helpers.ts";

function criaSkillGlobal(home: string, nome: string): void {
  const dir = join(globalSkillsDir(home), nome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${nome}\ndescription: skill de teste\n---\n`, "utf8");
}

describe("listSkills", () => {
  it("perfil claude enxerga skill global — é o motor que sabe ler SKILL.md", () => {
    const home = tempHome();
    criaSkillGlobal(home, "caveman");
    addProfile({ id: "conta-claude", engine: "claude" }, home, { skipBinCheck: true });
    const skills = listSkills(home, "conta-claude", undefined);
    expect(skills.map((s) => s.name)).toContain("caveman");
  });

  it("perfil codex não enxerga skill global — codex não lê SKILL.md, menu não deve prometer o que não vale", () => {
    const home = tempHome();
    criaSkillGlobal(home, "caveman");
    addProfile({ id: "conta-codex", engine: "codex" }, home, { skipBinCheck: true });
    const skills = listSkills(home, "conta-codex", undefined);
    expect(skills.map((s) => s.name)).not.toContain("caveman");
  });

  it("sem profileId (ex.: só projeto aberto, sem conta ativa ainda) mantém a global visível", () => {
    const home = tempHome();
    criaSkillGlobal(home, "caveman");
    const skills = listSkills(home, undefined, undefined);
    expect(skills.map((s) => s.name)).toContain("caveman");
  });
});
