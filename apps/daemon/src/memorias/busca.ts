/**
 * Busca lexical nas memórias: termos normalizados (sem acento, minúsculos, 2+
 * letras, sem palavra vazia) pontuados contra metadado e corpo. Mesma conta do
 * Agent Code: termo igual no metadado (pasta, título, gancho, caminho) vale 6,
 * contido num termo do metadado vale 3, presente no corpo soma 1.
 */
import type { Memoria } from "./tipos.ts";

const PALAVRAS_VAZIAS = new Set([
  "a", "ao", "as", "com", "da", "de", "do", "e", "em", "eu", "me", "na", "no", "o", "os", "para", "por", "que", "um", "uma",
]);

/** Pontuação mínima para a seleção lexical levar a memória ao turno. */
export const PONTUACAO_MINIMA = 3;
/** Quantas memórias a seleção lexical devolve por padrão. */
export const LIMITE_SELECAO = 10;

/** Termos distintos, sem acento e em minúsculas, na ordem em que aparecem. */
export function termosNormalizados(texto: string): string[] {
  const normal = String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const termos: string[] = [];
  const vistos = new Set<string>();
  for (const m of normal.matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    const t = m[0];
    if (PALAVRAS_VAZIAS.has(t) || vistos.has(t)) continue;
    vistos.add(t);
    termos.push(t);
  }
  return termos;
}

function pontuar(m: Memoria, termos: readonly string[]): number {
  const meta = termosNormalizados(`${m.pasta} ${m.titulo} ${m.gancho} ${m.relPath}`);
  const conteudo = new Set(termosNormalizados(m.corpo));
  let pontos = 0;
  for (const termo of termos) {
    if (meta.includes(termo)) pontos += 6;
    else if (meta.some((v) => v.includes(termo) || termo.includes(v))) pontos += 3;
    if (conteudo.has(termo)) pontos += 1;
  }
  return pontos;
}

/** Memórias com algum ponto para a consulta, da mais à menos relevante (empate: relPath). */
export function rankearMemorias(memorias: readonly Memoria[], consulta: string): Memoria[] {
  const termos = termosNormalizados(consulta);
  if (!termos.length) return [];
  return memorias
    .map((m) => ({ m, pontos: pontuar(m, termos) }))
    .filter((r) => r.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos || a.m.relPath.localeCompare(b.m.relPath))
    .map((r) => r.m);
}

/** As que passam da pontuação mínima, até `limite` (padrão 10). */
export function selecionarLexicamente(memorias: readonly Memoria[], consulta: string, limite = LIMITE_SELECAO): Memoria[] {
  const termos = termosNormalizados(consulta);
  if (!termos.length || limite <= 0) return [];
  return memorias
    .map((m) => ({ m, pontos: pontuar(m, termos) }))
    .filter((r) => r.pontos >= PONTUACAO_MINIMA)
    .sort((a, b) => b.pontos - a.pontos || a.m.relPath.localeCompare(b.m.relPath))
    .slice(0, limite)
    .map((r) => r.m);
}
