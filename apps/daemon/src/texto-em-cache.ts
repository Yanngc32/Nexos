import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

/**
 * Leitura de texto revalidada por `stat` (mtime em ns + tamanho). Os dados do projeto moram no
 * Google Drive: um `stat` lá custa ~4× menos que ler o arquivo, e plano, design system e quadro
 * eram relidos inteiros a cada abertura e a cada evento de SSE. Mudança por fora do motor (agente
 * com Edit, outro aparelho) muda o mtime e é relida na hora; quem grava pelo motor chama
 * `esquecerTexto` (pega até a troca dentro do mesmo instante, com o mesmo tamanho).
 */
type Lido = { texto: string; marca: string; mtime: Date };
const cache = new Map<string, Lido>();
const TETO = 5000;

function guardar(caminho: string, novo: Lido): Lido {
  if (cache.size >= TETO) cache.clear();
  cache.set(caminho, novo);
  return novo;
}

/** Texto do arquivo, ou `null` se ele não existe. Outros erros de leitura sobem. */
export function lerTextoEmCache(caminho: string): Lido | null {
  let st;
  try {
    st = statSync(caminho, { bigint: true });
  } catch {
    cache.delete(caminho);
    return null;
  }
  const marca = `${st.mtimeNs}:${st.size}`;
  const c = cache.get(caminho);
  if (c && c.marca === marca) return c;
  return guardar(caminho, { marca, mtime: st.mtime, texto: readFileSync(caminho, "utf8") });
}

/**
 * Igual a `lerTextoEmCache`, sem segurar o event loop: arquivo só-na-nuvem do Drive leva
 * segundos pra baixar, e as rotas de listagem leem dezenas deles.
 */
export async function lerTextoEmCacheAsync(caminho: string): Promise<Lido | null> {
  let st;
  try {
    st = await stat(caminho, { bigint: true });
  } catch {
    cache.delete(caminho);
    return null;
  }
  const marca = `${st.mtimeNs}:${st.size}`;
  const c = cache.get(caminho);
  if (c && c.marca === marca) return c;
  return guardar(caminho, { marca, mtime: st.mtime, texto: await readFile(caminho, "utf8") });
}

export function esquecerTexto(caminho?: string): void {
  if (caminho === undefined) cache.clear();
  else cache.delete(caminho);
}
