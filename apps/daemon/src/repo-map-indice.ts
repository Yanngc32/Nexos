import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { projectKey } from "./home.ts";

/**
 * Camada 1 do repo map: árvore de arquivos do projeto, sem símbolo nenhum, sempre no prompt (ver
 * `withInstructions` em session.ts, mesmo bloco que injeta MEMORIA.md). Gerada por parsing puro
 * (`git ls-files` — sem reimplementar `.gitignore`), sem custo de LLM. Ver
 * `docs/superpowers/specs/2026-09-10-repo-map-design.md`.
 *
 * Cache em disco por projeto, mesmo esquema de `memoria.ts` (raiz configurável + hash sha1 de
 * `projectKey`) — hash próprio aqui, não reaproveitado por import, porque cada módulo é dono do
 * seu hash de pasta (mesmo padrão já usado em `memoria.ts`).
 */

const TETO_TOKENS_PADRAO = 1200;

function estimarTokens(texto: string): number {
  return Math.ceil(texto.length / 4);
}

/** Raiz de todas as pastas de repo map — reaproveita `graphDir` (mesmo campo de config de antes). */
export function repoMapRoot(home: string): string {
  const cfg = loadConfig(home);
  return cfg.graphDir || join(home, "grafo");
}

function repoMapHash(projectPath: string): string {
  return createHash("sha1").update(projectKey(projectPath)).digest("hex");
}

/** Pasta de cache de UM projeto (índice + resumos) — usada também por `repo-map-enriquecimento.ts`. */
export function projectIndiceDir(projectPath: string, home: string): string {
  return join(repoMapRoot(home), repoMapHash(projectPath));
}

function indicePath(projectPath: string, home: string): string {
  return join(projectIndiceDir(projectPath, home), "indice.json");
}

/** Só o que `resumoDe` (repo-map-enriquecimento.ts) precisa — evita import circular entre os dois módulos. */
export type LeitorDeResumos = (caminho: string) => string | undefined;

type CacheIndice = { geradoEm: string; arquivos: number; texto: string; truncado: boolean };

/**
 * `git ls-files` — já vem filtrado por `.gitignore` sem reimplementar o parser dele. Projeto sem
 * `.git` (ou `git` ausente do PATH) devolve lista vazia: repo map depende de repositório git,
 * limitação aceita (documentada, não escondida).
 */
export function listarArquivos(projectPath: string): string[] {
  try {
    const saida = execFileSync("git", ["ls-files"], {
      cwd: projectPath,
      encoding: "utf8",
      timeout: 30_000,
      shell: process.platform === "win32",
    });
    return saida
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

type NoArvore = { arquivos: string[]; pastas: Map<string, NoArvore> };

function novoNo(): NoArvore {
  return { arquivos: [], pastas: new Map() };
}

export function montarArvore(caminhos: string[]): NoArvore {
  const raiz = novoNo();
  for (const caminho of caminhos) {
    const partes = caminho.split("/").filter(Boolean);
    if (!partes.length) continue;
    let no = raiz;
    for (let i = 0; i < partes.length - 1; i++) {
      const nome = partes[i]!;
      let filho = no.pastas.get(nome);
      if (!filho) {
        filho = novoNo();
        no.pastas.set(nome, filho);
      }
      no = filho;
    }
    no.arquivos.push(partes[partes.length - 1]!);
  }
  return raiz;
}

function contarArquivos(no: NoArvore): number {
  let n = no.arquivos.length;
  for (const filho of no.pastas.values()) n += contarArquivos(filho);
  return n;
}

/** Estimativa do custo de expandir uma subárvore inteira — sem resumo (aproximação: resumo só deixa mais apertado, nunca menos). */
function tamanhoEstimado(no: NoArvore, prefixo: string): number {
  let total = 0;
  for (const arquivo of no.arquivos) total += estimarTokens(prefixo ? `${prefixo}/${arquivo}` : arquivo) + 1;
  for (const [nome, filho] of no.pastas) total += tamanhoEstimado(filho, prefixo ? `${prefixo}/${nome}` : nome);
  return total;
}

/**
 * Renderiza a árvore respeitando o teto de tokens: raiz (arquivos soltos) e pastas de 1º nível
 * sempre entram inteiras; a partir do 2º nível, quando o orçamento aperta, colapsa em
 * `pasta/… (N arquivos)` em vez de listar tudo. Determinístico (ordem alfabética), pra o mesmo
 * projeto sempre gerar o mesmo índice.
 */
export function renderizarComTeto(
  raiz: NoArvore,
  tetoTokens: number,
  lerResumo?: LeitorDeResumos,
): { texto: string; truncado: boolean } {
  const linhas: string[] = [];
  let usados = 0;
  let truncado = false;

  function cabe(linha: string): boolean {
    return usados + estimarTokens(linha) + 1 <= tetoTokens;
  }
  function adicionar(linha: string): void {
    linhas.push(linha);
    usados += estimarTokens(linha) + 1;
  }

  function renderPasta(no: NoArvore, prefixo: string, depth: number): void {
    for (const arquivo of [...no.arquivos].sort()) {
      const caminho = prefixo ? `${prefixo}/${arquivo}` : arquivo;
      const resumo = lerResumo?.(caminho);
      const linhaComResumo = resumo ? `${caminho} — ${resumo}` : caminho;
      if (cabe(linhaComResumo)) {
        adicionar(linhaComResumo);
      } else if (resumo && cabe(caminho)) {
        // resumo estourou o teto — cai pro caminho puro, nunca mostra resumo como se coubesse
        adicionar(caminho);
      } else if (cabe(caminho)) {
        adicionar(caminho);
      } else {
        truncado = true;
      }
    }
    for (const nome of [...no.pastas.keys()].sort()) {
      const filho = no.pastas.get(nome)!;
      const caminhoPasta = prefixo ? `${prefixo}/${nome}` : nome;
      if (depth >= 1) {
        const expandeInteira = usados + tamanhoEstimado(filho, caminhoPasta) <= tetoTokens;
        if (!expandeInteira) {
          const linhaColapsada = `${caminhoPasta}/… (${contarArquivos(filho)} arquivos)`;
          truncado = true;
          if (cabe(linhaColapsada)) adicionar(linhaColapsada);
          continue;
        }
      }
      renderPasta(filho, caminhoPasta, depth + 1);
    }
  }

  renderPasta(raiz, "", 0);
  return { texto: linhas.join("\n"), truncado };
}

function lerCache(projectPath: string, home: string): CacheIndice | undefined {
  try {
    return JSON.parse(readFileSync(indicePath(projectPath, home), "utf8")) as CacheIndice;
  } catch {
    return undefined;
  }
}

/** Recalcula o índice do zero e grava o cache. Barato (parsing puro, sem LLM) — seguro pra rodar a cada commit. */
export function construirIndice(
  projectPath: string,
  home: string,
  lerResumo?: LeitorDeResumos,
): { texto: string; truncado: boolean } {
  const arquivos = listarArquivos(projectPath);
  const arvore = montarArvore(arquivos);
  const teto = loadConfig(home).repoMapTetoTokens || TETO_TOKENS_PADRAO;
  const resultado = renderizarComTeto(arvore, teto, lerResumo);
  const dir = projectIndiceDir(projectPath, home);
  mkdirSync(dir, { recursive: true });
  const cache: CacheIndice = { geradoEm: new Date().toISOString(), arquivos: arquivos.length, ...resultado };
  writeFileSync(indicePath(projectPath, home), JSON.stringify(cache, null, 2), "utf8");
  return resultado;
}

/** Já existe cache pra este projeto? Não constrói nada — só checa. */
export function indiceDisponivel(projectPath: string, home: string): boolean {
  return existsSync(indicePath(projectPath, home));
}

/**
 * Texto cacheado, ou vazio se nunca construído. Não cria pasta nenhuma só de ler (mesmo cuidado
 * de `readMemoria`) — esta função é chamada em todo turno (session.ts).
 */
export function lerIndice(projectPath: string, home: string): string {
  return lerCache(projectPath, home)?.texto ?? "";
}

/** Status pra UI (tela "Memória do Projeto"). */
export function statusDoIndice(
  projectPath: string,
  home: string,
): { existe: boolean; caminho: string; atualizadoEm?: string; truncado?: boolean; arquivos?: number } {
  const caminho = indicePath(projectPath, home);
  const cache = lerCache(projectPath, home);
  if (!cache) return { existe: false, caminho };
  let atualizadoEm = cache.geradoEm;
  try {
    atualizadoEm = statSync(caminho).mtime.toISOString();
  } catch {
    /* usa geradoEm do próprio cache */
  }
  return { existe: true, caminho, atualizadoEm, truncado: cache.truncado, arquivos: cache.arquivos };
}
