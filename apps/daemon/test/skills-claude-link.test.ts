import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addProfile, engineEnv, removeProfile } from "../src/profiles.ts";
import { ehLink, linkClaudeSkills, syncGlobalSkills } from "../src/skills.ts";
import { tempHome } from "./helpers.ts";

function skill(dir: string, nome: string, corpo = "corpo"): string {
  const d = join(dir, nome);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${nome}\ndescription: d\n---\n${corpo}\n`, "utf8");
  return d;
}

describe("skills do ~/.claude no perfil", () => {
  it("liga cada skill do usuário sem copiar e sem trocar skill do perfil", () => {
    const raiz = tempHome();
    const origem = join(raiz, "claude-skills");
    const dest = join(raiz, "perfil", "skills");
    skill(origem, "debug", "do usuario");
    skill(origem, "propria", "do usuario");
    skill(dest, "propria", "do perfil");

    linkClaudeSkills(dest, origem);

    expect(ehLink(join(dest, "debug"))).toBe(true);
    expect(readFileSync(join(dest, "debug", "SKILL.md"), "utf8")).toContain("do usuario");
    expect(ehLink(join(dest, "propria"))).toBe(false);
    expect(readFileSync(join(dest, "propria", "SKILL.md"), "utf8")).toContain("do perfil");
  });

  it("tira link quebrado quando a skill some da origem", () => {
    const raiz = tempHome();
    const origem = join(raiz, "claude-skills");
    const dest = join(raiz, "perfil", "skills");
    const src = skill(origem, "efemera");
    linkClaudeSkills(dest, origem);
    rmSync(src, { recursive: true, force: true });

    linkClaudeSkills(dest, origem);

    expect(ehLink(join(dest, "efemera"))).toBe(false);
    expect(existsSync(join(dest, "efemera"))).toBe(false);
  });

  it("skill do Nexos com o mesmo nome troca o link sem escrever dentro da skill do usuário", () => {
    const raiz = tempHome();
    const origem = join(raiz, "claude-skills");
    const nexos = join(raiz, "nexos-skills");
    const dest = join(raiz, "perfil", "skills");
    skill(origem, "caveman", "do usuario");
    skill(nexos, "caveman", "do nexos");
    linkClaudeSkills(dest, origem);

    syncGlobalSkills(dest, nexos);
    linkClaudeSkills(dest, origem);

    expect(ehLink(join(dest, "caveman"))).toBe(false);
    expect(readFileSync(join(dest, "caveman", "SKILL.md"), "utf8")).toContain("do nexos");
    expect(readFileSync(join(origem, "caveman", "SKILL.md"), "utf8")).toContain("do usuario");
  });

  it("remover o perfil não apaga as skills do usuário", () => {
    const home = tempHome();
    const origem = join(home, "claude-skills");
    skill(origem, "importante");
    const p = addProfile({ id: "rm", engine: "claude" }, home, { skipBinCheck: true });
    const dest = join(engineEnv(p, home).CLAUDE_CONFIG_DIR!, "skills");
    linkClaudeSkills(dest, origem);
    expect(ehLink(join(dest, "importante"))).toBe(true);

    removeProfile("rm", home);

    expect(readFileSync(join(origem, "importante", "SKILL.md"), "utf8")).toContain("corpo");
  });
});
