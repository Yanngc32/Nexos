import type { EngineEvent } from "@nexo/shared";
import { AUTH_STATUS_RE, isAuthText, prettyAuth } from "./parse-claude.ts";

/**
 * O stream do `codex exec --json`.
 *
 * **Por que este arquivo existe.** O motor `codex` do Nexo spawnava o binário
 * SEM argumento nenhum e parseava a saída com o parser do Claude. `codex` sem
 * subcomando abre a TUI interativa, e com stdin em pipe ela morre na hora:
 *
 *     $ echo "oi" | codex
 *     Error: stdin is not a terminal
 *
 * Ou seja: o motor nunca rodou um turno. Não havia teste que o exercitasse
 * (nem fixture), então nada apontou isso. O caminho não interativo é
 * `codex exec --json`, e o esquema de eventos dele não tem nada a ver com o
 * `stream-json` do Claude — daí um parser próprio.
 *
 * **Tudo aqui foi medido contra o `codex` de verdade** (codex-cli 0.153.4),
 * dirigido contra um provedor OpenAI-compatível local, não deduzido de
 * documentação. Uma linha de turno com comando e resposta sai assim:
 *
 *     {"type":"thread.started","thread_id":"01a0…"}
 *     {"type":"turn.started"}
 *     {"type":"item.started","item":{"id":"item_1","type":"command_execution",
 *       "command":"/bin/bash -lc 'echo oi'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
 *     {"type":"item.completed","item":{"id":"item_1","type":"command_execution",
 *       "command":"/bin/bash -lc 'echo oi'","aggregated_output":"oi\n","exit_code":0,"status":"completed"}}
 *     {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Terminei."}}
 *     {"type":"turn.completed","usage":{"input_tokens":30,"cached_input_tokens":3,
 *       "cache_write_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}
 *
 * Diferenças de comportamento que valem saber, porque mudam o desenho:
 *
 * - **Não há texto parcial.** O `--json` do `exec` só emite item COMPLETO, então
 *   a resposta chega de uma vez. O chat não vai digitar palavra por palavra como
 *   no `claude`, e isso não é defeito de parsing.
 * - **`error` não é fatal.** O aviso "Model metadata … not found" chega como
 *   `item.completed` de tipo `error`, e o `error` de topo carrega retentativa de
 *   rede ("Reconnecting… 2/5"). Nos dois casos o turno SEGUE e termina bem.
 *   Traduzir isso pro `error` do Nexo abortaria turno saudável — o canal fatal é
 *   o `turn.failed`.
 */

/** Tipos de item que o binário serializa. Os que o Nexo mostra viram linha de ferramenta. */
const FERRAMENTAS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"]);

/** Mesmo teto do parser do claude: nada que vá pra UI passa de um parágrafo. */
const SAIDA_MAX = 600;

/**
 * Campos que já viajam em outro canal do evento — repetir no `input` só incharia
 * a bolha e o `.jsonl`. `aggregated_output` sai daqui porque vira `tool_result`.
 */
const CAMPOS_DO_ENVELOPE = new Set(["id", "type", "status", "aggregated_output"]);

function texto(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function cap(s: string, max = SAIDA_MAX): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Os argumentos da ferramenta, como o binário os mandou.
 *
 * Repassa o item CRU (menos o envelope) em vez de mapear campo a campo de
 * propósito: só `command_execution` teve o payload medido contra o codex de
 * verdade (ver o cabeçalho). Mapear os outros exigiria inventar nome de campo,
 * que é justo o que `resumo()` evita desde o começo. Passando cru, a bolha
 * expandida mostra o payload real de `file_change` e companhia na primeira vez
 * que alguém rodar um — e é assim que a medição que falta vai acontecer, em vez
 * de eu chutar agora.
 */
function entradaDoItem(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (CAMPOS_DO_ENVELOPE.has(k) || v === null || v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** Uma linha só, pra caber sem quebrar a linha de ferramenta do chat. */
function resumo(item: Record<string, unknown>): string {
  const tipo = texto(item.type);
  if (tipo === "command_execution") {
    const cmd = texto(item.command).replace(/\s+/g, " ").trim();
    const code = item.exit_code;
    const fim = typeof code === "number" ? ` (exit ${code})` : "";
    return `${cmd}${fim}`;
  }
  /*
   * Os outros tipos vêm do enum do binário, mas o formato do payload de cada um
   * não foi medido — só o `command_execution` foi dirigido de verdade. Então em
   * vez de inventar nome de campo, mostra o que houver dos campos conhecidos e
   * cai no tipo. Errar aqui custa uma linha feia, não um turno.
   */
  for (const campo of ["server", "name", "query", "message", "path"]) {
    const v = texto(item[campo]);
    if (v) return v.replace(/\s+/g, " ").slice(0, 200);
  }
  return tipo;
}

/**
 * Uma ferramenta vira DOIS eventos, como no motor claude: a linha (`tool`, com
 * os argumentos) e a saída (`tool_result`, pareada pelo `id`).
 *
 * Antes daqui saía só a linha, sem `id` e sem `input` — e o chat do codex ficava
 * cego: nem o que o agente rodou, nem o que voltou. O `item.completed` já trazia
 * as duas coisas (`command`, `aggregated_output`, `exit_code`); o parser é que
 * as jogava fora. Com o `id` repassado, a bolha de resultado encaixa na de
 * ferramenta pelo mesmo caminho que o claude usa (`data-tool-id`, renderer.js).
 *
 * `exit_code` diferente de zero marca `isError`, que é o que acende o ✕ na
 * bolha. Sem saída nenhuma e sem falha não gera `tool_result`: bolha de
 * resultado vazia é ruído.
 */
function ferramentaEvents(item: Record<string, unknown>, kind: string): EngineEvent[] {
  const id = texto(item.id);
  const entrada = entradaDoItem(item);
  const out: EngineEvent[] = [
    {
      type: "tool",
      name: kind,
      summary: resumo(item),
      ...(id ? { id } : {}),
      ...(entrada ? { input: entrada } : {}),
    },
  ];

  // sem `id` não há como parear o resultado com a linha — o renderer acha a
  // bolha por `data-tool-id`, e um resultado órfão simplesmente sumiria
  if (!id) return out;

  const saida = cap(texto(item.aggregated_output));
  const code = item.exit_code;
  const falhou = typeof code === "number" && code !== 0;
  if (!saida && !falhou) return out;
  out.push({
    type: "tool_result",
    id,
    result: saida || `(sem saída, exit ${String(code)})`,
    ...(falhou ? { isError: true } : {}),
  });
  return out;
}

/**
 * Traduz uma linha do stream. Linha que não é JSON, ou evento que não interessa,
 * devolve lista vazia — o `codex` escreve linha solta de log em stderr, e ela
 * não pode virar texto do assistente.
 */
export function parseCodexLine(linha: string): EngineEvent[] {
  const cru = linha.trim();
  if (!cru || cru[0] !== "{") return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cru) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tipo = texto(obj.type);

  if (tipo === "item.completed") {
    const item = (obj.item ?? {}) as Record<string, unknown>;
    const kind = texto(item.type);
    if (kind === "agent_message") {
      const t = texto(item.text);
      return t ? [{ type: "text", text: t }] : [];
    }
    if (kind === "reasoning") {
      /*
       * O campo do texto de raciocínio não foi medido (o provedor de teste não
       * produz reasoning). Mostrar o bloco vazio é melhor que chutar campo: o
       * chat já sabe desenhar `thinking` sem texto, é o que o `claude` manda.
       */
      const t = texto(item.text);
      return [t ? { type: "thinking", text: t } : { type: "thinking" }];
    }
    if (kind === "error") {
      // aviso, não falha: vira linha visível na conversa em vez de abortar o turno
      const m = texto(item.message);
      return m ? [{ type: "tool", name: "aviso", summary: m }] : [];
    }
    if (FERRAMENTAS.has(kind)) return ferramentaEvents(item, kind);
    return [];
  }

  if (tipo === "turn.completed") {
    const u = (obj.usage ?? {}) as Record<string, unknown>;
    const input = int(u.input_tokens);
    const cacheRead = int(u.cached_input_tokens);
    const cacheCreate = int(u.cache_write_input_tokens);
    const pensando = int(u.reasoning_output_tokens);
    return [
      {
        type: "usage",
        input,
        output: int(u.output_tokens),
        cacheRead,
        cacheCreate,
        ...(pensando ? { thinking: pensando } : {}),
        contextTokens: input + cacheRead + cacheCreate,
      },
      { type: "done" },
    ];
  }

  // o canal fatal de verdade
  if (tipo === "turn.failed") {
    const err = (obj.error ?? {}) as Record<string, unknown>;
    const msg = texto(err.message) || texto(obj.message) || "o codex encerrou o turno com falha";
    // sessão OAuth vencida/revogada: sem isso o daemon repete "motor morreu" pra sempre,
    // porque nunca marca o perfil como precisando de login de novo (ver markAuthFailed).
    if (isAuthText(msg) || AUTH_STATUS_RE.test(msg)) return [{ type: "auth", detail: prettyAuth(msg) }];
    return [{ type: "error", message: msg }];
  }

  /*
   * `error` de topo é retentativa de rede — chega várias vezes e o turno segue.
   * Fica visível como aviso pra não parecer que travou, mas não aborta nada.
   */
  if (tipo === "error") {
    const m = texto(obj.message);
    return m ? [{ type: "tool", name: "aviso", summary: m }] : [];
  }

  /*
   * `thread.started` traz `thread_id`, e dava pra virar `session`. Não vira: o
   * `SessionInfo` exige `contextWindow`, o codex não reporta janela nenhuma, e
   * mandar 0 faria o medidor de contexto da tela mostrar "/0". Sem informação é
   * melhor que informação errada.
   *
   * `item.started` e `item.updated` também caem aqui: mostrar o comando em voo e
   * depois completo duplicaria a linha, e só o completo tem o exit code.
   */
  return [];
}
