import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { SwitchReason } from "@nexo/shared";
import { getAgent, listAgents, removeAgent, saveAgent, type AgentInput } from "./agents.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { projectKey, tokenPath } from "./home.ts";
import {
  accountInfo,
  addProfile,
  applyLoginResult,
  getProfile,
  importGlobalCredentials,
  IMPORT_WARNING,
  listProfiles,
  markReady,
  updateProfile,
  type AddProfileInput,
} from "./profiles.ts";
import { readAttachment, type IncomingImage } from "./attachments.ts";
import { listSkills } from "./skills.ts";
import { cliAuthStatus } from "./auth-status.ts";
import { cancelLogin, loginStatus, startLogin, submitCode } from "./login-session.ts";
import { createThread, listThreads, projectsFromThreads, projetosConhecidos, readThread, threadHead } from "./threads.ts";
import {
  abortThread,
  agentSnapshots,
  allLimits,
  busyThreads,
  clearThread,
  dropThread,
  postMessage,
  sessionBus,
  switchThread,
} from "./session.ts";
import { threadReport } from "./usage-report.ts";
import { getTeam, listTeams, removeTeam, saveTeam, upsertTimeDeMencao, type TeamInput } from "./teams.ts";
import {
  apagarRegra,
  dispararPrePush,
  fireHook,
  getRegra,
  listarRegras,
  regrasDoEscopo,
  saveRegra,
  sincronizarHooksDoProjeto,
} from "./hooks.ts";
import { ferramentaDeVeredito } from "./veredito.ts";
import { ferramentaDePerguntar, responderPergunta } from "./perguntas.ts";
import { ferramentaDeDelegar, modoDeDelegacaoDaThread } from "./delegar.ts";
import {
  abortarRun,
  criarRun,
  executarRun,
  ferramentasDoRun,
  getRun,
  listRuns,
  retomarRun,
  runAtual,
  runsBus,
} from "./runs.ts";
import { erroDeParse, ferramentasDoSupervisor, tratarMcp, type Conjunto, type JsonRpc } from "./mcp.ts";
import { ferramentasDeAutoria } from "./autoria.ts";
import {
  atualizarGrafo,
  ferramentasDeGraphify,
  caminhoDaArvoreDoGrafo,
  importarGrafoManual,
  statusDoGrafo,
} from "./graphify.ts";
import { desligarGrafoAutomatico, sincronizarGrafoAutomatico } from "./grafo-auto.ts";
import { statusDaMemoria } from "./memoria.ts";
import { estadoAtual, melhorHost } from "./escuta.ts";
import { abrirPareamento, fecharPareamento, pareamentoAberto, resgatar } from "./pair.ts";
import { servirWeb } from "./web.ts";
import {
  autostartServices,
  listServices,
  probeUrl,
  restartService,
  serviceLogs,
  servicesBus,
  servicesChannel,
  startService,
  stopService,
  trustProject,
} from "./services.ts";
import { streamSSE } from "hono/streaming";

/** Devolve o arquivo da interface web, ou 404 — nunca um caminho de fora dela. */
function responderWeb(c: { req: { path: string }; body: BodyResponder }, caminho: string): Response {
  const achado = servirWeb(caminho);
  if (!achado) return c.body("not found", 404);
  return c.body(achado.corpo, 200, {
    "Content-Type": achado.tipo,
    // sem cache: o app muda com o daemon, e celular com versão velha em cache
    // é o pior jeito de descobrir que algo mudou
    "Cache-Control": "no-store",
  });
}

type BodyResponder = (corpo: Buffer | string, status: number, headers?: Record<string, string>) => Response;

/** O mínimo do contexto do Hono que o MCP usa. */
type McpCtx = {
  req: { json: () => Promise<unknown> };
  json: (corpo: unknown, status: 200) => Response;
  body: (corpo: null, status: 202) => Response;
};

export function createApp(home: string, token: string): Hono {
  const app = new Hono();
  /*
   * O token é MUTÁVEL porque `POST /v1/token/rotate` o troca com o daemon de
   * pé. Fica na closure e não em estado de módulo: os testes criam vários apps,
   * e um token global vazaria entre eles.
   */
  let atual = token;
  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1/health", (c) => c.json({ ok: true }));

  /*
   * `POST /pair` é do CELULAR e NÃO é autenticada, porque o ponto dela é
   * justamente entregar o token a quem ainda não tem. É a única escrita sem
   * auth do daemon; o que a torna defensável está no `pair.ts` (2 minutos, uso
   * único, 5 erros queimam o código) — e vale reler aquilo antes de mexer aqui.
   *
   * As rotas que ABREM um pareamento são do desktop e ficam LÁ EMBAIXO, depois
   * do middleware de autenticação. A posição é o que autentica: rota registrada
   * antes do `app.use` não passa por ele. Ver o comentário no middleware.
   */
  app.post("/pair", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { codigo?: unknown };
    const r = resgatar(body.codigo);
    // 403 e não 401: não há credencial a corrigir, o código é que não serve
    if (!r.ok) return c.json({ error: r.motivo }, 403);
    return c.json({ token: atual, port: loadConfig(home).port });
  });

  /*
   * A interface web, servida sem autenticação: a página tem que carregar ANTES
   * de existir token, porque é nela que se digita o código de pareamento. Sem
   * token ela não faz nada — todo `/v1/*` abaixo continua exigindo o bearer.
   */
  /*
   * `/app` redireciona pra `/app/`, e a barra não é estética: sem ela o
   * documento tem base `/`, e o `./mobile.js` do HTML é pedido como
   * `/mobile.js` — 404, módulo nenhum carrega, e a tela fica muda sem dar erro.
   * Custou um teste no navegador pra descobrir.
   */
  app.get("/app", (c) => c.redirect("/app/", 302));
  app.get("/app/*", (c) => responderWeb(c, c.req.path));

  /*
   * A partir daqui, `/v1/*` exige o bearer.
   *
   * **A POSIÇÃO É O QUE AUTENTICA.** O Hono compõe as rotas na ordem em que
   * foram registradas, então uma rota escrita ACIMA deste `app.use` responde
   * antes de o middleware rodar e fica aberta — sem erro, sem aviso, e com o
   * comentário do lado dela dizendo que é autenticada.
   *
   * Foi exatamente o que me aconteceu: subi `POST /v1/pair` no bloco de
   * pareamento, acima daqui, e virou um bypass completo. Qualquer um que
   * alcançasse a porta pedia um código, trocava pelo token e era dono do
   * daemon — em duas requisições, sem adivinhar nada. E com CORS `*`, dava pra
   * fazer isso de uma página web qualquer aberta no navegador da vítima.
   *
   * `route-guard.test.ts` varre a tabela de rotas e falha se qualquer `/v1/*`
   * responder sem bearer. É esse teste, e não a leitura do arquivo, que impede
   * a repetição — a armadilha é invisível no diff.
   */
  app.use("/v1/*", async (c, next) => {
    if (c.req.path.endsWith("/health")) return next();
    const hdr = c.req.header("authorization") ?? "";
    if (hdr !== `Bearer ${atual}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  /*
   * Pareamento visto do DESKTOP: quem já tem o token abre um pareamento pra
   * mostrar o código e o QR na tela. Autenticadas por estarem aqui, depois do
   * middleware — e não podem subir pro bloco do `POST /pair`.
   */
  app.post("/v1/pair", (c) => c.json(abrirPareamento()));

  app.get("/v1/pair", (c) => c.json(pareamentoAberto() ?? null));

  app.delete("/v1/pair", (c) => {
    fecharPareamento();
    return c.json({ ok: true });
  });

  /*
   * Onde o daemon escuta AGORA, descoberto e mantido em dia pelo `escuta.ts` —
   * não é `config.host`, que é só um acréscimo manual. A tela usa isto pro QR:
   * QR com endereço que ninguém atende falha calado no celular.
   *
   * `melhor` é o que a tela deve mostrar: o túnel quando há um, porque é o
   * único por onde o celular chega.
   */
  app.get("/v1/escuta", (c) => {
    const e = estadoAtual();
    return c.json({ ...e, melhor: melhorHost(e), port: loadConfig(home).port });
  });

  /*
   * Troca o token e derruba todos os celulares pareados.
   *
   * Existe porque o token passou a sobreviver às subidas do daemon: antes ele
   * era sorteado a cada `up`, e a revogação acontecia por acidente toda vez que
   * a máquina reiniciava. Sessão que morre sozinha não é segurança, é atrito —
   * mas sem revogação explícita, celular perdido não tem solução. Agora é botão.
   *
   * O app do desktop também perde o token, e é por isso que ele relê o arquivo
   * depois de chamar aqui.
   */
  app.post("/v1/token/rotate", (c) => {
    atual = randomBytes(24).toString("hex");
    writeFileSync(tokenPath(home), atual, { encoding: "utf8", mode: 0o600 });
    // pareamento aberto com o token velho não serve mais pra nada
    fecharPareamento();
    return c.json({ ok: true });
  });

  app.get("/v1/profiles", (c) => c.json(listProfiles(home)));

  app.get("/v1/accounts", (c) => c.json(listProfiles(home).map((p) => accountInfo(p, home))));

  // Antes de /v1/accounts/:id, senão o Hono casa :id = "limits".
  app.get("/v1/accounts/limits", (c) => {
    const seen = allLimits();
    return c.json(
      listProfiles(home).map((p) => ({
        id: p.id,
        engine: p.engine,
        status: p.status,
        limits: seen[p.id] ?? null,
      })),
    );
  });

  app.get("/v1/accounts/:id", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "not found" }, 404);
    const info = accountInfo(applyLoginResult(p.id, home), home);
    // live=1 gasta um spawn do CLI; só quando a UI pede o painel.
    if (c.req.query("live") === "1") {
      const cli = cliAuthStatus(p, home);
      if (cli) info.cli = cli;
    }
    return c.json(info);
  });

  app.post("/v1/profiles/:id/login/start", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    try {
      return c.json(await startLogin(c.req.param("id"), home, { email: body.email }));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.post("/v1/profiles/:id/login/code", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { loginId?: string; code?: string };
    if (!body.loginId || !body.code) return c.json({ error: "loginId e code obrigatórios" }, 400);
    try {
      const res = await submitCode(body.loginId, body.code, home);
      return c.json(res, res.ok ? 200 : 400);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.get("/v1/profiles/:id/login/status", (c) => {
    const loginId = c.req.query("loginId") ?? "";
    if (!loginId) return c.json({ error: "loginId obrigatório" }, 400);
    try {
      return c.json(loginStatus(loginId, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.post("/v1/profiles/:id/login/cancel", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { loginId?: string };
    if (body.loginId) cancelLogin(body.loginId);
    return c.json({ ok: true });
  });

  app.post("/v1/profiles", async (c) => {
    const body = (await c.req.json()) as AddProfileInput & { apiKey?: string };
    try {
      const p = addProfile(body, home, { apiKey: body.apiKey, skipBinCheck: body.engine === "stub" });
      return c.json(p, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.patch("/v1/profiles/:id", async (c) => {
    const body = (await c.req.json()) as {
      model?: string | null;
      effort?: string | null;
      permissionMode?: string | null;
      allowedTools?: string[] | null;
      delegacaoModo?: string | null;
    };
    try {
      return c.json(updateProfile(c.req.param("id"), home, body));
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.includes("não existe") ? 404 : 400);
    }
  });

  app.get("/v1/profiles/:id", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(p.status === "ready" ? p : applyLoginResult(p.id, home));
  });

  app.post("/v1/profiles/:id/import", (c) => {
    try {
      return c.json({ ...importGlobalCredentials(c.req.param("id"), home), warning: IMPORT_WARNING });
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes("não existe") ? 404 : 400;
      return c.json({ error: msg }, status as 400);
    }
  });

  app.post("/v1/profiles/:id/login", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.engine === "stub" || p.engine === "api") {
      return c.json(markReady(p.id, home));
    }
    return c.json({ error: "abra o terminal: nexo login " + p.id }, 202);
  });

  app.get("/v1/threads", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    // `busy` é estado vivo (memória), não vem do JSONL: por isso é carimbado aqui.
    const busy = new Set(busyThreads());
    return c.json(listThreads(projectPath, home).map((t) => ({ ...t, busy: busy.has(t.id) })));
  });

  /**
   * Uma linha por conversa com motor de pé — conta, modelo, o que está escrevendo
   * agora. É o que o painel de agentes mostra quando há trabalho em paralelo.
   */
  app.get("/v1/agents", (c) => {
    const agents = agentSnapshots().map((a) => {
      const head = threadHead(a.threadId, home);
      const def = a.agentId ? getAgent(a.agentId, home) : undefined;
      return {
        ...a,
        projectPath: head?.projectPath ?? "",
        preview: head?.preview ?? "",
        updatedAt: head?.updatedAt ?? "",
        engine: getProfile(a.profileId, home)?.engine ?? "",
        // de qual run de time esta conversa é passo; o painel usa pra não
        // contar duas vezes o que já aparece como passo do run
        ...(head?.runId ? { runId: head.runId } : {}),
        // Nome e cor vêm daqui pro painel não ter que cruzar duas listas.
        ...(def ? { agentName: def.name, ...(def.color ? { agentColor: def.color } : {}) } : {}),
      };
    });
    return c.json(agents);
  });

  /* ---------- agentes personalizados (definições) ---------- */

  app.get("/v1/agents/defs", (c) => c.json(listAgents(home)));

  app.post("/v1/agents/defs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AgentInput;
    try {
      return c.json(saveAgent(body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/agents/defs/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AgentInput;
    try {
      // A rota manda no id: body sem id (ou com outro) não renomeia nada.
      return c.json(saveAgent({ ...body, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/agents/defs/:id", (c) => {
    try {
      removeAgent(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  /** Skills que o menu "/" do composer oferece: as do projeto aberto mais as do perfil ativo. */
  app.get("/v1/skills", (c) => {
    const projectPath = c.req.query("projectPath") || undefined;
    const profileId = c.req.query("profileId") || undefined;
    return c.json(listSkills(home, profileId, projectPath));
  });

  /** Stream global: o "*" do bus recebe o evento de qualquer conversa. */
  app.get("/v1/agents/events", (c) => {
    return streamSSE(c, async (stream) => {
      const onEv = (ev: unknown) => {
        void stream.writeSSE({ data: JSON.stringify(ev) });
      };
      sessionBus.on("*", onEv);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sessionBus.off("*", onEv);
          resolve();
        });
      });
    });
  });

  app.post("/v1/threads", async (c) => {
    const body = (await c.req.json()) as { projectPath: string; profileId?: string; agentId?: string };
    try {
      // Sem pasta a conversa nasce órfã: some da listagem (que filtra por
      // projectPath) e de /v1/projects, sem erro nenhum pra quem criou.
      const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
      if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
      // Com agente, a conta dele é o padrão — mas um profileId explícito ainda manda.
      const def = body.agentId ? getAgent(body.agentId, home) : undefined;
      if (body.agentId && !def) return c.json({ error: `agente não existe: ${body.agentId}` }, 400);
      const profileId = body.profileId || def?.profileId || "";
      if (!profileId) return c.json({ error: "profileId obrigatório" }, 400);
      // Antes de criar: depois disso a própria conversa já conta como "projeto conhecido" e o
      // teste de novidade não veria mais diferença nenhuma.
      const chave = projectKey(projectPath);
      const jaConhecido = projetosConhecidos(home).some((p) => projectKey(p) === chave);
      const created = createThread({ projectPath, profileId, ...(def ? { agentId: def.id } : {}) }, home);
      // Best-effort: cobre regra global criada antes deste projeto existir pro Nexo. Não pode
      // derrubar a criação da conversa por causa disto (ex.: pasta sem `.git` — sincronização já
      // ignora, mas por garantia extra contra qualquer outro erro imprevisto).
      try {
        sincronizarHooksDoProjeto(projectPath, home);
      } catch (e) {
        console.error("sincronizar hooks ao abrir projeto:", (e as Error).message || e);
      }
      // "Ao abrir o projeto, busca na pasta compartilhada pelo gráfico" — mesma ideia da memória:
      // puxa se a pasta compartilhada tiver algo mais novo, empurra se o local tiver.
      try {
        statusDoGrafo(projectPath, home);
      } catch (e) {
        console.error("sincronizar grafo ao abrir projeto:", (e as Error).message || e);
      }
      // `nexo.projeto-novo`: só na PRIMEIRA vez que este projeto aparece pro Nexo — fire-and-forget,
      // igual post-commit/post-push (já aconteceu, não tem o que bloquear).
      if (!jaConhecido) {
        try {
          fireHook("nexo.projeto-novo", projectPath, home);
        } catch (e) {
          console.error("nexo.projeto-novo:", (e as Error).message || e);
        }
      }
      return c.json(created, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/v1/threads/:id", (c) => {
    try {
      return c.json(readThread(c.req.param("id"), home));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.get("/v1/threads/:id/usage", (c) => {
    try {
      return c.json(threadReport(c.req.param("id"), home));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.get("/v1/threads/:id/events", (c) => {
    const threadId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const onEv = (ev: unknown) => {
        void stream.writeSSE({ data: JSON.stringify(ev) });
      };
      sessionBus.on(threadId, onEv);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sessionBus.off(threadId, onEv);
          resolve();
        });
      });
    });
  });

  app.post("/v1/threads/:id/messages", async (c) => {
    const body = (await c.req.json()) as { text?: string; images?: IncomingImage[] };
    const text = typeof body.text === "string" ? body.text : "";
    const images = Array.isArray(body.images) ? body.images : [];
    // Mensagem só de imagem vale; vazia de tudo, não.
    if (!text.trim() && images.length === 0) return c.json({ error: "mensagem vazia" }, 400);
    try {
      await postMessage(c.req.param("id"), text, home, images);
      return c.json({ ok: true });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 400;
      return c.json({ error: (e as Error).message }, status as 400);
    }
  });

  /** Serve a imagem colada pro chat renderizar o histórico depois de recarregar. */
  app.get("/v1/threads/:id/attachments/:file", (c) => {
    try {
      const { buf, mime } = readAttachment(c.req.param("id"), c.req.param("file"), home);
      // Uint8Array novo: o Buffer do node não casa com o tipo de corpo do Hono.
      return c.body(new Uint8Array(buf), 200, { "content-type": mime, "cache-control": "no-store" });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.post("/v1/threads/:id/switch", async (c) => {
    const body = (await c.req.json()) as {
      profileId: string;
      confirmed?: boolean;
      reason?: SwitchReason;
    };
    if (body.confirmed !== true) return c.json({ error: "confirmed obrigatório" }, 400);
    try {
      const resumed = await switchThread(
        c.req.param("id"),
        { profileId: body.profileId, confirmed: true, reason: body.reason ?? "user" },
        home,
      );
      // `resumed`: o cliente precisa saber que a conta nova já está respondendo o turno.
      return c.json({ ok: true, resumed });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 400;
      return c.json({ error: (e as Error).message }, status as 400);
    }
  });

  app.post("/v1/threads/:id/abort", async (c) => {
    await abortThread(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** "/clear": grava o corte de contexto e derruba a live em memória — não some do JSONL. */
  app.post("/v1/threads/:id/clear", async (c) => {
    try {
      await clearThread(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.delete("/v1/threads/:id", async (c) => {
    try {
      await dropThread(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 404;
      return c.json({ error: (e as Error).message }, status as 404);
    }
  });

  /** Lista de pastas: o que o app salvou + o que as conversas revelam. */
  app.get("/v1/projects", (c) => {
    const cfg = loadConfig(home);
    const chave =(p: string) => p.replace(/[\u005c]/g, "/").replace(/\/+$/, "").toLowerCase();
    // Escondida vence a dedução: senão tirar da lista era desfeito pelas conversas gravadas.
    const escondidas = new Set(cfg.hiddenRepos.map(chave));
    const merged = cfg.repos.filter((p) => !escondidas.has(chave(p)));
    const doConfig = merged.length;
    const vistos = new Set(merged.map(chave));
    for (const p of projectsFromThreads(home)) {
      if (vistos.has(chave(p)) || escondidas.has(chave(p))) continue;
      vistos.add(chave(p));
      merged.push(p);
    }
    return c.json({
      repos: merged,
      hiddenRepos: cfg.hiddenRepos,
      lastProject: cfg.lastProject,
      lastThread: cfg.lastThread,
      fromConfig: doConfig,
      fromThreads: merged.length - doConfig,
    });
  });

  /* ---------- serviços locais do projeto ---------- */

  app.get("/v1/services", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(listServices(projectPath, home));
  });

  /** Marca o projeto como confiável: sem isso o autostart do nexo.json é ignorado. */
  app.post("/v1/services/trust", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({ trustedProjects: trustProject(body.projectPath, home) });
  });

  /** Sobe o que está marcado com autostart. Sem efeito em projeto não confiável. */
  app.post("/v1/services/autostart", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json({ started: autostartServices(body.projectPath, home) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  app.get("/v1/services/events", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const canal = servicesChannel(projectPath);
    return streamSSE(c, async (stream) => {
      const onEv = (ev: unknown) => {
        void stream.writeSSE({ data: JSON.stringify(ev) });
      };
      servicesBus.on(canal, onEv);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          servicesBus.off(canal, onEv);
          resolve();
        });
      });
    });
  });

  app.get("/v1/services/:id/logs", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({ id: c.req.param("id"), log: serviceLogs(projectPath, c.req.param("id")) });
  });

  for (const acao of ["start", "stop", "restart"] as const) {
    app.post(`/v1/services/:id/${acao}`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
      if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
      try {
        const id = c.req.param("id");
        const status =
          acao === "start"
            ? startService(body.projectPath, id, home)
            : acao === "stop"
              ? stopService(body.projectPath, id, home)
              : await restartService(body.projectPath, id, home);
        return c.json(status);
      } catch (e) {
        const err = e as Error & { status?: number };
        // erro de parse do nexo.json não é culpa do request: 422
        const status = err.status ?? (/nexo\.json/.test(err.message) ? 422 : 400);
        return c.json({ error: err.message }, status as 400);
      }
    });
  }

  app.get("/v1/probe", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "url obrigatória" }, 400);
    try {
      return c.json(await probeUrl(url));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });


  /* ---------- times de agentes ---------- */

  app.get("/v1/teams", (c) => c.json(listTeams(home)));

  app.post("/v1/teams", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as TeamInput;
    try {
      return c.json(saveTeam(body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/teams/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as TeamInput;
    try {
      // igual ao agents: a rota manda no id, body com outro não renomeia nada
      return c.json(saveTeam({ ...body, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.get("/v1/teams/:id", (c) => {
    const t = getTeam(c.req.param("id"), home);
    if (!t) return c.json({ error: "not found" }, 404);
    return c.json(t);
  });

  app.delete("/v1/teams/:id", (c) => {
    try {
      removeTeam(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  /**
   * `@menção` de um agente avulso no composer: garante que existe um `teamId` de
   * verdade pra apontar um Run, sem a pessoa precisar criar um time primeiro.
   * Ver `upsertTimeDeMencao` — o time sai oculto da tela de Times, mas serve
   * pro motor de Run igual a qualquer outro.
   */
  app.post("/v1/teams/mencao/:agentId", (c) => {
    try {
      return c.json(upsertTimeDeMencao(c.req.param("agentId"), home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /* ---------- Nexo Hooks: regras ---------- */

  app.get("/v1/hooks/rules", (c) => c.json(listarRegras(home)));

  app.get("/v1/hooks/rules/:id", (c) => {
    const regra = getRegra(c.req.param("id"), home);
    return regra ? c.json(regra) : c.json({ error: "regra não existe" }, 404);
  });

  app.post("/v1/hooks/rules", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(saveRegra(body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/hooks/rules/:id", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(saveRegra({ ...body, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/hooks/rules/:id", (c) => {
    try {
      apagarRegra(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  /**
   * Gatilho dos Nexo Hooks — chamado pelo script instalado em `.git/hooks/`
   * (ver `sincronizarHooksDoProjeto`). `post-commit`/`post-push` respondem
   * rápido de propósito: a ação roda em segundo plano, sem segurar a
   * requisição — o script chama com `|| true`, então `git commit`/`git push`
   * nunca esperam nem falham por causa disto.
   *
   * `pre-push` é o oposto: a resposta SÓ volta depois de toda regra
   * bloqueante decidir (ou reprovar por padrão) — é essa espera que faz o
   * script do git segurar o push até saber se libera.
   */
  app.post("/v1/hooks/fire", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      event?: string;
      projectPath?: string;
      branch?: string;
    };
    const event = body.event ?? "";
    const projectPath = body.projectPath ?? "";
    const branch = typeof body.branch === "string" ? body.branch : "";
    try {
      if (event === "git.pre-push") return c.json(await dispararPrePush(projectPath, branch, home));
      return c.json(fireHook(event, projectPath, home, branch));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /* ---------- Grafo (graphify) ---------- */

  app.get("/v1/graph/status", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(statusDoGrafo(projectPath, home));
  });

  /**
   * "O que o Nexo sabe deste projeto" — memória + grafo + quantos Nexo Hooks (global ou deste
   * projeto) valem pra ele, numa chamada só. É a fonte da tela "Memória do Projeto" no desktop —
   * antes disso, a mesma informação estava espalhada em três telas (Configurações, Grafo, Hooks)
   * sem nenhum lugar que juntasse os três.
   */
  app.get("/v1/projeto/status", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({
      memoria: statusDaMemoria(projectPath, home),
      grafo: statusDoGrafo(projectPath, home),
      grafoAuto: loadConfig(home).modulos.grafoAuto,
      hooksCount: regrasDoEscopo(listarRegras(home), projectPath).length,
    });
  });

  /** Importa um grafo de fora (pasta escolhida no modal) — cobre "não achou em lugar nenhum". */
  app.post("/v1/graph/importar", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string; origem?: string };
    const projectPath = body.projectPath ?? "";
    const origem = body.origem ?? "";
    if (!projectPath || !origem) return c.json({ error: "projectPath e origem obrigatórios" }, 400);
    try {
      importarGrafoManual(projectPath, origem, home);
      return c.json(statusDoGrafo(projectPath, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /** `graphify update` — só AST, sem LLM, por isso seguro num botão (não gasta quota de conta). */
  app.post("/v1/graph/atualizar", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    const projectPath = body.projectPath ?? "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const r = await atualizarGrafo(projectPath, home);
    return c.json({ ...r, ...statusDoGrafo(projectPath, home) });
  });

  /** O `graph.html` do grafo semântico (já gerado pelo próprio `graphify`) — cliente abre no app padrão. */
  app.post("/v1/graph/arvore", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    const projectPath = body.projectPath ?? "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(caminhoDaArvoreDoGrafo(projectPath));
  });

  /* ---------- execuções de time ---------- */

  app.get("/v1/runs", (c) => c.json(listRuns(home, c.req.query("projectPath") || undefined)));

  /**
   * O run que interessa agora. Antes de `/v1/runs/:id`, senão o Hono casa
   * :id = "atual".
   *
   * Existe porque o painel flutuante consulta a cada 2s e só mostra UM run:
   * pedir a lista inteira pra isso lia todo `run.json` da máquina e serializava
   * megabytes por consulta. Aqui o caso comum não toca no disco.
   */
  app.get("/v1/runs/atual", (c) => c.json(runAtual(home, c.req.query("projectPath") || undefined) ?? null));

  /**
   * Cria e dispara. Responde 201 com o run parado nos passos pendentes: a
   * execução segue em segundo plano e o progresso sai pelo SSE — segurar a
   * resposta até o fim deixaria a requisição aberta por minutos.
   */
  app.post("/v1/runs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      teamId?: string;
      projectPath?: string;
      goal?: string;
      budget?: unknown;
    };
    try {
      const run = criarRun(
        {
          teamId: body.teamId ?? "",
          projectPath: body.projectPath ?? "",
          goal: body.goal ?? "",
          budget: body.budget,
        },
        home,
      );
      // Cópia antes de disparar: `executarRun` roda síncrono até o primeiro
      // await e já marca o passo 1 como "running". Sem isso, o corpo da
      // resposta dependeria de onde a execução tivesse chegado ao serializar.
      const criado = structuredClone(run);
      void executarRun(run, home);
      return c.json(criado, 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /**
   * Servidor MCP de UM run: é por aqui que o supervisor em canal `mcp` chama os
   * membros do time sem sair do turno dele.
   *
   * Preso ao run no caminho de propósito. O bearer já é exigido pelo middleware
   * de `/v1/*`, mas ele é o token da máquina inteira: sem o escopo do run, um
   * supervisor (ou qualquer coisa com o token) poderia disparar agente de outro
   * run. Run que não está em voo não tem ferramenta — 404, não 500.
   */
  async function responderMcp(c: McpCtx, conjunto: Conjunto): Promise<Response> {
    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      const r = erroDeParse();
      return c.json(r.corpo, r.status as 200);
    }
    const r = await tratarMcp(msg as JsonRpc, conjunto);
    // 202 sem corpo é a resposta certa a notificação: o cliente não espera JSON
    if (r.status === 202) return c.body(null, 202);
    return c.json(r.corpo, r.status as 200);
  }

  /*
   * Duas bocas de MCP, com alcances de propósito diferentes.
   *
   * `/v1/mcp/:id` é do SUPERVISOR e presa a um run: as ferramentas dele
   * EXECUTAM membros, então o id no caminho é o que impede um supervisor de
   * alcançar membro de outro run.
   *
   * `/v1/mcp` é da conversa normal e serve as ferramentas de AUTORIA, que só
   * escrevem `agents.json` e `teams.json`. Não precisa de run porque não há run
   * — e não executa nada, que é o que a torna aceitável numa conversa comum.
   */
  /**
   * `projectPath` vem na query, não no corpo: quem embutiu (`caminhoDaAutoria`
   * em mcp.ts) fez isso na hora de montar a URL desta conversa, e o MCP em si
   * não tem onde carregar um "projeto atual" — cada requisição já chega dizendo.
   * Sem projeto (config velha, ou cliente que não manda) só a autoria responde;
   * o graphify soma quando o projeto tem `graphify-out/graph.json` construído.
   */
  app.post("/v1/mcp", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    const runId = c.req.query("runId") || "";
    const threadId = c.req.query("threadId") || "";
    // `nexo_delegar` só em conversa NORMAL (sem runId) — é isso que impede recursão: o que ele
    // dispara é sempre um passo de Run, que nasce COM runId e por isso nunca cai aqui de novo.
    const modoDelegacao = threadId && projectPath && !runId ? modoDeDelegacaoDaThread(threadId, home) : "negado";
    const conjunto: Conjunto = () => [
      ...ferramentasDeAutoria(home)(),
      ...(projectPath ? ferramentasDeGraphify(projectPath)() : []),
      ...(runId ? ferramentaDeVeredito(runId)() : []),
      ...(threadId ? ferramentaDePerguntar(threadId, home)() : []),
      ...(modoDelegacao !== "negado" ? ferramentaDeDelegar(threadId, projectPath, modoDelegacao, home)() : []),
    ];
    return responderMcp(c, conjunto);
  });

  /** Resolve a pergunta pendente de `nexo_perguntar` nesta thread — ver perguntas.ts. */
  app.post("/v1/perguntas/:threadId/responder", async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json().catch(() => ({}))) as { resposta?: string };
    const resposta = typeof body.resposta === "string" ? body.resposta : "";
    if (!resposta.trim()) return c.json({ error: 'faltou "resposta"' }, 400);
    const ok = responderPergunta(threadId, resposta);
    if (!ok) return c.json({ error: "nenhuma pergunta pendente nesta conversa" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/mcp/:id", async (c) => {
    const fer = ferramentasDoRun(c.req.param("id"), home);
    if (!fer) return c.json({ error: "run não está em voo" }, 404);
    return responderMcp(c, ferramentasDoSupervisor(fer));
  });

  app.get("/v1/runs/:id", (c) => {
    const run = getRun(c.req.param("id"), home);
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json(run);
  });

  /**
   * Retoma de onde parou. Mesma forma do POST: responde o retrato do run antes
   * de disparar, e o progresso sai pelo SSE. O `budget` do corpo SUBSTITUI o
   * antigo — retomar com o mesmo teto que parou o run pararia na mesma linha.
   */
  app.post("/v1/runs/:id/resume", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { budget?: unknown };
    try {
      const run = retomarRun(c.req.param("id"), home, body.budget);
      const retomado = structuredClone(run);
      void executarRun(run, home);
      return c.json(retomado);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.post("/v1/runs/:id/abort", async (c) => {
    const parou = await abortarRun(c.req.param("id"));
    return c.json({ ok: true, running: parou });
  });

  app.get("/v1/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const onEv = (ev: unknown) => {
        void stream.writeSSE({ data: JSON.stringify(ev) });
      };
      runsBus.on(runId, onEv);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          runsBus.off(runId, onEv);
          resolve();
        });
      });
    });
  });

  app.get("/v1/config", (c) => c.json(loadConfig(home)));
  app.put("/v1/config", async (c) => {
    const antes = loadConfig(home).modulos.grafoAuto;
    const body = await c.req.json();
    const next = saveConfig(home, body);
    // Efeito colateral do toggle: liga (ou reconfere, se só a conta trocou) o agente + as duas
    // regras do módulo "Grafo automático" sem esperar reiniciar o daemon. Só DESLIGA na
    // transição true→false — chamar em toda gravação de config (mesmo trocar a cor) apagaria uma
    // regra que a pessoa tivesse criado à mão apontando pro mesmo agente `grafo`, por coincidência.
    if (next.modulos.grafoAuto) sincronizarGrafoAutomatico(home);
    else if (antes) desligarGrafoAutomatico(home);
    return c.json(next);
  });

  return app;
}
