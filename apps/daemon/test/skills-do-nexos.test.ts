import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalSkillsDir } from "../src/home.ts";
import { instalarSkillsDoNexos } from "../src/skills-do-nexos.ts";
import { tempHome } from "./helpers.ts";

describe("skills que vêm com o Nexos", () => {
  afterEach(() => {
    delete process.env.NEXOS_SKILLS_DO_NEXOS;
  });

  it("a nexo-video do pacote existe e cita as ferramentas nexo_video_* e as licenças", () => {
    const home = tempHome();
    const r = instalarSkillsDoNexos(home);
    expect(r.instaladas).toContain("nexo-video");
    const md = readFileSync(join(globalSkillsDir(home), "nexo-video", "SKILL.md"), "utf8");
    expect(md).toMatch(/^---\r?\nname: nexo-video\r?\n/);
    for (const f of ["nexo_video_cena_salvar", "nexo_video_transicao", "nexo_video_print", "nexo_video_entrega"]) expect(md).toContain(f);
    expect(md).not.toMatch(/grave (em|no) brag-output/i);
    expect(md).toContain("THIRD_PARTY_NOTICES.md");
  });

  it("versão nova atualiza a instalada; editada à mão fica", () => {
    const origem = mkdtempSync(join(tmpdir(), "nexo-skills-"));
    process.env.NEXOS_SKILLS_DO_NEXOS = origem;
    mkdirSync(join(origem, "x"));
    writeFileSync(join(origem, "x", "SKILL.md"), "v1");
    const home = tempHome();
    instalarSkillsDoNexos(home);
    const dest = join(globalSkillsDir(home), "x", "SKILL.md");
    expect(readFileSync(dest, "utf8")).toBe("v1");
    writeFileSync(join(origem, "x", "SKILL.md"), "v2");
    instalarSkillsDoNexos(home);
    expect(readFileSync(dest, "utf8")).toBe("v2");
    writeFileSync(dest, "minha edição");
    writeFileSync(join(origem, "x", "SKILL.md"), "v3");
    expect(instalarSkillsDoNexos(home).mantidas).toEqual(["x"]);
    expect(readFileSync(dest, "utf8")).toBe("minha edição");
    expect(existsSync(join(globalSkillsDir(home), "x", ".nexos-origem"))).toBe(true);
  });
});
