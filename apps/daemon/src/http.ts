import { randomBytes } from "node:crypto";
import { log, nivelDoLog, recarregarNivel } from "./log.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { SwitchReason } from "@nexos/shared";
import { getAgent, listAgents, removeAgent, saveAgent, type AgentInput } from "./agents.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { clearTypesafeApiKey, hasTypesafeApiKey, pausaDoTypesafe, saveTypesafeApiKey, typesafeUsage } from "./typesafe.ts";
import {
  cancelGithubLogin,
  disconnectGithub,
  githubAccount,
  githubLoginStatus,
  startGithubLogin,
} from "./github-auth.ts";
import { listGithubBranches, listGithubRepos } from "./github-repos.ts";
import { disconnectGoogle, googleAccount } from "./google-auth.ts";
import { cancelGoogleLogin, googleLoginStatus, startEscolherPasta, startGoogleLogin } from "./google-conectar.ts";
import { driveStatus, sincronizarDrive } from "./drive-sync.ts";
import { projectKey, tokenPath } from "./home.ts";
import { migrarArmazenamento, migrarProjeto, migrarRaizLegadaRemovida, pastaDeCodigo, projectSlug, projetosDirIgnorado } from "./projeto-dir.ts";
import {
  accountInfo,
  addProfile,
  applyLoginResult,
  codexModels,
  getProfile,
  importGlobalCredentials,
  IMPORT_WARNING,
  listProfiles,
  markReady,
  removeProfile,
  updateProfile,
  type AddProfileInput,
} from "./profiles.ts";
import { lerElementos, readAttachment, type IncomingImage } from "./attachments.ts";
import { installEngine } from "./install-engine.ts";
import {
  alvoDePullRequest,
  atualizar,
  clonar,
  estadoDoRepo,
  listarBranches,
  trocarBranch,
} from "./git.ts";
import { definirSkillNoProjeto, listSkills } from "./skills.ts";
import { cliAuthStatus } from "./auth-status.ts";
import { cancelLogin, loginStatus, startLogin, submitCode } from "./login-session.ts";
import {
  activeAgentId,
  appendEvent,
  createThread,
  createThreadNaBranch,
  listThreads,
  projectsFromThreads,
  projetosConhecidos,
  readThread,
  threadHead,
} from "./threads.ts";
import {
  abortThread,
  agentSnapshots,
  allLimits,
  pingUsoDaConta,
  busyThreads,
  clearThread,
  dropThread,
  injetarMensagem,
  postMessage,
  retomarTurnoPendente,
  sessionBus,
  switchThread,
  textoEmVoo,
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
import { ferramentasDeNavegador, modoDeNavegadorDaThread, responderNavegador } from "./navegador.ts";
import { ferramentaDePrintDoDs, responderPrint } from "./ds-print.ts";
import { ferramentasDeControleDoWindows } from "./windows-control.ts";
import {
  abortarRun,
  criarRun,
  executarNoChat,
  runsDoChat,
  pararPasso,
  ferramentasDoRun,
  getRun,
  listRuns,
  retomarRun,
  runAtual,
  runsBus,
} from "./runs.ts";
import { erroDeParse, ferramentasDoSupervisor, tratarMcp, type Conjunto, type JsonRpc } from "./mcp.ts";
import { ferramentasDeAutoria } from "./autoria.ts";
import { construirIndice, indiceDisponivel, statusDoIndice } from "./repo-map-indice.ts";
import { ferramentasDeRepoMap } from "./repo-map-simbolos.ts";
import { ferramentaDeResumo, leitorDeResumos } from "./repo-map-enriquecimento.ts";
import {
  adicionarChecklistItem,
  adicionarComentario,
  apagarChecklistItem,
  apagarColuna,
  apagarEtiqueta,
  apagarMarco,
  apagarTarefa,
  alternarChecklistItem,
  ferramentasDeTarefas,
  getQuadro,
  getTarefa,
  listarTarefas,
  salvarColuna,
  salvarEtiqueta,
  salvarMarco,
  salvarTarefa,
  type ColunaInput,
  type EtiquetaInput,
  type MarcoInput,
  type TarefaInput,
} from "./tarefas.ts";
import { commitsRelacionados } from "./tarefas-git.ts";
import {
  aplicarControles,
  apagarCard,
  ativarDs,
  criarDs,
  definirOficial,
  estadoDs,
  listarVersoes,
  promoverVariante,
  restaurarVersao,
  pastaDoAtivo,
  removerDs,
  salvarCard,
  salvarTokens,
  criarCardDeTipo,
  listarBases,
  mudarCard,
  mudarSecao,
  type MudancaDeCard,
  type NovoCardDeTipo,
} from "./design-system.ts";
import { TIPOS, varsDoTipo, type TipoDeToken } from "./ds-kit.ts";
import { assinarDs } from "./ds-watch.ts";
import { aplicarRessincronia, conformidade, exportar, ressincronizar, type FormatoExport, type ItemRessincronia } from "./ds-sync.ts";
import { definirLogoManual, limparLogoManual, logoDoProjeto } from "./project-logo.ts";
import {
  cancelarGeracao,
  canalGeracao,
  geracaoAtual,
  geracaoBus,
  iniciarFeedback,
  iniciarGeracao,
  iniciarNovoCard,
  type NovoCardInput,
  motorPadrao,
  type FeedbackInput,
  PLANO_PADRAO,
  type GerarInput,
} from "./ds-gerar.ts";
import { desligarRepoMapResumos, gerarResumosSobDemanda, sincronizarRepoMapResumos } from "./repo-map-auto.ts";
import { statusDaMemoria, statusDaMemoriaGlobal } from "./memoria.ts";
import { importarZip } from "./importadores/importar-zip.ts";
import { estadoAtual, melhorHost } from "./escuta.ts";
import { abrirPareamento, fecharPareamento, pareamentoAberto, resgatar } from "./pair.ts";
import { abrirDownload, downloadAberto, fecharDownload, resgatarDownload } from "./apk-share.ts";
import { paginaApk } from "./apk-pagina.ts";
import { construirApk, estadoAtualBuild } from "./apk-build.ts";
import { assetLinksPath } from "./apk-keystore.ts";
import { servirWeb } from "./web.ts";
import { listarProcessos, matarProcesso } from "./processos.ts";
import {
  autostartServices,
  listServices,
  probeUrl,
  restartService,
  serviceLogs,
  servicesBus,
  servicesChannel,
  startService,
  trocarPorta,
  stopService,
  trustProject,
} from "./services.ts";
import { streamSSE } from "hono/streaming";
import {
  abrirPlano,
  apagarCard as apagarCardDoPlano,
  canalPlanejamento,
  criarPlano,
  escreverHandoff,
  listarHandoffs,
  listarPlanos,
  marcarEtapa,
  planejamentoBus,
  salvarCard as salvarCardDoPlano,
  salvarLayout,
  salvarRoteiro,
  type CardInput,
  vincularImplementacao,
  vincularThread,
  type EventoPlano,
} from "./planejamento.ts";
import { ferramentasDePlanejamento } from "./planejamento-ferramentas.ts";
import { ferramentaDePainel, responderPainel } from "./paineis.ts";
import {
  alvosDeAnexo,
  blocoDeTarefas,
  conversaDeOrigem,
  avaliarDesign,
  enviarAoQuadro,
  marcarImplementacaoDaEtapa,
  pedidoDeConversa,
  resolverIntegracao,
} from "./planejamento-integracao.ts";
import { montarHandoff, pedidoAoManager, prontidao } from "./planejamento-handoff.ts";

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

/**
 * As rotas de git recusam muito, e de propósito (ver git.ts): branch não
 * pushada, árvore suja, as duas pontas andaram. Tudo isso é 400 com o motivo
 * em texto — a pessoa lê e resolve. 500 fica pro que é defeito nosso.
 */
async function erroDeGit(c: { json: (corpo: unknown, status?: 400) => Response }, f: () => Promise<unknown>) {
  try {
    return c.json(await f());
  } catch (e) {
    const err = e as Error & { status?: number };
    return c.json({ error: err.message }, (err.status ?? 400) as 400);
  }
}

/** O mínimo do contexto do Hono que o MCP usa. */
type McpCtx = {
  req: { json: () => Promise<unknown> };
  json: (corpo: unknown, status: 200) => Response;
  body: (corpo: string | null, status: 202) => Response;
  header: (nome: string, valor: string) => void;
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
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // `app`: versão do Nexos que subiu este motor (env do main.cjs). O app compara na subida e troca
  // o motor que ficou de pé de uma versão anterior (ele sobrevive ao fechamento do app).
  const saude = { ok: true, app: process.env.NEXOS_APP_VERSION ?? "" };
  app.get("/health", (c) => c.json(saude));
  app.get("/v1/health", (c) => c.json(saude));

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
   * `GET /apk` é do CELULAR e também NÃO é autenticada, pela mesma razão do
   * `/pair` logo acima: quem chega aqui ainda não tem o app instalado, então
   * não pode ter o token. A trava está em `apk-share.ts` (TTL curto, uso
   * único, erro demais queima o código) — mesma classe de risco do `/pair`,
   * mesma rigidez. NUNCA vira `/v1/*`: o middleware ali embaixo bloquearia
   * exatamente o celular que esta rota existe pra atender.
   *
   * Com build pronto, serve o `.apk` DIRETO (o código já é de uso único —
   * outra rodada de "clique aqui pra baixar" não protegeria nada a mais).
   * Sem build, devolve HTML solto explicando (não a SPA de `/app/`).
   */
  app.get("/apk", (c) => {
    const r = resgatarDownload(c.req.query("c"));
    if (!r.ok) return c.html(paginaApk({ tipo: "erro", motivo: r.motivo }), 403);
    const build = estadoAtualBuild(home);
    if (build.fase === "pronto") {
      const bytes = readFileSync(build.caminho);
      return c.body(new Uint8Array(bytes), 200, {
        "content-type": "application/vnd.android.package-archive",
        "content-disposition": 'attachment; filename="nexo.apk"',
        "x-nexo-sha256": build.sha256,
        "cache-control": "no-store",
      });
    }
    return c.html(paginaApk({ tipo: "sem-build" }));
  });

  /*
   * Digital Asset Links: o Android busca isto SOZINHO (sem cookie, sem
   * token, de qualquer origem) pra decidir se confia que o APK do TWA tem
   * permissão de abrir o site em tela cheia. Não é segredo — todo site
   * verificado por TWA publica o dele assim, de propósito — só declara
   * "este app com este fingerprint pode representar este site", o que só
   * importa se alguém já tem as duas coisas (o app instalado e o hostname).
   * Sem keystore/build ainda, devolve lista vazia: nenhum app autorizado.
   */
  app.get("/.well-known/assetlinks.json", (c) => {
    const arq = assetLinksPath(home);
    const corpo = existsSync(arq) ? readFileSync(arq, "utf8") : "[]";
    return c.body(corpo, 200, { "content-type": "application/json" });
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

  /**
   * Download de APK visto do DESKTOP: abre um código pra mostrar num QR
   * SEPARADO do de pareamento (nunca `#c=` misturado no mesmo link) — estado
   * próprio em `apk-share.ts`, então abrir um não fecha o outro.
   */
  app.post("/v1/apk", (c) => c.json(abrirDownload()));

  app.get("/v1/apk", (c) => c.json(downloadAberto() ?? null));

  app.delete("/v1/apk", (c) => {
    fecharDownload();
    return c.json({ ok: true });
  });

  /**
   * Build do APK (Fase 2) — visto do desktop. Autenticada, e precisa de HTTPS
   * de verdade já de pé (TWA não builda em cima de IP/HTTP puro — ver
   * `apk-build.ts`). Dispara em segundo plano; `GET` é só consulta de status,
   * pro painel Celular fazer polling enquanto `fase` for `"construindo"`.
   */
  app.post("/v1/apk/build", (c) => {
    const https = estadoAtual().https;
    if (!https) return c.json({ error: "HTTPS ainda não está disponível — sem ele, o TWA não builda" }, 400);
    construirApk(home, https);
    return c.json(estadoAtualBuild(home), 202);
  });

  app.get("/v1/apk/build", (c) => c.json(estadoAtualBuild(home)));

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
        ...(p.nickname ? { nickname: p.nickname } : {}),
        engine: p.engine,
        status: p.status,
        limits: seen[p.id] ?? null,
      })),
    );
  });

  /** Clique no anel do painel: lê o uso da conta agora (um turno mínimo, ver `pingUsoDaConta`). */
  app.post("/v1/accounts/:id/limits/atualizar", async (c) => {
    const r = await pingUsoDaConta(c.req.param("id"), home);
    if (r === "indisponivel") return c.json({ error: "conta não encontrada ou sem login" }, 404);
    return c.json({ resultado: r, limits: allLimits()[c.req.param("id")] ?? null });
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

  app.get("/v1/profiles/:id/codex-models", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "perfil não existe" }, 404);
    return c.json({ models: codexModels(p, home) });
  });

  // 200 sempre: falha de instalação é resultado esperado, não erro de rota — o corpo
  // ({ok,log}) é quem diz o que aconteceu, senão o `req()` do desktop jogaria fora o
  // `log` (só guarda `data.error` no catch) e a tela mostraria "Bad Request" sem info.
  app.post("/v1/engines/:engine/install", async (c) => {
    const engine = c.req.param("engine");
    if (engine !== "claude" && engine !== "codex") {
      return c.json({ ok: false, log: `sem instalação automática pro motor ${engine}` });
    }
    return c.json(await installEngine(engine));
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
      sandboxMode?: string | null;
      allowedTools?: string[] | null;
      delegacaoModo?: string | null;
      navegadorModo?: string | null;
      nickname?: string | null;
    };
    try {
      return c.json(updateProfile(c.req.param("id"), home, body));
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.includes("não existe") ? 404 : 400);
    }
  });

  app.delete("/v1/profiles/:id", (c) => {
    try {
      removeProfile(c.req.param("id"), home);
      return c.json({ ok: true });
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

  // Sem `projectPath` na query: lista as conversas globais (sem projeto), não todas.
  app.get("/v1/threads", (c) => {
    const projectPath = c.req.query("projectPath") || undefined;
    // `busy` é estado vivo (memória), não vem do JSONL: por isso é carimbado aqui.
    const busy = new Set(busyThreads());
    return c.json(listThreads(projectPath, home).map((t) => ({ ...t, busy: busy.has(t.id) })));
  });

  /**
   * Existe turno de agente em voo em QUALQUER conversa agora? O instalador do app usa isto
   * pra não aplicar update (`quitAndInstall`) no meio de um turno — nunca soube antes que
   * update existia, então basta ser "tem gente trabalhando", sem importar em qual thread.
   */
  app.get("/v1/status/turno-ativo", (c) => c.json({ ativo: busyThreads().length > 0 }));

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

  /**
   * Link do formulário de PR do GitHub pra branch atual do projeto. Quem abre o
   * navegador é o cliente (o desktop tem `shell.openExternal`; o celular abre a
   * aba), então aqui só sai a URL — e o daemon nunca navega por conta própria.
   */
  app.get("/v1/git/pr-url", async (c) => erroDeGit(c, () => alvoDePullRequest(c.req.query("projectPath") || "")));

  /** Branch, limpeza da árvore e distância pro upstream — o que a barra do repositório mostra. */
  app.get("/v1/git/estado", async (c) => erroDeGit(c, () => estadoDoRepo(c.req.query("projectPath") || "")));

  app.get("/v1/git/branches", async (c) => erroDeGit(c, () => listarBranches(c.req.query("projectPath") || "")));

  app.post("/v1/git/checkout", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string; branch?: string };
    return erroDeGit(c, () => trocarBranch(body.projectPath ?? "", body.branch ?? ""));
  });

  app.post("/v1/git/pull", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    return erroDeGit(c, () => atualizar(body.projectPath ?? ""));
  });

  /**
   * Clone com progresso, por SSE: repositório grande leva minutos, e uma tela
   * parada durante esse tempo é indistinguível de travamento. O `ok`/`erro`
   * final vai como evento — o status HTTP já saiu (200) quando o stream abriu,
   * então é o último evento que diz se deu certo, não o código.
   */
  app.post("/v1/git/clone", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string; destinoPai?: string; branch?: string };
    return streamSSE(c, async (stream) => {
      const enviar = (ev: unknown) => stream.writeSSE({ data: JSON.stringify(ev) });
      try {
        const { dir } = await clonar(
          body.url ?? "",
          body.destinoPai ?? "",
          (linha) => {
            void enviar({ type: "progresso", linha });
          },
          { home, ...(body.branch ? { branch: body.branch } : {}) },
        );
        await enviar({ type: "ok", dir });
      } catch (e) {
        await enviar({ type: "erro", message: (e as Error).message || "clone falhou" });
      }
    });
  });

  /** Skills que o menu "/" do composer oferece: as do projeto aberto mais as do perfil ativo. */
  app.get("/v1/skills", (c) => {
    const projectPath = c.req.query("projectPath") || undefined;
    const profileId = c.req.query("profileId") || undefined;
    return c.json(listSkills(home, profileId, projectPath));
  });

  /** Configurações → Skills: liga/desliga uma skill global num projeto. */
  app.put("/v1/skills/projeto", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { nome?: unknown; projectPath?: unknown; ligada?: unknown };
    const nome = typeof body.nome === "string" ? body.nome.trim() : "";
    const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
    if (!nome || !projectPath || typeof body.ligada !== "boolean") {
      return c.json({ error: "nome, projectPath e ligada (boolean) são obrigatórios" }, 400);
    }
    return c.json({ skillsDesligadas: definirSkillNoProjeto(home, nome, projectPath, body.ligada) });
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
    const body = (await c.req.json()) as { projectPath?: string; profileId?: string; agentId?: string; branch?: string };
    try {
      // `projectPath` ausente = conversa global (chat geral), sem projeto. Enviado mas vazio é erro
      // — evita um cliente mandar "" sem querer e criar uma conversa global sem perceber.
      // Sem pasta, a conversa também não entra em nenhuma listagem por projeto (filtra por
      // projectPath) nem em /v1/projects, sem erro nenhum pra quem criou.
      if (body.projectPath !== undefined && typeof body.projectPath === "string" && !body.projectPath.trim()) {
        return c.json({ error: "projectPath, se enviado, não pode ser vazio" }, 400);
      }
      const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() || undefined : undefined;
      // Com agente, a conta dele é o padrão — mas um profileId explícito ainda manda.
      const def = body.agentId ? getAgent(body.agentId, home) : undefined;
      if (body.agentId && !def) return c.json({ error: `agente não existe: ${body.agentId}` }, 400);
      const profileId = body.profileId || def?.profileId || "";
      if (!profileId) return c.json({ error: "profileId obrigatório" }, 400);
      const branch = typeof body.branch === "string" ? body.branch.trim() : "";
      // Antes de criar: depois disso a própria conversa já conta como "projeto conhecido" e o
      // teste de novidade não veria mais diferença nenhuma.
      const jaConhecido = projectPath
        ? projetosConhecidos(home).some((p) => projectKey(p) === projectKey(projectPath))
        : false;
      const created = await createThreadNaBranch(
        { ...(projectPath ? { projectPath } : {}), profileId, ...(def ? { agentId: def.id } : {}), ...(branch ? { branch } : {}) },
        home,
      );
      if (projectPath) {
        // Best-effort: cobre regra global criada antes deste projeto existir pro Nexos. Não pode
        // derrubar a criação da conversa por causa disto (ex.: pasta sem `.git` — sincronização já
        // ignora, mas por garantia extra contra qualquer outro erro imprevisto).
        try {
          sincronizarHooksDoProjeto(projectPath, home);
        } catch (e) {
          log.aviso("hook", "sincronizar hooks ao abrir projeto falhou", { projectPath, erro: (e as Error).message || String(e) });
        }
        // Primeira vez que este projeto abre no Nexos: constrói o índice do repo map (Camada 1) —
        // só se ainda não existir, pra não recalcular à toa em toda abertura (git.post-commit já
        // mantém fresco depois disso). Sem custo de LLM — seguro rodar aqui, best-effort.
        try {
          if (!indiceDisponivel(projectPath, home)) construirIndice(projectPath, home, leitorDeResumos(projectPath, home));
        } catch (e) {
          log.aviso("motor", "construir índice do repo map ao abrir projeto falhou", { projectPath, erro: (e as Error).message || String(e) });
        }
        // `nexo.projeto-novo`: só na PRIMEIRA vez que este projeto aparece pro Nexos — fire-and-forget,
        // igual post-commit/post-push (já aconteceu, não tem o que bloquear).
        if (!jaConhecido) {
          try {
            fireHook("nexo.projeto-novo", projectPath, home);
          } catch (e) {
            log.aviso("hook", "nexo.projeto-novo falhou", { projectPath, erro: (e as Error).message || String(e) });
          }
        }
      }
      return c.json(created, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/v1/threads/:id", (c) => {
    try {
      const id = c.req.param("id");
      const eventos: unknown[] = readThread(id, home);
      // fala em curso (ainda não gravada): a tela continua ela com o que chegar no SSE
      const emVooTexto = textoEmVoo(id);
      if (emVooTexto) eventos.push({ ts: new Date().toISOString(), type: "assistant", threadId: id, text: emVooTexto, emVoo: true });
      return c.json(eventos);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  /** Times chamados deste chat (em curso e recentes) — a barra "trabalhando" acima do input. */
  app.get("/v1/threads/:id/runs", (c) => c.json(runsDoChat(c.req.param("id"), home)));

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
    const body = (await c.req.json()) as { text?: string; images?: IncomingImage[]; elementos?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    const images = Array.isArray(body.images) ? body.images : [];
    const elementos = lerElementos(body.elementos);
    // Mensagem só de imagem (ou só de elementos do preview) vale; vazia de tudo, não.
    if (!text.trim() && images.length === 0 && elementos.length === 0) return c.json({ error: "mensagem vazia" }, 400);
    try {
      await postMessage(c.req.param("id"), text, home, images, elementos.length ? { elementos } : {});
      return c.json({ ok: true });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 400;
      return c.json({ error: (e as Error).message }, status as 400);
    }
  });

  /** Mensagem pro turno EM VOO (ver `injetarMensagem`). `injetada: false` = manda pela fila. */
  app.post("/v1/threads/:id/inject", async (c) => {
    const body = (await c.req.json()) as { text?: string; images?: IncomingImage[] };
    const text = typeof body.text === "string" ? body.text : "";
    const images = Array.isArray(body.images) ? body.images : [];
    if (!text.trim() && images.length === 0) return c.json({ error: "mensagem vazia" }, 400);
    try {
      return c.json({ injetada: injetarMensagem(c.req.param("id"), text, home, images) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
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

  /** Ícone escolhido à mão (menu do projeto). Body: { nome, base64 } da imagem. */
  app.put("/v1/projects/logo", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { nome?: unknown; base64?: unknown };
    if (typeof body.nome !== "string" || typeof body.base64 !== "string") return c.json({ error: "nome e base64 obrigatórios" }, 400);
    try {
      definirLogoManual(projectPath, home, body.nome, body.base64);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 500) as 400);
    }
  });

  /** Volta pro ícone automático. */
  app.delete("/v1/projects/logo", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    limparLogoManual(projectPath, home);
    return c.json({ ok: true });
  });

  /** Logo/ícone do projeto pra barra lateral. 404 = sem logo (o app mostra o ícone de pasta). */
  app.get("/v1/projects/logo", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const logo = logoDoProjeto(projectPath, home);
    if (!logo) return c.json({ error: "sem logo" }, 404);
    try {
      const corpo = readFileSync(logo.caminho);
      return c.body(corpo, 200, {
        "content-type": logo.mime,
        // SVG de projeto é arquivo de terceiro: sem script nem recurso externo quando aberto direto
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "cache-control": "private, max-age=300",
        "x-nexos-logo": logo.manual ? "manual" : "auto",
      });
    } catch {
      return c.json({ error: "sem logo" }, 404);
    }
  });

  /* ---------- serviços locais do projeto ---------- */

  app.get("/v1/services", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(listServices(projectPath, home));
  });

  /** Marca o projeto como confiável: sem isso o autostart do nexos.json é ignorado. */
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
      const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string; matar?: unknown; ignorarPorta?: unknown };
      if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
      try {
        const id = c.req.param("id");
        const status =
          acao === "start"
            ? startService(body.projectPath, id, home, { matar: body.matar === true, ignorarPorta: body.ignorarPorta === true })
            : acao === "stop"
              ? stopService(body.projectPath, id, home)
              : await restartService(body.projectPath, id, home);
        return c.json(status);
      } catch (e) {
        const err = e as Error & { status?: number };
        // erro de parse do nexos.json não é culpa do request: 422
        const status = err.status ?? (/nexo\.json/.test(err.message) ? 422 : 400);
        return c.json({ error: err.message }, status as 400);
      }
    });
  }

  /** Processos soltos que o Nexos pôs de pé, de qualquer projeto (ver processos.ts). */
  app.get("/v1/processos", (c) => c.json({ processos: listarProcessos(home) }));

  /** Mata pela `chave` da lista — PID cru não passa: o daemon só mata o que ele mesmo listou. */
  app.post("/v1/processos/matar", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { chave?: unknown };
    if (typeof body.chave !== "string" || !body.chave) return c.json({ error: "chave obrigatória" }, 400);
    if (!matarProcesso(home, body.chave)) return c.json({ error: "processo não está mais na lista" }, 404);
    return c.json({ ok: true });
  });

  /** Troca a porta do serviço (ver `trocarPorta`): a do `nexos.json` desfaz. */
  app.post("/v1/services/:id/port", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string; porta?: unknown };
    if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(await trocarPorta(body.projectPath, c.req.param("id"), Number(body.porta), home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

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

  /* ---------- Nexos Hooks: regras ---------- */

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

  /* ---------- Design system do projeto (view Canvas) ---------- */

  const dsErro = (c: Context, e: unknown) => {
    const err = e as Error & { status?: number };
    return c.json({ error: err.message }, (err.status ?? 400) as 400);
  };

  app.get("/v1/ds", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(estadoDs(projectPath, home));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Pontos de partida pro DS novo: do zero, padrão do Nexos e os DS que já existem. */
  app.get("/v1/ds/bases", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(listarBases(projectPath, home));
  });

  app.post("/v1/ds", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { nome?: unknown; base?: unknown };
      return c.json(criarDs(projectPath, home, body), 201);
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.put("/v1/ds/ativo", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { id?: string };
      return c.json(ativarDs(projectPath, home, String(body.id ?? "")));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** DS oficial do projeto: o que as conversas seguem e de onde sai o painel de mocks. */
  app.put("/v1/ds/oficial", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { id?: string };
      return c.json(definirOficial(projectPath, home, String(body.id ?? "")));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.delete("/v1/ds/:id", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(removerDs(projectPath, home, c.req.param("id")));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.put("/v1/ds/tokens", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { tokens?: unknown; base?: string };
      return c.json(salvarTokens(projectPath, home, body.tokens, body.base));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.put("/v1/ds/cards/:card", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as Parameters<typeof salvarCard>[3];
      return c.json(salvarCard(projectPath, home, c.req.param("card"), body));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Plano padrão de seções/cards — o Canvas monta o formulário e a estimativa a partir dele. */
  app.get("/v1/ds/gerar/plano", (c) =>
    c.json({ secoes: PLANO_PADRAO.map((s) => ({ id: s.id, titulo: s.titulo, cards: s.cards.length })) }),
  );

  app.get("/v1/ds/gerar", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({ geracao: geracaoAtual(projectPath) });
  });

  app.post("/v1/ds/gerar", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as GerarInput;
      return c.json({ geracao: iniciarGeracao(projectPath, home, body) }, 202);
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.post("/v1/ds/gerar/cancelar", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({ geracao: await cancelarGeracao(projectPath, motorPadrao(home)) });
  });

  /* Fase 5: DS ↔ código */

  /** Cor solta no front do projeto e qual token usar. Determinístico, sem LLM. */
  app.get("/v1/ds/conformidade", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(conformidade(projectPath, home));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** O que o código usa e o DS não tem (e o contrário). */
  app.get("/v1/ds/ressincronizar", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(ressincronizar(projectPath, home));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Aplica os itens da ressincronia que a pessoa aprovou (grava tokens.json, sem LLM). */
  app.post("/v1/ds/ressincronizar/aplicar", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { base?: string; itens?: ItemRessincronia[] };
      if (typeof body.base !== "string") return c.json({ error: "base obrigatório (hash do tokens.json lido)" }, 400);
      return c.json(aplicarRessincronia(projectPath, home, body.base, body.itens ?? []));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.get("/v1/ds/exportar", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    const formato = c.req.query("formato") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    if (!["css", "tailwind4", "tailwind3", "dtcg"].includes(formato)) return c.json({ error: "formato: css, tailwind4, tailwind3 ou dtcg" }, 400);
    try {
      return c.json(exportar(projectPath, home, formato as FormatoExport));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /* Fase 4: versões, variantes, controles e feedback por card */

  app.get("/v1/ds/cards/:card/versoes", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(listarVersoes(projectPath, home, c.req.param("card")));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.post("/v1/ds/cards/:card/restaurar", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { versao?: string };
      return c.json(restaurarVersao(projectPath, home, c.req.param("card"), String(body.versao ?? "")));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.delete("/v1/ds/cards/:card", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(apagarCard(projectPath, home, c.req.param("card")));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.post("/v1/ds/cards/:card/promover", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(promoverVariante(projectPath, home, c.req.param("card")));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** "Aplicar" dos Controles: grava os valores no bloco `data-ds-controles-valores` do card. */
  app.post("/v1/ds/cards/:card/controles", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { valores?: Record<string, unknown>; base?: string };
      const ds = estadoDs(projectPath, home).ds;
      const card = ds?.cards.find((x) => x.id === c.req.param("card"));
      if (!ds || !card) return c.json({ error: "card não existe" }, 404);
      const html = aplicarControles(card.html, body.valores ?? {}, ds.vars);
      return c.json(salvarCard(projectPath, home, card.id, { html, base: body.base ?? card.hash }, { versionar: true }));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Tipos de card e, pros de token, quais tokens o modelo pode mostrar (a lista pra marcar). */
  app.get("/v1/ds/tipos", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const ds = estadoDs(projectPath, home).ds;
    if (!ds) return c.json({ error: "este projeto não tem design system" }, 404);
    return c.json(
      TIPOS.map((t) => ({
        id: t.id,
        titulo: t.titulo,
        daIa: t.daIa,
        tokens: t.daIa ? [] : varsDoTipo(t.id as TipoDeToken, ds.vars).map((v) => ({ nome: v.nome, caminho: v.caminho, valor: v.valor })),
      })),
    );
  });

  /** Card de token (cores, tipografia, espaçamento, forma) montado do modelo, sem IA. */
  app.post("/v1/ds/cards", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as NovoCardDeTipo;
      return c.json(criarCardDeTipo(projectPath, home, body), 201);
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Card novo desenhado pela IA (componente, livre…), com streaming como a geração. */
  app.post("/v1/ds/cards/novo-ia", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as NovoCardInput;
      return c.json({ geracao: iniciarNovoCard(projectPath, home, body) }, 202);
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Layout de um card: título, seção, largura, mover (-1/+1) e, nos Fundamentos, ocultar. */
  app.patch("/v1/ds/cards/:card", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as MudancaDeCard;
      return c.json(mudarCard(projectPath, home, c.req.param("card"), body));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Título e alinhamento da seção (topo, esticar, alvenaria). */
  app.patch("/v1/ds/secoes/:secao", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { titulo?: unknown; alinhamento?: unknown };
      return c.json(mudarSecao(projectPath, home, c.req.param("secao"), body));
    } catch (e) {
      return dsErro(c, e);
    }
  });

  app.post("/v1/ds/cards/:card/feedback", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as FeedbackInput;
      return c.json({ geracao: iniciarFeedback(projectPath, home, c.req.param("card"), body) }, 202);
    } catch (e) {
      return dsErro(c, e);
    }
  });

  /** Mudança em disco na pasta do DS ativo. O Canvas relê `GET /v1/ds` e anima a diferença. */
  app.get("/v1/ds/events", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const pasta = pastaDoAtivo(projectPath, home);
    if (!pasta) return c.json({ error: "este projeto não tem design system" }, 404);
    return streamSSE(c, async (stream) => {
      let sair: () => void = () => {};
      // progresso da geração por IA vai no mesmo stream: o Canvas já está ouvindo este
      const canal = canalGeracao(projectPath);
      const onGeracao = (ev: unknown) => void stream.writeSSE({ data: JSON.stringify(ev) });
      geracaoBus.on(canal, onGeracao);
      try {
        const sairDoDisco = assinarDs(pasta, (ev) => {
          void stream.writeSSE({ data: JSON.stringify(ev) });
        });
        sair = () => {
          sairDoDisco();
          geracaoBus.off(canal, onGeracao);
        };
      } catch (e) {
        geracaoBus.off(canal, onGeracao);
        // pasta sumiu do disco entre o ponteiro e o watch: o Canvas mostra o erro no GET
        await stream.writeSSE({ data: JSON.stringify({ type: "erro", message: (e as Error).message }) });
        return;
      }
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sair();
          resolve();
        });
      });
    });
  });

  /* ---------- Tarefas (quadro Kanban por projeto) ---------- */

  app.get("/v1/tarefas/quadro", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(getQuadro(projectPath, home));
  });

  app.post("/v1/tarefas/colunas", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as ColunaInput;
      return c.json(salvarColuna(projectPath, body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/tarefas/colunas/:id", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as ColunaInput;
      return c.json(salvarColuna(projectPath, { ...body, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/tarefas/colunas/:id", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      apagarColuna(projectPath, c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  app.post("/v1/tarefas/marcos", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as MarcoInput;
      return c.json(salvarMarco(projectPath, body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/tarefas/marcos/:id", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as MarcoInput;
      return c.json(salvarMarco(projectPath, { ...body, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/tarefas/marcos/:id", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      apagarMarco(projectPath, c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  app.get("/v1/tarefas", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(listarTarefas(projectPath, home));
  });

  app.post("/v1/tarefas", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as TarefaInput;
      return c.json(salvarTarefa(body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.get("/v1/tarefas/:id", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const t = getTarefa(projectPath, home, c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "tarefa não existe" }, 404);
  });

  app.put("/v1/tarefas/:id", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as TarefaInput;
      const projectPath = c.req.query("projectPath") || body.projectPath;
      if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
      return c.json(salvarTarefa({ ...body, projectPath, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/tarefas/:id", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      apagarTarefa(projectPath, home, c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  /** Commits cuja mensagem menciona o id da tarefa — sempre computado na hora, ver tarefas-git.ts. */
  app.get("/v1/tarefas/:id/commits", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const id = c.req.param("id");
    if (!getTarefa(projectPath, home, id)) return c.json({ error: "tarefa não existe" }, 404);
    return c.json(commitsRelacionados(projectPath, id));
  });

  app.post("/v1/tarefas/etiquetas", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as EtiquetaInput;
      return c.json(salvarEtiqueta(projectPath, body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/tarefas/etiquetas/:id", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as EtiquetaInput;
      return c.json(salvarEtiqueta(projectPath, { ...body, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/tarefas/etiquetas/:id", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      apagarEtiqueta(projectPath, c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  app.post("/v1/tarefas/:id/checklist", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { texto?: string };
      return c.json(adicionarChecklistItem(projectPath, home, c.req.param("id"), body.texto ?? ""), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/tarefas/:id/checklist/:itemId", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { feito?: boolean };
      alternarChecklistItem(projectPath, home, c.req.param("id"), c.req.param("itemId"), Boolean(body.feito));
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/tarefas/:id/checklist/:itemId", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      apagarChecklistItem(projectPath, home, c.req.param("id"), c.req.param("itemId"));
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  app.post("/v1/tarefas/:id/comentarios", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { texto?: string; autor?: string };
      return c.json(adicionarComentario(projectPath, home, c.req.param("id"), body.texto ?? "", body.autor), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /**
   * Gatilho dos Nexos Hooks — chamado pelo script instalado em `.git/hooks/`
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
    // Camada 1 do repo map (índice) não passa por regra/agente — atualiza direto a cada commit,
    // best-effort, independente de qualquer regra configurada (ver sincronizarHooksDoProjeto).
    if (event === "git.post-commit" && projectPath) {
      try {
        construirIndice(projectPath, home, leitorDeResumos(projectPath, home));
      } catch (e) {
        log.aviso("hook", "construir índice do repo map no post-commit falhou", { projectPath, erro: (e as Error).message || String(e) });
      }
    }
    try {
      if (event === "git.pre-push") return c.json(await dispararPrePush(projectPath, branch, home));
      return c.json(fireHook(event, projectPath, home, { branch }));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /* ---------- Planejamento (planejamento.ts) ---------- */

  /** Mesmo formato de erro das outras rotas; 409 leva a versão atual pra quem chamou refazer. */
  const erroDoPlano = (c: Context, e: unknown) => {
    const err = e as Error & { status?: number; atual?: unknown };
    const status = (err.status ?? 400) as 400;
    return c.json(err.status === 409 ? { error: err.message, atual: err.atual ?? null } : { error: err.message }, status);
  };

  app.get("/v1/planejamento", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(listarPlanos(projectPath, home));
  });

  /**
   * A conversa do Agent Manager do plano: a que já está ligada a ele, ou uma nova (com
   * `thread_meta.planejamento`) se não houver ou se ela sumiu do disco.
   */
  const conversaDoManager = (projectPath: string, slug: string, profileId: unknown, origemThreadId?: string): string => {
    const atual = abrirPlano(projectPath, home, slug).roteiro.threadId;
    if (atual && threadHead(atual, home)?.planejamento?.slug === slug) return atual;
    if (typeof profileId !== "string" || !profileId) {
      const err = new Error("profileId obrigatório pra abrir a conversa do Manager") as Error & { status: number };
      err.status = 400;
      throw err;
    }
    // `origemThreadId`: plano nascido de conversa — o botão "voltar" do chat leva pra ela
    const { id } = createThread({ projectPath, profileId, planejamento: { slug }, ...(origemThreadId ? { origemThreadId } : {}) }, home);
    vincularThread(projectPath, home, slug, id);
    return id;
  };

  /**
   * Cria o plano e, com `profileId`, já a conversa do Manager. Com `deThreadId`, o plano nasce de
   * uma conversa existente: projeto e título vêm dela, e o Manager já recebe a transcrição como
   * primeiro pedido (sem esperar o turno — a tela só abre o plano).
   */
  app.post("/v1/planejamento", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { titulo?: unknown; profileId?: unknown; deThreadId?: unknown };
      if (typeof body.deThreadId === "string" && body.deThreadId) {
        const origem = conversaDeOrigem(body.deThreadId, home);
        const plano = criarPlano(origem.projectPath, home, { titulo: body.titulo || origem.titulo });
        const threadId = conversaDoManager(origem.projectPath, plano.slug, body.profileId, body.deThreadId);
        void postMessage(threadId, pedidoDeConversa(origem), home).catch((err) =>
          log.erro("turno", `plano a partir da conversa ${String(body.deThreadId)} falhou`, { threadId, erro: (err as Error).message }),
        );
        return c.json({ ...abrirPlano(origem.projectPath, home, plano.slug), projectPath: origem.projectPath, threadId }, 201);
      }
      const projectPath = c.req.query("projectPath") || "";
      if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
      const plano = criarPlano(projectPath, home, { titulo: body.titulo });
      if (body.profileId) conversaDoManager(projectPath, plano.slug, body.profileId);
      return c.json(abrirPlano(projectPath, home, plano.slug), 201);
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /** Garante a conversa do Manager de um plano existente (reabrir pela lista). */
  app.post("/v1/planejamento/:slug/manager", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { profileId?: unknown };
      return c.json({ threadId: conversaDoManager(projectPath, c.req.param("slug"), body.profileId) });
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /** SSE: um evento por escrita em qualquer plano deste projeto (a tela filtra pelo slug). */
  app.get("/v1/planejamento/events", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return streamSSE(c, async (stream) => {
      const canal = canalPlanejamento(projectPath);
      const ouvir = (ev: EventoPlano) => void stream.writeSSE({ data: JSON.stringify(ev) });
      planejamentoBus.on(canal, ouvir);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          planejamentoBus.off(canal, ouvir);
          resolve();
        });
      });
    });
  });

  /** O que dá pra anexar num card: telas dos DS do projeto e tarefas do Quadro. */
  app.get("/v1/planejamento/alvos", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(alvosDeAnexo(projectPath, home));
  });

  /** Plano + `integracao`: estado atual (DS/Quadro) dos anexos dos cards e das tarefas das etapas. */
  app.get("/v1/planejamento/:slug", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const plano = abrirPlano(projectPath, home, c.req.param("slug"));
      return c.json({ ...plano, integracao: resolverIntegracao(projectPath, home, plano) });
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  app.put("/v1/planejamento/:slug/roteiro", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { etapas?: unknown; titulo?: unknown; expectedRev?: unknown };
      return c.json(salvarRoteiro(projectPath, home, c.req.param("slug"), { ...body, expectedRev: body.expectedRev }));
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  app.put("/v1/planejamento/:slug/etapas/:etapa", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { status?: unknown; expectedRev?: unknown };
      return c.json(
        marcarEtapa(projectPath, home, c.req.param("slug"), { etapa: c.req.param("etapa"), status: body.status, expectedRev: body.expectedRev }),
      );
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /**
   * Veredito da pessoa sobre o mock de um card de tela. A conversa de implementação do plano
   * recebe o resultado: no turno em voo (inject) se estiver trabalhando, senão como mensagem nova.
   */
  app.post("/v1/planejamento/:slug/cards/:id/design", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { veredito?: unknown; motivo?: unknown; expectedRev?: unknown };
      const r = avaliarDesign(projectPath, home, c.req.param("slug"), { id: c.req.param("id"), veredito: body.veredito, motivo: body.motivo, expectedRev: body.expectedRev });
      let avisou = false;
      if (r.implementacaoThreadId && threadHead(r.implementacaoThreadId, home)) {
        avisou = true;
        if (!injetarMensagem(r.implementacaoThreadId, r.mensagem, home)) {
          void postMessage(r.implementacaoThreadId, r.mensagem, home).catch((err) =>
            log.erro("turno", "aviso do design pra implementação falhou", { threadId: r.implementacaoThreadId, erro: (err as Error).message }),
          );
        }
      }
      return c.json({ card: r.card, avisou });
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /** Andamento da implementação de uma etapa (tela); move a tarefa dela no Quadro, se houver. */
  app.put("/v1/planejamento/:slug/etapas/:etapa/implementacao", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { estado?: unknown; expectedRev?: unknown };
      return c.json(
        marcarImplementacaoDaEtapa(projectPath, home, c.req.param("slug"), {
          etapa: c.req.param("etapa"),
          estado: body.estado,
          expectedRev: body.expectedRev,
        }),
      );
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /** Cria (sem id na rota: POST) ou atualiza (PUT com id) um card; `expectedRev` no corpo. */
  app.post("/v1/planejamento/:slug/cards", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as CardInput;
      return c.json(salvarCardDoPlano(projectPath, home, c.req.param("slug"), { ...body, expectedRev: 0 }), 201);
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  app.put("/v1/planejamento/:slug/cards/:id", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as CardInput & { expectedRev?: unknown };
      return c.json(salvarCardDoPlano(projectPath, home, c.req.param("slug"), { ...body, id: c.req.param("id"), expectedRev: body.expectedRev }));
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  app.delete("/v1/planejamento/:slug/cards/:id", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      apagarCardDoPlano(projectPath, home, c.req.param("slug"), { id: c.req.param("id"), expectedRev: Number(c.req.query("rev")) });
      return c.json({ ok: true });
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  app.put("/v1/planejamento/:slug/layout", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(salvarLayout(projectPath, home, c.req.param("slug"), await c.req.json().catch(() => ({}))));
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  app.get("/v1/planejamento/:slug/handoff", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(listarHandoffs(projectPath, home, c.req.param("slug")));
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /** Conferência + rascunho automático + o pedido fixo pro Manager (passo 1 e 2 do envio). */
  app.get("/v1/planejamento/:slug/handoff/rascunho", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const plano = abrirPlano(projectPath, home, c.req.param("slug"));
      const p = prontidao(plano);
      return c.json({ texto: montarHandoff(plano), prontidao: p, pedido: pedidoAoManager(plano, p.bloqueios.length) });
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /**
   * Envia pra implementação: grava o texto final em `handoff/` (arquivo novo, nunca sobrescreve),
   * cria a conversa "Implementação: <título>" com `thread_meta.handoff` e manda o texto nela — sem
   * esperar o turno (a tela só abre a conversa).
   */
  app.post("/v1/planejamento/:slug/handoff/enviar", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const slug = c.req.param("slug");
      const body = (await c.req.json().catch(() => ({}))) as { texto?: unknown; profileId?: unknown; quadro?: unknown };
      if (typeof body.profileId !== "string" || !body.profileId) return c.json({ error: "profileId obrigatório" }, 400);
      if (typeof body.texto !== "string" || !body.texto.trim()) return c.json({ error: "texto do handoff obrigatório" }, 400);
      const plano = abrirPlano(projectPath, home, slug);
      const { id: threadId } = createThread(
        { projectPath, profileId: body.profileId, title: `Implementação: ${plano.roteiro.titulo}`, handoff: { slug } },
        home,
      );
      // `quadro`: uma tarefa por etapa, já ligada a esta conversa; o texto ganha a lista delas
      const envio = body.quadro === true && plano.roteiro.etapas.length ? enviarAoQuadro(projectPath, home, slug, { threadId }) : null;
      const texto = envio ? `${body.texto.trimEnd()}\n\n${blocoDeTarefas(plano, envio)}` : body.texto;
      const handoff = escreverHandoff(projectPath, home, slug, texto);
      vincularImplementacao(projectPath, home, slug, threadId);
      void postMessage(threadId, handoff.texto.trimEnd(), home).catch((err) =>
        log.erro("turno", `envio do plano ${slug} falhou`, { threadId, erro: (err as Error).message }),
      );
      return c.json({ threadId, handoff: handoff.nome, ...(envio ? { quadro: envio } : {}) }, 201);
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /** Etapas → tarefas no Quadro sem enviar pra implementação (idempotente). */
  app.post("/v1/planejamento/:slug/quadro", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json(enviarAoQuadro(projectPath, home, c.req.param("slug")), 201);
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  app.post("/v1/planejamento/:slug/handoff", async (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { texto?: unknown };
      return c.json(escreverHandoff(projectPath, home, c.req.param("slug"), body.texto), 201);
    } catch (e) {
      return erroDoPlano(c, e);
    }
  });

  /* ---------- Repo map ---------- */

  /**
   * "O que o Nexos sabe deste projeto" — memória + repo map + quantos Nexos Hooks (global ou deste
   * projeto) valem pra ele, numa chamada só. É a fonte da tela "Memória do Projeto" no desktop.
   */
  app.get("/v1/projeto/status", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({
      memoria: statusDaMemoria(projectPath, home),
      repoMap: statusDoIndice(projectPath, home),
      repoMapResumos: loadConfig(home).modulos.repoMapResumos,
      hooksCount: regrasDoEscopo(listarRegras(home), projectPath).length,
      ...projectSlug(projectPath, home),
    });
  });

  /** Espelho de `/v1/projeto/status`, mas pro chat geral (sem projeto) — só memória, sem repo map/hooks de projeto. */
  app.get("/v1/chat-geral/status", (c) => c.json({ memoria: statusDaMemoriaGlobal(home) }));

  /**
   * Importa um zip de export de outra ferramenta (hoje: Data export do Claude.ai) como
   * conversas GLOBAIS (sem projeto) — cada conversa do zip vira uma thread no chat geral.
   * Corpo em base64, mesmo padrão de `attachments.ts` (upload binário via JSON, sem multipart).
   */
  app.post("/v1/import/zip", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { zip?: string; profileId?: string };
    if (typeof body.zip !== "string" || !body.zip) return c.json({ error: "zip (base64) obrigatório" }, 400);
    if (!body.profileId) return c.json({ error: "profileId obrigatório" }, 400);
    if (!getProfile(body.profileId, home)) return c.json({ error: `perfil não existe: ${body.profileId}` }, 400);
    try {
      const buffer = Buffer.from(body.zip, "base64");
      const resultado = importarZip(buffer, body.profileId, home);
      return c.json(resultado, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Nome de pasta manual pra este projeto dentro de `projetosDir` — sobrescreve o slug detectado
   * (git remote ou nome da pasta local). Migra na hora (não espera o próximo restart do daemon)
   * pra quem já tinha dados no slug antigo não perder nada até reabrir o Nexos.
   */
  app.put("/v1/projeto/slug", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string; slug?: string };
    const projectPath = body.projectPath ?? "";
    const slug = (body.slug ?? "").trim();
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) return c.json({ error: "slug inválido — use letras minúsculas, números e -" }, 400);
    const chave = projectKey(projectPath);
    saveConfig(home, { slugOverrides: { ...loadConfig(home).slugOverrides, [chave]: slug } });
    migrarProjeto(projectPath, home);
    return c.json(projectSlug(projectPath, home));
  });

  /** Recalcula a Camada 1 (índice) do zero — sem custo de LLM, seguro num botão. */
  app.post("/v1/repo-map/atualizar", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    const projectPath = body.projectPath ?? "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    construirIndice(projectPath, home, leitorDeResumos(projectPath, home));
    return c.json(statusDoIndice(projectPath, home));
  });

  /** Dispara a geração de resumos por IA (enriquecimento opcional) pros arquivos que ainda não têm. */
  app.post("/v1/repo-map/resumos/gerar", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    const projectPath = body.projectPath ?? "";
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const r = await gerarResumosSobDemanda(projectPath, home);
    return c.json(r, r.ok ? 200 : 400);
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
      /** Chat que chamou (menção): os passos ficam dentro dele e o resultado volta pra ele. */
      origemThreadId?: string;
    };
    try {
      const run = criarRun(
        {
          teamId: body.teamId ?? "",
          projectPath: body.projectPath ?? "",
          goal: body.goal ?? "",
          budget: body.budget,
          origemThreadId: body.origemThreadId,
        },
        home,
      );
      // Cópia antes de disparar: `executarRun` roda síncrono até o primeiro
      // await e já marca o passo 1 como "running". Sem isso, o corpo da
      // resposta dependeria de onde a execução tivesse chegado ao serializar.
      const criado = structuredClone(run);
      void executarNoChat(run, home, { entregar: true });
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
    /*
     * `c.body(null, 202)` deixa a conexão keep-alive sem Content-Length. O fetch
     * do CLI (Bun) lê isso como "socket closed unexpectedly" na PRÓXIMA chamada
     * MCP — visto na prática: `nexo_tarefa_listar` falha, `nexo_mapa_simbolos`
     * na sequência já passa. Corpo vazio + Content-Length 0 + Connection: close
     * fecha o HTTP direito.
     */
    c.header("Connection", "close");
    if (r.status === 202) {
      c.header("Content-Length", "0");
      return c.body("", 202);
    }
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
   * o repo map soma quando o projeto já tem índice construído (Camada 2 + a ferramenta de
   * gravar resumo do enriquecimento, que fica disponível independente de índice existir —
   * é escrita de cache, não execução, mesmo critério de "aceitável" que já vale pra autoria).
   */
  app.post("/v1/mcp", (c) => {
    const projectPath = c.req.query("projectPath") || "";
    const runId = c.req.query("runId") || "";
    const threadId = c.req.query("threadId") || "";
    // Agent Manager (Tela de Planejamento): só o plano DELE (slug e projeto vêm da thread, nunca da
    // URL), perguntar e o mapa do repo — nada de autoria, tarefas, delegar, navegador ou Windows.
    const head = threadId && !runId ? threadHead(threadId, home) : undefined;
    if (head?.planejamento && head.projectPath) {
      const pp = head.projectPath;
      const slug = head.planejamento.slug;
      return responderMcp(c, () => [
        ...ferramentasDePlanejamento(pp, slug, home)(),
        // do DS só o print (ver a tela); criar/ativar/salvar ficam de fora
        ...ferramentaDePrintDoDs(threadId, pp, home)().filter((f) => f.name === "nexo_ds_print"),
        ...ferramentaDePerguntar(threadId, home)(),
        // Manager mostra o design/plano/quadro enquanto planeja; navegador só sem url (sem controle)
        ...ferramentaDePainel(threadId, "negado", home)(),
        ...ferramentasDeRepoMap(pp, home)(),
        ...ferramentaDeResumo(pp, home)(),
      ]);
    }
    // `nexo_delegar` só em conversa NORMAL (sem runId) — é isso que impede recursão: o que ele
    // dispara é sempre um passo de Run, que nasce COM runId e por isso nunca cai aqui de novo.
    const modoDelegacao = threadId && projectPath && !runId ? modoDeDelegacaoDaThread(threadId, home) : "negado";
    // `nexo_navegador_*` também só em conversa normal — não existe <webview> num run headless
    // (spec explícita: "ferramenta não aparece no conjunto MCP de um passo de Run").
    const modoNavegador = threadId && !runId ? modoDeNavegadorDaThread(threadId, home) : "negado";
    // conversa de implementação de um plano: lê e ajusta o plano dela (slug vem da thread)
    // (projeto também vem da thread, não da URL: o plano mora no projeto dela)
    const impl = threadId && !runId ? threadHead(threadId, home) : undefined;
    const conjunto: Conjunto = () => [
      ...(impl?.handoff && impl.projectPath ? ferramentasDePlanejamento(impl.projectPath, impl.handoff.slug, home, "implementacao")() : []),
      ...ferramentasDeAutoria(home)(),
      ...(projectPath ? ferramentasDeRepoMap(projectPath, home)() : []),
      ...(projectPath ? ferramentaDeResumo(projectPath, home)() : []),
      ...(projectPath && loadConfig(home).modulos.quadroTarefas ? ferramentasDeTarefas(projectPath, home)() : []),
      ...(runId ? ferramentaDeVeredito(runId)() : []),
      ...(threadId ? ferramentaDePerguntar(threadId, home)() : []),
      ...(modoDelegacao !== "negado" ? ferramentaDeDelegar(threadId, projectPath, modoDelegacao, home)() : []),
      ...(modoNavegador !== "negado" ? ferramentasDeNavegador(threadId, home, modoNavegador)() : []),
      ...(threadId && projectPath && !runId ? ferramentaDePrintDoDs(threadId, projectPath, home)() : []),
      ...(threadId && !runId ? ferramentaDePainel(threadId, modoNavegador, home)() : []),
      // Gate mestre: `--allowed-tools` (engines/cli.ts::profileFlags) já barra a CHAMADA
      // incondicionalmente se a config estiver desligada; listar aqui também, e não só lá,
      // é só pra não expor `tools/list` como se a ferramenta existisse quando não pode rodar.
      ...(!runId && loadConfig(home).windowsControlEnabled ? ferramentasDeControleDoWindows()() : []),
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

  /**
   * Resolve o comando de navegador pendente de `nexo_navegador_*` nesta thread — mesmo formato de
   * `/v1/perguntas/:threadId/responder`, ver navegador.ts. Diferente da pergunta, `ok` pode vir
   * `false` (a ação falhou de verdade no painel Browser) sem isso ser erro de rota.
   */
  app.post("/v1/navegador/:threadId/responder", async (c) => {
    const threadId = c.req.param("threadId");
    const body = (await c.req.json().catch(() => ({}))) as {
      ok?: boolean;
      texto?: string;
      imagem?: { dataBase64: string; mimeType: string };
    };
    if (typeof body.ok !== "boolean") return c.json({ error: 'faltou "ok"' }, 400);
    const resultado = { ok: body.ok, texto: typeof body.texto === "string" ? body.texto : "", imagem: body.imagem };
    const resolvido = responderNavegador(threadId, resultado);
    if (!resolvido) return c.json({ error: "nenhum comando de navegador pendente nesta conversa" }, 404);
    return c.json({ ok: true });
  });

  /** O app devolve o print pedido por `nexo_ds_print` (ds-print.ts). */
  /** O app abriu (ou não) o painel pedido por `nexo_abrir_painel` — ver paineis.ts. */
  app.post("/v1/paineis/:id/responder", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ok?: boolean; texto?: string };
    if (typeof body.ok !== "boolean") return c.json({ error: 'faltou "ok"' }, 400);
    const ok = responderPainel(c.req.param("id"), { ok: body.ok, texto: typeof body.texto === "string" ? body.texto : "" });
    if (!ok) return c.json({ error: "nenhum pedido de painel pendente com esse id" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/ds/print/:id/responder", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ok?: boolean; texto?: string; imagem?: { dataBase64: string; mimeType: string } };
    if (typeof body.ok !== "boolean") return c.json({ error: 'faltou "ok"' }, 400);
    const ok = responderPrint(c.req.param("id"), { ok: body.ok, texto: typeof body.texto === "string" ? body.texto : "", imagem: body.imagem });
    if (!ok) return c.json({ error: "nenhum print pendente com esse id" }, 404);
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
      void executarNoChat(run, home, { entregar: true });
      return c.json(retomado);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /** Para um agente só do run (botão da barra "trabalhando"). */
  app.post("/v1/runs/:id/steps/:index/parar", async (c) => {
    const parou = await pararPasso(c.req.param("id"), Number(c.req.param("index")));
    return parou ? c.json({ ok: true }) : c.json({ error: "esse agente não está trabalhando agora" }, 409);
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

  /*
   * Só pra teste manual do destrave (`NEXOS_DEBUG=1`): segura o event loop por `ms` — ou pra
   * sempre, sem `ms` —, que é exatamente o motor travado que o app precisa detectar e reiniciar.
   */
  if (process.env.NEXOS_DEBUG === "1") {
    app.post("/v1/debug/travar", (c) => {
      const ms = Number(c.req.query("ms") ?? 0);
      log.aviso("motor", `rota de debug: travando o event loop ${ms > 0 ? `por ${ms} ms` : "pra sempre"}`);
      const ate = ms > 0 ? Date.now() + ms : Infinity;
      while (Date.now() < ate) {
        /* travado de propósito */
      }
      return c.json({ ok: true });
    });
  }

  app.get("/v1/config", (c) => {
    // pasta de projetos salva que é pasta de repos: ignorada (ver projetosRoot) — a tela avisa
    const ignorada = projetosDirIgnorado(home);
    return c.json({ ...loadConfig(home), ...(ignorada ? { projetosDirIgnorado: ignorada } : {}) });
  });
  app.put("/v1/config", async (c) => {
    const cfgAntes = loadConfig(home);
    const nivelAntes = nivelDoLog();
    const antes = cfgAntes.modulos.repoMapResumos;
    const body = await c.req.json();
    /*
     * `projetosDir` é pasta de DADOS do Nexos (memória, tarefas, repo map). Apontada pra pasta de
     * código (repo ou pasta de repos), o Nexos passava a gravar lá dentro e, com o Google
     * conectado, copiava tudo pro Drive (279.990 arquivos numa máquina). Recusa antes de gravar.
     */
    const novaPasta = typeof body?.projetosDir === "string" ? body.projetosDir.trim() : "";
    if (novaPasta && novaPasta !== cfgAntes.projetosDir && pastaDeCodigo(novaPasta)) {
      return c.json(
        { error: "Essa pasta tem repositórios git — escolha uma pasta vazia só pros dados do Nexos, não a pasta dos seus projetos." },
        400,
      );
    }
    const next = saveConfig(home, body);
    // nível do log vale na hora, sem reiniciar o motor
    if (recarregarNivel(home) !== nivelAntes) log.info("motor", `nível do log agora é ${nivelDoLog()}`);
    /*
     * Apagar `memoriaDir`/`tarefasDir`/`graphDir` troca o layout daquele tipo pro novo (pasta
     * única por projeto, nome estável entre máquinas). O conteúdo que estava na raiz antiga
     * precisa vir junto, e só AQUI ainda se sabe qual era ela — depois de gravar, o valor
     * antigo não existe em lugar nenhum.
     */
    for (const campo of ["memoriaDir", "tarefasDir", "graphDir"] as const) {
      if (cfgAntes[campo] && !next[campo]) {
        migrarRaizLegadaRemovida(campo, cfgAntes[campo], projetosConhecidos(home), home);
      }
    }
    // pasta ↔ projeto: os dados de cada projeto vêm junto (cópia; o lugar antigo fica de backup)
    if (cfgAntes.armazenamento !== next.armazenamento) {
      migrarArmazenamento(cfgAntes.armazenamento, next.armazenamento, projetosConhecidos(home), home);
    }
    // Efeito colateral do toggle: liga (ou reconfere, se só a conta trocou) o agente + a regra do
    // módulo "Resumos por IA" sem esperar reiniciar o daemon. Só DESLIGA na transição true→false —
    // chamar em toda gravação de config (mesmo trocar a cor) apagaria uma regra que a pessoa
    // tivesse criado à mão apontando pro mesmo agente, por coincidência.
    if (next.modulos.repoMapResumos) sincronizarRepoMapResumos(home);
    else if (antes) desligarRepoMapResumos(home);
    return c.json(next);
  });

  app.post("/v1/github/login/start", async (c) => {
    try {
      return c.json(await startGithubLogin(home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.get("/v1/github/login/status", (c) => {
    const loginId = c.req.query("loginId") ?? "";
    if (!loginId) return c.json({ error: "loginId obrigatório" }, 400);
    try {
      return c.json(githubLoginStatus(loginId));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.post("/v1/github/login/cancel", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { loginId?: string };
    if (body.loginId) cancelGithubLogin(body.loginId);
    return c.json({ ok: true });
  });

  // Conta única, global (não por perfil): ver github-auth.ts.
  app.get("/v1/github", (c) => c.json(githubAccount(home)));
  app.delete("/v1/github", (c) => {
    disconnectGithub(home);
    return c.json({ connected: false });
  });

  app.get("/v1/github/repos", async (c) => {
    try {
      return c.json(await listGithubRepos(home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.get("/v1/github/branches", async (c) => {
    const repo = c.req.query("repo") ?? "";
    if (!repo) return c.json({ error: "repo obrigatório" }, 400);
    try {
      return c.json(await listGithubBranches(home, repo));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  /* ---------- Google Drive (conta única, global): login e escolha da pasta no navegador + sync ---------- */
  const googleRota = async (c: Context, f: () => unknown | Promise<unknown>) => {
    try {
      return c.json((await f()) as object);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  };

  app.get("/v1/google", (c) => c.json(googleAccount(home)));
  app.delete("/v1/google", (c) => {
    disconnectGoogle(home);
    return c.json(googleAccount(home));
  });
  app.post("/v1/google/login/start", (c) => googleRota(c, () => startGoogleLogin(home)));
  app.post("/v1/google/pasta/start", (c) => googleRota(c, () => startEscolherPasta(home)));
  app.get("/v1/google/login/status", (c) => {
    const loginId = c.req.query("loginId") ?? "";
    if (!loginId) return c.json({ error: "loginId obrigatório" }, 400);
    return googleRota(c, () => googleLoginStatus(loginId));
  });
  app.post("/v1/google/login/cancel", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { loginId?: string };
    if (body.loginId) cancelGoogleLogin(body.loginId);
    return c.json({ ok: true });
  });

  app.get("/v1/drive", (c) => c.json(driveStatus(home)));
  app.post("/v1/drive/sync", (c) => googleRota(c, () => sincronizarDrive(home)));

  // Modo (desligado/automatico/perguntar) fica em /v1/config (não é segredo). A key
  // fica aqui, separada: GET nunca devolve o valor, só se está configurada.
  app.get("/v1/typesafe", (c) =>
    c.json({ configured: hasTypesafeApiKey(home), usage: typesafeUsage(home), pausa: pausaDoTypesafe(home) ?? null }),
  );
  app.put("/v1/typesafe", async (c) => {
    const body = (await c.req.json()) as { apiKey?: string };
    if (typeof body.apiKey !== "string") return c.json({ error: "apiKey obrigatório" }, 400);
    try {
      if (body.apiKey === "") clearTypesafeApiKey(home);
      else saveTypesafeApiKey(body.apiKey, home);
      return c.json({ configured: hasTypesafeApiKey(home), usage: typesafeUsage(home) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /**
   * Aceita ou descarta a sugestão pendente do roteamento (`roteamento` com `aplicado: false`) —
   * agente em modo "perguntar", ou time (que nunca aplica sozinho). Aceitar agente atribui à
   * thread (`agent_assigned`, vale a partir da próxima mensagem); aceitar time dispara o run em
   * background, igual `/v1/runs` — o resultado não volta pra esta conversa, fica no run.
   */
  app.post("/v1/threads/:id/roteamento", async (c) => {
    const threadId = c.req.param("id");
    const body = (await c.req.json()) as { aceitar?: boolean };
    try {
      const events = readThread(threadId, home);
      const pendente = [...events].reverse().find((e) => e.type === "roteamento" && !e.aplicado);
      if (!pendente || pendente.type !== "roteamento") return c.json({ error: "sem sugestão pendente" }, 404);
      const jaDecidido = events.some(
        (e) => e.type === "roteamento_decidido" && events.indexOf(e) > events.indexOf(pendente),
      );
      if (jaDecidido) return c.json({ error: "sugestão já decidida" }, 409);

      const ts = new Date().toISOString();
      // O turno ficou PARADO esperando esta decisão (ver `postMessage`): aceitar time manda o
      // trabalho pro run e a conversa não responde; qualquer outro caminho retoma o turno aqui.
      let viraRun = false;
      if (body.aceitar) {
        if (pendente.tipo === "agente" && pendente.alvo) {
          appendEvent({ ts, type: "agent_assigned", threadId, agentId: pendente.alvo, confianca: pendente.confianca }, home);
        } else if (pendente.tipo === "time" && pendente.alvo) {
          const meta = events.find((e) => e.type === "thread_meta");
          const projectPath = meta && meta.type === "thread_meta" ? meta.projectPath : undefined;
          // Delegar a time exige projeto real (Run.projectPath) — conversa global (sem projeto)
          // fica fora do escopo por enquanto.
          if (!projectPath) return c.json({ error: "sem projeto: essa conversa não pode virar run de time" }, 400);
          const run = criarRun({ teamId: pendente.alvo, projectPath, goal: pendente.tarefa, origemThreadId: threadId }, home);
          viraRun = true;
          void executarNoChat(run, home, { entregar: true });
        }
      }
      appendEvent({ ts, type: "roteamento_decidido", threadId, aceito: Boolean(body.aceitar) }, home);
      // Fora do await: o turno pode demorar minutos e quem clicou não deve ficar preso na resposta.
      if (!viraRun) void retomarTurnoPendente(threadId, home);
      return c.json({ ok: true, retomado: !viraRun });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return app;
}
