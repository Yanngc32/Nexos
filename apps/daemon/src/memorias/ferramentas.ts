/**
 * Ferramentas MCP de memória do servidor `nexo` (o CLI as vê como
 * `mcp__nexo__memory_*`). Porta das `memoryTools` do Agent Code.
 *
 * - `memory_propose` é a ÚNICA forma de o agente escrever na pasta de memórias
 *   (Write/Edit lá são recusados pelo hook do motor). Conflito de revisão
 *   devolve a revisão atual para o agente refazer.
 * - Nenhuma saída ecoa valor de segredo: o corpo vai por `corpoParaPrompt` e
 *   `memory_secret_get` é a única porta para o valor real.
 */
import type { Conjunto, Ferramenta } from "../mcp.ts";
import { lerSegredo, listarSegredos } from "./cofre.ts";
import { listarMemorias, proporMemoria, statusMemorias } from "./nucleo.ts";
import type { OrigemMemoria, PropostaMemoria } from "./tipos.ts";

export type EventoMemoriaDaFerramenta = {
  relPath: string;
  titulo: string;
  op: PropostaMemoria["op"];
  origem: OrigemMemoria;
  threadId?: string;
};

/** Nomes como o CLI os enxerga — entram no --allowed-tools da conversa com `modulos.memoriaUsuario`. */
export const MCP_TOOLS_MEMORIA = [
  "mcp__nexo__memory_list",
  "mcp__nexo__memory_propose",
  "mcp__nexo__memory_status",
  "mcp__nexo__memory_secret_get",
];

const LIMITE_LISTA_PADRAO = 50;
const LIMITE_LISTA_MAX = 200;
const OPS = ["create", "update", "retire"] as const;

const texto = (v: unknown) => (typeof v === "string" ? v : undefined);
const umaLinha = (s: string) => s.replace(/\s+/g, " ").trim();

function segredosDe(v: unknown): { nome: string; valor: string }[] | undefined | string {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return 'campo "secrets" precisa ser uma lista de {name, value}';
  const out: { nome: string; valor: string }[] = [];
  for (const s of v) {
    const nome = texto((s as { name?: unknown })?.name)?.trim();
    const valor = texto((s as { value?: unknown })?.value);
    if (!nome || valor === undefined) return 'cada item de "secrets" precisa de "name" e "value" (texto)';
    out.push({ nome, valor });
  }
  return out;
}

/**
 * Conjunto de memória de uma conversa. `aoSalvar` recebe cada gravação bem
 * sucedida (o http.ts transforma em SSE `memoria.salva`).
 */
export function ferramentasDeMemoria(
  home: string,
  threadId?: string,
  aoSalvar?: (ev: EventoMemoriaDaFerramenta) => void,
): Conjunto {
  return () => {
    const lista: Ferramenta = {
      name: "memory_list",
      description:
        "Lista as memórias ativas com caminho, título, gancho e a REVISÃO ATUAL (necessária para memory_propose com " +
        'op="update"). Com "query", só as que combinam, da mais relevante para a menos.',
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "termos para filtrar (opcional)" },
          limit: { type: "number", description: `quantas no máximo (padrão ${LIMITE_LISTA_PADRAO}, teto ${LIMITE_LISTA_MAX})` },
        },
        additionalProperties: false,
      },
      executar: (args) => {
        const consulta = texto(args.query)?.trim();
        const pedido = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : LIMITE_LISTA_PADRAO;
        const limite = Math.max(1, Math.min(LIMITE_LISTA_MAX, pedido));
        const memorias = listarMemorias(home, { ...(consulta ? { consulta } : {}), limite });
        if (!memorias.length) return { ok: true, texto: consulta ? `Nenhuma memória combina com "${consulta}".` : "Nenhuma memória gravada ainda." };
        const linhas = memorias.map((m) => `- ${m.relPath} (revisão ${m.revisao}) — ${umaLinha(m.titulo)}: ${umaLinha(m.gancho)}`);
        return { ok: true, texto: linhas.join("\n") };
      },
    };

    const propor: Ferramenta = {
      name: "memory_propose",
      description:
        "Grave uma memória de longo prazo (criar, atualizar ou aposentar). Esta é a ÚNICA forma suportada de escrever na " +
        "pasta de memórias — nunca use Write/Edit lá. Para atualizar, primeiro rode memory_list e informe expected_revision " +
        "com a revisão atual. Um fato por arquivo. Senha, token ou chave vão em secrets, e o corpo usa {{secret:nome}}.",
      inputSchema: {
        type: "object",
        properties: {
          op: { type: "string", enum: [...OPS], description: "create (nova), update (troca o conteúdo) ou retire (aposenta)" },
          rel_path: { type: "string", description: "caminho relativo na pasta de memórias, kebab-case, terminando em .md (ex.: projeto-x/deploy.md)" },
          title: { type: "string", description: "título curto (create; opcional no update)" },
          hook: { type: "string", description: "uma linha dizendo QUANDO a memória se aplica (create; opcional no update)" },
          body: { type: "string", description: "o fato em si, em markdown (create/update)" },
          expected_revision: { type: "number", description: "revisão atual vista em memory_list (obrigatória em update/retire)" },
          secrets: {
            type: "array",
            description: "segredos a guardar no cofre; no corpo, referencie como {{secret:name}}",
            items: {
              type: "object",
              properties: { name: { type: "string" }, value: { type: "string" } },
              required: ["name", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["op", "rel_path"],
        additionalProperties: false,
      },
      executar: (args) => {
        const op = texto(args.op) as PropostaMemoria["op"] | undefined;
        if (!op || !OPS.includes(op)) return { ok: false, texto: 'campo "op" precisa ser create, update ou retire' };
        const relPath = texto(args.rel_path)?.trim();
        if (!relPath) return { ok: false, texto: 'faltou "rel_path"' };
        const segredos = segredosDe(args.secrets);
        if (typeof segredos === "string") return { ok: false, texto: segredos };
        const revisao = typeof args.expected_revision === "number" && Number.isFinite(args.expected_revision) ? args.expected_revision : undefined;
        const proposta: PropostaMemoria = {
          op,
          relPath,
          origem: "agente",
          ...(texto(args.title) !== undefined ? { titulo: texto(args.title) } : {}),
          ...(texto(args.hook) !== undefined ? { gancho: texto(args.hook) } : {}),
          ...(texto(args.body) !== undefined ? { corpo: texto(args.body) } : {}),
          ...(revisao !== undefined ? { revisaoEsperada: revisao } : {}),
          ...(segredos?.length ? { segredos } : {}),
        };
        const r = proporMemoria(home, proposta);
        if (!r.ok) {
          if (typeof r.revisaoAtual === "number") {
            return {
              ok: false,
              texto: `Conflito em ${relPath}: ${r.motivo}. Revisão atual: ${r.revisaoAtual}. Refaça a proposta com expected_revision = ${r.revisaoAtual}.`,
            };
          }
          return { ok: false, texto: `Não gravei ${relPath}: ${r.motivo}` };
        }
        try {
          aoSalvar?.({ relPath: r.memoria.relPath, titulo: r.memoria.titulo, op, origem: "agente", ...(threadId ? { threadId } : {}) });
        } catch {
          /* aviso de UI não derruba a gravação */
        }
        const verbo = op === "create" ? "Criada" : op === "update" ? "Atualizada" : "Aposentada";
        const guardados = r.segredosGuardados.length ? ` Segredos no cofre: ${r.segredosGuardados.join(", ")}.` : "";
        return { ok: true, texto: `${verbo}: ${r.memoria.relPath} (revisão ${r.memoria.revisao}).${guardados}` };
      },
    };

    const status: Ferramenta = {
      name: "memory_status",
      description: "Resumo do acervo de memórias: pasta, quantas ativas e aposentadas e quantos segredos há no cofre (só os nomes contam, nunca os valores).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      executar: () => {
        const s = statusMemorias(home);
        const nomes = listarSegredos(home).map((x) => x.nome);
        return {
          ok: true,
          texto: [
            `Pasta: ${s.dir}`,
            `Memórias: ${s.ativas} ativa(s), ${s.aposentadas} aposentada(s), ${s.total} no total.`,
            `Segredos no cofre: ${s.segredos}${nomes.length ? ` (${nomes.join(", ")})` : ""}.`,
          ].join("\n"),
        };
      },
    };

    const segredo: Ferramenta = {
      name: "memory_secret_get",
      description:
        "Lê o valor real de um segredo guardado no cofre (os placeholders {{secret:nome}} das memórias). Use apenas quando " +
        "precisar do valor para executar a tarefa.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "nome do segredo, como aparece em {{secret:nome}}" } },
        required: ["name"],
        additionalProperties: false,
      },
      executar: (args) => {
        const nome = texto(args.name)?.trim();
        if (!nome) return { ok: false, texto: 'faltou "name"' };
        const valor = lerSegredo(home, nome);
        if (valor === undefined) return { ok: false, texto: `Não há segredo chamado "${nome}" no cofre.` };
        return { ok: true, texto: valor };
      },
    };

    return [lista, propor, status, segredo];
  };
}
