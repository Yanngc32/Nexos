import { createApiClient } from "./api.js";
import { createFileTree } from "./file-tree.js";
import { createServicesPanel } from "./services.js";
import { aplicarNoRetrato } from "./agent-events.js";
import { createAgentStudio } from "./agent-studio.js";
import { createTeamStudio } from "./team-studio.js";
import { createHooksStudio } from "./hooks-studio.js";
import { lerEventos } from "./sse.js";
import { initCombobox } from "./combobox.js";
import { aplicarEventoDeRun, rotuloDoPasso, duracaoDoPasso, larguraDosPassos } from "./run-view.js";
import { fmtDuracao } from "./agent-trace.js";
import { agruparConversas } from "./thread-groups.js";
import { escapeHtml, renderMd } from "./markdown.js";
import {
  ago,
  clip,
  elapsed,
  fmtDetail,
  fmtReset,
  fmtTokens,
  fmtWhen,
  folderName,
  normPath,
  samePath,
} from "./format.js";
import { portaDaUrl, safeUrl, urlDoCelular } from "./url.js";
import { qrSvg } from "./qr.js";
import { celAlcance, celAviso } from "./celular.js";
import { extrairMencoes } from "./mention.js";
import { montarMensagem } from "./inspector-mensagem.js";
import { criarInspectorHost } from "./inspector-host.js";
import { FASE } from "./inspector-estado.js";

const $ = (id) => document.getElementById(id);

const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_ACCENT = "#4d9cd6";

const MODULES = [
  { id: "file", name: "Arquivo", keys: "Ctrl+G", ico: "📄" },
  { id: "terminal", name: "Terminal", keys: "Ctrl+J", ico: ">_" },
  { id: "browser", name: "Browser", keys: "Ctrl+Shift+B", ico: "🌐" },
  { id: "canvas", name: "Canvas", keys: "", ico: "▦" },
  { id: "graph", name: "Memória do Projeto", keys: "", ico: "◈" },
  { id: "side-chat", name: "Chat lateral", keys: "Ctrl+Shift+S", ico: "💬" },
];

const state = {
  ok: false,
  /** runId de `nexo_delegar` que chegou (evento `delegacao_run`) antes da bolha da ferramenta existir, por threadId. */
  subchatsPendentes: new Map(),
  projectPath: localStorage.getItem("nexo.project") || "",
  threadId: localStorage.getItem("nexo.thread") || "",
  profileId: "",
  profiles: [],
  /** Catálogo real de modelos do codex por perfil (ver /v1/profiles/:id/codex-models). `undefined` = ainda não pediu. */
  codexModels: {},
  pendingQuota: null,
  abortSse: null,
  fpThreads: "",
  fpProfiles: "",
  view: "file",
  sideChat: false,
  paletteOpen: false,
  paletteIndex: 0,
  paletteFilter: "",
  paletteKey: "",
  previewId: "",
  events: [],
  talking: false,
  think: { on: false, timer: null, start: 0, frame: 0, verb: 0, tokens: 0 },
  login: { id: "", profileId: "", url: "", poll: 0 },
  meter: {
    contextTokens: 0,
    contextWindow: 200_000,
    limits: null,
    totals: null,
    model: "",
    effort: "",
    permissionMode: "",
    sandboxMode: "",
    sessionModel: "",
    sessionId: "",
  },
  repos: [],
  hiddenRepos: new Set(),
  reposOpen: new Set(),
  /** Grupos de run abertos na lista. Só em memória: é estado da sessão, não preferência. */
  runsOpen: new Set(),
  threadsByRepo: {},
  setPanel: "aparencia",
  fileCache: null,
  termBuf: "",
  termRunning: false,
  term: null,
  fit: null,
  browserUrl: "about:blank",
  strokes: [],
  canvasNote: "",
  drawing: null,
  /** Imagens ainda no composer, esperando envio. */
  pendingImages: [],
  /** Object URLs vivos no log; revogados quando o log é recriado. */
  logShotUrls: [],
  /**
   * Menu de autocomplete do composer — serve tanto "/" (kind "cmd", sempre a mensagem
   * inteira) quanto "@" (kind "mencao", token em qualquer ponto do texto). A posição do
   * token não mora aqui: `applySlashSelection` recalcula na hora, porque mover o cursor sem
   * digitar não atualizaria um valor guardado.
   */
  slash: { open: false, index: 0, matches: [], kind: "cmd" },
  /** Skills descobertas (projeto + perfil); recarrega quando projectPath/profileId muda. */
  skills: { list: [], key: "", loading: false },
  /** Agentes/times pro autocomplete do "@"; carrega uma vez por sessão (mesma fonte do painel). */
  mencoes: { loaded: false, loading: false },
  /** SSE da conversa está de pé? O poll do motor usa isso pra religar sozinho. */
  sseOn: false,
  /** Fila de mensagens por thread: { [threadId]: [{ text, images }] }. */
  queue: {},
  /** Fila pausada porque o turno acabou mal (quota/login/erro). */
  queuePaused: false,
  /** Serviços locais declarados no nexo.json do projeto. */
  /**
   * Painel de agentes: um retrato por conversa com motor de pé, alimentado pelo
   * SSE global. É o que permite acompanhar duas contas trabalhando ao mesmo tempo.
   */
  agents: {
    list: [],
    open: localStorage.getItem("nexo.agentsOpen") === "1",
    abort: null,
    on: false,
    tick: null,
    paint: 0,
    refetch: null,
    fpBusy: "",
    /** threadIds com `nexo_perguntar` pendente agora — alimenta o badge, mesmo fora da conversa. */
    perguntasPendentes: new Set(),
    /** Motor antigo, sem /v1/agents: para de tentar em vez de martelar a rota. */
    unsupported: false,
    /** Agentes personalizados salvos (definições), não o que está rodando. */
    defs: [],
    defsLoaded: false,
    defsUnsupported: false,
  },
  /** Agente personalizado da conversa aberta; "" = conta pura. */
  agentId: "",
  /** Modo "selecionar elemento" do painel Browser — fase de verdade mora em `inspectorHost`
   * (ver inspector-host.js); isto só espelha a seleção acumulada pra `renderInspectorBox`.
   * `caixaAberta` é só apresentação: a caixa flutuante só nasce no 1º clique (posicionada
   * lá) e fica aberta até o modo desligar, mesmo que todos os chips sejam removidos. */
  inspector: { selecionados: [], caixaAberta: false },
  /** Times de agentes; a lista vive aqui porque o painel e a tela cheia leem. */
  teams: [],
  /** Regras de Nexo Hook; mesma razão de `teams`. */
  hookRules: [],
  /** Aba ativa da tela unificada Agentes/Times/Hooks (`#pane-agentes`). */
  axTab: "agentes",
};

const { api, aplicar: aplicarInfoDoMotor, headers, renovarCredenciais, req, reqBlob } = createApiClient({
  daemonInfo: () => window.nexo.daemonInfo(),
  // porta e token ficam no cliente; "o motor está de pé?" a UI lê em dezenas de pontos
  onInfo: (info) => {
    state.ok = info.ok;
  },
});

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_MAX_PER_MESSAGE = 6;

function trackLogUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.logShotUrls.push(url);
  return url;
}

function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Aceita o que vier de Ctrl+V, arrastar ou seletor; recusa o resto com motivo. */
function addImages(files) {
  const erros = [];
  for (const file of files) {
    if (!file) continue;
    if (!IMAGE_MIMES.includes(file.type)) {
      erros.push(`${file.name || "arquivo"}: só PNG, JPG, GIF ou WebP`);
      continue;
    }
    if (file.size > ATTACH_MAX_BYTES) {
      erros.push(`${file.name || "imagem"}: passa de 10 MB`);
      continue;
    }
    if (state.pendingImages.length >= ATTACH_MAX_PER_MESSAGE) {
      erros.push(`no máximo ${ATTACH_MAX_PER_MESSAGE} imagens por mensagem`);
      break;
    }
    state.pendingImages.push({
      file,
      name: file.name || "imagem colada",
      url: URL.createObjectURL(file),
    });
  }
  paintPending();
  if (erros.length) appendEvent({ type: "error", message: erros.join(" · ") });
}

function paintPending() {
  const strip = $("attach-strip");
  if (!strip) return;
  strip.classList.toggle("hidden", state.pendingImages.length === 0);
  strip.replaceChildren();
  state.pendingImages.forEach((item, i) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    const img = document.createElement("img");
    img.src = item.url;
    img.alt = "";
    const label = document.createElement("span");
    label.className = "attach-name";
    label.textContent = item.name;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "attach-x";
    x.title = "Remover";
    x.textContent = "×";
    x.addEventListener("click", () => {
      URL.revokeObjectURL(item.url);
      state.pendingImages.splice(i, 1);
      paintPending();
    });
    chip.append(img, label, x);
    strip.append(chip);
  });
}

/** Some do composer sem revogar: o URL passa a ser do log, que mostra a mensagem enviada. */
function takePending() {
  const items = state.pendingImages;
  state.pendingImages = [];
  paintPending();
  for (const item of items) state.logShotUrls.push(item.url);
  return items;
}

function clearPending() {
  for (const item of state.pendingImages) URL.revokeObjectURL(item.url);
  state.pendingImages = [];
  paintPending();
}

async function encodeImages(items) {
  const out = [];
  for (const item of items) {
    const buf = await item.file.arrayBuffer();
    out.push({ name: item.name, mime: item.file.type, data: bytesToBase64(new Uint8Array(buf)) });
  }
  return out;
}

/** Miniatura clicável: `previews` vem do envio agora, `attachments` vem do histórico. */
function shotsRow(items, threadId) {
  const row = document.createElement("div");
  row.className = "msg-shots";
  for (const item of items) {
    const img = document.createElement("img");
    img.className = "msg-shot";
    img.alt = item.name || "imagem";
    img.title = `${item.name || "imagem"} — clique pra ampliar`;
    img.addEventListener("click", () => img.classList.toggle("big"));
    row.append(img);
    if (item.url) img.src = item.url;
    else void fillShot(img, item.file, threadId);
  }
  return row;
}

async function fillShot(img, file, threadId) {
  if (!file || !threadId) return;
  try {
    const blob = await reqBlob(`/v1/threads/${threadId}/attachments/${encodeURIComponent(file)}`);
    img.src = trackLogUrl(blob);
  } catch {
    img.replaceWith(Object.assign(document.createElement("span"), {
      className: "attach-name",
      textContent: `${img.alt} (não achei o arquivo)`,
    }));
  }
}





function hydrateRepos() {
  let repos = [];
  try {
    const raw = JSON.parse(localStorage.getItem("nexo.repos") || "[]");
    if (Array.isArray(raw)) repos = raw.filter((p) => typeof p === "string" && p);
  } catch {
    repos = [];
  }
  let escondidas = [];
  try {
    const raw = JSON.parse(localStorage.getItem("nexo.reposHidden") || "[]");
    if (Array.isArray(raw)) escondidas = raw.filter((p) => typeof p === "string" && p);
  } catch {
    escondidas = [];
  }
  state.hiddenRepos = new Set(escondidas.map(normPath));
  repos = repos.filter((p) => !state.hiddenRepos.has(normPath(p)));
  const current = localStorage.getItem("nexo.project") || "";
  if (current && !state.hiddenRepos.has(normPath(current)) && !repos.some((p) => samePath(p, current))) {
    repos.unshift(current);
  }
  state.repos = repos;
  let open = [];
  try {
    const raw = JSON.parse(localStorage.getItem("nexo.reposOpen") || "[]");
    if (Array.isArray(raw)) open = raw.filter((p) => typeof p === "string" && p);
  } catch {
    open = [];
  }
  if (!open.length && current) open = [current];
  state.reposOpen = new Set(open.map(normPath));
}

let reposTimer;
function persistRepos() {
  // localStorage é só cache local: o dono da lista é o config do daemon
  localStorage.setItem("nexo.repos", JSON.stringify(state.repos));
  localStorage.setItem("nexo.reposOpen", JSON.stringify([...state.reposOpen]));
  localStorage.setItem("nexo.reposHidden", JSON.stringify([...state.hiddenRepos]));
  if (!state.ok) return;
  clearTimeout(reposTimer);
  reposTimer = setTimeout(() => {
    void req("/v1/config", {
      method: "PUT",
      body: JSON.stringify({
        repos: state.repos,
        hiddenRepos: [...state.hiddenRepos],
        lastProject: state.projectPath || "",
        lastThread: state.threadId || "",
      }),
    }).catch(() => {});
  }, 250);
}

/** Junta o que o daemon guardou com o cache local, sem perder nenhum dos dois. */
function mergeReposFromConfig(cfg) {
  const doDaemon = Array.isArray(cfg?.repos) ? cfg.repos : [];
  // O daemon já filtra as escondidas, mas o PUT que as grava é debounced: até
  // ele chegar, o poll ainda traria a pasta removida de volta.
  if (Array.isArray(cfg?.hiddenRepos)) {
    for (const p of cfg.hiddenRepos) if (typeof p === "string" && p) state.hiddenRepos.add(normPath(p));
  }
  const juntos = doDaemon.filter((p) => !state.hiddenRepos.has(normPath(p)));
  for (const p of state.repos) {
    if (state.hiddenRepos.has(normPath(p))) continue;
    if (!juntos.some((x) => samePath(x, p))) juntos.push(p);
  }
  const mudou = juntos.length !== state.repos.length || juntos.some((p, i) => !samePath(p, state.repos[i]));
  state.repos = juntos;
  if (!state.projectPath && cfg?.lastProject) state.projectPath = cfg.lastProject;
  if (!state.threadId && cfg?.lastThread) state.threadId = cfg.lastThread;
  if (!state.reposOpen.size && state.projectPath) state.reposOpen.add(normPath(state.projectPath));
  return mudou;
}

function rememberRepo(path) {
  if (!path) return;
  // Abrir a pasta de novo é o desfazer do "tirar da lista".
  state.hiddenRepos.delete(normPath(path));
  if (!state.repos.some((p) => samePath(p, path))) state.repos = [...state.repos, path];
  state.reposOpen.add(normPath(path));
  persistRepos();
}

function forgetRepo(path) {
  state.repos = state.repos.filter((p) => !samePath(p, path));
  state.reposOpen.delete(normPath(path));
  state.hiddenRepos.add(normPath(path));
  delete state.threadsByRepo[path];
  persistRepos();
}

function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111111" : "#f5f5f5";
}

function applyAccent(hex) {
  if (!HEX.test(hex)) return false;
  document.documentElement.style.setProperty("--accent", hex);
  document.documentElement.style.setProperty("--accent-ink", inkFor(hex));
  $("accent-picker").value = hex;
  $("accent-hex").value = hex;
  localStorage.setItem("nexo.accent", hex);
  for (const btn of $("accent-swatches").querySelectorAll("button")) {
    btn.dataset.on = btn.dataset.accent.toLowerCase() === hex.toLowerCase() ? "1" : "0";
  }
  paintPetFrame();
  return true;
}

let accentTimer;
function persistAccent(hex) {
  if (!applyAccent(hex)) return;
  clearTimeout(accentTimer);
  accentTimer = setTimeout(() => {
    if (state.ok) {
      void req("/v1/config", { method: "PUT", body: JSON.stringify({ accent: hex }) }).catch(() => {});
    }
  }, 250);
}

const MODEL_OPTION_VALUES = ["", "opus", "sonnet", "haiku", "fable"];
const CLAUDE_MODEL_ENTRIES = [
  { value: "", label: "Modelo: padrão" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];
/** Mesma ordem do <select id="mode-select">: valor do CLI -> rótulo. */
const MODE_VALUES = ["", "auto", "manual", "acceptEdits", "plan", "bypassPermissions"];
const MODE_NAMES = ["padrão", "automático", "manual", "aceitar edições", "planejar", "ignorar permissões"];
const CLAUDE_MODE_ENTRIES = [
  { value: "", label: "Modo: padrão" },
  { value: "auto", label: "Automático", title: "Claude gerencia decisões de permissão" },
  { value: "manual", label: "Manual", title: "Sempre perguntar antes de fazer alterações" },
  { value: "acceptEdits", label: "Aceitar edições", title: "Aceitar automaticamente todas as edições" },
  { value: "plan", label: "Planejar", title: "Criar um plano antes de fazer alterações" },
  { value: "bypassPermissions", label: "Ignorar permissões", title: "Aceita todas as permissões" },
];

/**
 * Modelo do codex é string livre (o catálogo real tem slug tipo `gpt-5.6-terra`,
 * não 4 aliases fixos) — por isso o valor especial abaixo abre o campo de texto
 * `#model-custom` em vez de forçar tudo num <select>.
 */
const CODEX_CUSTOM_MODEL = "__custom__";
/** Sandbox é a política real do `codex exec -s`; ver `codexFlags` em cli.ts do daemon. */
const CODEX_SANDBOX_ENTRIES = [
  { value: "", label: "Modo: padrão" },
  { value: "read-only", label: "Somente leitura", title: "Comando roda sem poder escrever nada" },
  { value: "workspace-write", label: "Leitura e escrita", title: "Comando pode escrever na pasta do projeto" },
  {
    value: "danger-full-access",
    label: "Acesso total (perigoso)",
    title: "Sem sandbox — comando pode tocar a máquina inteira",
  },
];
const CODEX_SANDBOX_LABELS = Object.fromEntries(CODEX_SANDBOX_ENTRIES.filter((e) => e.value).map((e) => [e.value, e.label]));
/** Esforço genérico quando o modelo escolhido é custom ou o catálogo ainda não chegou. */
const CODEX_EFFORT_FALLBACK = ["low", "medium", "high"];
/** Rótulo de esforço por valor — cobre os dois motores, sem depender da ordem de um array fixo. */
const EFFORT_LABELS = { low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto", max: "máximo", ultra: "ultra" };
function effortLabel(effort) {
  return effort ? EFFORT_LABELS[effort] || effort : "padrão";
}

/**
 * Busca o catálogo real de modelos do codex por perfil (ver /v1/profiles/:id/codex-models no
 * daemon). Só o resultado NÃO-VAZIO fica em cache pra sempre: `models_cache.json` só existe
 * depois do primeiro login/turno, então um perfil recém-criado busca vazio primeiro — sem
 * refazer a busca depois, o catálogo nunca apareceria até reiniciar o app inteiro.
 */
async function loadCodexModels(profileId) {
  const atual = state.codexModels[profileId];
  if (!profileId || atual === null || (Array.isArray(atual) && atual.length)) return;
  state.codexModels[profileId] = null; // marca "pedido em voo" pra não disparar fetch duplicado
  try {
    const { models } = await req(`/v1/profiles/${encodeURIComponent(profileId)}/codex-models`);
    state.codexModels[profileId] = Array.isArray(models) ? models : [];
  } catch {
    state.codexModels[profileId] = [];
  }
  if (selectedProfile()?.id === profileId) syncEngineControls();
}

const SIDE_MIN = 56;
const SIDE_MINI_AT = 150;
const SIDE_MAX = 460;
const CHAT_MIN = 300;
const CHAT_MAX = 900;

function lsGet(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage pode estar bloqueado */
  }
}

function applySideWidth(px, persist = true) {
  const mini = px < SIDE_MINI_AT;
  const width = mini ? SIDE_MIN : Math.min(SIDE_MAX, px);
  document.body.dataset.sideMini = mini ? "1" : "0";
  document.body.style.setProperty("--side-w", `${width}px`);
  if (persist) lsSet("nexo.sideW", String(width));
}

function applyChatWidth(px, persist = true) {
  const width = Math.max(CHAT_MIN, Math.min(CHAT_MAX, px));
  document.body.style.setProperty("--chat-w", `${width}px`);
  if (persist) lsSet("nexo.chatW", String(width));
  // fit() mede o DOM e redimensiona o buffer do xterm: caro demais pra cada quadro
  // de arraste. `persist` marca o fim da interação — é lá que vale pagar o preço.
  if (persist) requestAnimationFrame(() => state.fit?.fit());
}

/** Fecha a prévia do arquivo: só a árvore fica, ganhando a largura toda. */
function setFilePreview(on, persist = true) {
  $("file-split").dataset.preview = on ? "1" : "0";
  const btn = $("btn-file-preview");
  btn.textContent = on ? "Prévia" : "Mostrar prévia";
  btn.title = on ? "Esconder prévia" : "Mostrar prévia";
  if (persist) lsSet("nexo.filePreview", on ? "1" : "0");
}

/** Foco: só o prompt. Sai com Esc ou pelo botão no canto. */
function setFocus(on, persist = true) {
  document.body.dataset.focus = on ? "1" : "0";
  $("btn-focus-exit").classList.toggle("hidden", !on);
  $("btn-focus").textContent = on ? "Sair do foco" : "Foco";
  if (on && !state.sideChat) {
    state.sideChat = true;
    applyWorkLayout();
  }
  if (persist) lsSet("nexo.focus", on ? "1" : "0");
  requestAnimationFrame(() => state.fit?.fit());
}

/**
 * Arraste do splitter. `onMove(x, fim)` recebe a posição e se é o último quadro.
 *
 * Três coisas aqui existem só pra não engasgar:
 * 1. pointer capture — com listener no window, passar o cursor sobre o iframe do
 *    browser fazia o evento ir pro documento do iframe e o arraste travava até sair dele.
 * 2. um ajuste por quadro (rAF) — pointermove chega mais rápido que o repaint, e cada
 *    evento forçava um relayout que era jogado fora no evento seguinte.
 * 3. `fim` — gravar no localStorage é síncrono; a cada pixel travava a thread. Só no fim.
 */
function dragSplitter(handleId, onMove) {
  const handle = $(handleId);
  if (!handle) return;
  handle.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    handle.dataset.drag = "1";
    document.body.dataset.dragging = "1";
    let x = down.clientX;
    let frame = 0;
    const flush = () => {
      frame = 0;
      onMove(x, false);
    };
    const move = (e) => {
      x = e.clientX;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      if (frame) cancelAnimationFrame(frame);
      handle.dataset.drag = "0";
      delete document.body.dataset.dragging;
      onMove(x, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}



function setBar(fillId, ratio) {
  const el = $(fillId);
  if (!el) return;
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  el.style.width = `${(pct * 100).toFixed(1)}%`;
  el.dataset.hot = pct >= 0.85 ? "1" : "0";
}

/** Perímetro do anel da bolinha (r=15.5 no viewBox 36x36). */
const RING_LEN = 2 * Math.PI * 15.5;

/**
 * Compactação em curso.
 *
 * Anima o ANEL DO CONTEXTO, e não um canto qualquer da tela, porque é o número
 * dele que vai mudar quando o resumo entrar. Quem vê o anel pulsando está
 * olhando pra coisa certa.
 *
 * O motivo da falha vira aviso no painel: resumir gasta um turno, e falhar em
 * silêncio deixaria a pessoa achando que a conversa está encolhendo quando não
 * está — ela vai seguir sendo cortada como antes.
 */
function pintarCompactando(on, motivo) {
  state.compactando = Boolean(on);
  document.body.dataset.compactando = on ? "1" : "0";
  const rotulo = $("meter-compact");
  if (rotulo) {
    rotulo.textContent = on ? "resumindo o histórico…" : motivo ? `resumo falhou: ${motivo}` : "";
    rotulo.classList.toggle("hidden", !on && !motivo);
    rotulo.dataset.erro = !on && motivo ? "1" : "0";
  }
}

function paintContext() {
  const m = state.meter;
  const win = m.contextWindow || 200_000;
  const used = m.contextTokens || 0;
  const pct = Math.max(0, Math.min(1, win ? used / win : 0));
  $("meter-ctx").textContent = used
    ? `${fmtTokens(used)} / ${fmtTokens(win)} (${Math.round(pct * 100)}%)`
    : `— / ${fmtTokens(win)}`;
  setBar("meter-fill", pct);
  const ring = $("meter-ring");
  ring.style.strokeDasharray = `${RING_LEN}`;
  ring.style.strokeDashoffset = `${RING_LEN * (1 - pct)}`;
  ring.dataset.hot = pct >= 0.85 ? "1" : "0";
  $("meter-dot-pct").textContent = used ? `${Math.round(pct * 100)}` : "—";
  $("meter-dot-pct").title = `Janela de contexto · ${used ? fmtTokens(used) : "—"} / ${fmtTokens(win)}`;
}

function setWire(id, ratio) {
  const el = $(id);
  if (!el) return;
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0));
  el.style.width = `${(pct * 100).toFixed(1)}%`;
  el.dataset.hot = pct >= 0.85 ? "1" : "0";
}

/** No gatilho mostra a janela mais apertada: é ela que vai te barrar primeiro. */
function paintQuotaTrigger(cinco, sem) {
  setWire("wire-5h", cinco?.utilization ?? 0);
  setWire("wire-7d", sem?.utilization ?? 0);
  const pior = Math.max(cinco?.utilization ?? 0, sem?.utilization ?? 0);
  const temDado = Boolean(cinco || sem);
  $("quota-pct").textContent = temDado ? `${Math.round(pior * 100)}%` : "—";
  const box5 = $("wire-5h-box");
  const box7 = $("wire-7d-box");
  if (box5) box5.title = cinco ? `5 h · ${Math.round(cinco.utilization * 100)}% · ${fmtReset(cinco.resetsAt)}` : "5 h · sem dado";
  if (box7) box7.title = sem ? `semana · ${Math.round(sem.utilization * 100)}% · ${fmtReset(sem.resetsAt)}` : "semana · sem dado";
  $("meter-open").title = temDado
    ? `Cota consumida: ${Math.round(pior * 100)}% (a janela mais apertada)`
    : "Cota: sem dado ainda";
}

function paintLimits() {
  const l = state.meter.limits;
  const cinco = l?.fiveHour;
  const sem = l?.sevenDay;
  paintQuotaTrigger(cinco, sem);
  $("lim-5h").textContent = cinco ? `${fmtReset(cinco.resetsAt)} · ${Math.round(cinco.utilization * 100)}%` : "sem dado ainda";
  $("lim-7d").textContent = sem ? `${fmtReset(sem.resetsAt)} · ${Math.round(sem.utilization * 100)}%` : "sem dado ainda";
  setBar("lim-5h-fill", cinco?.utilization ?? 0);
  setBar("lim-7d-fill", sem?.utilization ?? 0);
}

function paintFacts() {
  const m = state.meter;
  const t = m.totals;
  const engineAtivo = selectedProfile()?.engine;
  $("fact-model").textContent = m.model || m.sessionModel || "padrão do CLI";
  $("fact-effort").textContent = `${effortLabel(m.effort)}${m.effort ? ` (${m.effort})` : ""}`;
  const modeVal = engineAtivo === "codex" ? m.sandboxMode : m.permissionMode;
  const mi = Math.max(0, MODE_VALUES.indexOf(m.permissionMode || ""));
  const modeNome = engineAtivo === "codex" ? modeVal && (CODEX_SANDBOX_LABELS[modeVal] || modeVal) : MODE_NAMES[mi];
  $("fact-mode").textContent = `${modeNome || "padrão"}${modeVal ? ` (${modeVal})` : ""}`;
  $("fact-tokens").textContent = t
    ? `${fmtTokens(t.input + t.output + t.cacheRead + t.cacheCreate)} em ${t.turns} turno(s) · saída ${fmtTokens(t.output)}`
    : "—";
  $("fact-cost").textContent = t && t.costUsd ? `US$ ${t.costUsd.toFixed(4)}` : "—";
  $("fact-session").textContent = m.sessionId ? m.sessionId.slice(0, 8) : "—";
}

function paintMeter() {
  $("meter").classList.toggle("hidden", !state.threadId);
  paintContext();
  paintLimits();
  paintFacts();
}

async function refreshMeter() {
  if (!state.threadId || !state.ok) return;
  let data;
  try {
    data = await req(`/v1/threads/${state.threadId}/usage`);
  } catch {
    return;
  }
  state.meter = {
    ...state.meter,
    totals: data.totals,
    contextTokens: data.totals?.contextTokens || state.meter.contextTokens,
    contextWindow: data.session?.contextWindow || state.meter.contextWindow,
    sessionModel: data.session?.model || "",
    sessionId: data.session?.sessionId || "",
    model: data.model || "",
    effort: data.effort || "",
    permissionMode: data.permissionMode || "",
    limits: data.limits || state.meter.limits,
  };
  paintMeter();
}

function toggleMeter(force) {
  const more = $("meter-more");
  const open = force ?? more.classList.contains("hidden");
  more.classList.toggle("hidden", !open);
  $("meter-open").setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) toggleAllAccounts(false);
  try {
    localStorage.setItem("nexo.meterOpen", open ? "1" : "0");
  } catch {
    /* localStorage pode estar bloqueado */
  }
  if (open) void refreshMeter();
}

function paintAllAccounts(rows) {
  const box = $("meter-all");
  if (!rows.length) {
    box.innerHTML = '<p class="empty inline">Nenhuma conta cadastrada.</p>';
    return;
  }
  box.innerHTML = rows
    .map((r) => {
      const cinco = r.limits?.fiveHour;
      const sem = r.limits?.sevenDay;
      const val = cinco
        ? `5h ${Math.round(cinco.utilization * 100)}%${sem ? ` · 7d ${Math.round(sem.utilization * 100)}%` : ""}`
        : "sem dado ainda";
      const me = r.id === state.profileId ? " meter-acc-me" : "";
      return `<div class="meter-row meter-acc${me}"><span>${escapeHtml(r.id)}</span><span class="meter-num">${val}</span></div>`;
    })
    .join("");
}

async function loadAllAccounts() {
  try {
    paintAllAccounts(await req("/v1/accounts/limits"));
  } catch {
    $("meter-all").innerHTML = '<p class="empty inline">Não deu pra ler as contas.</p>';
  }
}

function toggleAllAccounts(force) {
  const box = $("meter-all");
  const open = force ?? box.classList.contains("hidden");
  box.classList.toggle("hidden", !open);
  $("btn-meter-all").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) void loadAllAccounts();
}

const THINK_VERBS = [
  "Pensando",
  "Decifrando",
  "Tramando",
  "Ruminando",
  "Destrinchando",
  "Garimpando",
  "Costurando",
  "Elucubrando",
  "Maquinando",
  "Alinhavando",
];
function thinkTick() {
  const t = state.think;
  if (!t.on) return;
  t.frame += 1;
  // o glifo gira por CSS; aqui só o verbo e o contador
  if (t.frame % 8 === 0) {
    t.verb = (t.verb + 1) % THINK_VERBS.length;
    $("think-word").textContent = THINK_VERBS[t.verb];
  }
  const secs = Math.max(0, Math.round((Date.now() - t.start) / 1000));
  const parts = [`${secs}s`];
  if (t.tokens > 0) parts.push(`${t.tokens} tokens de pensamento`);
  parts.push("esc pra parar");
  $("think-meta").textContent = `· ${parts.join(" · ")}`;
}

function startThink() {
  const t = state.think;
  if (t.on) return;
  t.on = true;
  t.start = Date.now();
  t.frame = 0;
  t.verb = 0;
  t.tokens = 0;
  $("think-word").textContent = THINK_VERBS[0];
  $("think-meta").textContent = "";
  $("think-bar").classList.remove("hidden");
  t.timer = setInterval(thinkTick, 300);
}

function stopThink() {
  const t = state.think;
  t.on = false;
  if (t.timer) clearInterval(t.timer);
  t.timer = null;
  $("think-bar").classList.add("hidden");
  const open = $("log")?.querySelector('li[data-think="1"] details.think[open]');
  if (open && t.start) {
    open.open = false;
    const secs = Math.max(0, Math.round((Date.now() - t.start) / 1000));
    open.querySelector("summary").textContent = `Pensou por ${secs}s`;
  }
}

/* ---------- pet ----------
 * Maguinho no canto do composer. Troca da pedra.
 * Mesmo PNG: idle / work / off. Pisca, logo do notebook, Zzz.
 * Pé (ou aba, no off) cola no topo da box. Tamanho 50%. Gema = --accent.
 * Idle: entra no chapéu e sai. Work: braçinho tecla. Notebook igual.
 */
const PET_BASE = "./pets/nexo/mago/";
const PET_REST = "idle";
const PET_IDLE_SPICE = [
  [PET_REST, PET_REST, "idle-blink", PET_REST],
  [
    PET_REST, "idle-in1", "idle-in2", "idle-hide", "idle-hide",
    "idle-in2", "idle-in1", PET_REST, "idle-blink", PET_REST,
  ],
];
const PET_WORK_SPICE = [
  [
    "work", "work-tap-a", "work-on", "work-tap-b", "work-dim",
    "work-tap-a-on", "work", "work-tap-b", "work-logo", "work-tap-a",
    "work-blink", "work-tap-b-on", "work",
  ],
  [
    "work", "work-tap-b", "work-on", "work-tap-a", "work-dim",
    "work-tap-b-on", "work-logo", "work-tap-a", "work-blink", "work",
  ],
];
const PET_FRAMES = {
  off: ["off", "off-z1", "off-z2", "off-z1"],
  wake: ["idle-hide", "idle-in2", "idle-in1", "idle-blink", PET_REST],
  idle: PET_IDLE_SPICE[0],
  work: PET_WORK_SPICE[0],
};
const PET_NEXT = { wake: "idle" };
const PET_FRAME_MS = { off: 700, wake: 220, idle: 400, work: 120 };

const petState = {
  name: "",
  ok: true,
  timer: 0,
  frame: 0,
  reduceMotion: false,
  workQueue: null,
  idleQueue: null,
  spiceIn: 0,
};
const PET_SCALE = 0.5;
const petImgs = new Map();

function petSrc(frame) {
  return `${PET_BASE}${frame}.png?v=mago2`;
}

function petTitle(name) {
  if (name === "work") return "Motor trabalhando";
  if (name === "idle" || name === "wake") return "Motor ligado";
  return "Motor desligado";
}

function petCurrentFrames() {
  if (petState.name === "work" && petState.workQueue?.length) return petState.workQueue;
  if (petState.name === "idle" && petState.idleQueue?.length) return petState.idleQueue;
  return PET_FRAMES[petState.name] || PET_FRAMES.off;
}

function pickIdleClip() {
  if (petState.reduceMotion) return [PET_REST];
  return PET_IDLE_SPICE[Math.random() < 0.62 ? 0 : 1];
}

function refillIdleQueue() {
  petState.idleQueue = [...pickIdleClip()];
  petState.frame = 0;
}

function pickWorkClip() {
  if (petState.reduceMotion) return ["work"];
  return PET_WORK_SPICE[Math.random() < 0.65 ? 0 : 1];
}

function refillWorkQueue() {
  petState.workQueue = [...pickWorkClip()];
  petState.frame = 0;
}

function frameWait(name, shown) {
  const f = String(shown);
  if (petState.reduceMotion) return 0;
  if (f === "off") return 800;
  if (f.startsWith("off-z")) return 700;
  if (name === "wake") {
    if (f === "idle-hide") return 320;
    if (f === "idle-in1" || f === "idle-in2") return 160;
    if (f === "idle-blink") return 120;
    return 180;
  }
  if (f === PET_REST) return 2000 + Math.floor(Math.random() * 2800);
  if (f === "idle-blink") return 120;
  if (f === "idle-in1" || f === "idle-in2") return 160;
  if (f === "idle-hide") return 700;
  if (f === "work-blink") return 120;
  if (f.startsWith("work-tap")) return 90;
  if (f === "work-on") return 90 + Math.floor(Math.random() * 40);
  if (f === "work-dim") return 70;
  if (f === "work-logo") return 80;
  if (f === "work") return 120 + Math.floor(Math.random() * 80);
  return PET_FRAME_MS[name] || 400;
}

function petImg(frame) {
  let img = petImgs.get(frame);
  if (img) return img;
  img = new Image();
  img.src = petSrc(frame);
  petImgs.set(frame, img);
  return img;
}

function accentRgb() {
  let hex = (getComputedStyle(document.documentElement).getPropertyValue("--accent") || "").trim();
  if (!HEX.test(hex)) hex = DEFAULT_ACCENT;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Só a gema na ponta. Chapéu e notebook iguais. */
function tintPetGem(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let top = h;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 160) continue;
    const y = Math.floor(i / 4 / w);
    if (y < top) top = y;
  }
  if (top >= h) return;
  const y1 = Math.min(h, top + 14);
  const [ar, ag, ab] = accentRgb();
  for (let y = top; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 80) continue;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const blue = b - Math.max(r, g);
      if (blue < 10) continue;
      const t = Math.min(1, blue / 45);
      d[i] = Math.round(r + (ar - r) * t);
      d[i + 1] = Math.round(g + (ag - g) * t);
      d[i + 2] = Math.round(b + (ab - b) * t);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintPetFrame() {
  const sprite = $("pet-sprite");
  if (!sprite || !petState.ok) return;
  const frames = petCurrentFrames();
  if (!frames.length) return;
  const frame = frames[petState.frame % frames.length];
  const img = petImg(frame);
  if (!img.complete || img.naturalWidth === 0) {
    img.onload = () => paintPetFrame();
    return;
  }
  sprite.width = img.naturalWidth;
  sprite.height = img.naturalHeight;
  const dw = Math.max(1, Math.round(img.naturalWidth * PET_SCALE));
  const dh = Math.max(1, Math.round(img.naturalHeight * PET_SCALE));
  sprite.style.width = `${dw}px`;
  sprite.style.height = `${dh}px`;
  const ctx = sprite.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, sprite.width, sprite.height);
  ctx.drawImage(img, 0, 0);
  tintPetGem(ctx, sprite.width, sprite.height);
  sprite.dataset.state = petState.name;
  const stage = $("pet-stage");
  if (stage) {
    stage.dataset.state = petState.name;
    stage.style.width = `${dw}px`;
  }
}

function petTick() {
  clearTimeout(petState.timer);
  petState.timer = 0;
  if (!petState.ok) return;

  const name = petState.name;
  const frames = petCurrentFrames();
  const ms = PET_FRAME_MS[name] || 0;

  if (ms <= 0) {
    paintPetFrame();
    return;
  }

  petState.frame += 1;
  if (petState.frame >= frames.length) {
    const next = PET_NEXT[name];
    if (next) {
      setPet(next);
      return;
    }
    if (name === "work") refillWorkQueue();
    else if (name === "idle") refillIdleQueue();
    else petState.frame = 0;
  }
  paintPetFrame();
  const shown = petCurrentFrames()[petState.frame % Math.max(1, petCurrentFrames().length)] || "";
  const wait = frameWait(name, shown);
  petState.timer = setTimeout(petTick, wait);
}

function setPet(name, forcar = false) {
  const stage = $("pet-stage");
  const sprite = $("pet-sprite");
  if (!stage || !sprite || !petState.ok) return;
  if (!forcar && petState.name === name) return;

  clearTimeout(petState.timer);
  petState.timer = 0;
  petState.name = name;
  petState.frame = 0;
  petState.workQueue = null;
  petState.idleQueue = null;
  stage.dataset.state = name;
  stage.title = petTitle(name);
  sprite.dataset.state = name;

  if (name === "work") refillWorkQueue();
  if (name === "idle") refillIdleQueue();

  paintPetFrame();
  const shown = petCurrentFrames()[0] || "";
  const ms = frameWait(name, shown);
  if (ms > 0 && (petCurrentFrames().length > 1 || PET_NEXT[name])) {
    petState.timer = setTimeout(petTick, ms);
  }
}

/** Motor off = maguinho dorme. Ligado = idle. Stream = notebook. */
function syncPet(on, live) {
  if (!on) {
    if (petState.name !== "off") setPet("off");
    return;
  }
  if (live) {
    if (petState.name !== "work") setPet("work");
    return;
  }
  if (petState.name === "wake") return;
  if (petState.name === "off" || petState.name === "") setPet("wake");
  else if (petState.name === "work") setPet("idle");
}

function initPet() {
  const stage = $("pet-stage");
  const sprite = $("pet-sprite");
  if (!stage || !sprite) return;
  petState.reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  stage.addEventListener("click", () => $("btn-motor").click());

  const all = [
    ...new Set([
      ...Object.values(PET_FRAMES).flat(),
      ...PET_WORK_SPICE.flat(),
      ...PET_IDLE_SPICE.flat(),
    ]),
  ];
  let failed = 0;
  for (const frame of all) {
    const img = petImg(frame);
    img.addEventListener("error", () => {
      failed += 1;
      if (failed === all.length) {
        petState.ok = false;
        stage.classList.add("hidden");
        $("motor-status").classList.remove("sr-only");
      }
    });
    img.src = petSrc(frame);
  }
  setPet("off", true);
}

function setMotor(on, live = false) {
  const was = state.talking;
  state.talking = Boolean(on && live);
  if (state.talking) startThink();
  else stopThink();
  const st = $("motor-status");
  st.dataset.on = on ? "1" : "0";
  st.textContent = live ? "Falando" : on ? "Ligado" : "Desligado";
  if (petState.ok) st.classList.add("sr-only");
  syncPet(on, live);
  const btn = $("btn-motor");
  btn.textContent = on ? "Desligar" : "Ligar";
  $("banner").classList.toggle("hidden", on);
  syncTalking();
  // A conversa aberta não espera o poll de 4s pra acender/apagar o ponto.
  if (was !== state.talking) renderRepoTree();
}

function syncTalking() {
  const abort = $("btn-abort");
  const send = $("btn-send");
  if (abort) abort.classList.toggle("hidden", !state.talking);
  if (send) send.classList.toggle("hidden", state.talking);
}

function selectedProfile() {
  const id = $("profile-select")?.value || state.profileId;
  return state.profiles.find((x) => x.id === id);
}

function needsLogin(p = selectedProfile()) {
  return Boolean(p && p.status !== "ready" && p.engine !== "stub");
}

const EFFORT_STEPS = ["", "low", "medium", "high", "xhigh", "max"];
const EFFORT_NAMES = ["padrão", "baixo", "médio", "alto", "muito alto", "máximo"];

/** Pinta o trecho preenchido da trilha (0–100%) — CSS lê isso em `--fill` (ver styles.css). */
function pintarEffortFill(range) {
  const max = Number(range.max) || 1;
  const pct = (Number(range.value) / max) * 100;
  range.style.setProperty("--fill", `${pct}%`);
}

function setVia() {
  const sel = $("profile-select");
  if (sel && state.profileId) sel.value = state.profileId;
  syncLoginBtn();
  syncEngineControls();
}

/** Substitui as `<option>` de um select por `entries` ({value,label,title?}) e restaura o valor atual. */
function setSelectEntries(select, entries, currentValue) {
  select.replaceChildren();
  for (const e of entries) {
    const opt = document.createElement("option");
    opt.value = e.value;
    opt.textContent = e.label;
    if (e.title) opt.title = e.title;
    select.append(opt);
  }
  select.value = entries.some((e) => e.value === currentValue) ? currentValue : "";
}

/** Passos de esforço do modelo escolhido — do catálogo real quando o modelo é conhecido, senão um genérico. */
function codexEffortSteps(p) {
  const models = state.codexModels[p.id];
  const escolhido = (models || []).find((m) => m.slug === (p.model || ""));
  const efforts = escolhido?.efforts?.length ? escolhido.efforts : CODEX_EFFORT_FALLBACK;
  return ["", ...efforts];
}

function syncCodexControls(p, model, modelCustom, range, label, mode) {
  model.disabled = false;
  range.disabled = false;
  mode.disabled = false;
  model.title = "Modelo do motor (catálogo real da conta)";
  mode.title = "Sandbox do codex — o que o comando pode tocar";

  void loadCodexModels(p.id);
  const models = state.codexModels[p.id] || [];
  const entries = [
    { value: "", label: "Modelo: padrão" },
    ...models.map((m) => ({ value: m.slug, label: m.displayName, ...(m.description ? { title: m.description } : {}) })),
    { value: CODEX_CUSTOM_MODEL, label: "Outro…" },
  ];
  const conhecido = models.some((m) => m.slug === (p.model || ""));
  const usaCustom = Boolean(p.model) && !conhecido;
  setSelectEntries(model, entries, usaCustom ? CODEX_CUSTOM_MODEL : p.model || "");
  modelCustom.classList.toggle("hidden", !usaCustom);
  modelCustom.value = usaCustom ? p.model || "" : "";

  setSelectEntries(mode, CODEX_SANDBOX_ENTRIES, p.sandboxMode || "");

  const steps = codexEffortSteps(p);
  range.max = String(steps.length - 1);
  const idx = Math.max(0, steps.indexOf(p.effort || ""));
  range.value = String(idx);
  pintarEffortFill(range);
  label.textContent = `Esforço: ${effortLabel(steps[idx])}`;
  // o listener do range precisa saber os passos DESTE render pra traduzir índice -> valor no change/input
  range.dataset.steps = JSON.stringify(steps);
}

/** Modelo, esforço e modo/sandbox são do perfil — claude e codex têm flags e vocabulário próprios. */
function syncEngineControls() {
  const model = $("model-select");
  const modelCustom = $("model-custom");
  const range = $("effort-range");
  const label = $("effort-label");
  const mode = $("mode-select");
  if (!model || !modelCustom || !range || !label || !mode) return;
  const p = selectedProfile();

  if (p?.engine === "codex") {
    syncCodexControls(p, model, modelCustom, range, label, mode);
    return;
  }
  modelCustom.classList.add("hidden");
  delete range.dataset.steps;
  const isClaude = p?.engine === "claude";
  model.disabled = !isClaude;
  range.disabled = !isClaude;
  mode.disabled = !isClaude;
  if (!isClaude) {
    setSelectEntries(model, CLAUDE_MODEL_ENTRIES, "");
    setSelectEntries(mode, CLAUDE_MODE_ENTRIES, "");
    range.max = "5";
    range.value = "0";
    pintarEffortFill(range);
    label.textContent = p?.engine === "api" ? `Modelo: ${p.model || "da conta"}` : "Esforço: n/a";
    model.title = "Só claude e codex aceitam escolha de modelo aqui.";
    mode.title = "Só claude e codex aceitam esse controle aqui.";
    return;
  }
  model.title = "Modelo do motor";
  setSelectEntries(model, CLAUDE_MODEL_ENTRIES, MODEL_OPTION_VALUES.includes(p.model || "") ? p.model || "" : "");
  mode.title = "Modo de permissão do motor";
  setSelectEntries(mode, CLAUDE_MODE_ENTRIES, MODE_VALUES.includes(p.permissionMode || "") ? p.permissionMode || "" : "");
  range.max = "5";
  const idx = Math.max(0, EFFORT_STEPS.indexOf(p.effort || ""));
  range.value = String(idx);
  pintarEffortFill(range);
  label.textContent = `Esforço: ${EFFORT_NAMES[idx]}`;
}

async function patchProfile(patch) {
  state.meter.effort = patch.effort ?? state.meter.effort;
  state.meter.model = patch.model ?? state.meter.model;
  state.meter.permissionMode = patch.permissionMode ?? state.meter.permissionMode;
  state.meter.sandboxMode = patch.sandboxMode ?? state.meter.sandboxMode;
  paintFacts();
  const p = selectedProfile();
  if (!p) return;
  try {
    const next = await req(`/v1/profiles/${encodeURIComponent(p.id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    state.profiles = state.profiles.map((x) => (x.id === next.id ? next : x));
    // daemon velho ignora campo que não conhece: sem isso o controle só voltava sozinho
    const dropped = Object.keys(patch).filter((k) => (next[k] ?? "") !== (patch[k] ?? ""));
    if (dropped.length) {
      appendEvent({
        type: "error",
        message: `O daemon não gravou: ${dropped.join(", ")}. Desliga e liga o motor pra carregar a versão nova.`,
      });
    }
    syncEngineControls();
  } catch (err) {
    appendEvent({ type: "error", message: err.message || "Não deu pra salvar." });
    syncEngineControls();
  }
}

function syncLoginBtn() {
  const btn = $("btn-login");
  if (!btn) return;
  const p = selectedProfile();
  const need = needsLogin(p);
  btn.classList.toggle("hidden", !need);
  btn.disabled = !state.ok;
  btn.textContent = need ? `Login ${p.id}` : "Login";
  const imp = $("btn-import-login");
  if (imp) {
    const showImp = Boolean(need && p?.engine === "claude");
    imp.classList.toggle("hidden", !showImp);
    imp.disabled = !state.ok;
  }
  if ($("input").disabled) $("btn-send").disabled = true;
  else $("btn-send").disabled = need;
}

function setProjectLabel() {
  const el = $("project-path");
  if (el) {
    el.textContent = state.projectPath ? folderName(state.projectPath) : "Nenhum projeto";
    el.title = state.projectPath;
  }
  const add = $("btn-folder");
  if (add) add.title = "Adicionar pasta";
  $("file-cwd").textContent = state.projectPath || "Sem pasta";
  $("term-cwd").textContent = state.projectPath || "Sem pasta";
  const novo = $("btn-new");
  const novoLabel = $("new-label");
  if (novo && novoLabel) {
    // o botão cria a conversa em state.projectPath: o nome do projeto sai do implícito
    novoLabel.textContent = state.projectPath ? `Nova conversa em ${folderName(state.projectPath)}` : "Nova conversa";
    novo.title = state.projectPath
      ? `Cria uma conversa em ${state.projectPath}`
      : "Abre um repositório com + primeiro";
  }
  setChatHead();
}

/** Em que repositório está a conversa `id`, segundo o último /v1/threads. */
function threadStub(id) {
  for (const path of state.repos) {
    const t = (state.threadsByRepo[path] || []).find((x) => x.id === id);
    if (t) return { path, stub: t };
  }
  return null;
}

/**
 * Chapéu do chat: "projeto › conversa". Sem ele o painel de conversa não diz a
 * que pasta pertence — e o mesmo título de conversa aparece em repos diferentes.
 */
function setChatHead() {
  const repoBtn = $("crumb-repo");
  const th = $("crumb-thread");
  if (!repoBtn || !th) return;
  const found = state.threadId ? threadStub(state.threadId) : null;
  const path = found?.path || state.projectPath;
  repoBtn.textContent = path ? folderName(path) : "Sem projeto";
  repoBtn.title = path || "Nenhum projeto aberto";
  repoBtn.disabled = !path;
  if (!state.threadId) {
    th.textContent = "Nenhuma conversa";
    th.title = "";
    return;
  }
  const primeira = state.events.find((e) => e.type === "user");
  const titulo = found?.stub.preview || clip(primeira?.text ?? "", 80) || "Conversa nova";
  // Conversa de agente personalizado diz de quem é: o modelo e as instruções são dele.
  const def = agentDef(state.agentId);
  const nome = def?.name || state.agentId;
  th.textContent = nome ? `${nome} · ${titulo}` : titulo;
  th.title = nome ? `Agente ${nome} — ${titulo}` : titulo;
}

/** Abre o repositório na árvore e rola até ele. */
function revealRepo(path) {
  if (!path) return;
  state.reposOpen.add(normPath(path));
  persistRepos();
  renderRepoTree();
  const i = state.repos.findIndex((p) => samePath(p, path));
  if (i >= 0) $("repo-tree").children[i]?.scrollIntoView({ block: "nearest" });
}

function setComposer(on) {
  $("input").disabled = !on;
  $("btn-send").disabled = !on;
  $("chat-empty").classList.toggle("hidden", on);
}

function applyWorkLayout() {
  const work = $("work");
  const noModule = state.view === "none";
  work.dataset.view = state.view;
  work.dataset.side = state.sideChat ? "1" : "0";
  $("pane-file").classList.toggle("hidden", state.view !== "file");
  $("pane-terminal").classList.toggle("hidden", state.view !== "terminal");
  $("pane-browser").classList.toggle("hidden", state.view !== "browser");
  $("pane-canvas").classList.toggle("hidden", state.view !== "canvas");
  $("pane-graph").classList.toggle("hidden", state.view !== "graph");
  $("pane-agentes").classList.toggle("hidden", state.view !== "agentes");
  // Sem módulo aberto o chat vira o conteúdo principal — não depende de sideChat aqui.
  $("pane-chat").classList.toggle("hidden", !state.sideChat && !noModule);
}

/** Fecha o módulo aberto (Arquivos/Terminal/Browser/Canvas): só chat + sidebar ficam. */
function closeModule() {
  inspectorHost.desligar();
  state.view = "none";
  applyWorkLayout();
}

function setView(view) {
  if (view === "side-chat") {
    state.sideChat = !state.sideChat;
  } else {
    state.view = view;
  }
  applyWorkLayout();
  if (view === "file") void loadFileTree();
  if (view === "terminal") {
    ensureTerm();
    requestAnimationFrame(() => state.fit?.fit());
  }
  if (view === "canvas") requestAnimationFrame(resizeSketch);
  if (view === "graph") void loadGraphStatus();
}

function storeKey(kind) {
  return `nexo.${kind}:${state.projectPath || "_none"}`;
}


function setBrowserUrl(raw, persist = true) {
  const href = safeUrl(raw);
  state.browserUrl = href;
  $("browser-url").value = href === "about:blank" ? "" : href;
  const frame = $("browser-frame");
  if (frame.src !== href) frame.src = href;
  esconderFalhaBrowser();
  void conferirPreview(href);
  if (persist) localStorage.setItem(storeKey("browser"), href);
  if (state.paletteOpen && state.previewId === "browser") syncPalBrowser();
}

/**
 * Renavega o iframe pela mesma URL, passando por about:blank primeiro — assim o
 * documento antigo (e o JS dele) morre de verdade, em vez de só recarregar.
 * contentWindow.location.reload() não serve: a página é de outra origem.
 * A segunda atribuição fica no próximo tick porque duas trocas de src no mesmo
 * task se cancelam e o about:blank sobraria na tela.
 */
function reiniciarFrame(frame, href) {
  frame.src = "about:blank";
  setTimeout(() => {
    frame.src = href;
  }, 0);
}

function reiniciarBrowser() {
  const href = state.browserUrl || "about:blank";
  reiniciarFrame($("browser-frame"), href);
  esconderFalhaBrowser();
  void conferirPreview(href);
  if (state.paletteOpen && state.previewId === "browser") reiniciarFrame($("pal-frame"), href);
}

/** Mesmo reinício, mas descartando o cache antes — preview velho some. */
async function reiniciarBrowserSemCache() {
  const btn = $("btn-browser-hard-reload");
  btn.disabled = true;
  try {
    await window.nexo.clearBrowserCache?.(state.browserUrl);
  } finally {
    btn.disabled = false;
  }
  reiniciarBrowser();
}

/* ---------- preview: por que a tela ficou branca ---------- */

function esconderFalhaBrowser() {
  $("browser-fail").classList.add("hidden");
  atualizaDisponibilidadeInspector();
}

/** Serviço declarado que atende nessa URL — é o que o botão "Rodar" aciona. */
function servicoDaUrl(href) {
  const porta = portaDaUrl(href);
  if (!porta) return null;
  return svcPanel.servicos().find((s) => s.portNumber === porta) ?? null;
}


function mostrarFalhaBrowser({ msg, hint, url, externo }) {
  $("browser-fail-msg").textContent = msg;
  $("browser-fail-hint").textContent = hint || url || "";
  const svc = servicoDaUrl(url || state.browserUrl);
  const run = $("btn-browser-run");
  run.classList.toggle("hidden", !svc || svc.proc === "running");
  if (svc) {
    run.textContent = `Rodar "${svc.name}"`;
    run.onclick = async () => {
      await svcPanel.acionar(svc.id, "start");
      // dá um tempo do servidor subir antes de recarregar
      setTimeout(reiniciarBrowser, 1200);
    };
  }
  const ext = $("btn-browser-external");
  ext.classList.toggle("hidden", !externo);
  ext.onclick = () => void window.nexo.openExternal?.(url || state.browserUrl);
  $("browser-fail").classList.remove("hidden");
  atualizaDisponibilidadeInspector();
}

/** Sonda antes de culpar o iframe: conexão recusada é o caso comum. */
async function conferirPreview(href) {
  if (!href || href === "about:blank" || !state.ok) return;
  if (!/^https?:/i.test(href)) return;
  let r;
  try {
    r = await req(`/v1/probe?url=${encodeURIComponent(href)}`);
  } catch {
    return; // fora de loopback: não é nossa alçada, deixa o iframe tentar
  }
  if (href !== state.browserUrl) return; // navegou de novo enquanto sondava
  if (r.ok) {
    esconderFalhaBrowser();
    return;
  }
  const svc = servicoDaUrl(href);
  mostrarFalhaBrowser({
    msg: svc
      ? `${href} não respondeu — o serviço "${svc.name}" está ${svc.proc === "exited" ? "parado (saiu)" : "parado"}.`
      : `${href} não respondeu (${r.error || "conexão recusada"}).`,
    hint: href,
    url: href,
  });
}

function loadBrowser() {
  setBrowserUrl(localStorage.getItem(storeKey("browser")) || "about:blank", false);
}


/* ---------- inspector de elemento (modo seleção do painel Browser) ---------- */

/** Só há preview de verdade quando a URL não é about:blank e a tela de falha não tá em cima. */
function temPreviewDisponivel() {
  return state.browserUrl !== "about:blank" && $("browser-fail").classList.contains("hidden");
}

/** Chamada sempre que a disponibilidade do preview muda (URL nova, falha aparece/some). */
function atualizaDisponibilidadeInspector() {
  const disponivel = temPreviewDisponivel();
  const btn = $("btn-browser-inspect");
  btn.disabled = !disponivel;
  const titulo = disponivel ? "Selecionar elemento do preview" : "Abra um preview primeiro";
  btn.title = titulo;
  btn.setAttribute("aria-label", titulo);
  if (!disponivel) inspectorHost.desligar();
}

function renderInspectorBox(fase) {
  const mostraCaixa = fase === FASE.LIGADO && state.inspector.caixaAberta;
  $("inspector-box").classList.toggle("hidden", !mostraCaixa);
  const lista = state.inspector.selecionados;
  const ul = $("inspector-list");
  ul.replaceChildren();
  if (!mostraCaixa) return;
  if (lista.length === 0) {
    const vazio = document.createElement("li");
    vazio.className = "insp-vazio";
    vazio.textContent = "Nenhum elemento ainda — clique num elemento do preview.";
    ul.append(vazio);
    return;
  }
  lista.forEach((s, i) => {
    const li = document.createElement("li");
    // Chip curto ("div1", "button2") — seletor/HTML/texto completos não aparecem aqui, só
    // no title (hover) e na mensagem final pro agente (montarMensagem guarda tudo).
    li.title = s.texto ? `${s.seletor} — ${s.texto}` : s.seletor;
    const rotulo = document.createElement("span");
    rotulo.className = "insp-rotulo";
    rotulo.textContent = `${s.tag}${i + 1}`;
    li.append(rotulo);
    const remover = document.createElement("button");
    remover.type = "button";
    remover.className = "ghost insp-remover";
    remover.title = "Remover";
    remover.setAttribute("aria-label", "Remover");
    remover.textContent = "✕";
    remover.addEventListener("click", () => inspectorHost.removerSelecionado(i));
    li.append(remover);
    li.addEventListener("mouseenter", () => inspectorHost.realcarSelecionado(i));
    ul.append(li);
  });
}

/**
 * Abre a caixa flutuante perto de onde a pessoa clicou no 1º elemento da sessão — só ali,
 * não a cada clique (senão a caixa fica pulando de lugar a cada seleção). `sel.x`/`sel.y`
 * vêm do preload em coordenadas do viewport do `<webview>`; somamos o offset dele em
 * relação ao `.browser-stage` (offsetParent real do `.inspector-box`, position:relative)
 * pra virar coordenada local, e limitamos pra caixa não vazar pra fora do stage.
 */
function posicionarCaixaFlutuante(sel) {
  const stage = $("browser-frame").closest(".browser-stage");
  const caixa = $("inspector-box");
  if (!stage || !caixa) return;
  const rectStage = stage.getBoundingClientRect();
  const rectWebview = $("browser-frame").getBoundingClientRect();
  const larguraCaixa = caixa.offsetWidth || 240;
  const alturaCaixa = caixa.offsetHeight || 160;
  const origemX = rectWebview.left - rectStage.left + sel.x;
  const origemY = rectWebview.top - rectStage.top + sel.y;
  const maxLeft = Math.max(8, rectStage.width - larguraCaixa - 8);
  const maxTop = Math.max(8, rectStage.height - alturaCaixa - 8);
  caixa.style.left = `${Math.min(Math.max(8, origemX), maxLeft)}px`;
  caixa.style.top = `${Math.min(Math.max(8, origemY), maxTop)}px`;
}

const FAIXA_TEXTO = {
  [FASE.ARMANDO]: "Ligando o modo seleção…",
  [FASE.LIGADO]: "Modo seleção — clique nos elementos do preview. Esc sai.",
  [FASE.ERRO]: "Modo seleção não conseguiu entrar no preview.",
};

function renderInspectorFaixa(fase) {
  const faixa = $("inspector-faixa");
  faixa.classList.toggle("hidden", fase === FASE.DESLIGADO);
  faixa.dataset.fase = fase;
  faixa.replaceChildren();
  if (fase === FASE.DESLIGADO) return;
  faixa.append(document.createTextNode(FAIXA_TEXTO[fase] || ""));
  if (fase === FASE.ERRO) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost";
    btn.textContent = "Tentar de novo";
    btn.addEventListener("click", () => inspectorHost.ligar());
    faixa.append(btn);
  }
}

const inspectorHost = criarInspectorHost({
  getWebview: () => $("browser-frame"),
  temPreview: temPreviewDisponivel,
  onMudarEstado(estado) {
    const primeiraSelecao = state.inspector.selecionados.length === 0 && estado.selecionados.length === 1;
    state.inspector.selecionados = estado.selecionados;
    if (estado.fase !== FASE.LIGADO) state.inspector.caixaAberta = false;
    else if (primeiraSelecao) state.inspector.caixaAberta = true;
    $("btn-browser-inspect").setAttribute("aria-pressed", String(inspectorHost.botaoPressionado()));
    renderInspectorBox(estado.fase);
    renderInspectorFaixa(estado.fase);
    if (primeiraSelecao) posicionarCaixaFlutuante(estado.selecionados[0]);
    if (estado.fase === FASE.DESLIGADO) $("inspector-pedido").value = "";
  },
});

function toggleInspector() {
  const fase = inspectorHost.estadoAtual().fase;
  if (fase === FASE.DESLIGADO || fase === FASE.ERRO) inspectorHost.ligar();
  else inspectorHost.desligar();
}

/** Mensagens do preload dentro do preview — ver browser-inspector-preload.cjs. */
$("browser-frame").addEventListener("ipc-message", (e) => {
  if (e.channel === "nexo-inspector:selecionado") inspectorHost.receberSelecionado(e.args[0]);
  else if (e.channel === "nexo-inspector:pronto") inspectorHost.receberPronto();
  else if (e.channel === "nexo-inspector:esc") inspectorHost.receberEsc();
});

/**
 * O preload morre e nasce de novo a cada navegação do `<webview>` — sem isto, um reload
 * do preview com o modo ligado deixava o botão aceso e o preview inerte, em silêncio.
 */
$("browser-frame").addEventListener("dom-ready", () => inspectorHost.aoRecarregarPreview());
$("browser-frame").addEventListener("did-navigate", () => inspectorHost.aoRecarregarPreview());

$("btn-browser-inspect").addEventListener("click", toggleInspector);

$("btn-inspector-discard").addEventListener("click", () => inspectorHost.desligar());

function enviarInspector() {
  if (!state.threadId) {
    appendEvent({ type: "error", message: "Abre uma conversa primeiro." });
    return;
  }
  const texto = montarMensagem(state.inspector.selecionados, $("inspector-pedido").value);
  inspectorHost.desligar();
  void sendChatMessage(texto);
}

$("btn-inspector-send").addEventListener("click", enviarInspector);

$("inspector-pedido").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    enviarInspector();
  }
});

const fileTree = createFileTree({
  nexo: () => window.nexo,
  getProjectPath: () => state.projectPath,
  treeEl: () => $("file-tree"),
  previewEl: () => $("file-preview"),
});
const loadFileTree = () => fileTree.load();

let palFilesSeq = 0;
async function refreshPalFiles() {
  const seq = ++palFilesSeq;
  const ul = $("pal-files");
  ul.replaceChildren();
  if (!state.projectPath) {
    const li = document.createElement("li");
    li.textContent = "Sem projeto — escolhe uma pasta.";
    ul.append(li);
    return;
  }
  try {
    const data = await window.nexo.listDir(".");
    if (seq !== palFilesSeq) return;
    state.fileCache = data;
    if (!data.entries.length) {
      const li = document.createElement("li");
      li.textContent = "Pasta vazia.";
      ul.append(li);
      return;
    }
    for (const ent of data.entries.slice(0, 40)) {
      const li = document.createElement("li");
      li.className = ent.dir ? "dir" : "";
      li.textContent = (ent.dir ? "▸ " : "") + ent.name;
      ul.append(li);
    }
  } catch (e) {
    if (seq !== palFilesSeq) return;
    const li = document.createElement("li");
    li.textContent = e.message || "Falha ao listar.";
    ul.append(li);
  }
}

function ensureTerm() {
  if (state.term || $("term-out").classList.contains("ready")) return;
  const host = $("term");
  const Term = window.Terminal;
  if (typeof Term === "function") {
    try {
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || DEFAULT_ACCENT;
      state.term = new Term({
        theme: { background: "#1a1a1a", foreground: "#d4d4d4", cursor: accent, cursorAccent: "#111" },
        fontFamily: 'Consolas, "Cascadia Mono", "Segoe UI Mono", monospace',
        fontSize: 12,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
      });
      const Fit = window.FitAddon?.FitAddon || window.FitAddon;
      if (typeof Fit === "function") {
        state.fit = new Fit();
        state.term.loadAddon(state.fit);
      }
      state.term.open(host);
      $("term-out").classList.add("hidden");
      queueMicrotask(() => state.fit?.fit());
      if (state.termBuf) state.term.write(state.termBuf.replace(/\r?\n/g, "\r\n"));
      return;
    } catch {
      state.term = null;
    }
  }
  host.classList.add("hidden");
  $("term-out").classList.remove("hidden");
  $("term-out").classList.add("ready");
  $("term-out").textContent = state.termBuf;
}

function appendTerm(text) {
  state.termBuf += text;
  if (state.termBuf.length > 16000) state.termBuf = state.termBuf.slice(-12000);
  if (state.term) state.term.write(String(text).replace(/\r?\n/g, "\r\n"));
  else {
    const el = $("term-out");
    el.textContent = state.termBuf;
    el.scrollTop = el.scrollHeight;
  }
  updatePalTerm();
}

function updatePalTerm() {
  $("pal-cwd").textContent = state.projectPath ? `Prévia · ${folderName(state.projectPath)}` : "Prévia · Terminal";
  const snap = state.termBuf.trim() ? state.termBuf.slice(-1200) : state.projectPath ? `cwd  ${state.projectPath}\n\nNenhum comando ainda.` : "Sem projeto — escolhe uma pasta.";
  $("pal-term").textContent = snap;
}

async function runTermCmd(cmd) {
  const text = String(cmd || "").trim();
  if (!text) return;
  ensureTerm();
  if (!state.projectPath) {
    appendTerm("Sem projeto. Abre uma pasta primeiro.\n");
    return;
  }
  appendTerm(`\n› ${text}\n`);
  state.termRunning = true;
  $("btn-term-kill").hidden = false;
  const r = await window.nexo.runCommand(text);
  if (!r?.ok) {
    appendTerm((r?.error || "Falha ao rodar") + "\n");
    state.termRunning = false;
    $("btn-term-kill").hidden = true;
  }
}

function loadCanvas() {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey("canvas")) || "null");
    state.strokes = Array.isArray(raw?.strokes) ? raw.strokes : [];
    state.canvasNote = typeof raw?.note === "string" ? raw.note : "";
  } catch {
    state.strokes = [];
    state.canvasNote = "";
  }
  $("canvas-note").value = state.canvasNote;
  redrawSketch();
}

function saveCanvas() {
  localStorage.setItem(storeKey("canvas"), JSON.stringify({ strokes: state.strokes, note: state.canvasNote }));
}

function paintStrokes(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#181818";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of state.strokes) {
    if (!s.pts?.length) continue;
    ctx.strokeStyle = s.color || "#e8e8e8";
    ctx.lineWidth = s.size || 2;
    ctx.beginPath();
    s.pts.forEach((p, i) => {
      const x = p.x * canvas.width;
      const y = p.y * canvas.height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function redrawSketch() {
  paintStrokes($("sketch"));
  paintPalCanvas();
}

function resizeSketch() {
  const c = $("sketch");
  if ($("pane-canvas").classList.contains("hidden")) {
    paintPalCanvas();
    return;
  }
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  if (w < 8 || h < 8) return;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  redrawSketch();
}

function paintPalCanvas() {
  const dst = $("pal-sketch");
  const wrap = $("palette-preview");
  const w = Math.max(1, wrap.clientWidth);
  const h = Math.max(1, wrap.clientHeight - 56);
  dst.width = w;
  dst.height = h;
  paintStrokes(dst);
  const note = state.canvasNote.trim();
  $("pal-note").textContent = note || (state.strokes.length ? "Desenho neste projeto" : "Canvas vazio — desenha no módulo.");
}

function ptFromEvent(e) {
  const c = $("sketch");
  const r = c.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / Math.max(1, r.width),
    y: (e.clientY - r.top) / Math.max(1, r.height),
  };
}

function filteredModules() {
  const q = state.paletteFilter.trim().toLowerCase();
  if (!q) return MODULES;
  return MODULES.filter((m) => `${m.name} ${m.id} ${m.keys}`.toLowerCase().includes(q));
}

function renderPalette(rebuild = false) {
  const items = filteredModules();
  if (state.paletteIndex >= items.length) state.paletteIndex = Math.max(0, items.length - 1);
  const key = items.map((m) => m.id).join(",");
  const ul = $("palette-list");
  if (rebuild || state.paletteKey !== key) {
    state.paletteKey = key;
    ul.replaceChildren();
    items.forEach((m, i) => {
      const li = document.createElement("li");
      li.dataset.id = m.id;
      li.innerHTML = `<span class="pal-ico">${m.ico}</span><span class="pal-name">${m.name}</span><span class="pal-keys">${m.keys}</span>`;
      li.addEventListener("mouseenter", () => {
        state.paletteIndex = i;
        renderPalette(false);
      });
      li.addEventListener("click", () => pickModule(m.id));
      ul.append(li);
    });
  }
  [...ul.children].forEach((li, i) => {
    li.dataset.on = i === state.paletteIndex ? "1" : "0";
  });
  const current = items[state.paletteIndex];
  if (current) void showPalettePreview(current.id);
}

async function showPalettePreview(id) {
  for (const el of $("palette-preview").querySelectorAll(".pal-mod")) {
    el.classList.toggle("hidden", el.dataset.preview !== id);
  }
  const changed = state.previewId !== id;
  state.previewId = id;
  if (id === "file" && (changed || !state.fileCache)) await refreshPalFiles();
  if (id === "terminal") updatePalTerm();
  if (id === "browser") syncPalBrowser();
  if (id === "canvas") paintPalCanvas();
  if (id === "side-chat") renderPalChat();
}

function syncPalBrowser() {
  const href = state.browserUrl || "about:blank";
  $("pal-url").textContent = href === "about:blank" ? "Prévia · sem URL" : href;
  const frame = $("pal-frame");
  if (frame.src !== href) frame.src = href;
}

function renderPalChat() {
  const ol = $("pal-chat");
  ol.replaceChildren();
  const msgs = state.events.filter((e) => e.type === "user" || e.type === "assistant" || e.type === "error");
  if (!state.threadId) {
    const li = document.createElement("li");
    li.textContent = "Nenhuma conversa aberta.";
    ol.append(li);
    return;
  }
  if (!msgs.length) {
    const li = document.createElement("li");
    li.textContent = "Sem mensagens nesta conversa.";
    ol.append(li);
    return;
  }
  for (const ev of msgs.slice(-6)) {
    const li = document.createElement("li");
    if (ev.type === "user") {
      li.className = "you";
      li.innerHTML = `<div class="who">Você</div><div>${escapeHtml(clip(ev.text, 180))}</div>`;
    } else if (ev.type === "assistant") {
      li.className = "bot";
      li.innerHTML = `<div class="who">Conta</div><div>${escapeHtml(clip(ev.text, 180))}</div>`;
    } else {
      li.innerHTML = `<div class="err">${escapeHtml(clip(ev.message, 180))}</div>`;
    }
    ol.append(li);
  }
}


function openPalette() {
  state.paletteOpen = true;
  state.paletteFilter = "";
  state.paletteIndex = 0;
  state.paletteKey = "";
  state.previewId = "";
  state.fileCache = null;
  $("palette").classList.remove("hidden");
  $("palette-q").value = "";
  renderPalette(true);
  $("palette-q").focus();
}

function closePalette() {
  state.paletteOpen = false;
  $("palette").classList.add("hidden");
}

function pickModule(id) {
  closePalette();
  setView(id);
}

async function refreshDaemon() {
  const info = await window.nexo.daemonInfo();
  aplicarInfoDoMotor(info);
  // preserva o "falando": o poll não pode derrubar o estado no meio da resposta
  setMotor(info.ok, info.ok && state.talking);
  if (!info.ok) {
    state.sseOn = false;
    return;
  }
  // Rede de segurança: stream morto por qualquer motivo, o poll reabre. Sem isso
  // o envio funcionava, o daemon respondia, e a tela ficava parada até recarregar.
  if (state.threadId && !state.sseOn) listenSse();
  try {
    const cfg = await req("/v1/config");
    if (cfg.accent) applyAccent(cfg.accent);
    void celPintarUrl(cfg);
    // /v1/projects já vem com as pastas do config + as que as conversas revelam
    let fonte = cfg;
    try {
      fonte = await req("/v1/projects");
    } catch {
      /* rota nova pode não existir num motor antigo: cai no config */
    }
    const mudou = mergeReposFromConfig(fonte);
    if (mudou) {
      persistRepos();
      state.fpThreads = "";
      renderRepoTree();
      if (state.projectPath) {
        setProjectLabel();
        void window.nexo?.setProject?.(state.projectPath);
      }
    }
  } catch {
    /* motor up, config opcional */
  }
  await loadProfiles();
  if (state.repos.length) await loadThreads();
  await loadServices();
  listenServices();
  await loadAgents();
  // Uma carga no primeiro poll (o cabeçalho do chat precisa do nome do agente) e
  // depois só com o painel aberto: definição muda por ação do usuário, não do motor.
  if (state.agents.open || !state.agents.defsLoaded) await loadAgentDefs();
  // Stream global só reabre se caiu: diferente dos serviços, ele não depende do projeto.
  if (!state.agents.on) listenAgents();
}


async function loadProfiles() {
  // Nada de importar o login global sozinho: era isso que fazia dois perfis
  // virarem a mesma conta. Copiar credencial só no botão "Já loguei".
  const list = await req("/v1/profiles");
  const fp = JSON.stringify(list);
  if (fp === state.fpProfiles) return;
  state.fpProfiles = fp;
  state.profiles = list;
  const sel = $("profile-select");
  sel.replaceChildren();
  $("profiles-empty").classList.toggle("hidden", list.length > 0);
  sel.classList.toggle("hidden", list.length === 0);
  for (const p of list) {
    const opt = document.createElement("option");
    opt.value = p.id;
    const nome = p.nickname || p.id;
    opt.textContent = p.status === "ready" ? `${nome} · ${p.engine}` : `${nome} · ${p.engine} · login`;
    sel.append(opt);
  }
  if (state.profileId) sel.value = state.profileId;
  syncLoginBtn();
  paintAllowList();
  paintDelegList();
  renderAccountsManage();
}

/**
 * Permissões por intenção, não por sintaxe: cada preset vira um ou mais padrões
 * do CLI. O aviso de cada um é literal — `Bash(git *)` cobre `push --force` e
 * `reset --hard` também, e quem marca precisa saber disso.
 */
const ALLOW_PRESETS = [
  { id: "git", nome: "Git", aviso: "inclui push --force e reset --hard", tools: ["Bash(git *)"] },
  { id: "gh", nome: "GitHub (gh)", aviso: "cria PR, release e altera o repositório remoto", tools: ["Bash(gh *)"] },
  { id: "arquivos", nome: "Editar arquivos", aviso: "escreve e sobrescreve sem perguntar", tools: ["Edit", "Write"] },
  {
    id: "node",
    nome: "Node / npm",
    aviso: "inclui npm publish e scripts do package.json",
    tools: ["Bash(npm *)", "Bash(npx *)", "Bash(pnpm *)"],
  },
  { id: "python", nome: "Python / pip", aviso: "inclui pip install", tools: ["Bash(python *)", "Bash(pip *)"] },
];

/** Padrões que algum preset cobre — o resto vai pro campo avançado. */
function toolsDosPresets(marcados) {
  return marcados.flatMap((id) => ALLOW_PRESETS.find((p) => p.id === id)?.tools ?? []);
}

function paintAllowPresets(atuais) {
  const box = $("allow-presets");
  if (!box) return;
  box.replaceChildren();
  for (const preset of ALLOW_PRESETS) {
    const marcado = preset.tools.every((t) => atuais.includes(t));
    const label = document.createElement("label");
    label.className = "allow-chip";
    label.title = `${preset.tools.join(", ")} — ${preset.aviso}`;
    const box2 = document.createElement("input");
    box2.type = "checkbox";
    box2.checked = marcado;
    box2.dataset.preset = preset.id;
    const txt = document.createElement("span");
    txt.textContent = preset.nome;
    const aviso = document.createElement("small");
    aviso.textContent = preset.aviso;
    label.append(box2, txt, aviso);
    box.append(label);
  }
}

function presetsMarcados() {
  return [...$("allow-presets").querySelectorAll("input[data-preset]")]
    .filter((i) => i.checked)
    .map((i) => i.dataset.preset);
}

/**
 * Ferramentas liberadas (--allowed-tools). Só motor claude: é o único que
 * recebe esses flags, o resto ignora.
 */
function paintAllowList() {
  const sel = $("allow-profile");
  if (!sel) return;
  const claudes = state.profiles.filter((p) => p.engine === "claude");
  const antes = sel.value;
  sel.replaceChildren();
  for (const p of claudes) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.id;
    sel.append(opt);
  }
  sel.value = claudes.some((p) => p.id === antes) ? antes : (claudes[0]?.id ?? "");
  syncAllowInput();
}

function syncAllowInput() {
  const id = $("allow-profile")?.value;
  const p = state.profiles.find((x) => x.id === id);
  const campo = $("allow-tools");
  if (!campo) return;
  const atuais = p?.allowedTools ?? [];
  paintAllowPresets(atuais);
  // o que nenhum preset marcado cobre continua visível no avançado, em vez de sumir no save
  const cobertos = toolsDosPresets(presetsMarcados());
  campo.value = atuais.filter((t) => !cobertos.includes(t)).join(", ");
  campo.disabled = !p;
  $("btn-allow-save").disabled = !p;
  $("allow-err").textContent = "";
}

/** `nexo_delegar` vale pra claude e codex (os dois falam MCP); api/stub nunca ganham a ferramenta. */
function paintDelegList() {
  const sel = $("deleg-profile");
  if (!sel) return;
  const alvos = state.profiles.filter((p) => p.engine === "claude" || p.engine === "codex");
  const antes = sel.value;
  sel.replaceChildren();
  for (const p of alvos) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.id;
    sel.append(opt);
  }
  sel.value = alvos.some((p) => p.id === antes) ? antes : (alvos[0]?.id ?? "");
  syncDelegModo();
}

function syncDelegModo() {
  const id = $("deleg-profile")?.value;
  const p = state.profiles.find((x) => x.id === id);
  $("deleg-modo").value = p?.delegacaoModo || "negado";
  $("deleg-modo").disabled = !p;
  $("btn-deleg-save").disabled = !p;
  $("deleg-err").textContent = "";
}

/** Apelido/relogar/apagar — uma linha por conta, montada do zero a cada `loadProfiles`. */
function renderAccountsManage() {
  const box = $("accounts-manage-list");
  if (!box) return;
  box.replaceChildren();
  for (const p of state.profiles) {
    const row = document.createElement("div");
    row.className = "accounts-manage-row";

    const id = document.createElement("span");
    id.className = "accounts-manage-id";
    id.textContent = p.id;
    id.title = p.id;

    const engine = document.createElement("span");
    engine.className = "accounts-manage-engine";
    engine.textContent = p.engine;

    const nick = document.createElement("input");
    nick.type = "text";
    nick.className = "accounts-manage-nick";
    nick.placeholder = "apelido (opcional)";
    nick.maxLength = 40;
    nick.value = p.nickname || "";
    nick.addEventListener("change", () => void salvarNickname(p.id, nick.value.trim(), nick));

    row.append(id, engine, nick);

    if (p.engine === "claude" || p.engine === "codex") {
      const relogar = document.createElement("button");
      relogar.type = "button";
      relogar.className = "ghost";
      relogar.textContent = "Relogar";
      relogar.addEventListener("click", () => void startLogin(p.id));
      row.append(relogar);
    }

    const apagar = document.createElement("button");
    apagar.type = "button";
    apagar.className = "ghost danger";
    apagar.textContent = "Apagar";
    apagar.addEventListener("click", () => void apagarConta(p.id));
    row.append(apagar);

    box.append(row);
  }
}

async function salvarNickname(id, nickname, input) {
  const err = $("accounts-manage-err");
  err.textContent = "";
  try {
    const next = await req(`/v1/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ nickname }),
    });
    state.profiles = state.profiles.map((p) => (p.id === next.id ? next : p));
    state.fpProfiles = "";
  } catch (e) {
    err.textContent = e.message || "Não deu pra salvar o apelido.";
    input.value = state.profiles.find((p) => p.id === id)?.nickname || "";
  }
}

async function apagarConta(id) {
  const ok = window.confirm(`Apagar a conta "${id}"? Isso remove o login salvo — não dá pra desfazer.`);
  if (!ok) return;
  const err = $("accounts-manage-err");
  err.textContent = "";
  try {
    await req(`/v1/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.profiles = state.profiles.filter((p) => p.id !== id);
    state.fpProfiles = "";
    if (state.profileId === id) state.profileId = state.profiles[0]?.id || "";
    renderAccountsManage();
    await loadProfiles();
    setVia();
  } catch (e) {
    err.textContent = e.message || "Não deu pra apagar.";
  }
}

async function loadThreads() {
  const tree = $("repo-tree");
  if (!tree) return;
  if (!state.ok) {
    renderRepoTree();
    return;
  }
  const packs = {};
  await Promise.all(
    state.repos.map(async (path) => {
      try {
        packs[path] = await req(`/v1/threads?projectPath=${encodeURIComponent(path)}`);
      } catch {
        packs[path] = state.threadsByRepo[path] || [];
      }
    }),
  );
  const fp = JSON.stringify({
    repos: state.repos,
    packs,
    open: [...state.reposOpen].sort(),
    thread: state.threadId,
    active: state.projectPath,
  });
  if (fp === state.fpThreads) return;
  state.fpThreads = fp;
  state.threadsByRepo = packs;
  renderRepoTree();
}

/**
 * O daemon carimba `busy` em /v1/threads (turno em voo). A conversa aberta também
 * conta pelo estado local, que muda no mesmo instante do stream em vez de no poll.
 * O SSE global (painel de agentes) faz o mesmo pelas conversas que não estão em foco.
 */
function isBusy(t) {
  if (t.busy) return true;
  if (t.id === state.threadId && state.talking) return true;
  return state.agents.list.some((a) => a.threadId === t.id && a.busy);
}

/**
 * Pasta fechada + pasta aberta no mesmo span: o CSS mostra uma das duas conforme
 * `.repo[open]`, então abrir/fechar não precisa repintar a árvore.
 */
const REPO_ICO_HTML =
  '<svg class="ico-shut" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 20a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1Z" /></svg>' +
  '<svg class="ico-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M3 19V5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v2" /><path d="M3 19l2.4-7.3A1 1 0 0 1 6.3 11H21l-2.4 7.3a1 1 0 0 1-.95.7H4a1 1 0 0 1-1-1Z" /></svg>';

function renderRepoTree() {
  const tree = $("repo-tree");
  if (!tree) return;
  tree.replaceChildren();
  $("threads-empty").classList.toggle("hidden", state.repos.length > 0);
  for (const path of state.repos) {
    const det = document.createElement("details");
    det.className = "repo";
    det.open = state.reposOpen.has(normPath(path));
    det.dataset.on = samePath(path, state.projectPath) ? "1" : "0";
    const sum = document.createElement("summary");
    const ico = document.createElement("span");
    ico.className = "repo-ico";
    ico.innerHTML = REPO_ICO_HTML;
    const name = document.createElement("span");
    name.className = "repo-name";
    name.textContent = folderName(path);
    name.title = path;
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "ghost repo-forget";
    forget.title = "Tirar da lista (não apaga conversas)";
    forget.textContent = "×";
    forget.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void removeRepo(path);
    });
    sum.append(ico, name, forget);
    det.addEventListener("toggle", () => {
      if (det.open) state.reposOpen.add(normPath(path));
      else state.reposOpen.delete(normPath(path));
      persistRepos();
    });
    const ul = document.createElement("ul");
    const list = state.threadsByRepo[path] || [];
    const count = document.createElement("span");
    count.className = "repo-count";
    count.textContent = String(list.length);
    count.title = list.length === 1 ? "1 conversa neste projeto" : `${list.length} conversas neste projeto`;
    sum.insertBefore(count, forget);
    if (!list.length) {
      const empty = document.createElement("li");
      empty.className = "repo-empty";
      empty.textContent = "Nenhuma conversa";
      ul.append(empty);
    }
    // Repositório fechado esconde as conversas: o ponto vai pro summary pra atividade não sumir.
    if (list.some(isBusy)) {
      det.dataset.busy = "1";
      const dot = document.createElement("span");
      dot.className = "run-dot";
      dot.title = "Agente trabalhando neste repositório";
      sum.insertBefore(dot, forget);
    }
    /** Uma linha de conversa. Serve solta na lista e dentro do grupo de um run. */
    const linhaDeConversa = (t) => {
      const li = document.createElement("li");
      li.dataset.on = t.id === state.threadId ? "1" : "0";
      const busy = isBusy(t);
      li.dataset.busy = busy ? "1" : "0";
      const title = document.createElement("span");
      title.className = "stub-title";
      title.textContent = t.preview || "Conversa nova";
      // título é uma linha só e trunca: o texto inteiro fica no tooltip da linha
      li.title = t.preview || "Conversa nova";
      const meta = document.createElement("span");
      meta.className = "stub-meta";
      // Ocupado já tem o ponto pulsando do lado — "trabalhando…" escrito de novo é redundante.
      meta.textContent = busy ? "" : ago(t.updatedAt);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost thread-del";
      del.title = "Apagar conversa";
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void deleteThread(t.id);
      });
      li.append(title, meta, del);
      if (busy) {
        const dot = document.createElement("span");
        dot.className = "run-dot";
        dot.title = "Agente trabalhando nesta conversa";
        li.prepend(dot);
      }
      li.addEventListener("click", () => void openThreadInRepo(path, t.id));
      return li;
    };

    /**
     * Passos de um run entram numa pasta só. Soltos, um time de dez passos
     * afogava a lista e empurrava pra baixo a conversa que a pessoa estava
     * usando. Fechada por padrão: o interesse ali é o resultado, não cada passo.
     */
    const grupoDeRun = (g) => {
      const sub = document.createElement("details");
      sub.className = "run-group";
      sub.open = state.runsOpen.has(g.runId);
      sub.addEventListener("toggle", () => {
        if (sub.open) state.runsOpen.add(g.runId);
        else state.runsOpen.delete(g.runId);
      });
      const cab = document.createElement("summary");
      const nome = document.createElement("span");
      nome.className = "stub-title";
      nome.textContent = g.titulo;
      cab.title = g.titulo;
      const quantos = document.createElement("span");
      quantos.className = "stub-meta";
      quantos.textContent = `${g.threads.length} passos`;
      const detalhes = document.createElement("button");
      detalhes.type = "button";
      detalhes.className = "ghost run-info";
      detalhes.title = "Time, topologia e status de cada passo";
      detalhes.textContent = "ⓘ";
      // preventDefault: o <summary> abre/fecha o <details> com qualquer clique,
      // inclusive neste botão — sem isso, ver detalhes também alterna o grupo.
      detalhes.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void mostrarDetalhesDoRun(g.runId);
      });
      cab.append(nome, quantos, detalhes);
      // fechado, o ponto sobe pro cabeçalho pra atividade não sumir da lista
      if (g.threads.some(isBusy)) {
        const dot = document.createElement("span");
        dot.className = "run-dot";
        dot.title = "Um passo deste time está trabalhando";
        cab.prepend(dot);
      }
      const dentro = document.createElement("ul");
      for (const t of g.threads) dentro.append(linhaDeConversa(t));
      sub.append(cab, dentro);
      const li = document.createElement("li");
      li.className = "run-group-li";
      li.append(sub);
      return li;
    };

    for (const item of agruparConversas(list)) {
      ul.append(item.tipo === "run" ? grupoDeRun(item) : linhaDeConversa(item.thread));
    }
    det.append(sum, ul);
    tree.append(det);
  }
  setChatHead();
}

async function openThreadInRepo(path, id) {
  if (!samePath(state.projectPath, path)) await bindProject(path);
  await openThread(id);
}

async function removeRepo(path) {
  forgetRepo(path);
  // Pinta primeiro: se o rebind abaixo falhar (setProject, árvore de arquivos),
  // a pasta já saiu da tela em vez de ficar lá dando a impressão de que o × não faz nada.
  state.fpThreads = "";
  renderRepoTree();
  try {
    if (samePath(state.projectPath, path)) {
      const next = state.repos[0] || "";
      if (next) await bindProject(next);
      else {
        state.projectPath = "";
        localStorage.removeItem("nexo.project");
        setProjectLabel();
        await loadFileTree();
      }
    }
    await loadThreads();
  } catch (e) {
    appendEvent({ type: "sys", message: `Tirei ${folderName(path)} da lista, mas o rebind falhou: ${e.message}` });
  }
}

async function deleteThread(id) {
  if (!window.confirm("Apagar esta conversa? Não volta.")) return;
  try {
    await req(`/v1/threads/${id}`, { method: "DELETE" });
  } catch (e) {
    appendEvent({ type: "error", message: e.message || "Não apagou." });
    return;
  }
  if (state.threadId === id) {
    state.abortSse?.abort();
    state.threadId = "";
    localStorage.removeItem("nexo.thread");
    state.events = [];
    delete state.queue[id];
    paintQueue();
    $("log").replaceChildren();
    setComposer(false);
  }
  state.fpThreads = "";
  await loadThreads();
}

function renderEvents(events) {
  state.events = events;
  const log = $("log");
  for (const url of state.logShotUrls) URL.revokeObjectURL(url);
  state.logShotUrls = [];
  log.replaceChildren();
  for (const ev of events) appendEvent(ev, false);
  log.scrollTop = log.scrollHeight;
}

/** Só chega texto de raciocínio de motor que expõe isso (o CLI do Claude não expõe). */
function appendThinking(text) {
  const log = $("log");
  let last = log.lastElementChild;
  if (!last || last.dataset.think !== "1") {
    last = document.createElement("li");
    last.dataset.think = "1";
    last.innerHTML = `<details class="think" open><summary>Pensando…</summary><pre></pre></details>`;
    log.append(last);
  }
  last.querySelector("pre").textContent += text;
  log.scrollTop = log.scrollHeight;
}

/** Nome como o CLI reporta a ferramenta MCP — `mcp__nexo__nexo_delegar` no claude; sufixo cobre variação de motor. */
function ehFerramentaDeDelegar(name) {
  return typeof name === "string" && name.endsWith("nexo_delegar");
}

function ehFerramentaDePerguntar(name) {
  return typeof name === "string" && name.endsWith("nexo_perguntar");
}

/**
 * A bolha de "Pergunta" já conta a história inteira (texto + opções) — mostrar TAMBÉM a chamada
 * crua da ferramenta (e o `ToolSearch` que o motor faz antes, pra achar a ferramenta adiada) só
 * duplica a mesma informação de um jeito mais feio. Esconde as duas.
 */
function ehRuidoDePerguntar(ev) {
  if (ehFerramentaDePerguntar(ev.name)) return true;
  if (ev.name !== "ToolSearch") return false;
  const query = ev.input?.query;
  return typeof query === "string" && query.includes("nexo_perguntar");
}

/**
 * Abre o "subchat": passos do run ao vivo dentro da própria bolha de `nexo_delegar`, reaproveitando
 * a lógica pura de `run-view.js` (mesma que a tela de Times usa) — só o desenho é local.
 */
async function iniciarSubchat(li, runId) {
  const ol = li.querySelector(".subchat");
  if (!ol) return;
  li.dataset.runId = runId;
  let run;
  try {
    run = await req(`/v1/runs/${runId}`);
  } catch {
    return; // run já pode ter sumido (home trocado, etc.) — a bolha segue funcionando sem subchat
  }
  ol.classList.remove("hidden");

  function pintar() {
    const doc = ol.ownerDocument;
    ol.replaceChildren();
    const t = Date.now();
    const larg = larguraDosPassos(run.steps, t);
    run.steps.forEach((s, i) => {
      const item = doc.createElement("li");
      item.className = "ag-step";
      item.dataset.tipo = s.status;
      const n = doc.createElement("span");
      n.className = "ag-step-n";
      n.textContent = s.supervisor ? "sup" : `#${i + 1}`;
      const ico = doc.createElement("span");
      ico.className = "ag-step-ico";
      ico.textContent = { done: "✓", running: "▸", error: "✕", skipped: "–" }[s.status] ?? "·";
      const nome = doc.createElement("span");
      nome.className = "ag-step-name";
      nome.textContent = s.agentId;
      const det = doc.createElement("span");
      det.className = "ag-step-det";
      det.textContent = s.error || s.papel || rotuloDoPasso(s);
      const barra = doc.createElement("span");
      barra.className = "ag-step-bar";
      const fill = doc.createElement("i");
      fill.style.width = `${larg[i]}%`;
      barra.append(fill);
      const ms = doc.createElement("span");
      ms.className = "ag-step-ms";
      ms.textContent = s.startedAt ? fmtDuracao(duracaoDoPasso(s, t)) : "";
      item.append(n, ico, nome, det, barra, ms);
      ol.append(item);
    });
  }
  pintar();

  const ac = new AbortController();
  fetch(api(`/v1/runs/${runId}/events`), { headers: headers(), signal: ac.signal })
    .then((res) => lerEventos(res, (ev) => {
      if (aplicarEventoDeRun(run, ev)) pintar();
      if (ev.type === "run_end") ac.abort();
    }))
    .catch(() => {}); // stream cortado (run terminou, ou daemon reiniciou) — a bolha já tem o resultado final pelo tool_result
}

function appendEvent(ev, scroll = true) {
  const log = $("log");
  const li = document.createElement("li");
  if (ev.type === "user") {
    li.className = "you";
    li.innerHTML = `<div class="who">Você</div><div>${escapeHtml(ev.text)}</div>`;
    const shots = ev.previews ?? ev.attachments ?? [];
    if (shots.length) li.append(shotsRow(shots, ev.threadId ?? state.threadId));
  } else if (ev.type === "assistant") {
    li.className = "bot";
    li.innerHTML = `<div class="who">Conta</div><div class="md"></div>`;
    renderMd(li.querySelector(".md"), ev.text);
  } else if (ev.type === "tool") {
    if (ehRuidoDePerguntar(ev)) return;
    const arg = ev.summary ? `<span class="tool-arg">${escapeHtml(ev.summary)}</span>` : "";
    li.className = "tool";
    if (ev.id) li.dataset.toolId = ev.id;
    const temInput = ev.input !== undefined && ev.input !== null && Object.keys(ev.input).length > 0;
    const subchat = ehFerramentaDeDelegar(ev.name) ? `<ol class="subchat hidden"></ol>` : "";
    li.innerHTML =
      `<div class="tool-line"><span class="tool-ico">⚙</span><span class="tool-name">${escapeHtml(ev.name)}</span>${arg}` +
      `<span class="tool-result-badge"></span><span class="tool-toggle">▾</span></div>` +
      subchat +
      `<div class="tool-detail hidden">` +
      (temInput
        ? `<div class="tool-detail-sec"><h4>Argumentos</h4><pre>${escapeHtml(JSON.stringify(ev.input, null, 2))}</pre></div>`
        : "") +
      `<div class="tool-detail-sec tool-detail-result hidden"><h4>Resultado</h4><pre></pre></div>` +
      `</div>`;
    if (subchat) {
      // O `delegacao_run` (session.ts) pode chegar antes ou depois desta bolha — se já chegou
      // (fica em `state.subchatsPendentes`, por threadId), abre agora em vez de esperar de novo.
      const threadId = ev.threadId ?? state.threadId;
      const pendente = state.subchatsPendentes.get(threadId);
      if (pendente) {
        state.subchatsPendentes.delete(threadId);
        iniciarSubchat(li, pendente);
      }
    }
  } else if (ev.type === "tool_result") {
    // Não é bolha nova: anexa no `tool` de mesmo id, que já está no log (chega sempre depois).
    const alvo = log.querySelector(`li.tool[data-tool-id="${CSS.escape(ev.id ?? "")}"]`);
    if (alvo) {
      const sec = alvo.querySelector(".tool-detail-result");
      sec.querySelector("pre").textContent = ev.result || "(sem saída)";
      sec.classList.remove("hidden");
      const badge = alvo.querySelector(".tool-result-badge");
      if (ev.isError) {
        badge.textContent = "✕";
        badge.dataset.err = "1";
      }
    }
    return;
  } else if (ev.type === "pergunta") {
    // Anima só quando chega ao vivo — reabrir a conversa não deve fazer toda pergunta antiga
    // piscar de novo na tela.
    li.className = scroll ? "pergunta pergunta-viva" : "pergunta";
    li.dataset.perguntaId = ev.id;
    li.dataset.threadId = ev.threadId ?? state.threadId;
    if (ev.multiSelect) li.dataset.multi = "1";
    const opcoes = ev.opcoes ?? [];
    const corpo = opcoes.length
      ? `<div class="pergunta-opcoes">${opcoes
          .map((o) => `<button type="button" class="pergunta-opcao" data-valor="${escapeHtml(o)}">${escapeHtml(o)}</button>`)
          .join("")}</div>` +
        (ev.multiSelect ? `<button type="button" class="pergunta-confirmar" disabled>Confirmar</button>` : "")
      : `<form class="pergunta-form"><input type="text" placeholder="responder..." autocomplete="off" /><button type="submit">Enviar</button></form>`;
    li.innerHTML =
      `<div class="who pergunta-who">Pergunta</div>` +
      `<div class="pergunta-texto">${escapeHtml(ev.texto)}</div>${corpo}`;
  } else if (ev.type === "pergunta_resposta") {
    const alvo = log.querySelector(`li.pergunta[data-pergunta-id="${CSS.escape(ev.id ?? "")}"]`);
    pintarRespostaDaPergunta(alvo, ev.resposta);
    return;
  } else if (ev.type === "switched") {
    li.innerHTML = `<span class="stamp">Trocou ${escapeHtml(ev.fromProfileId)} → ${escapeHtml(ev.toProfileId)}</span>`;
  } else if (ev.type === "error") {
    li.innerHTML = `<div class="err">${escapeHtml(fmtDetail(ev.message) || "erro")}</div>`;
  } else if (ev.type === "quota") {
    li.innerHTML = `<div class="err">${escapeHtml(fmtDetail(ev.detail) || "Limite de uso do Claude.")}</div>`;
  } else if (ev.type === "sys") {
    li.innerHTML = `<span class="stamp">${escapeHtml(ev.message)}</span>`;
  } else if (ev.type === "panel") {
    const rows = ev.rows
      .map(
        ([label, value, cls]) =>
          `<dt>${escapeHtml(label)}</dt><dd${cls ? ` class="${cls}"` : ""}>${escapeHtml(String(value))}</dd>`,
      )
      .join("");
    li.innerHTML = `<div class="panel"><h3>${escapeHtml(ev.title)}</h3><dl>${rows}</dl></div>`;
  } else if (ev.type === "context_trimmed") {
    li.innerHTML = `<span class="stamp">Contexto cortado · ficou ${escapeHtml(String(ev.keptMessages))} msgs</span>`;
  } else if (ev.type === "compacting") {
    // não é linha na conversa: é estado. Sai pelo anel do contexto, que é
    // justamente o número que a compactação vai mudar.
    pintarCompactando(ev.on, ev.motivo);
    return;
  } else if (ev.type === "compacted") {
    /*
     * Dobrável, e fechado: o resumo é longo e a pessoa quase nunca quer lê-lo —
     * ela quer saber que ele existe. Mas quando a resposta seguinte parecer ter
     * esquecido algo, é aqui que se descobre o que foi guardado.
     */
    const de = fmtTokens(ev.tokensAntes);
    const pra = fmtTokens(ev.tokensDepois);
    li.innerHTML =
      `<details class="compact"><summary><span class="stamp">Histórico resumido · ` +
      `${escapeHtml(de)} → ${escapeHtml(pra)} tokens</span></summary>` +
      `<div class="compact-txt"></div></details>`;
    const alvo = li.querySelector(".compact-txt");
    if (alvo) renderMd(alvo, ev.text);
  } else {
    return;
  }
  if (scroll) state.events = [...state.events, ev];
  log.append(li);
  if (scroll) log.scrollTop = log.scrollHeight;
}


/* markdown no streaming: no máximo um render por frame, e um final no done */
let streamPending = null;
let streamRaf = 0;

function scheduleStreamRender(el, text) {
  streamPending = { el, text };
  if (streamRaf) return;
  streamRaf = requestAnimationFrame(() => {
    streamRaf = 0;
    if (streamPending) renderMd(streamPending.el, streamPending.text);
  });
}

function flushStreamRender() {
  if (streamRaf) cancelAnimationFrame(streamRaf);
  streamRaf = 0;
  if (streamPending) renderMd(streamPending.el, streamPending.text);
  streamPending = null;
}

/** Delegado (não por bolha): pega tanto as ferramentas que chegam ao vivo quanto as de uma conversa reaberta. */
$("log").addEventListener("click", (e) => {
  const confirmar = e.target.closest(".pergunta-confirmar");
  if (confirmar) {
    const li = confirmar.closest("li.pergunta");
    const marcadas = [...li.querySelectorAll(".pergunta-opcao.marcada")].map((b) => b.dataset.valor);
    if (marcadas.length) void responderPergunta(li, marcadas.join("; "));
    return;
  }
  const opcao = e.target.closest(".pergunta-opcao");
  if (opcao) {
    const li = opcao.closest("li.pergunta");
    if (li.dataset.multi === "1") {
      // Multi-seleção: só marca/desmarca — quem envia é o botão Confirmar.
      opcao.classList.toggle("marcada");
      const confirmarBtn = li.querySelector(".pergunta-confirmar");
      confirmarBtn.disabled = !li.querySelector(".pergunta-opcao.marcada");
      return;
    }
    void responderPergunta(li, opcao.dataset.valor);
    return;
  }
  const linha = e.target.closest(".tool-line");
  if (!linha) return;
  const li = linha.closest("li.tool");
  const detalhe = li?.querySelector(".tool-detail");
  if (!detalhe) return;
  const abrir = detalhe.classList.contains("hidden");
  detalhe.classList.toggle("hidden", !abrir);
  li.dataset.open = abrir ? "1" : "0";
});

$("log").addEventListener("submit", (e) => {
  const form = e.target.closest(".pergunta-form");
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector("input");
  const valor = input.value.trim();
  if (!valor) return;
  void responderPergunta(form.closest("li.pergunta"), valor);
});

/**
 * Pinta a resposta final na bolha: opção(ões) escolhida(s) viram a própria resposta (sem linha
 * repetida dizendo a mesma coisa embaixo); resposta aberta substitui o form por uma citação do
 * que foi dito. Chamado pelo eco do servidor (`pergunta_resposta`, SSE) — é a MESMA pintura pra
 * uma pergunta respondida agora e pra uma reaberta do histórico.
 */
function pintarRespostaDaPergunta(li, resposta) {
  if (!li || li.dataset.respondida === "1") return;
  li.dataset.respondida = "1";
  delete li.dataset.enviando;
  const opcoes = [...li.querySelectorAll(".pergunta-opcao")];
  // Multi-seleção junta valores com "; " (ver ferramentaDePerguntar) — separa de volta pra marcar
  // cada botão batido, em vez de procurar um botão só com o texto inteiro.
  const escolhidas = li.dataset.multi === "1" ? resposta.split("; ") : [resposta];
  const marcadas = opcoes.filter((b) => escolhidas.includes(b.dataset.valor));
  if (marcadas.length) {
    marcadas.forEach((b) => b.classList.add("selecionada"));
    opcoes.forEach((b) => (b.disabled = true));
    const confirmar = li.querySelector(".pergunta-confirmar");
    if (confirmar) confirmar.remove();
    return;
  }
  li.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  const form = li.querySelector(".pergunta-form");
  const resp = document.createElement("div");
  resp.className = "pergunta-resposta";
  resp.textContent = resposta;
  if (form) form.replaceWith(resp);
  else li.append(resp);
}

/** Manda a resposta pro daemon e só desabilita os controles — quem pinta o estado final é o eco (`pergunta_resposta`). */
async function responderPergunta(li, resposta) {
  if (!li || li.dataset.respondida === "1" || li.dataset.enviando === "1") return;
  const threadId = li.dataset.threadId;
  li.dataset.enviando = "1";
  li.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  try {
    await req(`/v1/perguntas/${threadId}/responder`, { method: "POST", body: JSON.stringify({ resposta }) });
  } catch (e) {
    delete li.dataset.enviando;
    li.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
    appendEvent({ type: "error", message: e.message || "Não deu pra responder." });
  }
}



async function openThread(id) {
  // Imagem no composer é da conversa onde foi colada: não segue pra outra.
  if (state.threadId !== id) clearPending();
  state.threadId = id;
  localStorage.setItem("nexo.thread", id);
  const events = await req(`/v1/threads/${id}`);
  const meta = events.find((e) => e.type === "thread_meta");
  const switched = [...events].reverse().find((e) => e.type === "switched");
  state.profileId = switched?.toProfileId || meta?.profileId || "";
  state.agentId = meta?.agentId || "";
  setVia();
  renderEvents(events);
  setComposer(true);
  // "Falando" é por conversa: com duas contas trabalhando em paralelo, sair de uma
  // em voo não pode deixar a próxima com o indicador aceso e o Parar mirando errado.
  if (state.ok) setMotor(true, state.agents.list.some((a) => a.threadId === id && a.busy));
  setChatHead();
  state.queuePaused = false;
  paintQueue();
  state.fpThreads = "";
  state.fpProfiles = "";
  if (!state.sideChat) {
    state.sideChat = true;
    applyWorkLayout();
  }
  await loadThreads();
  await loadProfiles();
  listenSse();
  await refreshMeter();
}

function listenSse() {
  state.abortSse?.abort();
  if (!state.threadId) return;
  const ac = new AbortController();
  state.abortSse = ac;
  state.sseOn = true;

  /**
   * Religa e recupera o que passou. Vale pra queda com erro E pra fim limpo do
   * stream (o que acontece quando o daemon reinicia) — antes só o erro religava,
   * e um fim limpo deixava o chat mudo até o Ctrl+R.
   */
  const religar = () => {
    state.sseOn = false;
    if (state.abortSse !== ac) return;
    setTimeout(async () => {
      if (state.abortSse !== ac || !state.threadId) return;
      await renovarCredenciais();
      if (!state.ok) return;
      // o SSE não repõe o que perdeu: relê a conversa do disco antes de voltar a ouvir
      try {
        renderEvents(await req(`/v1/threads/${state.threadId}`));
        setMotor(true, false);
      } catch {
        /* se falhar, o listen abaixo ainda tenta de novo */
      }
      listenSse();
    }, 1500);
  };

  fetch(api(`/v1/threads/${state.threadId}/events`), {
    headers: headers(),
    signal: ac.signal,
  })
    .then(async (res) => {
      await lerEventos(res, onLive);
      religar();
    })
    .catch((e) => {
      if (e.name === "AbortError") {
        state.sseOn = false;
        return;
      }
      console.error(e);
      religar();
    });
}

/** Turno acabou mal: segura a fila e diz por quê, em vez de despejar tudo na parede. */
function pausarFila(motivo) {
  if (!filaDa().length) return;
  state.queuePaused = true;
  paintQueue();
  appendEvent({
    type: "sys",
    message: `Fila pausada (${motivo}): ${filaDa().length} mensagem(ns) esperando. Resolve e clica em Retomar.`,
  });
}


function onLive(ev) {
  if (ev.type === "text") {
    setMotor(true, true);
    const log = $("log");
    let last = log.lastElementChild;
    if (!last || last.dataset.stream !== "1") {
      last = document.createElement("li");
      last.className = "bot";
      last.dataset.stream = "1";
      last.innerHTML = `<div class="who">Conta</div><div class="stream md"></div>`;
      log.append(last);
      state.events = [...state.events, { type: "assistant", text: "" }];
    }
    const live = state.events.at(-1);
    if (live?.type === "assistant") live.text += ev.text;
    scheduleStreamRender(last.querySelector(".stream"), live?.text ?? ev.text);
    log.scrollTop = log.scrollHeight;
    return;
  }
  if (ev.type === "thinking") {
    setMotor(true, true);
    if (typeof ev.tokens === "number" && ev.tokens > state.think.tokens) state.think.tokens = ev.tokens;
    if (ev.text) appendThinking(ev.text);
    return;
  }
  // Snapshot do request individual mais recente: atualiza o medidor ainda durante o turno,
  // sem esperar o "usage" final (que só chega quando o motor termina toda a volta de ferramentas).
  if (ev.type === "context") {
    state.meter.contextTokens = ev.contextTokens || state.meter.contextTokens;
    paintContext();
    return;
  }
  if (ev.type === "usage") {
    state.meter.contextTokens = ev.contextTokens || state.meter.contextTokens;
    paintContext();
    void refreshMeter();
    return;
  }
  if (ev.type === "limits") {
    state.meter.limits = ev;
    paintLimits();
    return;
  }
  if (ev.type === "session") {
    state.meter.contextWindow = ev.contextWindow || state.meter.contextWindow;
    state.meter.sessionModel = ev.model || state.meter.sessionModel;
    state.meter.sessionId = ev.sessionId || state.meter.sessionId;
    paintContext();
    paintFacts();
    return;
  }
  if (ev.type === "done") {
    flushStreamRender();
    setMotor(true, false);
    void enviarProximoDaFila();
    return;
  }
  if (ev.type === "tool") {
    appendEvent({ type: "tool", name: ev.name, summary: ev.summary, id: ev.id, input: ev.input });
    registrarAtividadeGrafo(ev.name, ev.summary);
    return;
  }
  if (ev.type === "tool_result") {
    appendEvent({ type: "tool_result", id: ev.id, result: ev.result, isError: ev.isError });
    return;
  }
  if (ev.type === "pergunta") {
    appendEvent({ type: "pergunta", id: ev.id, texto: ev.texto, opcoes: ev.opcoes, threadId: ev.threadId });
    return;
  }
  if (ev.type === "pergunta_resposta") {
    appendEvent({ type: "pergunta_resposta", id: ev.id, resposta: ev.resposta });
    return;
  }
  if (ev.type === "delegacao_run") {
    // A bolha da ferramenta (evento "tool") normalmente já chegou — acha a mais recente sem
    // subchat aberto ainda. Se ainda não chegou (corrida rara), guarda pra quando ela aparecer.
    const bolha = [...$("log").querySelectorAll("li.tool")].reverse().find((li) => li.querySelector(".subchat") && !li.dataset.runId);
    if (bolha) iniciarSubchat(bolha, ev.runId);
    else state.subchatsPendentes.set(ev.threadId ?? state.threadId, ev.runId);
    return;
  }
  if (ev.type === "quota") {
    setMotor(true, false);
    pausarFila("quota");
    showQuota(ev);
    return;
  }
  // Troca feita pelo daemon (modo automático): ninguém pediu daqui, então a tela se atualiza sozinha.
  if (ev.type === "switched") {
    // conta nova: o motivo da pausa (quota da conta velha) deixou de valer
    state.queuePaused = false;
    paintQueue();
    appendEvent({ type: "switched", fromProfileId: ev.fromProfileId, toProfileId: ev.toProfileId });
    state.profileId = ev.toProfileId;
    setVia();
    void refreshMeter();
    return;
  }
  if (ev.type === "auth") {
    setMotor(true, false);
    pausarFila("login");
    appendEvent({ type: "error", message: ev.detail || "Essa conta precisa de login novo." });
    state.fpProfiles = "";
    void loadProfiles();
    if (ev.suggestedProfileId) showQuota({ ...ev, auth: true }, true);
    return;
  }
  if (ev.type === "error") {
    setMotor(true, false);
    pausarFila("erro");
    appendEvent({ type: "error", message: ev.message || "motor morreu" });
    if (ev.suggestedProfileId) showQuota({ ...ev, crash: true }, true);
  }
}

function showQuota(ev, skipChat = false) {
  const p = state.profiles.find((x) => x.id === ev.suggestedProfileId);
  const chatOnly = ev.chatOnly || p?.engine === "api";
  const warn = chatOnly ? " Essa conta é só chat, sem tools." : "";
  const detail = fmtDetail(ev.detail);
  const why = ev.auth
    ? `A conta ${state.profileId} precisa de login`
    : ev.crash
      ? "O motor caiu"
      : detail || `A quota de ${state.profileId} acabou`;
  $("toast-text").textContent = ev.suggestedProfileId
    ? `${why}. Continuar em ${ev.suggestedProfileId}?${warn}`
    : ev.auth
      ? `${why} e não há outra conta pronta.`
      : ev.crash
        ? "O motor caiu e não há outra conta pronta."
        : detail || "A quota acabou e não há outra conta pronta.";
  state.pendingQuota = ev.suggestedProfileId ?? null;
  $("toast").classList.toggle("hidden", !ev.suggestedProfileId);
  $("toast-yes").textContent = ev.suggestedProfileId ? `Ir para ${ev.suggestedProfileId}` : "Ir para a outra conta";
  if (skipChat) return;
  appendEvent({
    type: "error",
    message: ev.crash
      ? ev.suggestedProfileId
        ? `${why}. Continuar em ${ev.suggestedProfileId}?`
        : "O motor caiu. Sem outra conta pronta."
      : detail || "Quota estourou. Sem outra conta pronta.",
  });
}

async function switchTo(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (p && p.status !== "ready") {
    state.profileId = id;
    setVia();
    return;
  }
  if (!state.threadId) {
    state.profileId = id;
    setVia();
    state.fpProfiles = "";
    await loadProfiles();
    return;
  }
  if (id === state.profileId) return;
  if (p?.engine === "api") {
    state.pendingQuota = id;
    $("profile-select").value = state.profileId;
    $("toast-text").textContent = `Ir para ${id}? Essa conta é só chat, sem tools.`;
    $("toast-yes").textContent = `Ir para ${id}`;
    $("toast").classList.remove("hidden");
    $("toast-yes").dataset.reason = "user";
    return;
  }
  await doSwitch(id, "user");
}

function loginMsg(text, ok = false) {
  const el = $("login-msg");
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
  el.classList.toggle("ok", ok);
}

function stopLoginPoll() {
  if (state.login.poll) clearInterval(state.login.poll);
  state.login.poll = 0;
}

/** O CLI pode fechar o login sozinho pelo callback, sem código. Isso detecta. */
function watchLogin() {
  stopLoginPoll();
  state.login.poll = setInterval(async () => {
    if (!state.login.id) return stopLoginPoll();
    let res;
    try {
      res = await req(
        `/v1/profiles/${encodeURIComponent(state.login.profileId)}/login/status?loginId=${encodeURIComponent(state.login.id)}`,
      );
    } catch {
      return;
    }
    if (res.state === "waiting") return;
    const id = state.login.profileId;
    stopLoginPoll();
    if (res.state === "done") {
      closeLoginModal(false);
      state.fpProfiles = "";
      await loadProfiles();
      appendEvent({ type: "sys", message: `${id} logada.` });
      if (state.threadId) {
        try {
          await doSwitch(id, "user");
        } catch (e) {
          appendEvent({ type: "error", message: e.message || "Não trocou a conversa." });
        }
      }
      return;
    }
    state.login.id = "";
    loginMsg(res.message || "O login falhou. Tente de novo.");
  }, 1500);
}

function closeLoginModal(cancel = true) {
  stopLoginPoll();
  if (cancel && state.login.id && state.login.profileId) {
    void req(`/v1/profiles/${encodeURIComponent(state.login.profileId)}/login/cancel`, {
      method: "POST",
      body: JSON.stringify({ loginId: state.login.id }),
    }).catch(() => {});
  }
  state.login = { id: "", profileId: "", url: "", poll: 0 };
  $("login-code").value = "";
  loginMsg("");
  $("login-modal").classList.add("hidden");
}

/** Login dentro do app: o CLI abre o navegador e espera o código; a gente entrega. */
async function startLogin(id) {
  if (!state.ok) return;
  const p = state.profiles.find((x) => x.id === id);
  if (p && p.engine !== "claude") {
    await startLoginTerminal(id);
    return;
  }
  $("login-title").textContent = `Entrar em ${id}`;
  $("login-step").textContent = "Abrindo o navegador…";
  $("login-url").value = "";
  $("login-code").value = "";
  loginMsg("");
  $("login-modal").classList.remove("hidden");
  try {
    const r = await req(`/v1/profiles/${encodeURIComponent(id)}/login/start`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    state.login = { id: r.loginId, profileId: id, url: r.url, poll: 0 };
    $("login-url").value = r.url;
    $("login-step").textContent =
      "Autorize no navegador. Se a página mostrar um código, cole abaixo; se ela disser que já pode fechar, é só esperar — a gente detecta.";
    $("login-code").focus();
    watchLogin();
  } catch (e) {
    loginMsg(e.message || "Não deu pra começar o login.");
    $("login-step").textContent = "Falhou antes de abrir o navegador.";
  }
}

async function submitLoginCode() {
  const code = $("login-code").value.trim();
  if (!state.login.id) {
    loginMsg("Sessão de login perdida. Feche e tente de novo.");
    return;
  }
  if (!code) {
    loginMsg("Cole o código primeiro.");
    return;
  }
  $("btn-login-submit").disabled = true;
  loginMsg("Conferindo…");
  try {
    const res = await req(`/v1/profiles/${encodeURIComponent(state.login.profileId)}/login/code`, {
      method: "POST",
      body: JSON.stringify({ loginId: state.login.id, code }),
    });
    const id = state.login.profileId;
    closeLoginModal(false);
    state.fpProfiles = "";
    await loadProfiles();
    appendEvent({ type: "sys", message: `${id} logada.` });
    if (state.threadId && res.profile?.status === "ready") {
      try {
        await doSwitch(id, "user");
      } catch (e) {
        appendEvent({ type: "error", message: e.message || "Não trocou a conversa." });
      }
    }
  } catch (e) {
    loginMsg(e.message || "O código não foi aceito.");
  } finally {
    $("btn-login-submit").disabled = false;
  }
}

/** Escape: fluxo antigo, na janela do terminal. */
async function startLoginTerminal(id) {
  const r = await window.nexo.openLogin(id);
  if (!r?.ok) {
    appendEvent({ type: "error", message: r?.error || "Não abriu o login." });
    return;
  }
  appendEvent({ type: "sys", message: `Terminei o login de ${id} na janela do terminal, depois clique "Já loguei".` });
}

async function importClaudeLogin(id) {
  if (!state.ok) return;
  try {
    await req(`/v1/profiles/${id}/import`, { method: "POST", body: "{}" });
  } catch (e) {
    appendEvent({ type: "error", message: e.message || "Não achei login do Claude neste PC." });
    return;
  }
  state.fpProfiles = "";
  await loadProfiles();
  appendEvent({ type: "sys", message: `${id} pronto (login do Claude deste PC).` });
  if (state.threadId) {
    try {
      await doSwitch(id, "user");
    } catch (e) {
      appendEvent({ type: "error", message: e.message || "Não trocou a conversa." });
    }
  }
}

async function doSwitch(id, reason) {
  const from = state.profileId;
  const res = await req(`/v1/threads/${state.threadId}/switch`, {
    method: "POST",
    body: JSON.stringify({ profileId: id, confirmed: true, reason }),
  });
  // Sem recarregar a conversa: o daemon pode já estar respondendo o turno retomado
  // e um openThread aqui derrubaria o SSE (e a bolha) no meio do stream.
  appendEvent({ type: "switched", fromProfileId: from, toProfileId: id });
  state.profileId = id;
  setVia();
  if (res?.resumed) setMotor(true, true);
  state.fpProfiles = "";
  await loadProfiles();
  await refreshMeter();
}

/* ---------- serviços locais ---------- */

const svcPanel = createServicesPanel({
  req,
  api,
  headers,
  getProjectPath: () => state.projectPath,
  isOk: () => state.ok,
  el: $,
  // o painel não precisa saber o que é aba de browser nem log de chat
  abrirNoBrowser: (url) => {
    setBrowserUrl(url);
    state.view = "browser";
    applyWorkLayout();
  },
  aoErro: (message) => appendEvent({ type: "error", message }),
});

/* ---------- times ---------- */

async function loadTeams() {
  if (!state.ok) return;
  try {
    state.teams = await req("/v1/teams");
  } catch {
    // motor antigo sem a rota: painel vazio, não erro na cara
    state.teams = [];
  }
  paintTeams();
}

function paintTeams() {
  const ul = $("team-list");
  ul.replaceChildren();
  $("team-empty").classList.toggle("hidden", state.teams.length > 0);
  for (const t of state.teams) {
    const li = document.createElement("li");
    li.className = "agent-card";
    const nome = document.createElement("strong");
    nome.textContent = t.name;
    const meta = document.createElement("span");
    meta.className = "agent-card-meta";
    meta.textContent = `${t.members.length} membro${t.members.length === 1 ? "" : "s"} · ${t.members
      .map((m) => m.agentId)
      .join(" → ")}`;
    const editar = document.createElement("button");
    editar.type = "button";
    editar.className = "ghost";
    editar.textContent = "✎";
    editar.title = "Abrir";
    editar.addEventListener("click", () => void abrirTime(t));
    li.append(nome, meta, editar);
    li.addEventListener("click", (e) => {
      if (e.target === editar) return;
      void abrirTime(t);
    });
    ul.append(li);
  }
}

/**
 * Painel lateral fecha e a tela cheia assume, igual ao agente. Espera os agentes
 * carregarem antes: o seletor de membro é montado a partir deles, e abrir sem a
 * lista deixava o time novo sem membro nenhum e sem explicação.
 */
async function abrirTime(def) {
  toggleAgents(false);
  state.view = "agentes";
  applyWorkLayout();
  setAxTab("times");
  if (!state.agents.defs.length) await loadAgentDefs();
  teamStudio.abrir(def);
}

/** Painel lateral fecha e a tela unificada assume, na aba Agentes. */
function abrirEstudio(def) {
  toggleAgents(false);
  state.view = "agentes";
  applyWorkLayout();
  setAxTab("agentes");
  agentStudio.abrir(def);
}

/* ---------- Nexo Hooks ---------- */

async function loadHookRules() {
  if (!state.ok) return;
  try {
    state.hookRules = await req("/v1/hooks/rules");
  } catch {
    // motor antigo sem a rota: painel vazio, não erro na cara
    state.hookRules = [];
  }
  paintHookRules();
}

function rotuloDoEscopo(regra) {
  return regra.escopo.tipo === "global" ? "global" : regra.escopo.projectPath;
}

function paintHookRules() {
  const ul = $("hook-list");
  ul.replaceChildren();
  $("hook-empty").classList.toggle("hidden", state.hookRules.length > 0);
  for (const r of state.hookRules) {
    const li = document.createElement("li");
    li.className = "agent-card";
    const nome = document.createElement("strong");
    nome.textContent = r.nome || `${r.evento} · ${rotuloDoEscopo(r)}`;
    const meta = document.createElement("span");
    meta.className = "agent-card-meta";
    const quem = r.teamId ? `time ${r.teamId}` : r.agentId;
    const partes = r.nome ? [`${r.evento} · ${rotuloDoEscopo(r)}`, quem] : [quem];
    if (r.branch) partes.push(`branch ${r.branch}`);
    if (r.bloqueante) partes.push("bloqueante");
    meta.textContent = partes.join(" · ");
    const editar = document.createElement("button");
    editar.type = "button";
    editar.className = "ghost";
    editar.textContent = "✎";
    editar.title = "Abrir";
    editar.addEventListener("click", () => abrirHook(r));
    li.append(nome, meta, editar);
    li.addEventListener("click", (e) => {
      if (e.target === editar) return;
      abrirHook(r);
    });
    ul.append(li);
  }
}

/** Painel lateral fecha e a tela unificada assume, na aba Hooks. */
async function abrirHook(def) {
  toggleAgents(false);
  state.view = "agentes";
  applyWorkLayout();
  setAxTab("hooks");
  if (!state.agents.defs.length) await loadAgentDefs();
  if (!state.teams.length) await loadTeams();
  hooksStudio.abrir(def);
}

/* ---------- Grafo (graphify) ---------- */

/** Data legível, ou vazio — mtime pode não vir (nunca escrito ainda). */
function fmtQuando(iso) {
  if (!iso) return "";
  try {
    return ` · atualizado ${new Date(iso).toLocaleString("pt-BR")}`;
  } catch {
    return "";
  }
}

async function loadGraphStatus() {
  if (!state.ok || !state.projectPath) return;
  $("graph-err").classList.add("hidden");
  let status;
  try {
    status = await req(`/v1/projeto/status?projectPath=${encodeURIComponent(state.projectPath)}`);
  } catch (e) {
    $("graph-status").textContent = "erro";
    $("graph-status").dataset.on = "0";
    $("graph-detalhe").textContent = e.message || "Não deu pra checar o status.";
    return;
  }

  const mem = status.memoria;
  $("mem-status").textContent = mem.existe ? "escrita" : "vazia";
  $("mem-status").dataset.on = mem.existe ? "1" : "0";
  $("mem-detalhe").textContent =
    (mem.compartilhado ? `${mem.caminho} · pasta compartilhada` : mem.caminho) + fmtQuando(mem.atualizadoEm);

  const gr = status.grafo;
  $("graph-status").textContent = gr.disponivel ? "disponível" : "ausente";
  $("graph-status").dataset.on = gr.disponivel ? "1" : "0";
  $("graph-detalhe").textContent =
    (gr.compartilhado ? `${gr.caminho} · pasta compartilhada` : gr.caminho) + fmtQuando(gr.atualizadoEm);

  $("graph-auto").checked = Boolean(status.grafoAuto);
  $("graph-auto-profile-wrap").classList.toggle("hidden", !status.grafoAuto);
  pintarPerfisDoGrafoAuto();

  const n = status.hooksCount;
  $("proj-hooks-count").textContent = n ? `${n} regra${n > 1 ? "s" : ""} vale${n > 1 ? "m" : ""} pra este projeto.` : "Nenhuma regra vale pra este projeto ainda.";
}

function pintarPerfisDoGrafoAuto() {
  const sel = $("graph-auto-profile");
  const atual = sel.value;
  sel.replaceChildren();
  for (const p of state.profiles) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.id;
    sel.append(o);
  }
  if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
}

$("graph-auto").addEventListener("change", async (e) => {
  const ligar = e.target.checked;
  $("graph-auto-profile-wrap").classList.toggle("hidden", !ligar);
  $("graph-auto-err").classList.add("hidden");
  if (ligar && !$("graph-auto-profile").value) {
    // sem conta ainda escolhida: não liga sozinho com perfil vazio, espera a pessoa escolher
    pintarPerfisDoGrafoAuto();
    if (!$("graph-auto-profile").value) return;
  }
  try {
    await req("/v1/config", {
      method: "PUT",
      body: JSON.stringify({
        modulos: { grafoAuto: ligar, ...(ligar ? { grafoAutoProfileId: $("graph-auto-profile").value } : {}) },
      }),
    });
  } catch (err) {
    $("graph-auto-err").textContent = err.message || "Não gravou.";
    $("graph-auto-err").classList.remove("hidden");
    e.target.checked = !ligar;
    return;
  }
  await loadGraphStatus();
});

$("graph-auto-profile").addEventListener("change", async (e) => {
  if (!$("graph-auto").checked) return;
  $("graph-auto-err").classList.add("hidden");
  try {
    await req("/v1/config", { method: "PUT", body: JSON.stringify({ modulos: { grafoAutoProfileId: e.target.value } }) });
  } catch (err) {
    $("graph-auto-err").textContent = err.message || "Não gravou.";
    $("graph-auto-err").classList.remove("hidden");
  }
});

$("btn-proj-hooks-abrir").addEventListener("click", () => {
  toggleAgents(true);
  setAgentsTab("hooks");
});

$("btn-close-graph").addEventListener("click", closeModule);

$("btn-graph-atualizar").addEventListener("click", async () => {
  if (!state.projectPath) return;
  $("graph-err").classList.add("hidden");
  $("btn-graph-atualizar").disabled = true;
  try {
    const r = await req("/v1/graph/atualizar", { method: "POST", body: JSON.stringify({ projectPath: state.projectPath }) });
    if (!r.ok) $("graph-err").textContent = r.texto || "Falhou ao atualizar.";
    await loadGraphStatus();
  } catch (e) {
    $("graph-err").textContent = e.message || "Falhou ao atualizar.";
    $("graph-err").classList.remove("hidden");
  } finally {
    $("btn-graph-atualizar").disabled = false;
  }
});

$("btn-graph-arvore").addEventListener("click", async () => {
  if (!state.projectPath) return;
  $("graph-err").classList.add("hidden");
  try {
    const r = await req("/v1/graph/arvore", { method: "POST", body: JSON.stringify({ projectPath: state.projectPath }) });
    if (!r.ok || !r.arquivo) {
      $("graph-err").textContent = r.texto || "Falhou ao gerar a árvore.";
      $("graph-err").classList.remove("hidden");
      return;
    }
    await window.nexo.openLocalFile(r.arquivo);
  } catch (e) {
    $("graph-err").textContent = e.message || "Falhou ao gerar a árvore.";
    $("graph-err").classList.remove("hidden");
  }
});

$("btn-graph-importar").addEventListener("click", async () => {
  if (!state.projectPath) return;
  const origem = await window.nexo.pickFolder();
  if (!origem) return;
  $("graph-err").classList.add("hidden");
  try {
    await req("/v1/graph/importar", {
      method: "POST",
      body: JSON.stringify({ projectPath: state.projectPath, origem }),
    });
    await loadGraphStatus();
  } catch (e) {
    $("graph-err").textContent = e.message || "Falhou ao importar.";
    $("graph-err").classList.remove("hidden");
  }
});

/**
 * Trilha de atividade — v1 simplificado do que o agent-code faz (mapa de arquivo com física em
 * canvas): reusa o MESMO evento `tool` que já alimenta o chat, sem stream novo nem motor de
 * desenho. Evolução futura, se topar: física de verdade em canvas.
 */
function registrarAtividadeGrafo(nome, resumo) {
  const ol = $("graph-atividade");
  if (!ol) return;
  $("graph-atividade-vazio").classList.add("hidden");
  const li = document.createElement("li");
  li.className = "graph-ato-item graph-ato-novo";
  const ico = document.createElement("span");
  ico.className = "graph-ato-ico";
  ico.textContent = "⚙";
  const nomeEl = document.createElement("span");
  nomeEl.className = "graph-ato-nome";
  nomeEl.textContent = nome;
  const resumoEl = document.createElement("span");
  resumoEl.className = "graph-ato-resumo";
  resumoEl.textContent = resumo || "";
  li.append(ico, nomeEl, resumoEl);
  ol.prepend(li);
  requestAnimationFrame(() => requestAnimationFrame(() => li.classList.remove("graph-ato-novo")));
  while (ol.children.length > 30) ol.lastElementChild?.remove();
}

const hooksStudio = createHooksStudio({
  req,
  el: $,
  getProjects: () => state.repos,
  getAgents: () => state.agents.defs,
  getTeams: () => state.teams,
  aoSalvar: () => loadHookRules(),
  aoFechar: () => {
    state.view = "none";
    applyWorkLayout();
  },
});

const teamStudio = createTeamStudio({
  req,
  api,
  headers,
  el: $,
  getProjectPath: () => state.projectPath,
  isOk: () => state.ok,
  getAgents: () => state.agents.defs,
  lerEventos,
  aoSalvar: () => loadTeams(),
  aoFechar: () => {
    state.view = "none";
    applyWorkLayout();
  },
});

const agentStudio = createAgentStudio({
  req,
  api,
  headers,
  el: $,
  getProjectPath: () => state.projectPath,
  isOk: () => state.ok,
  getProfiles: () => state.profiles,
  lerEventos,
  renderMd,
  aoSalvar: () => loadAgentDefs(),
  aoFechar: () => {
    state.view = "none";
    applyWorkLayout();
  },
});

const loadServices = () => svcPanel.load();
const listenServices = () => svcPanel.listen();
const fecharLogServico = () => svcPanel.fecharLog();

/* ---------- painel de agentes ---------- */

async function loadAgents() {
  if (!state.ok) {
    state.agents.list = [];
    paintAgents();
    return;
  }
  try {
    state.agents.list = await req("/v1/agents");
    state.agents.unsupported = false;
  } catch (e) {
    // motor antigo (sem a rota) ou fora do ar: painel vazio, não erro na cara
    state.agents.list = [];
    state.agents.unsupported = /404|not found/i.test(e.message || "");
  }
  paintAgents();
}

/** Conversa que apareceu depois do último retrato: repõe o retrato, sem martelar. */
function agendarRetrato() {
  if (state.agents.refetch || state.agents.unsupported) return;
  state.agents.refetch = setTimeout(() => {
    state.agents.refetch = null;
    void loadAgents();
  }, 400);
}

function applyAgentEvent(ev) {
  const id = ev.threadId;
  if (!id) return;
  // Contagem GLOBAL de perguntas pendentes: vem do bus "*", então soma de QUALQUER conversa —
  // é isso que deixa o badge avisar sem precisar estar olhando a conversa certa.
  if (ev.type === "pergunta") {
    state.agents.perguntasPendentes.add(id);
    schedulePaintAgents();
    return;
  }
  if (ev.type === "pergunta_resposta") {
    state.agents.perguntasPendentes.delete(id);
    schedulePaintAgents();
    return;
  }
  const a = state.agents.list.find((x) => x.threadId === id);
  if (!a) {
    agendarRetrato();
    return;
  }
  if (aplicarNoRetrato(a, ev)) schedulePaintAgents();
}

/** Coalesce: um turno em stream emite dezenas de eventos por segundo. */
function schedulePaintAgents() {
  if (state.agents.paint) return;
  state.agents.paint = requestAnimationFrame(() => {
    state.agents.paint = 0;
    paintAgents();
  });
}

function listenAgents() {
  state.agents.abort?.abort();
  if (!state.ok) return;
  const ac = new AbortController();
  state.agents.abort = ac;
  state.agents.on = true;
  fetch(api("/v1/agents/events"), { headers: headers(), signal: ac.signal })
    .then(async (res) => {
      if (!res.ok || !res.body) throw new Error(`agents sse ${res.status}`);
      await lerEventos(res, applyAgentEvent);
      religarAgentes();
    })
    .catch((e) => {
      if (e.name === "AbortError") {
        state.agents.on = false;
        return;
      }
      religarAgentes();
    });

  function religarAgentes() {
    state.agents.on = false;
    if (state.agents.abort !== ac) return;
    setTimeout(() => {
      if (state.agents.abort !== ac || !state.ok) return;
      void loadAgents();
      listenAgents();
    }, 1500);
  }
}

function agentesAtivos() {
  return state.agents.list.filter((a) => a.busy || a.pendingQuota);
}


function toggleAgents(want) {
  state.agents.open = want === undefined ? !state.agents.open : Boolean(want);
  localStorage.setItem("nexo.agentsOpen", state.agents.open ? "1" : "0");
  if (state.agents.open) {
    void loadAgents();
    void loadAgentDefs();
  }
  paintAgents();
}

/**
 * Abas da tela unificada (`#pane-agentes`) — Agentes/Times/Hooks. Troca é só visibilidade: nada
 * é montado/desmontado, então a seleção de cada aba (o que `agentStudio`/`teamStudio`/
 * `hooksStudio` está editando) persiste sozinha ao ir e voltar.
 */
const ABAS_TELA_AGENTES = ["agentes", "times", "hooks"];

function setAxTab(tab) {
  state.axTab = ABAS_TELA_AGENTES.includes(tab) ? tab : "agentes";
  for (const aba of ABAS_TELA_AGENTES) {
    const ativa = aba === state.axTab;
    $(`tab-ax-${aba}`).dataset.on = ativa ? "1" : "0";
    $(`ax-body-${aba}`).classList.toggle("hidden", !ativa);
  }
  // times e hooks listam/escolhem agente (e hooks também time) junto: o seletor precisa deles
  if (state.axTab === "agentes" || state.axTab === "times" || state.axTab === "hooks") void loadAgentDefs();
  if (state.axTab === "times" || state.axTab === "hooks") void loadTeams();
  if (state.axTab === "hooks") void loadHookRules();
}

/* ---------- agentes personalizados: definições ---------- */

async function loadAgentDefs() {
  if (!state.ok || state.agents.defsUnsupported) return;
  try {
    state.agents.defs = await req("/v1/agents/defs");
    state.agents.defsLoaded = true;
  } catch (e) {
    state.agents.defs = [];
    // Motor antigo sem a rota: para de tentar em vez de martelar a cada abertura.
    state.agents.defsUnsupported = /404|not found/i.test(e.message || "");
  }
  paintAgentDefs();
}

function agentDef(id) {
  return id ? state.agents.defs.find((d) => d.id === id) : undefined;
}

function paintAgentDefs() {
  const ul = $("agent-defs");
  if (!ul) return;
  const vazio = $("agent-defs-empty");
  vazio.textContent = state.agents.defsUnsupported
    ? "Motor antigo, sem suporte a agentes personalizados. Desliga e liga o motor."
    : "Nenhum agente criado. Um agente guarda conta, modelo e instruções próprias.";
  vazio.classList.toggle("hidden", state.agents.defs.length > 0);
  ul.replaceChildren();
  for (const d of state.agents.defs) ul.append(agentDefCard(d));
}

function agentDefCard(d) {
  const li = document.createElement("li");
  li.className = "agent";
  li.dataset.def = "1";
  if (d.color) li.style.setProperty("--agent-color", d.color);

  const head = document.createElement("div");
  head.className = "agent-head";
  const nome = document.createElement("span");
  nome.className = "agent-name";
  nome.textContent = d.name;
  head.append(nome);

  const badges = document.createElement("div");
  badges.className = "agent-badges";
  const conta = document.createElement("span");
  conta.className = "agent-acct";
  conta.textContent = d.profileId;
  badges.append(conta);
  for (const t of [d.model, d.effort, d.permissionMode]) {
    if (!t) continue;
    const tag = document.createElement("span");
    tag.className = "agent-tag";
    tag.textContent = t;
    badges.append(tag);
  }
  if (d.instructions) {
    const tag = document.createElement("span");
    tag.className = "agent-tag";
    tag.textContent = `${d.instructions.length} car. de instrução`;
    badges.append(tag);
  }

  const acts = document.createElement("div");
  acts.className = "agent-acts";
  const usar = document.createElement("button");
  usar.type = "button";
  usar.className = "ghost";
  usar.textContent = "Nova conversa";
  usar.addEventListener("click", () => void novaConversaComAgente(d));
  const editar = document.createElement("button");
  editar.type = "button";
  editar.className = "ghost";
  editar.textContent = "Editar";
  editar.addEventListener("click", () => abrirEstudio(d));
  acts.append(usar, editar);

  li.append(head, badges);
  if (d.description) {
    const p = document.createElement("p");
    p.className = "agent-desc";
    p.textContent = d.description;
    li.append(p);
  }
  li.append(acts);
  return li;
}

/** Preenche o select de conta do formulário com os perfis já carregados. */
function fillAgentProfiles(escolhido) {
  const sel = $("agent-f-profile");
  sel.replaceChildren();
  for (const p of state.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.status === "ready" ? `${p.id} · ${p.engine}` : `${p.id} · ${p.engine} · login`;
    sel.append(opt);
  }
  if (escolhido) sel.value = escolhido;
}







async function novaConversaComAgente(d) {
  if (!state.projectPath) {
    appendEvent({ type: "sys", message: "Abre um repositório com + na barra esquerda." });
    return;
  }
  let t;
  try {
    t = await req("/v1/threads", {
      method: "POST",
      body: JSON.stringify({ projectPath: state.projectPath, agentId: d.id }),
    });
  } catch (e) {
    appendEvent({ type: "error", message: e.message || "Não deu pra abrir a conversa." });
    return;
  }
  toggleAgents(false);
  await openThread(t.id);
}

function paintAgents() {
  const dock = $("agents-dock");
  if (!dock) return;
  const ativos = agentesAtivos();
  // A árvore da esquerda acende junto: o ponto das outras conversas deixa de
  // esperar o poll de 4s e passa a seguir o mesmo stream deste painel.
  const fpBusy = state.agents.list
    .filter((a) => a.busy)
    .map((a) => a.threadId)
    .sort()
    .join("|");
  if (fpBusy !== state.agents.fpBusy) {
    state.agents.fpBusy = fpBusy;
    renderRepoTree();
  }
  const badge = $("agents-badge");
  const pendentes = state.agents.perguntasPendentes.size;
  const total = ativos.length + pendentes;
  badge.textContent = String(total);
  badge.title = pendentes ? `${ativos.length} rodando · ${pendentes} pergunta(s) esperando resposta` : "";
  badge.classList.toggle("hidden", total === 0);
  $("btn-agents").dataset.busy = total ? "1" : "0";
  $("btn-agents").setAttribute("aria-expanded", state.agents.open ? "true" : "false");
  dock.classList.toggle("hidden", !state.agents.open);
  // O relógio só corre com o painel aberto e alguém trabalhando.
  if (state.agents.open && ativos.length) {
    if (!state.agents.tick) state.agents.tick = setInterval(paintAgents, 1000);
  } else if (state.agents.tick) {
    clearInterval(state.agents.tick);
    state.agents.tick = null;
  }
  if (!state.agents.open) return;

  // Trabalhando primeiro; o resto é motor de pé mas parado, útil pra retomar.
  const ordem = [...state.agents.list].sort((a, b) => {
    const pa = a.busy ? 0 : a.pendingQuota ? 1 : 2;
    const pb = b.busy ? 0 : b.pendingQuota ? 1 : 2;
    return pa - pb || (a.startedAt < b.startedAt ? 1 : -1);
  });
  $("agents-title").textContent = ativos.length ? `Agentes · ${ativos.length} rodando` : "Agentes";
  $("agents-empty").textContent = state.agents.unsupported
    ? "Motor antigo, sem suporte ao painel. Desliga e liga o motor pra recarregar."
    : "Nenhum agente rodando agora. O motor só sobe quando a conversa recebe um turno.";
  $("agents-empty").classList.toggle("hidden", ordem.length > 0);
  const ul = $("agents-list");
  ul.replaceChildren();
  for (const a of ordem) {
    ul.append(agentCard(a));
  }
  // O interessante é o fim da saída, e o corte por altura mostraria o começo.
  for (const tail of ul.querySelectorAll(".agent-tail")) tail.scrollTop = tail.scrollHeight;
}

function agentCard(a) {
  const li = document.createElement("li");
  li.className = "agent";
  li.dataset.busy = a.busy ? "1" : "0";
  li.dataset.on = a.threadId === state.threadId ? "1" : "0";

  const head = document.createElement("div");
  head.className = "agent-head";
  if (a.busy) {
    const dot = document.createElement("span");
    dot.className = "run-dot";
    head.append(dot);
  }
  const title = document.createElement("span");
  title.className = "agent-title";
  title.textContent = `${folderName(a.projectPath)} › ${a.preview || "Conversa nova"}`;
  title.title = a.projectPath || "";
  head.append(title);

  const badges = document.createElement("div");
  badges.className = "agent-badges";
  if (a.agentName || a.agentId) {
    const nome = document.createElement("span");
    nome.className = "agent-tag";
    nome.textContent = a.agentName || a.agentId;
    if (a.agentColor) nome.style.color = a.agentColor;
    nome.title = "Agente personalizado desta conversa";
    badges.append(nome);
  }
  const acct = document.createElement("span");
  acct.className = "agent-acct";
  acct.textContent = a.profileId;
  acct.title = a.engine ? `motor ${a.engine}` : "";
  badges.append(acct);
  if (a.model) {
    const model = document.createElement("span");
    model.className = "agent-tag";
    model.textContent = a.model;
    badges.append(model);
  }
  const st = document.createElement("span");
  st.className = "agent-state";
  st.textContent = a.busy
    ? `trabalhando · ${elapsed(a.startedAt)}`
    : a.pendingQuota
      ? "quota estourada"
      : a.lastTerminal === "error"
        ? "erro no último turno"
        : a.lastTerminal === "auth"
          ? "precisa de login"
          : "ocioso";
  badges.append(st);

  const tail = document.createElement("div");
  tail.className = "agent-tail";
  tail.textContent = a.tail ? a.tail.trim() : a.busy ? "…" : "sem saída neste turno";

  const acts = document.createElement("div");
  acts.className = "agent-acts";
  const abrir = document.createElement("button");
  abrir.type = "button";
  abrir.className = "ghost";
  abrir.textContent = a.threadId === state.threadId ? "Em foco" : "Abrir";
  abrir.disabled = a.threadId === state.threadId;
  abrir.addEventListener("click", () => void abrirAgente(a));
  acts.append(abrir);
  if (a.busy) {
    const parar = document.createElement("button");
    parar.type = "button";
    parar.className = "ghost";
    parar.textContent = "Parar";
    parar.addEventListener("click", async () => {
      parar.disabled = true;
      try {
        await req(`/v1/threads/${a.threadId}/abort`, { method: "POST" });
      } catch {
        parar.disabled = false;
        return;
      }
      a.busy = false;
      paintAgents();
    });
    acts.append(parar);
  }

  li.append(head, badges, tail, acts);
  return li;
}

const RUN_STATUS_LABEL = { running: "rodando", done: "concluído", error: "erro", aborted: "abortado" };
const RUN_STEP_STATUS_LABEL = { pending: "esperando", running: "trabalhando", done: "concluído", error: "erro", skipped: "pulado" };

/** Painel "quem está em qual passo": puxa o Run (papel + status de cada membro) e o Time (nome/topologia). */
async function mostrarDetalhesDoRun(runId) {
  let run;
  try {
    run = await req(`/v1/runs/${runId}`);
  } catch (e) {
    appendEvent({ type: "error", message: e.message || "Não consegui ler o run." });
    return;
  }
  let time = null;
  try {
    time = await req(`/v1/teams/${run.teamId}`);
  } catch {
    // time pode ter sido apagado depois do run: segue só com o id dele
  }
  if (!state.agents.defs.length) await loadAgentDefs();
  const rows = [
    ["time", time?.name || run.teamId],
    ["topologia", time?.topology || "—"],
    ["objetivo", run.goal],
    ["status do run", RUN_STATUS_LABEL[run.status] || run.status],
  ];
  for (const s of run.steps) {
    const quem = s.papel || agentDef(s.agentId)?.name || s.agentId;
    const custo = typeof s.costUsd === "number" ? ` · US$ ${s.costUsd.toFixed(2)}` : "";
    const status = `${RUN_STEP_STATUS_LABEL[s.status] || s.status}${custo}`;
    const cls = s.status === "error" ? "bad" : s.status === "done" ? "good" : "";
    rows.push([`passo ${s.index + 1}${s.supervisor ? " (supervisor)" : ""} — ${quem}`, status, cls]);
  }
  appendEvent({ type: "panel", title: `Time · ${time?.name || run.teamId}`, rows });
}

async function abrirAgente(a) {
  if (!a.projectPath) return;
  await openThreadInRepo(a.projectPath, a.threadId);
  paintAgents();
}

async function bindProject(path) {
  rememberRepo(path);
  state.projectPath = path;
  localStorage.setItem("nexo.project", path);
  setProjectLabel();
  state.fpThreads = "";
  fileTree.limparSelecao();
  state.fileCache = null;
  $("file-preview").textContent = "Escolhe um arquivo na árvore.";
  await window.nexo.setProject?.(path);
  loadBrowser();
  loadCanvas();
  state.termBuf = "";
  if (state.term) state.term.clear();
  else $("term-out").textContent = "";
  updatePalTerm();
  await loadFileTree();
  fecharLogServico();
  svcPanel.limparPortas();
  if (state.ok) await loadThreads();
  await loadServices();
  listenServices();
}

$("btn-motor").addEventListener("click", async () => {
  const wantOn = !state.ok;
  if (wantOn) await window.nexo.startDaemon();
  else await window.nexo.stopDaemon();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 300));
    await refreshDaemon();
    if (state.ok === wantOn) break;
  }
});

$("model-select").addEventListener("change", (e) => {
  // "Outro…" do codex: abre o texto livre em vez de gravar o valor sentinela.
  if (selectedProfile()?.engine === "codex" && e.target.value === CODEX_CUSTOM_MODEL) {
    $("model-custom").classList.remove("hidden");
    $("model-custom").value = "";
    $("model-custom").focus();
    return;
  }
  $("model-custom").classList.add("hidden");
  void patchProfile({ model: e.target.value });
});

function commitModelCustom() {
  const valor = $("model-custom").value.trim();
  const p = selectedProfile();
  if (valor && valor !== (p?.model || "")) void patchProfile({ model: valor });
}
$("model-custom").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  commitModelCustom();
  e.target.blur();
});
$("model-custom").addEventListener("blur", () => commitModelCustom());

$("mode-select").addEventListener("change", (e) => {
  // codex usa sandbox (`-s`), claude usa modo de permissão (`--permission-mode`) — campos diferentes no Profile.
  if (selectedProfile()?.engine === "codex") void patchProfile({ sandboxMode: e.target.value });
  else void patchProfile({ permissionMode: e.target.value });
});

/** Passos de esforço do render atual do slider — do modelo escolhido (codex) ou fixos (claude). Ver `syncCodexControls`. */
function effortStepsAtivos() {
  const raw = $("effort-range").dataset.steps;
  if (!raw) return EFFORT_STEPS;
  try {
    const steps = JSON.parse(raw);
    return Array.isArray(steps) && steps.length ? steps : EFFORT_STEPS;
  } catch {
    return EFFORT_STEPS;
  }
}

$("effort-range").addEventListener("input", (e) => {
  const steps = effortStepsAtivos();
  const idx = Number(e.target.value) || 0;
  $("effort-label").textContent = `Esforço: ${effortLabel(steps[idx])}`;
  pintarEffortFill(e.target);
});

$("effort-range").addEventListener("change", (e) => {
  const steps = effortStepsAtivos();
  const idx = Number(e.target.value) || 0;
  void patchProfile({ effort: steps[idx] });
});

$("profile-select").addEventListener("change", () => {
  const id = $("profile-select").value;
  if (id) void switchTo(id);
});

$("btn-login").addEventListener("click", () => {
  const id = $("profile-select").value || state.profileId;
  if (id) void startLogin(id);
});

initPet();

$("meter-open").addEventListener("click", () => toggleMeter());
$("btn-meter-all").addEventListener("click", () => toggleAllAccounts());
document.addEventListener("click", (e) => {
  if (!$("meter-more").classList.contains("hidden") && !$("meter").contains(e.target)) {
    toggleMeter(false);
  }
});

$("btn-focus").addEventListener("click", () => setFocus(document.body.dataset.focus !== "1"));
$("btn-widget").addEventListener("click", () => void window.nexo.toggleWidget());

/* ---------- celular ---------- */

/**
 * Pareamento visto do desktop: pede o código, desenha o QR, e some em 2 minutos.
 *
 * **O QR carrega o endereço e o CÓDIGO — nunca o token.** Quem fotografa a tela
 * leva um código de 6 caracteres que vale 2 minutos, serve uma vez e queima em
 * 5 erros, e não uma credencial permanente. O QR só poupa a pessoa de digitar
 * `http://100.101.102.103:7432/app/` num teclado de telefone.
 *
 * O código continua visível ao lado: celular sem câmera, câmera negada e leitor
 * que não abre link são reais.
 *
 * Ele expira na tela junto com o daemon, e não só no daemon: QR velho à mostra
 * convida a escanear o que já não serve, e o erro apareceria no telefone, longe
 * de quem poderia entender.
 */
let celTimer = 0;
let celPar = null;
/** O que `GET /v1/escuta` devolveu: onde o daemon está de fato escutando. */
let celEscuta = null;

function celMostrar(par) {
  if (celTimer) clearInterval(celTimer);
  celPar = par ?? null;
  if (!par) {
    $("cel-qr").classList.add("hidden");
    $("cel-qr-img").textContent = "";
    $("btn-cel-codigo").textContent = "Gerar código";
    return;
  }
  /*
   * O endereço do QR é o que o daemon está ESCUTANDO, e o melhor deles: com
   * túnel de pé, é o do túnel, porque é o único por onde o celular chega. QR
   * com o endereço errado manda o telefone pra um lugar onde não há ninguém, e
   * ele falha calado.
   */
  const url = urlDoCelular(celEscuta?.melhor, celEscuta?.port, par.codigo);
  $("cel-qr").classList.remove("hidden");
  // innerHTML com SVG que este módulo acabou de gerar a partir de um endereço e
  // 6 caracteres — nada aqui vem de fora, e SVG inline não carrega nem executa nada
  $("cel-qr-img").innerHTML = qrSvg(url);
  const tique = () => {
    const resta = Math.max(0, Math.round((par.expiraEm - Date.now()) / 1000));
    if (!resta) return celMostrar(null);
    $("cel-codigo").textContent = par.codigo;
    $("btn-cel-codigo").textContent = `expira em ${resta}s`;
  };
  tique();
  celTimer = setInterval(tique, 1000);
}

async function celPedirCodigo() {
  try {
    // relê a escuta antes: o túnel pode ter subido desde a última pintura, e
    // gerar um QR com o endereço velho seria o pior momento pra errar
    await celPintar();
    celMostrar(await req("/v1/pair", { method: "POST" }));
  } catch (e) {
    $("cel-aviso").textContent = e.message || "Não deu pra gerar o código.";
  }
}

/**
 * Pinta o painel a partir do que o daemon está escutando AGORA.
 *
 * Não existe mais "vale a partir da próxima subida": o daemon descobre os
 * endereços sozinho e os mantém em dia enquanto roda, então isto é um relatório
 * e não um formulário.
 */
async function celPintar() {
  celEscuta = await req("/v1/escuta").catch(() => null);
  const host = celEscuta?.melhor || "127.0.0.1";
  const porta = celEscuta?.port || 7432;
  $("cel-url").textContent = urlDoCelular(host, porta);
  $("cel-alcance").textContent = celAlcance(celEscuta);
  $("cel-aviso").textContent = celAviso(celEscuta);
  if (celPar) celMostrar(celPar);
}

/** O campo avançado: só o que foi escrito à mão, que é acréscimo e não escolha única. */
function celPintarUrl(cfg) {
  const manual = cfg?.host && cfg.host !== "127.0.0.1" ? cfg.host : "";
  if ($("cel-host") !== document.activeElement) $("cel-host").value = manual;
  if (manual) $("cel-avancado").open = true;
  return celPintar();
}

$("btn-cel-codigo").addEventListener("click", () => void celPedirCodigo());

/**
 * Desconecta todos os celulares de uma vez.
 *
 * O token passou a sobreviver às subidas do daemon, então a revogação deixou de
 * acontecer por acidente a cada reinício — e sem isto, celular perdido não teria
 * solução. Confirma antes porque também derruba este app por um instante: ele
 * relê o token do disco em seguida.
 */
$("btn-cel-revogar").addEventListener("click", async () => {
  if (!confirm("Desconectar todos os celulares? Eles vão pedir um código novo.")) return;
  try {
    await req("/v1/token/rotate", { method: "POST" });
  } catch {
    /* a própria rotação derruba a resposta às vezes; o que vale é reler abaixo */
  }
  await renovarCredenciais();
  celMostrar(null);
  await celPintar();
  $("cel-aviso").textContent = "Pronto: os celulares foram desconectados.";
});

$("cel-host").addEventListener("change", async () => {
  try {
    const valor = $("cel-host").value.trim();
    await celPintarUrl(await req("/v1/config", { method: "PUT", body: JSON.stringify({ host: valor || "127.0.0.1" }) }));
  } catch (e) {
    $("cel-aviso").textContent = e.message || "Endereço inválido.";
  }
});
$("btn-focus-exit").addEventListener("click", () => setFocus(false));
$("btn-file-preview").addEventListener("click", () => setFilePreview($("file-split").dataset.preview === "0"));
$("btn-browser-retry").addEventListener("click", reiniciarBrowser);
$("btn-browser-reload").addEventListener("click", reiniciarBrowser);
$("btn-browser-hard-reload").addEventListener("click", () => void reiniciarBrowserSemCache());

/*
 * did-fail-load do subframe: pega o que a sonda não vê — servidor que responde
 * por HTTP mas recusa ser embutido (X-Frame-Options / frame-ancestors).
 */
window.nexo.onFrameFail?.(({ code, desc, url }) => {
  if (state.view !== "browser") return;
  const bloqueio = code === -30 || /BLOCKED_BY_RESPONSE|X_FRAME/i.test(desc || "");
  mostrarFalhaBrowser({
    msg: bloqueio
      ? "O servidor respondeu, mas proíbe ser embutido (X-Frame-Options)."
      : `O preview não carregou (${desc || code}).`,
    hint: url,
    url,
    externo: bloqueio,
  });
});

$("btn-svc-create").addEventListener("click", async () => {
  if (!state.threadId) {
    appendEvent({ type: "error", message: "Abre uma conversa primeiro — quem escreve o arquivo é o agente." });
    return;
  }
  state.view = "none";
  applyWorkLayout();
  await sendChatMessage(
    "Crie um nexo.json na raiz deste projeto declarando os serviços locais dele " +
      "(front, backend, worker — o que existir). Formato: " +
      '{ "services": [ { "id": "web", "name": "Frontend", "cmd": "npm run dev", "cwd": ".", ' +
      '"url": "http://localhost:5173", "autostart": true } ] }. ' +
      "Descubra os comandos e portas reais lendo package.json, README, docker-compose e o código do backend. " +
      "cwd é relativo à raiz e não pode escapar dela.",
  );
});

$("btn-svc-refresh").addEventListener("click", () => void loadServices());
$("btn-svc-log-close").addEventListener("click", fecharLogServico);
$("btn-svc-trust").addEventListener("click", () => void svcPanel.confiar());
$("btn-close-file").addEventListener("click", closeModule);
$("btn-close-terminal").addEventListener("click", closeModule);
$("btn-close-browser").addEventListener("click", closeModule);
$("btn-close-canvas").addEventListener("click", closeModule);

dragSplitter("split-side", (x, fim) => applySideWidth(x, fim));
dragSplitter("split-chat", (x, fim) => applyChatWidth(window.innerWidth - x, fim));

applySideWidth(Number(lsGet("nexo.sideW", "252")) || 252, false);
applyChatWidth(Number(lsGet("nexo.chatW", "380")) || 380, false);
setFocus(lsGet("nexo.focus", "0") === "1", false);
setFilePreview(lsGet("nexo.filePreview", "1") !== "0", false);

try {
  if (localStorage.getItem("nexo.meterOpen") === "1") toggleMeter(true);
} catch {
  /* localStorage pode estar bloqueado */
}

$("btn-login-close").addEventListener("click", () => closeLoginModal());

$("btn-login-open").addEventListener("click", () => {
  const url = $("login-url").value.trim();
  if (url) void window.nexo.openExternal(url).catch((e) => loginMsg(e.message || "Não abriu o navegador."));
});

$("btn-login-submit").addEventListener("click", () => void submitLoginCode());

$("login-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void submitLoginCode();
  }
});

$("btn-login-terminal").addEventListener("click", () => {
  const id = state.login.profileId || $("profile-select").value;
  closeLoginModal();
  if (id) void startLoginTerminal(id);
});

$("btn-import-login").addEventListener("click", () => {
  const id = $("profile-select").value || state.profileId;
  if (id) void importClaudeLogin(id);
});

$("btn-folder").addEventListener("click", async () => {
  const path = await window.nexo.pickFolder();
  if (!path) return;
  await bindProject(path);
});

$("crumb-repo").addEventListener("click", () => {
  const found = state.threadId ? threadStub(state.threadId) : null;
  revealRepo(found?.path || state.projectPath);
});

$("btn-new").addEventListener("click", async () => {
  if (!state.ok) return;
  if (!state.projectPath) {
    appendEvent({ type: "sys", message: "Abre um repositório com + na barra esquerda." });
    return;
  }
  const profileId = state.profileId || state.profiles.find((p) => p.status === "ready")?.id;
  if (!profileId) {
    appendEvent({ type: "error", message: "Nenhuma conta pronta. Configurações → Nova conta." });
    state.sideChat = true;
    applyWorkLayout();
    setComposer(true);
    return;
  }
  const t = await req("/v1/threads", {
    method: "POST",
    body: JSON.stringify({ projectPath: state.projectPath, profileId }),
  });
  await openThread(t.id);
});

/**
 * Comandos do chat, agrupados por função pro menu de "/". Não é 1:1 com o
 * Claude Code: fora ficam comandos de config global do CLI (/mcp, /hooks,
 * /statusline, /agents, /vim, /ide…) e de sessão interativa persistente
 * (/rewind, /resume, /doctor…) — o Nexo spawna o motor sem sessão contínua
 * e já tem painel próprio de Configurações pra isso.
 */
const SLASH_GROUPS = ["Conta", "Sessão", "Tarefas", "Skills", "Ajuda"];
const SLASH_COMMANDS = [
  { cmd: "account", args: "[id]", group: "Conta", desc: "Painel da conta em uso (ou de uma conta específica)" },
  { cmd: "accounts", args: "", group: "Conta", desc: "Todas as contas com status de login" },
  { cmd: "switch", args: "<id>", group: "Conta", desc: "Troca a conta desta conversa" },
  { cmd: "login", args: "[id]", group: "Conta", desc: "Abre o login da conta no terminal" },
  { cmd: "cost", args: "", group: "Sessão", desc: "Tokens e custo acumulado desta conversa" },
  { cmd: "context", args: "", group: "Sessão", desc: "Quanto da janela de contexto o último turno ocupou" },
  { cmd: "usage", args: "", group: "Sessão", desc: "Cota do plano (5 horas e semana)" },
  { cmd: "export", args: "", group: "Sessão", desc: "Baixa esta conversa em markdown" },
  { cmd: "clear", args: "", group: "Sessão", desc: "Limpa contexto e tela (o histórico continua salvo)" },
  { cmd: "init", args: "", group: "Tarefas", desc: "Pede ao agente pra criar/atualizar o CLAUDE.md do projeto" },
  { cmd: "review", args: "", group: "Tarefas", desc: "Pede revisão do diff atual" },
  { cmd: "security-review", args: "", group: "Tarefas", desc: "Pede revisão de segurança do diff atual" },
  { cmd: "help", args: "", group: "Ajuda", desc: "Esta lista" },
];
const SLASH_HELP = SLASH_COMMANDS.map((c) => [`/${c.cmd}${c.args ? ` ${c.args}` : ""}`, c.desc]);

/** Comandos de tarefa: só compõem a mensagem e mandam pelo caminho normal do chat. */
const PRESET_PROMPTS = {
  init: "Analise este projeto e crie ou atualize o arquivo CLAUDE.md na raiz com: visão geral, comandos de build/test/lint, arquitetura e convenções importantes pra quem for editar este código.",
  review: "Revise o diff atual (git diff) deste projeto. Aponte bugs, riscos e problemas de simplificação/eficiência antes de eu commitar.",
  "security-review": "Faça uma revisão de segurança do diff atual (git diff) deste projeto: procure segredo exposto, injeção, autenticação/autorização quebrada e configuração insegura.",
};

/** Chave de cache das skills: refaz a varredura só quando pasta ou conta muda. */
function skillsKey() {
  return `${state.projectPath}|${state.profileId}`;
}

/** Varre `.claude/skills` do projeto e do perfil ativo via daemon. Cacheado por skillsKey(). */
async function loadSkills() {
  const key = skillsKey();
  if (state.skills.loading || state.skills.key === key) return;
  state.skills.loading = true;
  try {
    const qs = new URLSearchParams();
    if (state.projectPath) qs.set("projectPath", state.projectPath);
    if (state.profileId) qs.set("profileId", state.profileId);
    state.skills.list = await req(`/v1/skills?${qs}`);
    state.skills.key = key;
  } catch {
    state.skills.list = [];
  } finally {
    state.skills.loading = false;
  }
}

/** Dispara a varredura se a pasta/conta mudou desde a última vez; re-renderiza o menu ao chegar. */
function ensureSkillsLoaded() {
  if (state.skills.key === skillsKey() || state.skills.loading) return;
  void loadSkills().then(() => {
    if (state.slash.open) openSlashMenuIfNeeded();
  });
}

function slashMatches(fragment) {
  const f = fragment.toLowerCase();
  const built = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(f));
  const skills = state.skills.list
    .filter((s) => s.name.toLowerCase().startsWith(f))
    .map((s) => ({ cmd: s.name, args: "", group: "Skills", desc: s.description || "(sem descrição)" }));
  return [...built, ...skills];
}

/** Carrega agentes/times uma vez por sessão pro autocomplete do "@" — mesma fonte do painel. */
function ensureMencoesLoaded() {
  if (state.mencoes.loaded || state.mencoes.loading) return;
  state.mencoes.loading = true;
  Promise.all([state.agents.defs.length ? null : loadAgentDefs(), loadTeams()]).finally(() => {
    state.mencoes.loading = false;
    state.mencoes.loaded = true;
    if (state.slash.open) openSlashMenuIfNeeded();
  });
}

function mencaoMatches(fragment) {
  const f = fragment.toLowerCase();
  const agentes = state.agents.defs
    .filter((a) => a.id.toLowerCase().startsWith(f))
    .map((a) => ({ cmd: a.id, args: "", group: "Agentes", desc: a.name }));
  const times = state.teams
    .filter((t) => t.id.toLowerCase().startsWith(f))
    .map((t) => ({ cmd: t.id, args: "", group: "Times", desc: t.name }));
  return [...agentes, ...times];
}

function closeSlashMenu() {
  if (!state.slash.open) return;
  state.slash.open = false;
  $("slash-menu").classList.add("hidden");
}

function applySlashSelection(idx) {
  const item = state.slash.matches[idx];
  if (!item) return;
  const el = $("input");
  if (state.slash.kind === "mencao") {
    /*
     * Recalcula a posição do token AGORA, no clique — não usa o que foi gravado quando o
     * menu abriu. Mover o cursor (clique, setas) sem digitar nada não dispara "input", então
     * o valor salvo ficaria apontando pro lugar errado do texto: substituiria um trecho que
     * não é mais o "@fragmento" atual, corrompendo a mensagem.
     */
    const gat = detectarGatilho();
    if (gat?.kind !== "mencao") {
      closeSlashMenu();
      return;
    }
    const antes = el.value.slice(0, gat.tokenStart);
    const depois = el.value.slice(gat.tokenEnd);
    const inserido = `@${item.cmd} `;
    el.value = antes + inserido + depois;
    closeSlashMenu();
    el.focus();
    const pos = antes.length + inserido.length;
    el.setSelectionRange(pos, pos);
    return;
  }
  el.value = `/${item.cmd}${item.args ? " " : ""}`;
  closeSlashMenu();
  el.focus();
}

function renderSlashMenu() {
  const menu = $("slash-menu");
  const matches = state.slash.matches;
  const mencao = state.slash.kind === "mencao";
  menu.setAttribute("aria-label", mencao ? "Agentes e times" : "Comandos");
  if (!matches.length) {
    menu.innerHTML = `<p class="slash-empty">${mencao ? "Nenhum agente ou time bate com isso." : "Nenhum comando bate com isso."}</p>`;
    return;
  }
  let html = "";
  for (const group of mencao ? ["Agentes", "Times"] : SLASH_GROUPS) {
    const items = matches.filter((m) => m.group === group);
    if (!items.length) continue;
    html += `<div class="slash-group"><h4>${escapeHtml(group)}</h4><ul>`;
    for (const item of items) {
      const idx = matches.indexOf(item);
      html += `<li class="slash-item" data-idx="${idx}" data-on="${idx === state.slash.index ? "1" : "0"}">
        <span class="cmd">${mencao ? "@" : "/"}${escapeHtml(item.cmd)}${item.args ? ` ${escapeHtml(item.args)}` : ""}</span>
        <span class="desc">${escapeHtml(item.desc)}</span>
      </li>`;
    }
    html += `</ul></div>`;
  }
  menu.innerHTML = html;
  for (const el of menu.querySelectorAll(".slash-item")) {
    // preventDefault: sem isso o mousedown tira o foco do textarea antes do click chegar.
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applySlashSelection(Number(el.dataset.idx));
    });
  }
}

/**
 * O que o cursor está tentando completar agora: "/comando" só quando é a mensagem inteira
 * (regra original, preservada), ou "@agente"/"@time" em qualquer ponto do texto — desde que
 * ainda não tenha espaço depois do @, senão já é outra palavra.
 */
function detectarGatilho() {
  const el = $("input");
  const value = el.value;
  const cursor = el.selectionStart ?? value.length;
  const cmd = /^\/([a-z-]*)$/i.exec(value);
  if (cmd) return { kind: "cmd", fragment: cmd[1].toLowerCase(), tokenStart: 0, tokenEnd: value.length };
  const antes = value.slice(0, cursor);
  const at = /(?:^|\s)@([a-z0-9_-]{0,40})$/i.exec(antes);
  if (!at) return null;
  return {
    kind: "mencao",
    fragment: at[1].toLowerCase(),
    tokenStart: antes.length - at[1].length - 1,
    tokenEnd: cursor,
  };
}

function openSlashMenuIfNeeded() {
  const gat = detectarGatilho();
  if (!gat) {
    closeSlashMenu();
    return;
  }
  state.slash.kind = gat.kind;
  let matches;
  if (gat.kind === "cmd") {
    ensureSkillsLoaded();
    matches = slashMatches(gat.fragment);
    // Fragmento já bate exato com um comando (ex: "/clear"): nada mais a completar,
    // fecha o menu pra o Enter seguir pro envio normal em vez de só fechar o dropdown.
    if (matches.some((c) => c.cmd.toLowerCase() === gat.fragment)) {
      closeSlashMenu();
      return;
    }
  } else {
    ensureMencoesLoaded();
    matches = mencaoMatches(gat.fragment);
  }
  state.slash.matches = matches;
  state.slash.index = 0;
  state.slash.open = true;
  $("slash-menu").classList.remove("hidden");
  renderSlashMenu();
}

function accountRows(a) {
  const credOk = a.credential === "live";
  const rows = [
    ["conta", a.id],
    ["motor", a.engine],
    ["login", a.status === "ready" ? "logada" : "sem login", a.status === "ready" ? "good" : "bad"],
    ["credencial", a.credential, credOk ? "good" : "bad"],
  ];
  if (a.email) rows.push(["e-mail", a.email]);
  if (a.fullName) rows.push(["nome", a.fullName]);
  if (a.organization) rows.push(["organização", a.organization]);
  if (a.seatTier) rows.push(["assento", a.seatTier]);
  if (a.subscription) rows.push(["plano", a.subscription]);
  if (a.rateLimitTier) rows.push(["tier de limite", a.rateLimitTier]);
  if (a.provider) rows.push(["provider", a.provider]);
  rows.push(["modelo", a.model || "padrão do CLI"]);
  if (a.engine === "claude") rows.push(["esforço", a.effort || "padrão do CLI"]);
  if (a.engine === "claude") {
    const mi = Math.max(0, MODE_VALUES.indexOf(a.permissionMode || ""));
    rows.push(["modo", a.permissionMode ? MODE_NAMES[mi] : "padrão do CLI"]);
  }
  if (a.expiresAt) rows.push(["token expira", fmtWhen(a.expiresAt), Date.parse(a.expiresAt) > Date.now() ? "" : "bad"]);
  if (a.refreshExpiresAt) rows.push(["refresh expira", fmtWhen(a.refreshExpiresAt)]);
  if (a.authFailedAt) rows.push(["recusado em", fmtWhen(a.authFailedAt), "bad"]);
  if (a.cli) {
    rows.push([
      "CLI diz",
      a.cli.loggedIn ? `logada${a.cli.email ? ` como ${a.cli.email}` : ""}` : "não logada",
      a.cli.loggedIn ? "good" : "bad",
    ]);
  }
  if (a.configDir) rows.push(["pasta", a.configDir]);
  return rows;
}


async function runSlash(text) {
  const [raw, ...rest] = text.slice(1).split(/\s+/);
  const cmd = (raw || "").toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "help" || cmd === "?") {
    appendEvent({ type: "panel", title: "Comandos", rows: SLASH_HELP });
    return;
  }
  if (cmd === "clear") {
    if (state.threadId) {
      try {
        await req(`/v1/threads/${state.threadId}/clear`, { method: "POST", body: "{}" });
      } catch (err) {
        appendEvent({ type: "error", message: err.message || "Não consegui limpar o contexto." });
        return;
      }
    }
    for (const url of state.logShotUrls) URL.revokeObjectURL(url);
    state.logShotUrls = [];
    state.events = [];
    $("log").innerHTML = "";
    appendEvent({ type: "sys", message: "Contexto limpo — a próxima mensagem começa do zero (o histórico anterior continua salvo)." });
    return;
  }
  if (cmd === "login") {
    const id = arg || $("profile-select").value || state.profileId;
    if (!id) {
      appendEvent({ type: "error", message: "Cria uma conta em Configurações primeiro." });
      $("settings").classList.remove("hidden");
      return;
    }
    void startLogin(id);
    return;
  }
  if (cmd === "switch") {
    if (!arg) {
      appendEvent({ type: "error", message: "uso: /switch <id>. Vê os ids com /accounts." });
      return;
    }
    await switchTo(arg);
    return;
  }
  if (cmd === "account" || cmd === "conta") {
    const id = arg || state.profileId || $("profile-select").value;
    if (!id) {
      appendEvent({ type: "error", message: "Nenhuma conta selecionada." });
      return;
    }
    try {
      const a = await req(`/v1/accounts/${encodeURIComponent(id)}?live=1`);
      appendEvent({ type: "panel", title: `Conta em uso · ${a.id}`, rows: accountRows(a) });
    } catch (err) {
      appendEvent({ type: "error", message: err.message || "Não consegui ler a conta." });
    }
    return;
  }
  if (cmd === "accounts" || cmd === "contas" || cmd === "profiles") {
    try {
      const list = await req("/v1/accounts");
      const rows = list.map((a) => [
        a.id === state.profileId ? `${a.id} (em uso)` : a.id,
        [a.engine, a.status === "ready" ? "logada" : "sem login", a.email || ""].filter(Boolean).join(" · "),
        a.status === "ready" ? "good" : "bad",
      ]);
      appendEvent({ type: "panel", title: "Contas", rows: rows.length ? rows : [["—", "nenhuma conta"]] });
    } catch (err) {
      appendEvent({ type: "error", message: err.message || "Não consegui listar as contas." });
    }
    return;
  }
  if (cmd === "cost" || cmd === "context" || cmd === "usage") {
    await slashUsage(cmd);
    return;
  }
  if (cmd === "export") {
    await slashExport();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(PRESET_PROMPTS, cmd)) {
    if (!state.threadId) {
      appendEvent({ type: "error", message: "Abre uma conversa primeiro." });
      return;
    }
    await sendChatMessage(PRESET_PROMPTS[cmd]);
    return;
  }
  // Skill descoberta em `.claude/skills` (projeto ou perfil): manda "/nome ..." como
  // mensagem normal — quem invoca a skill via ferramenta Skill é o motor, não o Nexo.
  // Recarrega se ainda não tiver rodado pra esta pasta/conta (ex: comando digitado
  // e enviado rápido demais pro menu ter disparado a varredura antes).
  await loadSkills();
  if (state.skills.list.some((s) => s.name.toLowerCase() === cmd)) {
    if (!state.threadId) {
      appendEvent({ type: "error", message: "Abre uma conversa primeiro." });
      return;
    }
    await sendChatMessage(text);
    return;
  }
  appendEvent({
    type: "panel",
    title: `Comando desconhecido: /${cmd}`,
    rows: SLASH_HELP,
  });
}

/** `/cost`, `/context`, `/usage`: só lê o que o daemon já sabe, nunca gasta turno. */
async function slashUsage(kind) {
  if (!state.threadId) {
    appendEvent({ type: "error", message: "Abre uma conversa primeiro." });
    return;
  }
  let data;
  try {
    data = await req(`/v1/threads/${state.threadId}/usage`);
  } catch (err) {
    appendEvent({ type: "error", message: err.message || "Não consegui ler o uso." });
    return;
  }
  const t = data.totals;
  if (kind === "cost") {
    if (!t || !t.turns) {
      appendEvent({ type: "panel", title: "Custo", rows: [["turnos", "sem turno nesta conversa ainda"]] });
      return;
    }
    const total = t.input + t.output + t.cacheRead + t.cacheCreate;
    const rows = [
      ["turnos", String(t.turns)],
      ["entrada", fmtTokens(t.input)],
      ["saída", fmtTokens(t.output)],
      ["cache lido", fmtTokens(t.cacheRead)],
      ["cache criado", fmtTokens(t.cacheCreate)],
    ];
    if (t.thinking) rows.push(["raciocínio", fmtTokens(t.thinking)]);
    rows.push(["total", fmtTokens(total)]);
    rows.push(["custo", t.costUsd ? `US$ ${t.costUsd.toFixed(4)}` : "— (motor não reporta)"]);
    appendEvent({ type: "panel", title: "Custo da conversa", rows });
    return;
  }
  if (kind === "context") {
    const win = data.session?.contextWindow || 200_000;
    const used = t?.contextTokens || 0;
    const pct = win ? Math.min(1, used / win) : 0;
    const rows = [
      ["modelo", data.session?.model || t?.model || "(padrão do CLI)"],
      ["janela", fmtTokens(win)],
      ["em uso", used ? `${fmtTokens(used)} (${Math.round(pct * 100)}%)` : "— (sem turno ainda)"],
    ];
    appendEvent({ type: "panel", title: "Janela de contexto", rows });
    return;
  }
  const l = data.limits;
  const rows = [];
  if (!l || (!l.fiveHour && !l.sevenDay)) {
    rows.push(["cota", "sem dado ainda — o motor só reporta depois de um turno"]);
  } else {
    rows.push([
      "5 h",
      l.fiveHour ? `${Math.round(l.fiveHour.utilization * 100)}% · ${fmtReset(l.fiveHour.resetsAt) || "—"}` : "sem dado ainda",
    ]);
    rows.push([
      "semana",
      l.sevenDay ? `${Math.round(l.sevenDay.utilization * 100)}% · ${fmtReset(l.sevenDay.resetsAt) || "—"}` : "sem dado ainda",
    ]);
    if (l.status) rows.push(["status", l.status]);
  }
  appendEvent({ type: "panel", title: "Cota do plano", rows });
}

function threadToMarkdown(events) {
  const lines = [];
  for (const e of events) {
    if (e.type === "user") lines.push(`**Você:** ${e.text}`, "");
    else if (e.type === "assistant") lines.push(`**Conta:** ${e.text}`, "");
    else if (e.type === "tool") lines.push(`_Ferramenta: ${e.name} — ${e.summary}_`, "");
    else if (e.type === "switched") lines.push(`_Trocou ${e.fromProfileId} → ${e.toProfileId}_`, "");
    else if (e.type === "error") lines.push(`_Erro: ${e.message}_`, "");
  }
  return lines.join("\n");
}

/** `/export`: salva a conversa em markdown via diálogo nativo do Electron. */
async function slashExport() {
  if (!state.threadId) {
    appendEvent({ type: "error", message: "Abre uma conversa primeiro." });
    return;
  }
  let events;
  try {
    events = await req(`/v1/threads/${state.threadId}`);
  } catch (err) {
    appendEvent({ type: "error", message: err.message || "Não consegui ler a conversa." });
    return;
  }
  const md = `# Conversa ${state.threadId}\n\n${threadToMarkdown(events)}`;
  const res = await window.nexo.saveFile(`nexo-${state.threadId}.md`, md);
  if (res?.ok) appendEvent({ type: "sys", message: `Exportado: ${res.path}` });
}

/* ---------- fila de mensagens ---------- */

function filaDa(threadId = state.threadId) {
  if (!threadId) return [];
  state.queue[threadId] = state.queue[threadId] ?? [];
  return state.queue[threadId];
}

function paintQueue() {
  const strip = $("queue-strip");
  const fila = filaDa();
  strip.classList.toggle("hidden", fila.length === 0);
  strip.replaceChildren();
  if (!fila.length) return;

  const head = document.createElement("span");
  head.className = "queue-head";
  head.textContent = state.queuePaused
    ? `${fila.length} na fila · pausada`
    : `${fila.length} na fila · envia quando terminar`;
  strip.append(head);

  fila.forEach((item, i) => {
    const chip = document.createElement("span");
    chip.className = "queue-chip";
    const txt = document.createElement("span");
    txt.className = "queue-text";
    txt.textContent = item.text || `(${item.images.length} imagem(ns))`;
    txt.title = item.text;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "queue-x";
    x.title = "Tirar da fila";
    x.textContent = "×";
    x.addEventListener("click", () => {
      for (const img of item.images) URL.revokeObjectURL(img.url);
      fila.splice(i, 1);
      paintQueue();
    });
    chip.append(txt, x);
    strip.append(chip);
  });

  if (state.queuePaused) {
    const retomar = document.createElement("button");
    retomar.type = "button";
    retomar.className = "ghost queue-resume";
    retomar.textContent = "Retomar";
    retomar.addEventListener("click", () => {
      state.queuePaused = false;
      paintQueue();
      void enviarProximoDaFila();
    });
    strip.append(retomar);
  }
}

/** Guarda o texto e as imagens que estavam no composer, sem mandar ainda. */
function enfileirar(text, images) {
  filaDa().push({ text, images });
  paintQueue();
}

/**
 * Manda o próximo da fila. Só é chamado depois de um turno que terminou bem:
 * em quota/login/erro a fila fica parada, senão a próxima mensagem cairia na
 * mesma parede sem ninguém ver.
 */
async function enviarProximoDaFila() {
  if (state.queuePaused || state.talking) return;
  const fila = filaDa();
  const item = fila.shift();
  paintQueue();
  if (!item) return;
  await sendChatMessage(item.text, item.images);
}

/**
 * `@menção` na mensagem dispara um Run de verdade em paralelo ao turno de chat — não muda o
 * texto que vai pro modelo, só roda ao lado (mesmo `POST /v1/runs` que o Team Studio já usa).
 *
 * Time citado direto usa o id dele; agente avulso vira (ou reusa) um time-pipeline-de-1 oculto
 * via `/v1/teams/mencao/:agentId` (ver `teams.ts`). Cada menção é o seu próprio Run: erro numa
 * não impede as outras nem desfaz o turno de chat, que já foi decidido e mandado à parte.
 */
async function dispararMencoes(texto) {
  const { ids, goal } = extrairMencoes(texto);
  if (!ids.length) return;
  const projectPath = state.projectPath;
  if (!state.agents.defs.length) await loadAgentDefs();
  await loadTeams();
  for (const id of ids) {
    const time = state.teams.find((t) => t.id === id);
    const agente = time ? null : state.agents.defs.find((a) => a.id === id);
    if (!time && !agente) {
      appendEvent({ type: "sys", message: `@${id} — não achei agente nem time com esse nome.` });
      continue;
    }
    try {
      const teamId = time ? time.id : (await req(`/v1/teams/mencao/${encodeURIComponent(id)}`, { method: "POST" })).id;
      const run = await req("/v1/runs", { method: "POST", body: JSON.stringify({ teamId, projectPath, goal }) });
      appendEvent({ type: "sys", message: `→ Run disparado: ${time?.name ?? agente.name} (${run.id})` });
    } catch (err) {
      appendEvent({ type: "sys", message: `@${id} — run não disparou: ${err.message || "erro"}` });
    }
  }
}

/** Caminho real de envio: usado tanto pelo composer quanto pelos comandos de tarefa (/init, /review…). */
async function sendChatMessage(text, pendentes = null) {
  if (!state.threadId) return;
  // Ocupado não descarta: enfileira. Antes a mensagem sumia sem aviso nenhum.
  if (state.talking) {
    enfileirar(text, pendentes ?? takePending());
    return;
  }
  if (needsLogin()) {
    appendEvent({ type: "error", message: `${selectedProfile().id} ainda sem login. Clica o botão Login — a janela preta do Windows, não este chat.` });
    return;
  }
  // da fila vêm itens já tirados do composer; do composer, pega os de agora
  const itens = pendentes ?? takePending();
  let images = [];
  try {
    images = await encodeImages(itens);
  } catch (err) {
    appendEvent({ type: "error", message: err.message || "Não consegui ler a imagem." });
    return;
  }
  const previews = itens.map((item) => ({ url: item.url, name: item.name }));
  appendEvent({ type: "user", text, previews });
  void dispararMencoes(text);
  try {
    await req(`/v1/threads/${state.threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, ...(images.length ? { images } : {}) }),
    });
  } catch (err) {
    appendEvent({ type: "error", message: err.message || "Falha ao enviar." });
  }
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  closeSlashMenu();
  const text = $("input").value.trim();
  if (!text && state.pendingImages.length === 0) return;
  if (text.startsWith("/")) {
    $("input").value = "";
    await runSlash(text);
    return;
  }
  $("input").value = "";
  if (state.talking) {
    enfileirar(text, takePending());
    return;
  }
  await sendChatMessage(text);
});

/**
 * Ctrl+V com imagem na área de transferência: anexa em vez de colar caminho nenhum.
 * Escuta no documento porque o foco raramente está no campo — mas cala a boca
 * enquanto um modal está aberto, senão a paleta rouba a colagem do chat.
 */
document.addEventListener("paste", (e) => {
  if (state.paletteOpen) return;
  if (!$("settings").classList.contains("hidden")) return;
  if (!$("login-modal").classList.contains("hidden")) return;
  const files = [...(e.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile());
  if (files.length === 0) return;
  e.preventDefault();
  addImages(files);
});

for (const evt of ["dragover", "dragenter"]) {
  $("composer").addEventListener(evt, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    $("composer").classList.add("dropping");
  });
}

for (const evt of ["dragleave", "drop"]) {
  $("composer").addEventListener(evt, () => $("composer").classList.remove("dropping"));
}

$("composer").addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  e.preventDefault();
  addImages(files);
});

$("btn-attach").addEventListener("click", () => $("attach-input").click());

$("attach-input").addEventListener("change", (e) => {
  addImages([...e.target.files]);
  e.target.value = "";
});

async function abortTalk() {
  if (!state.threadId || !state.talking) return;
  try {
    await req(`/v1/threads/${state.threadId}/abort`, { method: "POST", body: "{}" });
  } catch (e) {
    appendEvent({ type: "error", message: e.message || "Não parou." });
    return;
  }
  appendEvent({ type: "sys", message: "Parou." });
}

$("btn-abort").addEventListener("click", () => void abortTalk());

$("input").addEventListener("input", openSlashMenuIfNeeded);

$("input").addEventListener("keydown", (e) => {
  if (state.slash.open) {
    const n = state.slash.matches.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (n) state.slash.index = (state.slash.index + 1) % n;
      renderSlashMenu();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) state.slash.index = (state.slash.index - 1 + n) % n;
      renderSlashMenu();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && n) {
      e.preventDefault();
      applySlashSelection(state.slash.index);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSlashMenu();
      return;
    }
  }
  if (e.key === "Escape" && state.talking) {
    e.preventDefault();
    void abortTalk();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("toast-yes").addEventListener("click", async () => {
  const id = state.pendingQuota;
  const reason = $("toast-yes").dataset.reason === "user" ? "user" : "quota";
  $("toast").classList.add("hidden");
  $("toast-yes").dataset.reason = "";
  if (!id || !state.threadId) return;
  await doSwitch(id, reason);
});

$("toast-no").addEventListener("click", () => {
  $("toast").classList.add("hidden");
  state.pendingQuota = null;
  $("toast-yes").dataset.reason = "";
});

async function renderFallback() {
  const ul = $("fallback-list");
  if (!ul || !state.ok) return;
  let cfg;
  try {
    cfg = await req("/v1/config");
  } catch {
    return;
  }
  $("switch-mode").value = cfg.switchMode || "manual";
  const ids = [...(cfg.fallbackOrder || [])];
  for (const p of state.profiles) {
    if (!ids.includes(p.id)) ids.push(p.id);
  }
  ul.replaceChildren();
  if (!ids.length) {
    const empty = document.createElement("li");
    empty.textContent = "Nenhuma conta ainda.";
    ul.append(empty);
    return;
  }
  ids.forEach((id, i) => {
    const p = state.profiles.find((x) => x.id === id);
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = p ? `${id} · ${p.engine}${p.status === "ready" ? "" : " · login"}` : id;
    const up = document.createElement("button");
    up.type = "button";
    up.className = "ghost";
    up.textContent = "↑";
    up.disabled = i === 0;
    up.dataset.move = "-1";
    up.dataset.id = id;
    const down = document.createElement("button");
    down.type = "button";
    down.className = "ghost";
    down.textContent = "↓";
    down.disabled = i === ids.length - 1;
    down.dataset.move = "1";
    down.dataset.id = id;
    li.append(label, up, down);
    ul.append(li);
  });
  ul.dataset.order = JSON.stringify(ids);
}

async function renderMemoria() {
  if (!state.ok) return;
  let cfg;
  try {
    cfg = await req("/v1/config");
  } catch {
    return;
  }
  $("mem-dir").value = cfg.memoriaDir || "";
  $("graph-dir").value = cfg.graphDir || "";
}

async function salvarMemoriaDir(path) {
  $("mem-dir").value = path;
  $("mem-dir-err").textContent = "";
  try {
    await req("/v1/config", { method: "PUT", body: JSON.stringify({ memoriaDir: path.trim() }) });
  } catch (err) {
    $("mem-dir-err").textContent = err.message || "Não gravou.";
  }
}

$("mem-dir").addEventListener("change", (e) => void salvarMemoriaDir(e.target.value.trim()));
$("btn-mem-dir-pick").addEventListener("click", async () => {
  const path = await window.nexo.pickFolder();
  if (path) void salvarMemoriaDir(path);
});

async function salvarGraphDir(path) {
  $("graph-dir").value = path;
  $("graph-dir-err").textContent = "";
  try {
    await req("/v1/config", { method: "PUT", body: JSON.stringify({ graphDir: path.trim() }) });
  } catch (err) {
    $("graph-dir-err").textContent = err.message || "Não gravou.";
  }
}

$("graph-dir").addEventListener("change", (e) => void salvarGraphDir(e.target.value.trim()));
$("btn-graph-dir-pick").addEventListener("click", async () => {
  const path = await window.nexo.pickFolder();
  if (path) void salvarGraphDir(path);
});

async function renderModulos() {
  if (!state.ok) return;
  let cfg;
  try {
    cfg = await req("/v1/config");
  } catch {
    return;
  }
  $("mod-rtk").checked = Boolean(cfg.modulos?.rtk);
  $("mod-caveman").checked = Boolean(cfg.modulos?.caveman);
  $("mod-caveman-nivel").value = cfg.modulos?.cavemanNivel || "full";
}

/** Erro: volta os campos pro que já estava salvo (via `renderModulos`), em vez de mentir na tela. */
async function salvarModulo(nome, valor, errId) {
  $(errId).textContent = "";
  try {
    await req("/v1/config", { method: "PUT", body: JSON.stringify({ modulos: { [nome]: valor } }) });
  } catch (err) {
    $(errId).textContent = err.message || "Não gravou.";
    await renderModulos();
  }
}

$("mod-rtk").addEventListener("change", (e) => void salvarModulo("rtk", e.target.checked, "mod-rtk-err"));
$("mod-caveman").addEventListener("change", (e) => void salvarModulo("caveman", e.target.checked, "mod-caveman-err"));
$("mod-caveman-nivel").addEventListener("change", (e) =>
  void salvarModulo("cavemanNivel", e.target.value, "mod-caveman-err"),
);

$("switch-mode").addEventListener("change", async (e) => {
  const mode = e.target.value;
  $("switch-mode-err").textContent = "";
  try {
    await req("/v1/config", { method: "PUT", body: JSON.stringify({ switchMode: mode }) });
  } catch (err) {
    $("switch-mode-err").textContent = err.message || "Não gravou o modo de troca.";
    await renderFallback();
  }
});

$("fallback-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const ids = JSON.parse($("fallback-list").dataset.order || "[]");
  const i = ids.indexOf(btn.dataset.id);
  const j = i + Number(btn.dataset.move);
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await req("/v1/config", { method: "PUT", body: JSON.stringify({ fallbackOrder: ids }) });
    await renderFallback();
  } catch (err) {
    $("profile-add-err").textContent = err.message || "Não gravou a ordem.";
  }
});

/** Nav e busca das Configurações: painel por vez, busca varre todos. */
function showSetPanel(id) {
  state.setPanel = id;
  for (const b of document.querySelectorAll(".set-nav-item")) b.dataset.on = b.dataset.panel === id ? "1" : "0";
  for (const sec of document.querySelectorAll(".set-sec")) sec.classList.toggle("hidden", sec.dataset.panel !== id);
  $("set-scroll").scrollTop = 0;
}

function filterSettings() {
  const q = $("set-q").value.trim().toLowerCase();
  if (!q) {
    for (const row of document.querySelectorAll(".set-row")) row.dataset.hit = "1";
    $("set-empty").classList.add("hidden");
    showSetPanel(state.setPanel);
    return;
  }
  let any = false;
  for (const sec of document.querySelectorAll(".set-sec")) {
    const title = sec.querySelector("h3")?.textContent || "";
    let hits = 0;
    for (const row of sec.querySelectorAll(".set-row")) {
      const hit = `${title} ${row.textContent}`.toLowerCase().includes(q);
      row.dataset.hit = hit ? "1" : "0";
      if (hit) hits += 1;
    }
    sec.classList.toggle("hidden", hits === 0);
    if (hits) any = true;
  }
  for (const b of document.querySelectorAll(".set-nav-item")) b.dataset.on = "0";
  $("set-empty").classList.toggle("hidden", any);
}

$("set-q").addEventListener("input", filterSettings);

document.querySelector(".set-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".set-nav-item");
  if (!btn) return;
  $("set-q").value = "";
  filterSettings();
  showSetPanel(btn.dataset.panel);
});

$("btn-settings").addEventListener("click", () => {
  $("settings").classList.remove("hidden");
  $("set-q").value = "";
  filterSettings();
  showSetPanel("aparencia");
  void renderFallback();
  void renderMemoria();
  void renderModulos();
});
$("btn-settings-close").addEventListener("click", () => $("settings").classList.add("hidden"));
$("settings").addEventListener("click", (e) => {
  if (e.target === $("settings")) $("settings").classList.add("hidden");
});

function syncApiFields() {
  $("api-fields").classList.toggle("hidden", $("profile-engine").value !== "api");
  $("btn-profile-add").textContent = $("profile-engine").value === "claude" || $("profile-engine").value === "codex"
    ? "Criar e logar"
    : "Criar conta";
}

$("profile-engine").addEventListener("change", syncApiFields);

/** "claude não tá no PATH" / "codex não tá no PATH" — ver `which()` em profiles.ts. */
const BIN_NAO_ACHADO_RE = /^(claude|codex) não tá no PATH$/;

/** Tenta criar o perfil; se faltar o binário, mostra "Instalar agora" em vez de só erro cru. */
async function tentarCriarPerfil(body) {
  const err = $("profile-add-err");
  const instalar = $("btn-profile-install");
  err.textContent = "";
  instalar.classList.add("hidden");
  try {
    await req("/v1/profiles", { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    const msg = e.message || "Não criou.";
    err.textContent = msg;
    const m = BIN_NAO_ACHADO_RE.exec(msg);
    if (m) {
      instalar.textContent = `Instalar ${m[1]} agora`;
      instalar.dataset.engine = m[1];
      instalar.classList.remove("hidden");
    }
    return false;
  }
  $("profile-id").value = "";
  state.fpProfiles = "";
  state.profileId = body.id;
  await loadProfiles();
  setVia();
  void renderFallback();
  if (body.engine === "claude" || body.engine === "codex") {
    $("settings").classList.add("hidden");
    void startLogin(body.id);
  }
  return true;
}

function corpoNovoPerfil() {
  const err = $("profile-add-err");
  const id = $("profile-id").value.trim().toLowerCase();
  const engine = $("profile-engine").value;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    err.textContent = "id: só a-z, 0-9 e hífen.";
    return null;
  }
  const body = { id, engine };
  if (engine === "api") {
    body.api = {
      provider: $("profile-provider").value.trim() || "anthropic",
      model: $("profile-model").value.trim(),
    };
    body.apiKey = $("profile-key").value.trim();
    if (!body.api.model || !body.apiKey) {
      err.textContent = "API precisa modelo e key.";
      return null;
    }
  }
  return body;
}

$("btn-profile-add").addEventListener("click", async () => {
  const err = $("profile-add-err");
  err.textContent = "";
  $("btn-profile-install").classList.add("hidden");
  if (!state.ok) {
    err.textContent = "Liga o motor primeiro.";
    return;
  }
  const body = corpoNovoPerfil();
  if (!body) return;
  await tentarCriarPerfil(body);
});

$("btn-profile-install").addEventListener("click", async () => {
  const btn = $("btn-profile-install");
  const err = $("profile-add-err");
  const engine = btn.dataset.engine;
  if (!engine) return;
  btn.disabled = true;
  err.textContent = `Instalando ${engine}… pode levar um minuto.`;
  let res;
  try {
    res = await req(`/v1/engines/${encodeURIComponent(engine)}/install`, { method: "POST" });
  } catch (e) {
    btn.disabled = false;
    err.textContent = e.message || `Não deu pra instalar ${engine}.`;
    return;
  }
  btn.disabled = false;
  if (!res.ok) {
    // últimas linhas do log do npm costumam ser o erro de verdade; o resto é ruído de progresso
    const cauda = String(res.log || "").trim().split(/\r?\n/).filter(Boolean).slice(-6).join(" ");
    err.textContent = `Falha ao instalar ${engine}.${cauda ? ` ${cauda}` : ""}`;
    return;
  }
  btn.classList.add("hidden");
  const body = corpoNovoPerfil();
  if (body) await tentarCriarPerfil(body);
});

$("allow-profile").addEventListener("change", syncAllowInput);
// marcar preset reflete na hora no campo avançado (tira o que passou a ser coberto)
$("allow-presets").addEventListener("change", (e) => {
  if (!e.target.dataset.preset) return;
  const campo = $("allow-tools");
  const cobertos = toolsDosPresets(presetsMarcados());
  const extras = campo.value.split(",").map((t) => t.trim()).filter(Boolean);
  campo.value = extras.filter((t) => !cobertos.includes(t)).join(", ");
});

$("btn-allow-save").addEventListener("click", async () => {
  const id = $("allow-profile").value;
  const err = $("allow-err");
  err.textContent = "";
  if (!id) return;
  const extras = $("allow-tools")
    .value.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const lista = [...new Set([...toolsDosPresets(presetsMarcados()), ...extras])];
  try {
    const next = await req(`/v1/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: lista }),
    });
    state.profiles = state.profiles.map((p) => (p.id === next.id ? next : p));
    state.fpProfiles = "";
    syncAllowInput();
    appendEvent({
      type: "sys",
      message: lista.length
        ? `${id}: liberado ${lista.join(", ")}. Vale já na próxima mensagem.`
        : `${id}: nenhuma ferramenta liberada.`,
    });
  } catch (e) {
    err.textContent = e.message || "não deu pra salvar";
  }
});

$("deleg-profile").addEventListener("change", syncDelegModo);

$("btn-deleg-save").addEventListener("click", async () => {
  const id = $("deleg-profile").value;
  const err = $("deleg-err");
  err.textContent = "";
  if (!id) return;
  const modo = $("deleg-modo").value;
  try {
    const next = await req(`/v1/profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ delegacaoModo: modo }),
    });
    state.profiles = state.profiles.map((p) => (p.id === next.id ? next : p));
    state.fpProfiles = "";
    syncDelegModo();
    appendEvent({ type: "sys", message: `${id}: delegação — ${modo}. Vale já na próxima mensagem.` });
  } catch (e) {
    err.textContent = e.message || "não deu pra salvar";
  }
});

$("accent-picker").addEventListener("input", (e) => persistAccent(e.target.value));
$("accent-hex").addEventListener("change", (e) => persistAccent(e.target.value.trim()));
$("accent-swatches").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-accent]");
  if (btn) persistAccent(btn.dataset.accent);
});

$("btn-agents").addEventListener("click", () => toggleAgents());
$("btn-agents-close").addEventListener("click", () => toggleAgents(false));
$("btn-agents-full").addEventListener("click", () => {
  toggleAgents(false);
  state.view = "agentes";
  applyWorkLayout();
  setAxTab(state.axTab);
});
$("tab-ax-agentes").addEventListener("click", () => setAxTab("agentes"));
$("tab-ax-times").addEventListener("click", () => setAxTab("times"));
$("tab-ax-hooks").addEventListener("click", () => setAxTab("hooks"));
$("btn-close-agentes").addEventListener("click", () => {
  agentStudio.fechar();
  teamStudio.fechar();
  hooksStudio.fechar();
});
$("btn-team-new").addEventListener("click", () => void abrirTime(null));
$("btn-hook-new").addEventListener("click", () => abrirHook(null));
teamStudio.ligar();
$("btn-agent-new").addEventListener("click", () => abrirEstudio(null));
agentStudio.ligar();
hooksStudio.ligar();

$("btn-palette").addEventListener("click", () => handleMod("palette"));
$("btn-palette-close").addEventListener("click", () => closePalette());
$("palette").addEventListener("click", (e) => {
  if (e.target === $("palette")) closePalette();
});
/**
 * A prévia mostra o módulo que a linha selecionada abriria, então clicar nela
 * é a mesma intenção de clicar na linha: abre e fecha a paleta. Antes o clique
 * caía no vazio (todo `.pal-mod` é pointer-events:none) e a paleta ficava aberta.
 */
$("palette-preview").addEventListener("click", () => {
  if (state.previewId) pickModule(state.previewId);
});
$("palette-q").addEventListener("input", (e) => {
  state.paletteFilter = e.target.value;
  state.paletteIndex = 0;
  renderPalette(true);
});
$("palette-q").addEventListener("keydown", (e) => {
  const items = filteredModules();
  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.paletteIndex = Math.min(items.length - 1, state.paletteIndex + 1);
    renderPalette(false);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.paletteIndex = Math.max(0, state.paletteIndex - 1);
    renderPalette(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const m = items[state.paletteIndex];
    if (m) pickModule(m.id);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});

$("term-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const cmd = $("term-cmd").value;
  $("term-cmd").value = "";
  void runTermCmd(cmd);
});
$("btn-term-kill").addEventListener("click", () => {
  void window.nexo.killCommand?.();
});

$("browser-form").addEventListener("submit", (e) => {
  e.preventDefault();
  setBrowserUrl($("browser-url").value);
});

const sketch = $("sketch");
sketch.addEventListener("pointerdown", (e) => {
  sketch.setPointerCapture(e.pointerId);
  state.drawing = {
    color: $("canvas-color").value,
    size: Number($("canvas-size").value) || 2,
    pts: [ptFromEvent(e)],
  };
  state.strokes.push(state.drawing);
  redrawSketch();
});
sketch.addEventListener("pointermove", (e) => {
  if (!state.drawing) return;
  state.drawing.pts.push(ptFromEvent(e));
  redrawSketch();
});
function endStroke() {
  if (!state.drawing) return;
  state.drawing = null;
  saveCanvas();
}
sketch.addEventListener("pointerup", endStroke);
sketch.addEventListener("pointercancel", endStroke);
$("btn-canvas-clear").addEventListener("click", () => {
  state.strokes = [];
  saveCanvas();
  redrawSketch();
});
let noteTimer;
$("canvas-note").addEventListener("input", (e) => {
  state.canvasNote = e.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveCanvas, 250);
  $("pal-note").textContent = state.canvasNote.trim() || "Notas vazias.";
});

window.nexo.onShellData?.((text) => appendTerm(text));
window.nexo.onShellExit?.((code) => {
  state.termRunning = false;
  $("btn-term-kill").hidden = true;
  appendTerm(`\n[saiu ${code}]\n`);
});

function handleMod(id) {
  if (id === "palette") {
    if (state.paletteOpen) closePalette();
    else openPalette();
    return;
  }
  closePalette();
  setView(id);
}

window.nexo.onMod?.((id) => handleMod(id));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    inspectorHost.desligar();
    if (state.paletteOpen) closePalette();
    else if (state.agents.open) toggleAgents(false);
    $("settings").classList.add("hidden");
    if (!$("login-modal").classList.contains("hidden")) closeLoginModal();
    else if (document.body.dataset.focus === "1" && !state.talking) setFocus(false);
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") {
    e.preventDefault();
    toggleAgents();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    setFocus(document.body.dataset.focus !== "1");
    return;
  }
  if (typeof window.nexo?.onMod === "function") return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
    e.preventDefault();
    handleMod("palette");
    return;
  }
  if (mod && e.key.toLowerCase() === "g" && !e.shiftKey) {
    e.preventDefault();
    handleMod("file");
    return;
  }
  if (mod && e.key.toLowerCase() === "j" && !e.shiftKey) {
    e.preventDefault();
    handleMod("terminal");
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    handleMod("browser");
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    handleMod("side-chat");
    return;
  }
});

window.addEventListener("resize", () => {
  state.fit?.fit();
  if (state.view === "canvas" || (state.paletteOpen && state.previewId === "canvas")) resizeSketch();
});

/**
 * Modelo, modo e esforço se mudam de casa quando a barra do composer fica estreita — pro "⋯"
 * ("bar-more"), em vez de sumir sem aviso (era `display:none` puro em CSS antes). Move os
 * elementos DE VERDADE (não clona): o `<select>` continua sendo o mesmo nó, com os mesmos
 * listeners — só troca de container.
 */
function initBarOverflow() {
  const composer = $("composer");
  const bar = document.querySelector(".bar");
  const btnMore = $("btn-bar-more");
  const panel = $("bar-more-panel");
  const anchor = $("btn-attach");
  const itens = [$("model-select"), $("mode-select"), document.querySelector(".effort")].filter(Boolean);
  if (!composer || !bar || !btnMore || !panel || !anchor || !itens.length) return;
  const LIMIAR = 520;
  let empilhado = false;

  function fecharPainel() {
    panel.classList.add("hidden");
    btnMore.setAttribute("aria-expanded", "false");
  }

  function aplicar(empilhar) {
    if (empilhar === empilhado) return;
    empilhado = empilhar;
    if (empilhar) {
      for (const el of itens) panel.append(el);
    } else {
      for (const el of itens) bar.insertBefore(el, anchor);
      fecharPainel();
    }
    btnMore.classList.toggle("hidden", !empilhar);
  }

  new ResizeObserver((entries) => {
    const largura = entries[0]?.contentRect.width ?? composer.clientWidth;
    aplicar(largura < LIMIAR);
  }).observe(composer);

  btnMore.addEventListener("click", () => {
    const abrir = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !abrir);
    btnMore.setAttribute("aria-expanded", String(abrir));
  });

  document.addEventListener("click", (e) => {
    if (panel.classList.contains("hidden")) return;
    if (panel.contains(e.target) || e.target === btnMore) return;
    fecharPainel();
  });
}

initCombobox();
initBarOverflow();

const bootAccent = new URLSearchParams(location.search).get("accent");
applyAccent(HEX.test(bootAccent || "") ? bootAccent : localStorage.getItem("nexo.accent") || DEFAULT_ACCENT);
hydrateRepos();
syncApiFields();
setProjectLabel();
setComposer(Boolean(state.threadId));
applyWorkLayout();
updatePalTerm();
paintAgents();
void (async () => {
  if (state.projectPath) await window.nexo.setProject?.(state.projectPath);
  loadBrowser();
  loadCanvas();
  await loadFileTree();
  await refreshDaemon();
  if (state.ok && state.threadId && state.projectPath) {
    try {
      await openThread(state.threadId);
    } catch {
      state.threadId = "";
      localStorage.removeItem("nexo.thread");
      setComposer(false);
    }
  }
})();
setInterval(refreshDaemon, 4000);
