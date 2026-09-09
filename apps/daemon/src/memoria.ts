import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { projectKey } from "./home.ts";

/**
 * Memória de projeto: fatos duráveis que o agente "memória" escreve depois de
 * cada commit/push (ver hooks.ts), pra qualquer conversa/run futuro no mesmo
 * projeto não remapear o código do zero.
 *
 * Fica FORA da pasta do projeto de propósito — projeto pode ser open-source, e
 * memória (decisão interna, causa-raiz, convenção) não pode arriscar ir num
 * `git push` de repositório público. `graphify-out/` (estrutural, regenerável
 * do código) é a única parte que continua dentro do projeto.
 */

/** Raiz de todas as memórias de projeto. Configurável pra apontar numa pasta já sincronizada. */
export function memoriaRoot(home: string): string {
  const cfg = loadConfig(home);
  return cfg.memoriaDir || join(home, "memoria");
}

/**
 * Chave estável e segura como nome de pasta — `projectKey` tem barra e não
 * serve de nome de diretório direto. Sha1 inteiro (não os 10 caracteres que
 * `services.ts` usa pra pid transiente): esta pasta é permanente, e colisão
 * aqui perderia memória de um projeto sem ninguém perceber.
 */
export function projectHash(projectPath: string): string {
  return createHash("sha1").update(projectKey(projectPath)).digest("hex");
}

/** Pasta de memória de UM projeto. Cria (com o `meta.json`) se ainda não existir. */
export function projectMemoriaDir(projectPath: string, home: string): string {
  const dir = join(memoriaRoot(home), projectHash(projectPath));
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ projectPath }, null, 2), "utf8");
  }
  return dir;
}

export function memoriaPath(projectPath: string, home: string): string {
  return join(projectMemoriaDir(projectPath, home), "MEMORIA.md");
}

/**
 * Conteúdo atual da memória do projeto, ou vazio se ele nunca escreveu nada ainda.
 *
 * Não usa `projectMemoriaDir` de propósito: essa função é chamada em TODA
 * conversa (ver session.ts), e criar pasta/`meta.json` só de ler encheria
 * `memoriaRoot` de entrada pra todo projeto já aberto, mesmo o que nunca vai
 * ter memória nenhuma.
 */
/** Status pra UI (tela "Memória do Projeto") — não cria pasta nenhuma só de checar, mesma razão de `readMemoria`. */
export function statusDaMemoria(
  projectPath: string,
  home: string,
): { existe: boolean; caminho: string; compartilhado: boolean; atualizadoEm?: string } {
  const caminho = join(memoriaRoot(home), projectHash(projectPath), "MEMORIA.md");
  const compartilhado = Boolean(loadConfig(home).memoriaDir);
  try {
    const st = statSync(caminho);
    return { existe: true, caminho, compartilhado, atualizadoEm: st.mtime.toISOString() };
  } catch {
    return { existe: false, caminho, compartilhado };
  }
}

export function readMemoria(projectPath: string, home: string): string {
  const path = join(memoriaRoot(home), projectHash(projectPath), "MEMORIA.md");
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
