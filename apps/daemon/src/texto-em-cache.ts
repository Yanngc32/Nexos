import { readFileSync, statSync } from "node:fs";

/**
 * Leitura de texto revalidada por `stat` (mtime em ns + tamanho). Os dados do projeto moram no
 * Google Drive: um `stat` lá custa ~4× menos que ler o arquivo, e plano, design system e quadro
 * eram relidos inteiros a cada abertura e a cada evento de SSE. Mudança por fora do motor (agente
 * com Edit, outro aparelho) muda o mtime e é relida na hora; quem grava pelo motor chama
 * `esquecerTexto` (pega até a troca dentro do mesmo instante, com o mesmo tamanho).
 */
const cache = new Map<string, { marca: string; texto: string }>();
const TETO = 5000;

/** Texto do arquivo, ou `null` se ele não existe. Outros erros de leitura sobem. */
export function lerTextoEmCache(caminho: string): { texto: string; marca: string } | null {
  let marca: string;
  try {
    const st = statSync(caminho, { bigint: true });
    marca = `${st.mtimeNs}:${st.size}`;
  } catch {
    cache.delete(caminho);
    return null;
  }
  const c = cache.get(caminho);
  if (c && c.marca === marca) return c;
  const novo = { marca, texto: readFileSync(caminho, "utf8") };
  if (cache.size >= TETO) cache.clear();
  cache.set(caminho, novo);
  return novo;
}

export function esquecerTexto(caminho?: string): void {
  if (caminho === undefined) cache.clear();
  else cache.delete(caminho);
}
