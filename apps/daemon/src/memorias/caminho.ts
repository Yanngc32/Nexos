/**
 * Caminhos das memórias do usuário: onde ficam e quais nomes são aceitos.
 *
 * Uma memória é `<arquivo>.md` em kebab-case na raiz ou `<pasta>/<arquivo>.md`
 * (um nível só). O caminho é tratado como não confiável — pode vir do modelo —,
 * então tudo que escapa da pasta, se esconde ou colide com o que o Nexos gera
 * (MEMORY.md, `.retired/`, o diário) é recusado com o motivo.
 */
import { isAbsolute, join, relative, resolve } from "node:path";

/** Pasta das memórias: `<home>/memorias`. */
export function memoriasDir(home: string): string {
  return join(home, "memorias");
}

/** Nome do índice gerado. */
export const ARQUIVO_INDICE = "MEMORY.md";
/** Pasta para onde vai a memória aposentada. */
export const PASTA_APOSENTADAS = ".retired";

const RESERVADOS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Controle, e o que o Windows não aceita em nome de arquivo.
// eslint-disable-next-line no-control-regex
const INVALIDOS = /[\u0000-\u001f<>:"|?*]/;

/** Barra única e sem espaço nas pontas — a forma canônica de um relPath. */
export function normalizarCaminho(relPath: string): string {
  return String(relPath ?? "").trim().replace(/\\/g, "/");
}

/**
 * Motivo da recusa do caminho, ou `undefined` quando ele é aceito. Recebe o
 * caminho como veio; a forma aceita é a de `normalizarCaminho`.
 */
export function validarCaminhoMemoria(relPath: string): string | undefined {
  if (typeof relPath !== "string" || !relPath.trim()) return "Caminho vazio.";
  const p = normalizarCaminho(relPath);
  if (/^(?:\/|[a-z]:)/i.test(p) || isAbsolute(p)) return "Caminho absoluto não é aceito: use um caminho relativo à pasta de memórias.";
  if (INVALIDOS.test(p)) return "Caminho com caractere inválido.";
  const segmentos = p.split("/");
  for (const s of segmentos) {
    if (s === "..") return "Caminho com '..' não é aceito.";
    if (s === PASTA_APOSENTADAS) return "A pasta .retired guarda memórias aposentadas e não aceita escrita.";
    if (!s || s === ".") return "Caminho com segmento vazio.";
    if (s.startsWith(".")) return "Caminho oculto (começando com '.') não é aceito.";
    if (s.endsWith(".") || s.endsWith(" ")) return "Segmento terminando em '.' ou espaço não é aceito.";
    if (RESERVADOS.test(s)) return `"${s}" é um nome reservado do Windows.`;
  }
  if (segmentos.length === 1 && segmentos[0]!.toLowerCase() === ARQUIVO_INDICE.toLowerCase()) {
    return "MEMORY.md é o índice gerado pelo Nexos: edite as memórias, não ele.";
  }
  if (!p.toLowerCase().endsWith(".md")) return "A memória precisa ser um arquivo .md.";
  if (segmentos.length > 2) return "Só um nível de pasta: use <pasta>/<arquivo>.md.";
  const nomes = [...segmentos.slice(0, -1), segmentos[segmentos.length - 1]!.replace(/\.md$/, "")];
  for (const n of nomes) {
    if (!KEBAB.test(n)) return `"${n}" precisa estar em kebab-case (minúsculas, números e hífen), com extensão .md minúscula.`;
  }
  return undefined;
}

/** `pasta` de um relPath já validado ("" na raiz). */
export function pastaDe(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
}

/** Caminho absoluto de uma memória ativa. */
export function caminhoAtivo(home: string, relPath: string): string {
  return join(memoriasDir(home), ...relPath.split("/"));
}

/** Caminho absoluto de uma memória aposentada (`.retired/<relPath>`). */
export function caminhoAposentado(home: string, relPath: string): string {
  return join(memoriasDir(home), PASTA_APOSENTADAS, ...relPath.split("/"));
}

/**
 * Mensagem de recusa quando `caminhoAbs` cai dentro da pasta de memórias (ou é
 * ela). A pasta só muda pela proposta (`proporMemoria`), que confere revisão,
 * guarda segredos no cofre e regenera o índice — escrita direta pularia tudo isso.
 */
export function escritaDiretaNegada(home: string, caminhoAbs: string): string | undefined {
  if (typeof caminhoAbs !== "string" || !caminhoAbs.trim()) return undefined;
  const dir = resolve(memoriasDir(home));
  const alvo = resolve(caminhoAbs);
  const comparar = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const rel = relative(comparar(dir), comparar(alvo));
  const dentro = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!dentro) return undefined;
  return `A pasta de memórias (${dir}) não aceita escrita direta. Proponha a mudança pela ferramenta de memória (create/update/retire com a revisão esperada).`;
}
