import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Conjunto } from "./mcp.ts";
import { extrairSimbolos } from "./repo-map-parser.ts";
import { indiceDisponivel } from "./repo-map-indice.ts";

/**
 * Camada 2 do repo map: `nexo_mapa_simbolos` — detalhe de símbolo sob pedido, sem depender de
 * nada construído de antemão (roda o parser na hora, só no caminho pedido). Ver
 * `docs/superpowers/specs/2026-09-10-repo-map-design.md`.
 */

export const MCP_TOOLS_REPO_MAP = ["mcp__nexo__nexo_mapa_simbolos"];

/** Teto de arquivos por chamada numa pasta — sem isso, apontar pra uma pasta gigante travaria o turno. */
const ARQUIVOS_MAX_PASTA = 300;

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

/** Mesma regra de `services.ts` (`assertInsideProject`): caminho não pode escapar da pasta do projeto. */
function resolveDentroDoProjeto(projectPath: string, caminhoRelativo: string): string {
  const root = resolve(projectPath);
  const alvo = resolve(root, caminhoRelativo);
  const rel = relative(root, alvo);
  if (rel.startsWith("..") || isAbsolute(rel)) throw badRequest(`caminho escapa da pasta do projeto: ${caminhoRelativo}`);
  return alvo;
}

async function linhaDeArquivo(caminhoAbs: string, caminhoRel: string): Promise<string> {
  let conteudo: string;
  try {
    conteudo = readFileSync(caminhoAbs, "utf8");
  } catch {
    return `${caminhoRel}: (não consegui ler)`;
  }
  const { linguagem, simbolos } = await extrairSimbolos(caminhoRel, conteudo);
  if (linguagem === undefined) return `${caminhoRel}: (sem parser para esta linguagem)`;
  if (!simbolos.length) return `${caminhoRel}: (sem símbolo top-level)`;
  return `${caminhoRel}: ${simbolos.join(", ")}`;
}

/** Vazio (não `undefined`) quando o projeto ainda não tem índice — `Conjunto` já é reavaliado a cada `tools/list`. */
export function ferramentasDeRepoMap(projectPath: string, home: string): Conjunto {
  return () => {
    if (!indiceDisponivel(projectPath, home)) return [];
    return [
      {
        name: "nexo_mapa_simbolos",
        description:
          "Assinaturas top-level (função, classe, export, interface/type) de um arquivo ou pasta do " +
          "projeto — sem descer no corpo. Use ANTES de abrir um arquivo inteiro pra decidir se ele tem o " +
          "que você procura. Pasta devolve uma linha por arquivo dentro dela (não recursivo). Arquivo de " +
          "linguagem sem parser conhecido avisa isso explicitamente, em vez de devolver lista vazia.",
        inputSchema: {
          type: "object",
          properties: { caminho: { type: "string", description: "arquivo ou pasta, relativo à raiz do projeto" } },
          required: ["caminho"],
          additionalProperties: false,
        },
        executar: async (args) => {
          const caminhoRel = typeof args.caminho === "string" ? args.caminho.trim() : "";
          if (!caminhoRel) return { ok: false, texto: 'faltou "caminho"' };
          const alvo = resolveDentroDoProjeto(projectPath, caminhoRel);
          if (!existsSync(alvo)) return { ok: false, texto: `caminho não existe: ${caminhoRel}` };
          const st = statSync(alvo);
          if (st.isFile()) return { ok: true, texto: await linhaDeArquivo(alvo, caminhoRel) };
          const entradas = readdirSync(alvo, { withFileTypes: true })
            .filter((e) => e.isFile())
            .slice(0, ARQUIVOS_MAX_PASTA);
          if (!entradas.length) return { ok: true, texto: "(pasta vazia, ou só com subpastas)" };
          const linhas = await Promise.all(
            entradas.map((e) => linhaDeArquivo(join(alvo, e.name), caminhoRel ? `${caminhoRel}/${e.name}` : e.name)),
          );
          return { ok: true, texto: linhas.join("\n") };
        },
      },
    ];
  };
}
