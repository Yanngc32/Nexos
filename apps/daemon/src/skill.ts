import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalSkillsDir, nexoHome } from "./home.ts";

/**
 * Instala a skill `nexo-times` na pasta global do Nexo.
 *
 * As ferramentas MCP já bastam pro modelo criar agente e time: as regras estão
 * nas descrições delas. A skill é a camada de JULGAMENTO — quando vale montar
 * um time, qual topologia, o que faz um `instructions` prestar — que não cabe
 * em descrição de ferramenta e que ele só carrega quando o assunto aparece.
 *
 * Vai em `~/.nexo/skills/` — a mesma pasta que `syncGlobalSkills` (ver
 * `engines/cli.ts`) já copia pra dentro do `CLAUDE_CONFIG_DIR` isolado de cada
 * perfil a cada turno. Instalar direto em `~/.claude/skills/` (config real do
 * Claude Code na máquina, fora do isolamento por perfil) fazia a skill vazar
 * pra qualquer sessão Claude Code do usuário — inclusive fora do Nexo — e
 * ainda assim não chegar em perfil nenhum do Nexo que não usasse por acaso
 * esse mesmo `~/.claude` como config.
 */

const NOME = "nexo-times";

export function destinoDaSkill(base = nexoHome()): string {
  return join(globalSkillsDir(base), NOME, "SKILL.md");
}

/**
 * A fonte, dentro do repositório do Nexo.
 *
 * `fileURLToPath` e NÃO `new URL(...).pathname`: no Windows o `pathname` vem
 * como `/D:/a/repo/...`, e o `join` com isso produz `D:\D:\a\repo\...` — caminho
 * inválido com a letra de unidade duplicada. No Linux passa, então é o tipo de
 * bug que só aparece na máquina de outra pessoa (aqui, no CI).
 */
export function origemDaSkill(): string {
  // .../apps/daemon/src/skill.ts → raiz do repo
  const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(raiz, ".claude", "skills", NOME, "SKILL.md");
}

export type Instalacao = { ok: boolean; destino: string; motivo?: string };

export function instalarSkill(base = nexoHome()): Instalacao {
  const origem = origemDaSkill();
  const destino = destinoDaSkill(base);
  if (!existsSync(origem)) {
    return { ok: false, destino, motivo: `não achei a skill em ${origem}` };
  }
  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(origem, destino);
  return { ok: true, destino };
}
