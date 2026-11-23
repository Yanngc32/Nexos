/**
 * Formato do arquivo de uma memória:
 *
 *   ---
 *   name: <slug>
 *   description: <gancho>
 *   metadata:
 *     type: <tipo>
 *   ---
 *   # <titulo>
 *   <corpo>
 *
 * Ler é tolerante (arquivo editado à mão, sem frontmatter, sem título): o que
 * falta vem do nome do arquivo. Escrever é sempre o formato acima.
 */

export const TIPOS_MEMORIA = ["instrucao", "preferencia", "conhecimento", "decisao", "infra", "correcao"] as const;
export const TIPO_PADRAO = "conhecimento";

export function tipoValido(tipo: unknown): tipo is string {
  return typeof tipo === "string" && (TIPOS_MEMORIA as readonly string[]).includes(tipo);
}

/** Campos do frontmatter que o Nexos entende. */
export interface Cabecalho {
  name?: string;
  description?: string;
  type?: string;
}

/** Tira aspas simples/duplas das pontas de um valor YAML de uma linha. */
function semAspas(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/**
 * Separa o frontmatter do resto. `tem` diz se havia um bloco `---` no topo;
 * sem ele, `resto` é o texto inteiro.
 */
export function separarFrontmatter(texto: string): { tem: boolean; cabecalho: Cabecalho; resto: string } {
  const t = String(texto ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!t.startsWith("---\n")) return { tem: false, cabecalho: {}, resto: t };
  const fim = t.indexOf("\n---", 3);
  if (fim < 0) return { tem: false, cabecalho: {}, resto: t };
  const depois = t.slice(fim + 4);
  if (depois && !depois.startsWith("\n")) return { tem: false, cabecalho: {}, resto: t };
  const cabecalho: Cabecalho = {};
  for (const linha of t.slice(4, fim).split("\n")) {
    const m = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(linha);
    if (!m) continue;
    const [, recuo, chave, valor] = m as unknown as [string, string, string, string];
    if (!valor.trim()) continue;
    if (!recuo && chave === "name") cabecalho.name = semAspas(valor);
    else if (!recuo && chave === "description") cabecalho.description = semAspas(valor);
    else if (chave === "type") cabecalho.type = semAspas(valor);
  }
  return { tem: true, cabecalho, resto: depois.replace(/^\n/, "") };
}

/** Separa o `# Título` da primeira linha (quando houver) do corpo. */
export function separarTitulo(texto: string): { titulo?: string; corpo: string } {
  const t = String(texto ?? "").replace(/\r\n/g, "\n");
  const m = /^#[ \t]+(.+?)[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { corpo: t };
  return { titulo: m[1]!.trim(), corpo: t.slice(m[0].length) };
}

/** Título a partir do nome do arquivo: `minha-memoria.md` → `minha memoria`. */
export function tituloDoArquivo(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return base.replace(/-/g, " ").trim() || base;
}

/** Uma linha só: o índice e o frontmatter não aceitam quebra. */
export function umaLinha(v: string): string {
  return String(v ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** O que se lê de um arquivo de memória. */
export interface ConteudoMemoria {
  titulo: string;
  gancho: string;
  tipo: string;
  corpo: string;
}

/** Lê um arquivo de memória (do Nexos ou editado à mão). */
export function lerConteudo(texto: string, relPath: string): ConteudoMemoria {
  const { cabecalho, resto } = separarFrontmatter(texto);
  const { titulo, corpo } = separarTitulo(resto);
  return {
    titulo: umaLinha(titulo ?? "") || tituloDoArquivo(relPath),
    gancho: umaLinha(cabecalho.description ?? ""),
    tipo: tipoValido(cabecalho.type) ? cabecalho.type : TIPO_PADRAO,
    corpo: corpo.replace(/\s+$/, ""),
  };
}

/** Monta o arquivo no formato do Nexos. */
export function montarArquivo(relPath: string, c: ConteudoMemoria): string {
  const slug = relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const corpo = c.corpo.replace(/\s+$/, "");
  return `---\nname: ${slug}\ndescription: ${umaLinha(c.gancho)}\nmetadata:\n  type: ${c.tipo}\n---\n# ${umaLinha(c.titulo)}\n${corpo}${corpo ? "\n" : ""}`;
}
