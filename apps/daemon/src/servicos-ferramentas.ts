import type { ServiceStatus } from "@nexos/shared";
import { pastaDaConversa } from "./entregar-arquivo.ts";
import { assertSlug } from "./ids.ts";
import type { Conjunto, Saida } from "./mcp.ts";
import {
  declararServico,
  listServices,
  probeUrl,
  restartService,
  serviceLogs,
  startService,
  stopService,
  SERVICES_FILE,
} from "./services.ts";

/**
 * `nexo_servico_*`: servidor de dev (localhost) com o MOTOR do Nexos como dono do processo.
 *
 * O agente subia o servidor como tarefa em background do próprio CLI: filho da conversa, ele morria
 * quando o turno fechava, no Parar e no teto de 2 h — e ainda prendia a conversa em "esperando".
 * Daí o preview com ERR_CONNECTION_REFUSED. Aqui o serviço vai pro `nexos.json` do projeto (fica
 * registrado pra reaproveitar), roda pelo `services.ts` e aparece no painel Serviços.
 */

export const MCP_TOOLS_SERVICOS = [
  "mcp__nexo__nexo_servico_subir",
  "mcp__nexo__nexo_servico_parar",
  "mcp__nexo__nexo_servico_listar",
];

/** Quanto o `subir` espera a URL responder antes de devolver "subiu, mas ainda não responde". */
const ESPERA_SUBIR_MS = 45_000;
const ESPERA_PASSO_MS = 500;
const LOG_NA_RESPOSTA = 2000;

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function cauda(log: string, n = LOG_NA_RESPOSTA): string {
  const t = log.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function statusDe(raiz: string, id: string, home: string): ServiceStatus | undefined {
  return listServices(raiz, home).services.find((s) => s.id === id);
}

function urlReal(s: ServiceStatus): string {
  if (!s.url) return "";
  if (!s.portaReal) return s.url;
  try {
    const u = new URL(s.url);
    u.port = String(s.portaReal);
    return u.href;
  } catch {
    return s.url;
  }
}

type Deps = { esperaMs?: number; passoMs?: number };

export async function subirServico(threadId: string, args: Record<string, unknown>, home: string, deps: Deps = {}): Promise<Saida> {
  const raiz = pastaDaConversa(threadId, home);
  if (!raiz) return { ok: false, texto: "conversa sem pasta de projeto" };
  const id = texto(args.id);
  const cmd = texto(args.cmd);
  const url = texto(args.url);
  if (!id || !cmd || !url) return { ok: false, texto: 'faltou "id", "cmd" ou "url"' };
  try {
    assertSlug(id);
  } catch {
    return { ok: false, texto: `id inválido "${id}" (use a-z, 0-9 e hífen)` };
  }
  let mudou: boolean;
  try {
    ({ mudou } = declararServico(raiz, {
      id,
      cmd,
      url,
      ...(texto(args.cwd) ? { cwd: texto(args.cwd) } : {}),
      ...(texto(args.nome) ? { name: texto(args.nome) } : {}),
    }));
  } catch (e) {
    return { ok: false, texto: (e as Error).message };
  }

  const antes = statusDe(raiz, id, home);
  const rodando = antes?.proc === "running";
  let s: ServiceStatus;
  try {
    if (rodando && mudou) s = await restartService(raiz, id, home);
    else s = startService(raiz, id, home, { matar: args.matar === true });
  } catch (e) {
    return { ok: false, texto: (e as Error).message };
  }

  if (s.conflito) {
    const quem = s.conflito.processos.map((p) => `${p.pid}${p.nome ? ` ${p.nome}` : ""}`).join(", ");
    const responde = (await probeUrl(url).catch(() => ({ ok: false }))).ok;
    return {
      ok: false,
      texto:
        `a porta ${s.conflito.porta} já está ocupada por ${quem || "outro processo"}` +
        (responde ? ` e ${url} responde — pode ser um servidor antigo; dá pra usar a URL assim mesmo` : "") +
        `. Pra o Nexos assumir, chame de novo com matar: true` +
        (s.conflito.livre ? ` (ou troque a porta: ${s.conflito.livre} está livre)` : "") +
        ".",
    };
  }
  if (rodando && !mudou) return { ok: true, texto: `"${id}" já estava de pé em ${urlReal(s)} (pid ${s.pid}).` };

  const espera = deps.esperaMs ?? ESPERA_SUBIR_MS;
  const passo = deps.passoMs ?? ESPERA_PASSO_MS;
  const inicio = Date.now();
  for (;;) {
    const atual = statusDe(raiz, id, home);
    if (!atual || atual.proc !== "running") {
      const codigo = atual?.exitCode !== undefined ? ` (código ${atual.exitCode})` : "";
      return { ok: false, texto: `"${id}" saiu antes de responder${codigo}. Log:\n${cauda(serviceLogs(raiz, id))}` };
    }
    const alvo = urlReal(atual) || url;
    if ((await probeUrl(alvo).catch(() => ({ ok: false }))).ok) {
      return {
        ok: true,
        texto:
          `"${id}" de pé em ${alvo} (pid ${atual.pid}). O motor do Nexos é o dono: continua rodando depois do turno ` +
          `e aparece no painel Serviços${mudou ? `; ficou registrado no ${SERVICES_FILE}` : ""}. ` +
          "Abra no preview com nexo_navegador_abrir; pra derrubar, nexo_servico_parar.",
      };
    }
    if (Date.now() - inicio >= espera) {
      return {
        ok: true,
        texto: `"${id}" está rodando (pid ${atual.pid}), mas ${alvo} ainda não respondeu em ${Math.round(espera / 1000)} s. Log:\n${cauda(serviceLogs(raiz, id))}`,
      };
    }
    await new Promise((r) => setTimeout(r, passo));
  }
}

export function pararServico(threadId: string, args: Record<string, unknown>, home: string): Saida {
  const raiz = pastaDaConversa(threadId, home);
  const id = texto(args.id);
  if (!raiz || !id) return { ok: false, texto: raiz ? 'faltou "id"' : "conversa sem pasta de projeto" };
  try {
    stopService(raiz, id, home);
    return { ok: true, texto: `"${id}" parado (continua no ${SERVICES_FILE} pra subir de novo).` };
  } catch (e) {
    return { ok: false, texto: (e as Error).message };
  }
}

export function listarServicos(threadId: string, home: string): Saida {
  const raiz = pastaDaConversa(threadId, home);
  if (!raiz) return { ok: false, texto: "conversa sem pasta de projeto" };
  const r = listServices(raiz, home);
  if (r.error) return { ok: false, texto: r.error };
  if (!r.services.length) return { ok: true, texto: `nenhum serviço no ${SERVICES_FILE} — use nexo_servico_subir` };
  const linhas = r.services.map((s) => {
    const estado = s.proc === "running" ? `rodando (pid ${s.pid})` : s.proc === "exited" ? `saiu (código ${s.exitCode})` : "parado";
    const log = s.proc === "off" ? "" : cauda(serviceLogs(raiz, s.id), 600);
    return `- ${s.id}: ${estado} — ${urlReal(s) || "sem url"} — \`${s.cmd}\`${log ? `\n  log: ${log.replace(/\n/g, "\n  ")}` : ""}`;
  });
  return { ok: true, texto: linhas.join("\n") };
}

export function ferramentasDeServicos(threadId: string, home: string): Conjunto {
  return () => [
    {
      name: "nexo_servico_subir",
      description:
        "Sobe um servidor de dev/localhost (vite, next, uvicorn, http.server…) com o Nexos como dono do processo: " +
        "continua rodando depois do turno, aparece no painel Serviços e fica registrado no nexos.json do projeto. " +
        "Use SEMPRE isto pra servidor que precisa ficar de pé (preview, testes no navegador) — NÃO rode servidor " +
        "em background no terminal (run_in_background, &, Start-Process): morre quando o turno fecha. " +
        "Espera a URL responder e devolve o log se o processo cair. Idempotente: já de pé com o mesmo comando, só confirma.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "nome curto do serviço (a-z, 0-9, hífen), ex.: web, api" },
          cmd: { type: "string", description: "linha de comando, ex.: npm run dev -- --port 5173 --strictPort" },
          url: { type: "string", description: "URL local que responde quando está de pé, com a porta, ex.: http://localhost:5173" },
          cwd: { type: "string", description: "pasta, relativa à raiz do projeto (padrão: a raiz)" },
          nome: { type: "string", description: "nome amigável pro painel" },
          matar: { type: "boolean", description: "porta ocupada por outro processo: mata ele e sobe" },
        },
        required: ["id", "cmd", "url"],
        additionalProperties: false,
      },
      executar: (args) => subirServico(threadId, args, home),
    },
    {
      name: "nexo_servico_parar",
      description: "Derruba um serviço subido pelo Nexos (nexo_servico_subir ou painel Serviços). Continua no nexos.json.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "id do serviço" } },
        required: ["id"],
        additionalProperties: false,
      },
      executar: (args) => pararServico(threadId, args, home),
    },
    {
      name: "nexo_servico_listar",
      description: "Lista os serviços do nexos.json do projeto: estado, URL, comando e o fim do log dos que rodaram.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      executar: () => listarServicos(threadId, home),
    },
  ];
}
