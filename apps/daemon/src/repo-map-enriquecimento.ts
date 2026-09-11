import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Conjunto } from "./mcp.ts";
import { listarArquivos, projectIndiceDir } from "./repo-map-indice.ts";

/**
 * Enriquecimento opcional do repo map: resumo de 1 linha por arquivo, gerado por IA sob pedido —
 * nunca a fonte de verdade, some sem quebrar nada se nunca for ligado. Ver
 * `docs/superpowers/specs/2026-09-10-repo-map-design.md`.
 *
 * Cache por hash de CONTEÚDO (não de nome/mtime): arquivo mudou → hash não bate → some do cache
 * até o próximo "Gerar resumos"/commit re-resumir. Nunca mostra resumo velho como se fosse atual.
 */

export const MCP_TOOLS_REPO_MAP_RESUMO = ["mcp__nexo__nexo_repomap_resumo_salvar"];

type EntradaResumo = { hash: string; resumo: string; atualizadoEm: string };
type CacheResumos = Record<string, EntradaResumo>;

function resumosPath(projectPath: string, home: string): string {
  return join(projectIndiceDir(projectPath, home), "resumos.json");
}

function lerCache(projectPath: string, home: string): CacheResumos {
  try {
    return JSON.parse(readFileSync(resumosPath(projectPath, home), "utf8")) as CacheResumos;
  } catch {
    return {};
  }
}

function escreverCache(projectPath: string, home: string, cache: CacheResumos): void {
  mkdirSync(projectIndiceDir(projectPath, home), { recursive: true });
  writeFileSync(resumosPath(projectPath, home), JSON.stringify(cache, null, 2), "utf8");
}

function hashDeConteudo(conteudo: string): string {
  return createHash("sha1").update(conteudo).digest("hex");
}

/** Resumo cacheado de um arquivo, ou `undefined` se nunca resumido OU se o conteúdo mudou desde então. */
export function resumoDe(projectPath: string, home: string, caminho: string, conteudoAtual: string): string | undefined {
  const entrada = lerCache(projectPath, home)[caminho];
  if (!entrada) return undefined;
  return entrada.hash === hashDeConteudo(conteudoAtual) ? entrada.resumo : undefined;
}

/** Leitor pronto pra passar direto pra `renderizarComTeto`/`construirIndice` — lê o arquivo do disco na hora. */
export function leitorDeResumos(projectPath: string, home: string): (caminho: string) => string | undefined {
  const cache = lerCache(projectPath, home);
  return (caminho: string) => {
    const entrada = cache[caminho];
    if (!entrada) return undefined;
    let conteudo: string;
    try {
      conteudo = readFileSync(join(projectPath, caminho), "utf8");
    } catch {
      return undefined; // arquivo sumiu — não mostra resumo de algo que não existe mais
    }
    return entrada.hash === hashDeConteudo(conteudo) ? entrada.resumo : undefined;
  };
}

export function gravarResumo(projectPath: string, home: string, caminho: string, conteudoAtual: string, resumo: string): void {
  const cache = lerCache(projectPath, home);
  cache[caminho] = { hash: hashDeConteudo(conteudoAtual), resumo, atualizadoEm: new Date().toISOString() };
  escreverCache(projectPath, home, cache);
}

/** Arquivos do repo sem resumo cacheado, ou com resumo de um conteúdo diferente do atual. */
export function arquivosParaResumir(projectPath: string, home: string): string[] {
  const cache = lerCache(projectPath, home);
  const out: string[] = [];
  for (const caminho of listarArquivos(projectPath)) {
    let conteudo: string;
    try {
      conteudo = readFileSync(join(projectPath, caminho), "utf8");
    } catch {
      continue; // não deu pra ler (binário grande, etc.) — sem resumo, mostra só o caminho
    }
    const entrada = cache[caminho];
    if (!entrada || entrada.hash !== hashDeConteudo(conteudo)) out.push(caminho);
  }
  return out;
}

/**
 * Ferramenta MCP que o agente de resumo usa pra persistir o que gerou — ele não escreve fora da
 * pasta do projeto por conta própria. Sempre disponível na conversa normal (mesmo critério de
 * "aceitável" que já vale pra `ferramentasDeAutoria`): é escrita de cache, não execução de nada.
 */
export function ferramentaDeResumo(projectPath: string, home: string): Conjunto {
  return () => [
    {
      name: "nexo_repomap_resumo_salvar",
      description:
        "Grava o resumo de 1 linha de um arquivo no cache do repo map (usado pela Camada 1). Chame uma " +
        "vez por arquivo que você resumiu. O resumo deve ser curto (uma frase, foco em propósito — " +
        '"cuida de autenticação", não um resumo do código linha a linha).',
      inputSchema: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "caminho do arquivo, relativo à raiz do projeto" },
          resumo: { type: "string", description: "resumo de 1 linha" },
        },
        required: ["caminho", "resumo"],
        additionalProperties: false,
      },
      executar: (args) => {
        const caminho = typeof args.caminho === "string" ? args.caminho.trim() : "";
        const resumo = typeof args.resumo === "string" ? args.resumo.trim() : "";
        if (!caminho) return { ok: false, texto: 'faltou "caminho"' };
        if (!resumo) return { ok: false, texto: 'faltou "resumo"' };
        let conteudo: string;
        try {
          conteudo = readFileSync(join(projectPath, caminho), "utf8");
        } catch {
          return { ok: false, texto: `não consegui ler o arquivo: ${caminho}` };
        }
        gravarResumo(projectPath, home, caminho, conteudo, resumo);
        return { ok: true, texto: `resumo salvo: ${caminho}` };
      },
    },
  ];
}

/** Status pra UI: quantos arquivos têm resumo cacheado agora (informativo, não afeta comportamento). */
export function statusDosResumos(projectPath: string, home: string): { total: number } {
  if (!existsSync(resumosPath(projectPath, home))) return { total: 0 };
  return { total: Object.keys(lerCache(projectPath, home)).length };
}
