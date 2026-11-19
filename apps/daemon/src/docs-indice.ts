import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Índice dos docs do projeto pro system prompt (ver `instrucoesDoPack` em session.ts): uma linha
 * por arquivo, "caminho — primeiro título #". Entra o `*.md` da raiz e o `docs/**` — o modelo
 * fica sabendo que a documentação existe e onde, sem gastar contexto lendo nenhuma.
 */

/** Teto do bloco inteiro: é system prompt de todo turno, não pode crescer com o repo. */
export const TETO_INDICE_DOCS = 3000;

const PULAR = new Set(["node_modules", "build", "dist"]);

function mdsDaPasta(raiz: string, rel: string, recursivo: boolean, saida: string[]): void {
  let itens;
  try {
    itens = readdirSync(join(raiz, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of itens) {
    const caminho = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) {
      if (recursivo && !it.name.startsWith(".") && !PULAR.has(it.name)) mdsDaPasta(raiz, caminho, true, saida);
    } else if (it.isFile() && it.name.toLowerCase().endsWith(".md")) {
      saida.push(caminho);
    }
  }
}

function primeiroTitulo(arquivo: string): string {
  try {
    // título fica no topo; ler só o começo evita carregar doc gigante inteiro
    const m = /^#\s+(.+)$/m.exec(readFileSync(arquivo, "utf8").slice(0, 4000));
    return m ? m[1].trim().slice(0, 120) : "";
  } catch {
    return "";
  }
}

/** Bloco pronto (com título) ou "" quando o projeto não tem docs. */
export function blocoDeDocs(projectPath: string): string {
  const arquivos: string[] = [];
  mdsDaPasta(projectPath, "", false, arquivos);
  mdsDaPasta(projectPath, "docs", true, arquivos);
  if (!arquivos.length) return "";
  arquivos.sort((a, b) => a.localeCompare(b));
  const cabecalho =
    "# Docs do projeto\nDocumentação que já existe no repo (caminho — título). Antes de mexer numa área, leia o doc dela.";
  const linhas: string[] = [];
  let tamanho = cabecalho.length;
  for (let i = 0; i < arquivos.length; i++) {
    const titulo = primeiroTitulo(join(projectPath, arquivos[i]));
    const linha = titulo ? `- ${arquivos[i]} — ${titulo}` : `- ${arquivos[i]}`;
    // reserva espaço pra nota de corte
    if (tamanho + linha.length + 1 > TETO_INDICE_DOCS - 40) {
      linhas.push(`- … e mais ${arquivos.length - i} doc(s) fora do índice`);
      break;
    }
    linhas.push(linha);
    tamanho += linha.length + 1;
  }
  return `${cabecalho}\n${linhas.join("\n")}`;
}
