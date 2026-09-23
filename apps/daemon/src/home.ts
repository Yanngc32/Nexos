import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertSlug } from "./ids.ts";

/**
 * A pasta de dados chamava `.nexo` (nome do produto até a v0.1.0) e migra sozinha pra
 * `.nexos` na primeira subida depois do rename — sem isto, quem já tinha perfil/conversas
 * configurados "perderia" tudo ao atualizar. Só entra quando `NEXOS_HOME` não foi setado à
 * mão (isso já escolhe o caminho por fora) e só quando o destino ainda não existe — depois
 * da primeira migração vira no-op (um `existsSync` só).
 */
function migrarHomeAntigo(novo: string): void {
  if (existsSync(novo)) return;
  const antigo = join(homedir(), ".nexo"); // NUNCA mudar pra ".nexos" — é o nome ANTIGO
  if (!existsSync(antigo)) return;
  try {
    renameSync(antigo, novo);
  } catch {
    // rename cruzando de dispositivo, ou pasta em uso: copia em vez de mover.
    cpSync(antigo, novo, { recursive: true });
    try {
      rmSync(antigo, { recursive: true, force: true });
    } catch {
      // best-effort: a cópia já está de pé, sobrar a antiga não quebra nada.
    }
  }
}

export function nexoHome(): string {
  if (process.env.NEXOS_HOME) return process.env.NEXOS_HOME;
  const novo = join(homedir(), ".nexos");
  migrarHomeAntigo(novo);
  return novo;
}

/**
 * Normaliza um caminho de projeto pra comparação/chave estável: resolvido,
 * barra sempre `/` (Windows manda `\`), sem barra final, minúsculo (o mesmo
 * projeto aberto com capitalização diferente de unidade no Windows não pode
 * virar duas chaves). Base de `projectKey` em vários lugares — canal de SSE de
 * serviço (`services.ts`), pasta de memória de projeto (`memoria.ts`).
 */
export function projectKey(projectPath: string): string {
  return resolve(projectPath)
    .replace(/[\u005c]/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function ensureHome(root = nexoHome()): string {
  for (const dir of [
    root,
    join(root, "profiles"),
    join(root, "threads"),
    join(root, "run"),
    join(root, "attachments"),
    join(root, "runs"),
    join(root, "skills"),
    join(root, "worktrees"),
    join(root, "chat-geral"),
    join(root, "memoria-global"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return root;
}

/*
 * Todo caminho derivado de um id passa por assertSlug aqui, e não só em quem
 * chama: id de perfil e de conversa vêm de parâmetro de rota, e um `..` no meio
 * escapava do NEXOS_HOME. Validar no construtor do caminho fecha o furo uma vez
 * em vez de depender de cada chamador lembrar.
 */
export function profileDir(id: string, root = nexoHome()): string {
  return join(root, "profiles", assertSlug(id));
}

export function threadPath(id: string, root = nexoHome()): string {
  return join(root, "threads", `${assertSlug(id)}.jsonl`);
}

/**
 * Sessão do CLI `claude` desta conversa (`--resume`). Não é JSONL: o id muda
 * (troca de conta, `/clear`, sessão que o CLI perdeu) e JSONL é append-only.
 * `listThreads` só lê `.jsonl`, então este arquivo não vira conversa fantasma.
 */
export function claudeSessionPath(id: string, root = nexoHome()): string {
  return join(root, "threads", `${assertSlug(id)}.claude-session`);
}

/**
 * `git worktree` isolada de uma conversa com branch fixa — ver
 * `thread_meta.worktreeDir` e worktree.ts. Uma por thread, não por projeto:
 * duas conversas na mesma branch reaproveitam a mesma pasta (ver threads.ts),
 * mas o nome vem do id da thread que criou primeiro.
 */
export function threadWorktreeDir(id: string, root = nexoHome()): string {
  return join(root, "worktrees", assertSlug(id));
}

export function attachmentsDir(threadId: string, root = nexoHome()): string {
  return join(root, "attachments", assertSlug(threadId));
}

export function configPath(root = nexoHome()): string {
  return join(root, "config.json");
}

/**
 * API key do typesafe.ai + contador de uso. Fora de `config.json` de propósito:
 * `GET /v1/config` devolve o config inteiro pra UI, e uma secret ali vazaria
 * pro renderer a cada carga de tela — mesmo motivo de `keys.json` por perfil
 * ficar fora de `profile.json` (ver profiles.ts).
 */
export function typesafePath(root = nexoHome()): string {
  return join(root, "typesafe.json");
}

export function agentsPath(root = nexoHome()): string {
  return join(root, "agents.json");
}

export function teamsPath(root = nexoHome()): string {
  return join(root, "teams.json");
}

/** Pasta de um run: guarda a saída de cada passo como artefato. */
export function runDir(id: string, root = nexoHome()): string {
  return join(root, "runs", assertSlug(id));
}

/**
 * Token do GitHub (conta única, global — compartilhada por todo perfil/agente).
 * Fora de `config.json` pelo mesmo motivo de `typesafePath`: `GET /v1/config`
 * devolve o config inteiro pra UI, e o token vazaria pro renderer a cada carga.
 */
export function githubAuthPath(root = nexoHome()): string {
  return join(root, "github-auth.json");
}

/**
 * `GH_CONFIG_DIR` isolado e descartável pra cada tentativa de login: o `gh auth
 * login` roda apontando pra cá (nunca pro `~/.config/gh` real da máquina), então
 * nunca toca a sessão pessoal de `gh` que a pessoa já tem no terminal dela. O
 * token final é extraído e guardado em `github-auth.json`; esta pasta é apagada
 * logo em seguida (ver github-auth.ts).
 */
export function githubLoginRunDir(loginId: string, root = nexoHome()): string {
  return join(root, "run", `gh-login-${assertSlug(loginId)}`);
}

/**
 * Conta Google (refresh token) + client OAuth + pasta do Drive escolhida. Fora de `config.json`
 * pelo mesmo motivo de `githubAuthPath`: o refresh token não pode ir pro renderer.
 */
export function googleAuthPath(root = nexoHome()): string {
  return join(root, "google.json");
}

/** Estado LOCAL do sync com o Drive (o que já foi sincronizado, por arquivo) — cada máquina tem o seu. */
export function driveSyncStatePath(root = nexoHome()): string {
  return join(root, "drive-sync.json");
}

/** Estado LOCAL da conciliação da biblioteca (agentes/times/hooks/skills ↔ espelho, ver biblioteca.ts). */
export function bibliotecaSyncStatePath(root = nexoHome()): string {
  return join(root, "biblioteca-sync.json");
}

export function runsRoot(root = nexoHome()): string {
  return join(root, "runs");
}

export function enginePidPath(threadId: string, root = nexoHome()): string {
  return join(root, "run", `engine-${assertSlug(threadId)}.pid`);
}

export function tokenPath(root = nexoHome()): string {
  return join(root, "daemon.token");
}

/** Config dos Nexos Hooks: lista de regras (escopo global ou de projeto, evento, branch, agente). Ver hooks.ts. */
export function hooksPath(root = nexoHome()): string {
  return join(root, "hooks.json");
}

/** Quadros Kanban por projeto + tarefas. Ver tarefas.ts. */
export function tarefasPath(root = nexoHome()): string {
  return join(root, "tarefas.json");
}

/**
 * Skills globais do Nexos: um SKILL.md aqui vale pra qualquer perfil/conta,
 * porque `engineSpawnEnv` isola `CLAUDE_CONFIG_DIR` por perfil e o motor só
 * lê skill de dentro dessa pasta (ou do `.claude/skills` do projeto aberto).
 * Ver `syncGlobalSkills` em engines/cli.ts, que copia daqui pra cada perfil
 * antes de nascer o processo.
 */
export function globalSkillsDir(root = nexoHome()): string {
  return join(root, "skills");
}

/**
 * Cwd do processo do motor pra conversa sem projeto (chat geral). Não é
 * identidade de projeto nenhum — nunca entra em `projetosConhecidos`, nunca
 * roda comando git — só existe porque `spawnCwd` sempre precisa de um
 * diretório real em disco pra nascer o processo.
 */
export function globalChatDir(root = nexoHome()): string {
  return join(root, "chat-geral");
}

/** Memória das conversas sem projeto (chat geral) — única, global, sem hash de projeto. Ver memoria.ts. */
export function globalMemoriaDir(root = nexoHome()): string {
  return join(root, "memoria-global");
}
