import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globalSkillsDir } from "../src/home.ts";
import { addProfile } from "../src/profiles.ts";
import { expandirSkill, listSkills } from "../src/skills.ts";
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

  it("perfil codex TAMBÉM enxerga skill global — agora o menu não promete o que não vale", () => {
    /*
     * Este teste já disse o contrário: `SKILL.md` é conceito do CLI do claude,
     * então listar pra codex anunciava opção que não funcionava no turno. A
     * conclusão certa era dar o caminho, não esconder o menu — `expandirSkill`
     * carrega a skill no prompt, e aí listar passa a ser verdade.
     */
    const home = tempHome();
    criaSkillGlobal(home, "caveman");
    addProfile({ id: "conta-codex", engine: "codex" }, home, { skipBinCheck: true });
    const skills = listSkills(home, "conta-codex", undefined);
    expect(skills.map((s) => s.name)).toContain("caveman");
  });

  it("sem profileId (ex.: só projeto aberto, sem conta ativa ainda) mantém a global visível", () => {
    const home = tempHome();
    criaSkillGlobal(home, "caveman");
    const skills = listSkills(home, undefined, undefined);
    expect(skills.map((s) => s.name)).toContain("caveman");
  });
});

describe("listSkills em motor que não é claude", () => {
  it("codex e api agora ENXERGAM a skill — o Nexo é quem carrega, via expandirSkill", () => {
    /*
     * Antes o menu "/" era escondido de conta codex/api porque `SKILL.md` é
     * conceito do CLI do claude. Só que quem perdia era a pessoa: o menu inteiro
     * sumia. Agora o Nexo expande a skill no prompt, então listar é verdade.
     */
    const home = tempHome();
    criaSkillGlobal(home, "revisar");
    addProfile({ id: "conta-cx", engine: "codex" }, home, { skipBinCheck: true });
    expect(listSkills(home, "conta-cx", undefined).map((s) => s.name)).toContain("revisar");
  });
});

describe("expandirSkill", () => {
  it("troca /nome pelo corpo da skill, e diz onde a pasta está", () => {
    const home = tempHome();
    const dir = join(globalSkillsDir(home), "revisar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: revisar\ndescription: revisa\n---\nLeia o diff antes de opinar.\n",
      "utf8",
    );
    const out = expandirSkill("/revisar", home, undefined, undefined);
    expect(out).toContain("Leia o diff antes de opinar.");
    expect(out, "o frontmatter é metadado de listagem, não instrução").not.toContain("description: revisa");
    expect(out, "skill séria tem arquivo ao lado; sem o caminho o modelo não chega neles").toContain(dir);
  });

  it("o que a pessoa escreveu depois do comando é preservado", () => {
    const home = tempHome();
    criaSkillGlobal(home, "revisar");
    const out = expandirSkill("/revisar o login está lento", home, undefined, undefined);
    expect(out).toContain("o login está lento");
  });

  it("nome que não é skill fica como está — pode ser comando do CLI", () => {
    const home = tempHome();
    criaSkillGlobal(home, "revisar");
    expect(expandirSkill("/clear", home, undefined, undefined)).toBe("/clear");
    expect(expandirSkill("/cost", home, undefined, undefined)).toBe("/cost");
  });

  it("mensagem comum passa intacta", () => {
    const home = tempHome();
    criaSkillGlobal(home, "revisar");
    expect(expandirSkill("como faço x?", home, undefined, undefined)).toBe("como faço x?");
    // barra no meio não é comando
    expect(expandirSkill("veja a/b/c", home, undefined, undefined)).toBe("veja a/b/c");
  });
});
