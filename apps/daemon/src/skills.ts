import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { globalSkillsDir, profileDir } from "./home.ts";
import { getProfile } from "./profiles.ts";

export type SkillDef = {
  name: string;
  description: string;
  /**
   * "projeto" = `.claude/skills` do repo aberto; "perfil" = pasta claude do
   * perfil ativo; "global" = `~/.nexo/skills`, a mesma pra qualquer conta.
   */
  scope: "projeto" | "perfil" | "global";
};

/**
 * Frontmatter YAML de SKILL.md é sempre raso (chave: valor, ou bloco `>`/`|`
 * indentado) — não vale puxar uma lib de YAML só pra ler `name`/`description`.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const km = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!km) {
      i++;
      continue;
    }
    const key = km[1];
    let value = km[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const fold = value.startsWith(">");
      const bloco: string[] = [];
      i++;
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        bloco.push(lines[i].trim());
        i++;
      }
      value = fold ? bloco.filter(Boolean).join(" ") : bloco.join("\n");
    } else {
      value = value.replace(/^["']|["']$/g, "");
      i++;
    }
    out[key] = value;
  }
  return out;
}

function scanSkillsDir(dir: string, scope: SkillDef["scope"], seen: Set<string>, out: SkillDef[]): void {
  if (!existsSync(dir)) return;
  let entradas: string[];
  try {
    entradas = readdirSync(dir);
  } catch {
    return;
  }
  for (const entrada of entradas) {
    const md = join(dir, entrada, "SKILL.md");
    if (!existsSync(md)) continue;
    let raw: string;
    try {
      raw = readFileSync(md, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    const name = (fm.name || entrada).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: fm.description || "", scope });
  }
}

/**
 * Copia cada skill de `~/.nexo/skills` pra dentro da pasta de skills do perfil
 * (`CLAUDE_CONFIG_DIR/skills`, isolada por conta). É a diferença entre uma
 * skill só aparecer no menu "/" do Nexo e o motor de verdade enxergar ela — o
 * CLI só lê skill de dentro do seu próprio `CLAUDE_CONFIG_DIR` ou do
 * `.claude/skills` do projeto aberto, nunca de uma pasta global arbitrária.
 * Roda a cada turno (custo é ler alguns KB de markdown); sobrescreve pra
 * pegar edição, mas nunca apaga skill que só existe no perfil.
 */
export function syncGlobalSkills(destSkillsDir: string, globalDir: string): void {
  if (!existsSync(globalDir)) return;
  let entradas: string[];
  try {
    entradas = readdirSync(globalDir);
  } catch {
    return;
  }
  for (const entrada of entradas) {
    const src = join(globalDir, entrada);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    try {
      mkdirSync(destSkillsDir, { recursive: true });
      cpSync(src, join(destSkillsDir, entrada), { recursive: true, force: true });
    } catch {
      // pasta do perfil pode estar ocupada com o motor de pé; não vale travar o turno por isso.
    }
  }
}

/**
 * Skills que o motor desta conversa enxerga: as do projeto (`.claude/skills`),
 * as do perfil (pasta claude isolada por conta — ver `engineEnv`) e as globais
 * do Nexo (`~/.nexo/skills`, sincronizadas pra dentro do perfil a cada turno
 * por `syncGlobalSkills`). Em empate de nome, projeto > perfil > global.
 *
 * Skill (SKILL.md) é um conceito só do motor `claude` — `codex` não lê nada
 * disso. Listar skill do perfil/global pra um perfil `codex`/`api` inflaria o
 * menu "/" com opção que nunca chega a valer no turno de verdade.
 */
export function listSkills(home: string, profileId: string | undefined, projectPath: string | undefined): SkillDef[] {
  const out: SkillDef[] = [];
  const seen = new Set<string>();
  if (projectPath) scanSkillsDir(join(projectPath, ".claude", "skills"), "projeto", seen, out);
  const profile = profileId ? getProfile(profileId, home) : undefined;
  const engineSuportaSkill = !profileId || profile?.engine === "claude";
  if (profile && engineSuportaSkill) {
    scanSkillsDir(join(profileDir(profile.id, home), "claude", "skills"), "perfil", seen, out);
  }
  if (engineSuportaSkill) scanSkillsDir(globalSkillsDir(home), "global", seen, out);
  return out.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}
