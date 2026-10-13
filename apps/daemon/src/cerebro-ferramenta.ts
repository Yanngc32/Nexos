import { ajustarCapacidade, catalogoDoCerebro, conteudoDaCapacidade, DESCRICAO_MAX, type Capacidade } from "./cerebro-catalogo.ts";
import { capacidadesVisiveis, gatilhoBate, type ContextoDoBloco } from "./cerebro-gatilhos.ts";
import { tipoDaConversa } from "./cerebro-uso.ts";
import type { Conjunto, Saida } from "./mcp.ts";
import { perguntar } from "./perguntas.ts";
import { threadHead } from "./threads.ts";

/**
 * `nexo_cerebro`: uma porta só pra tudo que o agente sabe usar (ferramentas, skills, agentes,
 * times, memória, docs, MCP externos). Três ações, nenhuma chama modelo:
 *
 * - `consultar(situacao)`: até `CONSULTA_MAX` capacidades que casam com a situação (gatilhos e
 *   descrição), com `comoUsar`. É o que o modelo chama em vez de adivinhar qual `nexo_*` existe.
 * - `ler(id)`: o conteúdo da capacidade (SKILL.md inteiro, doc, memória, agente).
 * - `registrar(id, nota)`: acrescenta gatilho/descrição a uma capacidade (ou cria uma nova) como
 *   `origem: pessoa`. Num run (sem pessoa olhando) pede confirmação por `nexo_perguntar` antes.
 *
 * Chega ao CLI SEM adiamento: `_meta["anthropic/alwaysLoad"]` (ver `Ferramenta.meta` em mcp.ts).
 */

export const MCP_TOOLS_CEREBRO = ["mcp__nexo__nexo_cerebro"];
export const CONSULTA_MAX = 8;

const PALAVRAS_VAZIAS = new Set(["de", "da", "do", "das", "dos", "a", "o", "as", "os", "um", "uma", "e", "ou", "que", "pra", "para", "em", "no", "na", "com", "the", "to", "of", "and", "in", "for", "on"]);

function termos(situacao: string): string[] {
  return [...new Set(situacao.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 3 && !PALAVRAS_VAZIAS.has(t)))];
}

/** Puro: pontua cada capacidade contra a situação (gatilho inteiro > termo na descrição/nome). */
export function consultarCatalogo(situacao: string, itens: Capacidade[], ctx: ContextoDoBloco, max = CONSULTA_MAX): Capacidade[] {
  const ts = termos(situacao);
  const pontuadas: Array<{ c: Capacidade; p: number }> = [];
  for (const c of capacidadesVisiveis(itens, ctx)) {
    let p = 0;
    for (const g of c.gatilhos) if (gatilhoBate(situacao, g)) p += 10 + g.length;
    const alvo = `${c.nome} ${c.descricao} ${c.comoUsar}`.toLowerCase();
    for (const t of ts) {
      if (gatilhoBate(c.nome, t)) p += 6;
      else if (alvo.includes(t)) p += 2;
    }
    if (p > 0) pontuadas.push({ c, p });
  }
  return pontuadas
    .sort((a, b) => b.p - a.p || b.c.usos30d - a.c.usos30d || a.c.nome.localeCompare(b.c.nome, "pt-BR"))
    .slice(0, max)
    .map((x) => x.c);
}

function linha(c: Capacidade): string {
  const uso = c.usos30d ? ` · ${c.usos30d} usos/30d` : " · nunca usada";
  return `- \`${c.id}\` (${c.tipo}${uso}): ${c.descricao}\n  como usar: ${c.comoUsar}`;
}

export function ferramentaDoCerebro(threadId: string, projectPath: string | undefined, home: string): Conjunto {
  return () => [
    {
      name: "nexo_cerebro",
      description:
        "O Cérebro do Nexos: catálogo de TUDO que você sabe usar nesta conversa — ferramentas nexo_*, skills, " +
        "subagentes, times, memória, docs do projeto, MCP externos — com uso real de cada um. " +
        "`consultar` quando não souber se existe ferramenta/skill/agente pra uma situação (descreva a situação, " +
        "ex.: \"subir servidor de dev\", \"revisar diff antes do commit\", \"mock de tela\"): devolve até 8 capacidades " +
        "com o que chamar — sem LLM, resposta imediata. `ler` traz o conteúdo (SKILL.md inteiro, doc, memória, agente). " +
        "`registrar` acrescenta gatilho/descrição a uma capacidade (ou cria uma nova) pra lembrar da próxima vez.",
      inputSchema: {
        type: "object",
        properties: {
          acao: { type: "string", enum: ["consultar", "ler", "registrar"] },
          situacao: { type: "string", description: "consultar: o que você precisa fazer, em uma frase" },
          id: { type: "string", description: "ler/registrar: id da capacidade (`tipo:nome`, ex. `skill:caveman`, `doc:DOC_TEC.md`)" },
          nota: { type: "string", description: `registrar: gatilho novo (curto) ou descrição (≤${DESCRICAO_MAX} chars)` },
          campo: { type: "string", enum: ["gatilho", "descricao", "comoUsar"], description: "registrar: o que a nota é (padrão gatilho)" },
          tipo: {
            type: "string",
            enum: ["ferramenta", "skill", "agente", "time", "memoria", "doc", "mcp-externo"],
            description: "registrar capacidade NOVA: tipo (o id tem que começar por ele)",
          },
          nome: { type: "string", description: "registrar capacidade NOVA: nome curto" },
          caminho: { type: "string", description: "registrar doc novo: caminho do .md" },
        },
        required: ["acao"],
        additionalProperties: false,
      },
      meta: { "anthropic/alwaysLoad": true },
      executar: async (args): Promise<Saida> => {
        const acao = String(args.acao ?? "");
        const head = threadHead(threadId, home);
        const ctx: ContextoDoBloco = {
          tipo: head ? tipoDaConversa(head) : "chat",
          ...(head?.planejamento ? { planejamento: true } : {}),
        };
        if (acao === "consultar") {
          const situacao = String(args.situacao ?? "").trim();
          if (!situacao) return { ok: false, texto: "consultar precisa de `situacao`" };
          const itens = consultarCatalogo(situacao, catalogoDoCerebro(projectPath, home), ctx);
          if (!itens.length) return { ok: true, texto: "Nenhuma capacidade casa com isso — faça com as ferramentas nativas (Bash, Read, Edit…)." };
          return { ok: true, texto: `Capacidades pra "${situacao}":\n${itens.map(linha).join("\n")}` };
        }
        if (acao === "ler") {
          const id = String(args.id ?? "").trim();
          if (!id) return { ok: false, texto: "ler precisa de `id`" };
          const r = conteudoDaCapacidade(id, projectPath, home);
          if (!r) return { ok: false, texto: `capacidade não existe: ${id} (use consultar pra achar o id)` };
          return { ok: true, texto: `${r.caminho ? `[${r.caminho}]\n\n` : ""}${r.texto.slice(0, 40_000)}` };
        }
        if (acao === "registrar") {
          const id = String(args.id ?? "").trim();
          const nota = String(args.nota ?? "").trim();
          if (!id || !nota) return { ok: false, texto: "registrar precisa de `id` e `nota`" };
          const campo = String(args.campo ?? "gatilho");
          const atual = catalogoDoCerebro(projectPath, home).find((c) => c.id === id);
          if (!atual && !args.tipo) return { ok: false, texto: `capacidade não existe: ${id} — pra criar uma nova, mande também \`tipo\` e \`nome\`` };
          // run não tem pessoa olhando: confirma antes de gravar em nome dela
          if (ctx.tipo === "run" || ctx.tipo === "time") {
            const r = await perguntar(threadId, home, `O agente quer registrar no Cérebro (${id}, ${campo}): "${nota}". Pode?`, ["sim", "não"]);
            if (!r.ok || r.texto.trim().toLowerCase() !== "sim") return { ok: false, texto: "registro cancelado — não foi confirmado" };
          }
          const body: Record<string, unknown> = {};
          if (campo === "gatilho") body.gatilhos = [...(atual?.gatilhos ?? []), nota];
          else if (campo === "descricao") body.descricao = nota;
          else if (campo === "comoUsar") body.comoUsar = nota;
          else return { ok: false, texto: "campo tem que ser gatilho, descricao ou comoUsar" };
          if (!atual) {
            body.tipo = args.tipo;
            body.nome = args.nome ?? id.slice(id.indexOf(":") + 1);
            if (campo !== "descricao") body.descricao = nota;
            if (args.caminho) body.caminho = args.caminho;
          }
          try {
            const cap = ajustarCapacidade(id, body, projectPath ? { projectPath } : { escopo: "global" }, home);
            return { ok: true, texto: `registrado em ${cap.id} (${campo}): ${nota}\ngatilhos agora: ${cap.gatilhos.join(", ") || "(nenhum)"}` };
          } catch (e) {
            return { ok: false, texto: (e as Error).message };
          }
        }
        return { ok: false, texto: "acao tem que ser consultar, ler ou registrar" };
      },
    },
  ];
}
