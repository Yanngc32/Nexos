import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { globalMemoriaDir, projectKey } from "./home.ts";
import { projectDir, projectDirSemCriar } from "./projeto-dir.ts";

/**
 * Memória de projeto: fatos duráveis que o agente "memória" escreve depois de
 * cada commit/push (ver hooks.ts), pra qualquer conversa/run futuro no mesmo
 * projeto não remapear o código do zero.
 *
 * Fica FORA da pasta do projeto de propósito — projeto pode ser open-source, e
 * memória (decisão interna, causa-raiz, convenção) não pode arriscar ir num
 * `git push` de repositório público. O cache do repo map (ver
 * `repo-map-indice.ts`) segue a mesma regra — nada de estrutural é gravado
 * dentro da pasta do projeto.
 */

/** Raiz LEGADA de memórias (layout por-tipo, um hash por projeto) — só usada quando `memoriaDir` está configurado. */
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

/**
 * Pasta de memória de UM projeto. Layout novo (`projectDir/memoria`) por padrão; cai pro
 * layout legado (`memoriaRoot/<hash>`) só quando `config.memoriaDir` está explicitamente
 * definido — ver spec docs/superpowers/specs/2026-09-12-storage-cross-device-design.md.
 * Cria a pasta (com `meta.json` no caso legado) se ainda não existir.
 */
export function projectMemoriaDir(projectPath: string, home: string): string {
  if (loadConfig(home).memoriaDir) {
    const dir = join(memoriaRoot(home), projectHash(projectPath));
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(metaPath, JSON.stringify({ projectPath }, null, 2), "utf8");
    }
    return dir;
  }
  const dir = join(projectDir(projectPath, home), "memoria");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Mesma escolha de layout de `projectMemoriaDir`, mas SEM criar nada — pra caminhos de leitura. */
function projectMemoriaDirSemCriar(projectPath: string, home: string): string {
  return loadConfig(home).memoriaDir
    ? join(memoriaRoot(home), projectHash(projectPath))
    : join(projectDirSemCriar(projectPath, home), "memoria");
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
  const caminho = join(projectMemoriaDirSemCriar(projectPath, home), "MEMORIA.md");
  const compartilhado = Boolean(loadConfig(home).memoriaDir || loadConfig(home).projetosDir);
  try {
    const st = statSync(caminho);
    return { existe: true, caminho, compartilhado, atualizadoEm: st.mtime.toISOString() };
  } catch {
    return { existe: false, caminho, compartilhado };
  }
}

export function readMemoria(projectPath: string, home: string): string {
  const path = join(projectMemoriaDirSemCriar(projectPath, home), "MEMORIA.md");
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function globalMemoriaPath(home: string): string {
  return join(globalMemoriaDir(home), "MEMORIA.md");
}

/** Memória das conversas sem projeto (chat geral): única, global, mesmo padrão de `readMemoria`. */
export function readMemoriaGlobal(home: string): string {
  const path = globalMemoriaPath(home);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Status pra UI (tela "Memória Geral") — espelha `statusDaMemoria`. */
export function statusDaMemoriaGlobal(home: string): { existe: boolean; caminho: string; atualizadoEm?: string } {
  const caminho = globalMemoriaPath(home);
  try {
    const st = statSync(caminho);
    return { existe: true, caminho, atualizadoEm: st.mtime.toISOString() };
  } catch {
    return { existe: false, caminho };
  }
}
