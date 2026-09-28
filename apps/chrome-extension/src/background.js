import { BASE_PADRAO, criarLeitorSse, normalizarBase, resumoDaAcao, teclaParaCdp, urlPermitida } from "./util.js";

/**
 * Service worker da extensão Nexos. Liga no motor (`GET /v1/chrome/events`, com o token do
 * pareamento), executa os `chrome_comando` que chegam e devolve em `POST /v1/chrome/:id/responder`.
 *
 * Trava de escopo: só age em abas do grupo "Nexos", que é criado pelo próprio agente
 * (`nexo_chrome_abrir`). Aba fora do grupo é recusada — as abas da pessoa ficam intocadas.
 *
 * Híbrido: content script (`pagina-bundle.js`) por padrão; `chrome.debugger` (CDP) só pro que o
 * content script não faz — clique/tecla de verdade e print de aba em fundo — e solto logo depois.
 */

const VERSAO = chrome.runtime.getManifest().version;
const TITULO_GRUPO = "Nexos";
const RECONEXAO_MS = 5_000;
const CARREGAR_TETO_MS = 20_000;
const MAX_LOG = 20;

/* ---------- estado ---------- */

/** "sem-par" | "conectando" | "conectado" | "sem-motor" | "token-invalido" */
let status = "conectando";
let conexao = null;
let reconexaoTimer = 0;
let ultimaTentativa = 0;
let ultimoErro = "";

async function cfg() {
  const { base = BASE_PADRAO, token = "" } = await chrome.storage.local.get(["base", "token"]);
  return { base, token };
}

async function pausado() {
  return (await chrome.storage.local.get("pausado")).pausado === true;
}

async function setStatus(s) {
  status = s;
  const pausa = await pausado();
  const badge = pausa ? { t: "II", c: "#d8a657" } : s === "conectado" ? { t: "", c: "#5fae74" } : s === "conectando" ? { t: "…", c: "#71717b" } : { t: "!", c: "#dd7f77" };
  await chrome.action.setBadgeText({ text: badge.t });
  await chrome.action.setBadgeBackgroundColor({ color: badge.c });
  chrome.runtime.sendMessage({ tipo: "mudou" }).catch(() => {});
}

async function registrar(ev, r) {
  const { log = [] } = await chrome.storage.session.get("log");
  log.unshift({ hora: Date.now(), texto: resumoDaAcao(ev), ok: r.ok, detalhe: r.ok ? "" : r.texto.slice(0, 140) });
  await chrome.storage.session.set({ log: log.slice(0, MAX_LOG), ultimaAcao: Date.now(), ultimaThread: ev.threadId });
  chrome.runtime.sendMessage({ tipo: "mudou" }).catch(() => {});
}

/* ---------- conexão com o motor ---------- */

function agendarReconexao() {
  clearTimeout(reconexaoTimer);
  reconexaoTimer = setTimeout(() => void conectar(), RECONEXAO_MS);
}

async function conectar() {
  if (conexao) return;
  const { base, token } = await cfg();
  if (!token) return setStatus("sem-par");
  const ctrl = new AbortController();
  conexao = ctrl;
  ultimaTentativa = Date.now();
  if (status !== "conectado") await setStatus("conectando");
  try {
    const res = await fetch(`${base}/v1/chrome/events?versao=${encodeURIComponent(VERSAO)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.status === 401) {
      ultimoErro = "o motor recusou o token (celulares desconectados ou token trocado) — pareie de novo";
      await setStatus("token-invalido");
      return;
    }
    if (!res.ok || !res.body) throw new Error(`motor respondeu ${res.status}`);
    ultimoErro = "";
    await setStatus("conectado");
    const alimentar = criarLeitorSse(({ event, data }) => {
      // qualquer chamada de API da extensão zera o relógio de inatividade do service worker (MV3)
      if (event === "ping") void chrome.runtime.getPlatformInfo();
      else if (event === "comando") void tratarComando(JSON.parse(data), base, token);
    });
    const leitor = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      alimentar(value);
    }
    throw new Error("o motor fechou a conexão");
  } catch (e) {
    if (ctrl.signal.aborted) return;
    ultimoErro = e?.message || String(e);
    await setStatus("sem-motor");
  } finally {
    if (conexao === ctrl) conexao = null;
    if (!ctrl.signal.aborted && status !== "token-invalido" && status !== "sem-par") agendarReconexao();
  }
}

function desconectar() {
  clearTimeout(reconexaoTimer);
  conexao?.abort();
  conexao = null;
}

/* ---------- grupo "Nexos" ---------- */

async function grupoId() {
  const { grupo } = await chrome.storage.session.get("grupo");
  if (typeof grupo === "number") {
    try {
      await chrome.tabGroups.get(grupo);
      return grupo;
    } catch {
      /* grupo fechado pela pessoa: nasce outro na próxima abertura */
    }
  }
  return null;
}

async function abasDoGrupo() {
  const g = await grupoId();
  return g === null ? [] : chrome.tabs.query({ groupId: g });
}

async function colocarNoGrupo(tabId) {
  const g = await grupoId();
  if (g !== null) {
    await chrome.tabs.group({ groupId: g, tabIds: [tabId] });
    return;
  }
  const novo = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(novo, { title: TITULO_GRUPO, color: "purple" });
  await chrome.storage.session.set({ grupo: novo });
}

async function abaDaThread(threadId) {
  const { abas = {} } = await chrome.storage.session.get("abas");
  return abas[threadId];
}

async function lembrarAba(threadId, tabId) {
  const { abas = {} } = await chrome.storage.session.get("abas");
  abas[threadId] = tabId;
  await chrome.storage.session.set({ abas });
}

/** A aba em que o comando age: a pedida, ou a última desta conversa, ou a única do grupo. */
async function alvo(ev) {
  const abas = await abasDoGrupo();
  const pedida = typeof ev.aba === "number" ? ev.aba : await abaDaThread(ev.threadId);
  if (pedida === undefined) {
    if (abas.length === 1) return abas[0];
    throw new Error(
      abas.length
        ? "mais de uma aba no grupo Nexos — diga qual com `aba` (nexo_chrome_abas_listar)"
        : "nenhuma aba no grupo Nexos — abra uma com nexo_chrome_abrir",
    );
  }
  const aba = abas.find((a) => a.id === pedida);
  if (!aba) throw new Error(`a aba ${pedida} não está no grupo Nexos — só dá pra mexer nas abas que o agente abriu (nexo_chrome_abas_listar)`);
  await lembrarAba(ev.threadId, aba.id);
  return aba;
}

function esperarCarregar(tabId) {
  return new Promise((resolve) => {
    const fim = () => {
      clearTimeout(teto);
      chrome.tabs.onUpdated.removeListener(ouvir);
      resolve();
    };
    const ouvir = (id, info) => {
      if (id === tabId && info.status === "complete") fim();
    };
    const teto = setTimeout(fim, CARREGAR_TETO_MS);
    chrome.tabs.onUpdated.addListener(ouvir);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && t.url && t.url !== "about:blank" && fim(), fim);
  });
}

/* ---------- execução ---------- */

async function naPagina(tabId, fn, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["pagina-bundle.js"] });
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
  if (r?.error) throw new Error(r.error.message || String(r.error));
  return r?.result;
}

/**
 * Funções abaixo são serializadas e rodam NA ABA — não enxergam nada deste arquivo. O
 * try/catch devolve o erro como valor: exceção de `func` injetada chega vazia do outro lado.
 */
function chamarNaPagina(metodo, ...args) {
  try {
    globalThis.__nexo.pilula();
    return { ok: true, valor: globalThis.__nexo[metodo](...args) };
  } catch (e) {
    return { ok: false, erro: e?.message || String(e) };
  }
}

async function pagina(tabId, metodo, ...args) {
  const r = await naPagina(tabId, chamarNaPagina, [metodo, ...args]);
  if (!r?.ok) throw new Error(r?.erro || "a página não respondeu (aba do Chrome interno ou da Web Store não deixa extensão entrar)");
  return r.valor;
}

async function comDebugger(tabId, fn) {
  const alvoCdp = { tabId };
  try {
    await chrome.debugger.attach(alvoCdp, "1.3");
  } catch (e) {
    throw new Error(`não deu pra usar o modo real nesta aba (DevTools aberto nela?): ${e?.message || e}`);
  }
  try {
    return await fn((metodo, params) => chrome.debugger.sendCommand(alvoCdp, metodo, params));
  } finally {
    await chrome.debugger.detach(alvoCdp).catch(() => {});
  }
}

async function cliqueReal(tabId, { x, y }) {
  await comDebugger(tabId, async (cdp) => {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  });
}

async function teclaReal(cdp, tecla) {
  const p = teclaParaCdp(tecla);
  await cdp("Input.dispatchKeyEvent", { type: p.text ? "keyDown" : "rawKeyDown", ...p });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: p.key, code: p.code, windowsVirtualKeyCode: p.windowsVirtualKeyCode, modifiers: p.modifiers });
}

async function print(aba) {
  let dataUrl;
  if (aba.active) {
    dataUrl = await chrome.tabs.captureVisibleTab(aba.windowId, { format: "jpeg", quality: 70 });
  } else {
    const r = await comDebugger(aba.id, (cdp) => cdp("Page.captureScreenshot", { format: "jpeg", quality: 70 }));
    dataUrl = `data:image/jpeg;base64,${r.data}`;
  }
  return { dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" };
}

function descreverAba(a) {
  return `aba ${a.id}${a.active ? " (ativa)" : ""}: ${a.title || "(sem título)"} — ${a.url || a.pendingUrl || ""}`;
}

async function executar(ev) {
  switch (ev.acao) {
    case "abas": {
      const abas = await abasDoGrupo();
      if (!abas.length) return { ok: true, texto: "(grupo Nexos vazio — abra uma aba com nexo_chrome_abrir)" };
      const minha = await abaDaThread(ev.threadId);
      return { ok: true, texto: abas.map((a) => descreverAba(a) + (a.id === minha ? " ← última usada por você" : "")).join("\n") };
    }
    case "abrir": {
      const url = urlPermitida(ev.url);
      if (!url) return { ok: false, texto: "só abro URL http/https" };
      let aba = null;
      if (!ev.nova) aba = await alvo(ev).catch(() => null);
      if (aba) {
        await chrome.tabs.update(aba.id, { url });
      } else {
        aba = await chrome.tabs.create({ url, active: false });
        await colocarNoGrupo(aba.id);
        await lembrarAba(ev.threadId, aba.id);
      }
      await esperarCarregar(aba.id);
      const t = await chrome.tabs.get(aba.id);
      await pagina(t.id, "rolar", { direcao: "topo" }).catch(() => {});
      return { ok: true, texto: `aberto — ${descreverAba(t)}` };
    }
    case "ler": {
      const aba = await alvo(ev);
      const itens = await pagina(aba.id, "ler");
      if (!itens.length) return { ok: true, texto: "(nenhum elemento interativo na página)" };
      return { ok: true, texto: `${descreverAba(aba)}\n` + itens.map((it) => `${it.ref}: [${it.papel}] ${it.texto}`).join("\n") };
    }
    case "markdown": {
      const aba = await alvo(ev);
      return { ok: true, texto: await pagina(aba.id, "markdown") };
    }
    case "screenshot": {
      const aba = await alvo(ev);
      await pagina(aba.id, "pilula").catch(() => {});
      return { ok: true, texto: descreverAba(aba), imagem: await print(aba) };
    }
    case "clicar": {
      const aba = await alvo(ev);
      if (!ev.real) return { ok: true, texto: await pagina(aba.id, "clicarSintetico", ev.ref) };
      await cliqueReal(aba.id, await pagina(aba.id, "mirar", ev.ref, "clicando", false));
      return { ok: true, texto: "clicado (clique real)" };
    }
    case "digitar": {
      const aba = await alvo(ev);
      if (!ev.real) return { ok: true, texto: await pagina(aba.id, "digitarSintetico", ev.ref, ev.texto, ev.enter) };
      await pagina(aba.id, "mirar", ev.ref, "digitando", true);
      await comDebugger(aba.id, async (cdp) => {
        await cdp("Input.insertText", { text: ev.texto });
        if (ev.enter) await teclaReal(cdp, "Enter");
      });
      return { ok: true, texto: ev.enter ? "digitado e Enter (teclado real)" : "digitado (teclado real)" };
    }
    case "rolar": {
      const aba = await alvo(ev);
      return { ok: true, texto: await pagina(aba.id, "rolar", { ref: ev.ref, direcao: ev.direcao }) };
    }
    case "tecla": {
      const aba = await alvo(ev);
      teclaParaCdp(ev.tecla); // valida antes de ligar o debugger
      await pagina(aba.id, "pilula").catch(() => {});
      await comDebugger(aba.id, (cdp) => teclaReal(cdp, ev.tecla));
      return { ok: true, texto: `tecla ${ev.tecla}` };
    }
    default:
      return { ok: false, texto: `ação desconhecida: ${ev.acao} (extensão ${VERSAO} — atualize a extensão?)` };
  }
}

async function tratarComando(ev, base, token) {
  let r;
  if (await pausado()) {
    r = { ok: false, texto: "a pessoa pausou o agente no Chrome (popup da extensão) — espere ela retomar" };
  } else {
    try {
      r = await executar(ev);
    } catch (e) {
      r = { ok: false, texto: e?.message || String(e) };
    }
  }
  await registrar(ev, r);
  await fetch(`${base}/v1/chrome/${encodeURIComponent(ev.threadId)}/responder`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: ev.id, ...r }),
  }).catch(() => {
    /* motor já desistiu (timeout) ou caiu — nada a fazer */
  });
}

/* ---------- popup ---------- */

async function estado() {
  const { base, token } = await cfg();
  const { log = [], ultimaAcao = 0 } = await chrome.storage.session.get(["log", "ultimaAcao"]);
  const abas = await abasDoGrupo();
  return {
    status: token ? status : "sem-par",
    base,
    pausado: await pausado(),
    abas: abas.map((a) => ({ id: a.id, titulo: a.title || "", url: a.url || a.pendingUrl || "", ativa: a.active, favicon: a.favIconUrl || "" })),
    log,
    agindo: Date.now() - ultimaAcao < 15_000,
    ultimaTentativa,
    ultimoErro,
    versao: VERSAO,
  };
}

async function parear(baseBruta, codigo) {
  const base = normalizarBase(baseBruta);
  if (!base) return { ok: false, erro: "endereço do motor inválido" };
  let res;
  try {
    res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigo }),
    });
  } catch {
    return { ok: false, erro: `não achei o motor em ${base} — o Nexos está aberto?` };
  }
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok || !corpo.token) return { ok: false, erro: corpo.error || `o motor respondeu ${res.status}` };
  await chrome.storage.local.set({ base, token: corpo.token });
  desconectar();
  void conectar();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  const tratar = async () => {
    switch (msg?.tipo) {
      case "estado":
        return estado();
      case "parear":
        return parear(msg.base, msg.codigo);
      case "pausar":
      case "retomar":
        await chrome.storage.local.set({ pausado: msg.tipo === "pausar" });
        await setStatus(status);
        return { ok: true };
      case "tentar":
        desconectar();
        void conectar();
        return { ok: true };
      case "desparear":
        desconectar();
        await chrome.storage.local.remove(["token"]);
        await setStatus("sem-par");
        return { ok: true };
      case "focar-aba": {
        const t = await chrome.tabs.get(msg.id);
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  };
  tratar().then(responder, (e) => responder({ ok: false, erro: e?.message || String(e) }));
  return true;
});

/* ---------- vida do service worker ---------- */

// o alarme religa o worker se o Chrome o matou (MV3 derruba worker parado)
chrome.alarms.create("nexos-vivo", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "nexos-vivo" && !conexao) void conectar();
});
chrome.runtime.onStartup.addListener(() => void conectar());
chrome.runtime.onInstalled.addListener(() => void conectar());
void conectar();
