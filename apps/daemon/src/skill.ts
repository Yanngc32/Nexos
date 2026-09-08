import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Instala a skill `nexo-times` pro CLI do Claude.
 *
 * As ferramentas MCP já bastam pro modelo criar agente e time: as regras estão
 * nas descrições delas. A skill é a camada de JULGAMENTO — quando vale montar
 * um time, qual topologia, o que faz um `instructions` prestar — que não cabe
 * em descrição de ferramenta e que ele só carrega quando o assunto aparece.
 *
 * Vai em `~/.claude/skills/` (escopo de usuário) e não no `.claude/` do
 * projeto, por dois motivos: vale em todos os projetos de uma vez, e o Nexo não
 * escreve dentro do SEU repositório sem você pedir.
 *
 * É comando explícito, e não algo que o daemon faça ao subir: `~/.claude` é a
 * configuração de outra ferramenta, e mexer nela sozinho seria abusar da
 * confiança de quem só queria um orquestrador.
 */

const NOME = "nexo-times";

export function destinoDaSkill(base = homedir()): string {
  return join(base, ".claude", "skills", NOME, "SKILL.md");
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

export function instalarSkill(base = homedir()): Instalacao {
  const origem = origemDaSkill();
  const destino = destinoDaSkill(base);
  if (!existsSync(origem)) {
    return { ok: false, destino, motivo: `não achei a skill em ${origem}` };
  }
  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(origem, destino);
  return { ok: true, destino };
}
