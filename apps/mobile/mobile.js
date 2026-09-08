import {
  codigoDaUrl,
  credencialGuardada,
  esquecer,
  guardar,
  limparCodigo,
  limparUrl,
  parear,
} from "./pareamento.js";
import { renderMd } from "./comum/markdown.js";
import { ago } from "./comum/format.js";
import { fmtDuracao } from "./comum/agent-trace.js";
import { lerEventos } from "./comum/sse.js";
import { aneisDeConta, emVoo, faixaDoRun } from "./comum/widget-view.js";
import { agruparConversas } from "./comum/thread-groups.js";
import { extrairMencoes } from "./comum/mention.js";

/**
 * App de celular do Nexo, servido pelo próprio daemon.
 *
 * Ele NÃO é o app do desktop encolhido: só existe aqui o que faz sentido com o
 * telefone na mão — acompanhar o que está rodando e conversar. Árvore de
 * arquivos e terminal ficam de fora porque hoje não existem como HTTP (vivem no
 * processo principal do Electron), e porque telefone não é onde se lê diff.
 *
 * O que ele reaproveita do desktop vem de `./comum/`, servido pelo daemon a
 * partir de uma lista branca: `markdown.js`, `format.js`, `sse.js`,
 * `widget-view.js`, `mention.js`. Sem cópia — arquivo copiado diverge.
 */

const $ = (id) => document.getElementById(id);
const PERIODO_MS = 3000;
const EFFORT_STEPS = ["", "low", "medium", "high", "xhigh", "max"];
const EFFORT_NAMES = ["padrão", "baixo", "médio", "alto", "muito alto", "máximo"];

let cred = null;
let projeto = "";
let threadId = "";
let threadProfileId = "";
let abortStream = null;
let timer = 0;
let ultimo = null;

/** Cache do que o compositor precisa pro "/" (skills) e "@" (agentes/times). */
const mencoes = { profiles: [], agentDefs: [], teams: [], loaded: false, loading: false };
const skills = { list: [], key: "", loading: false };
/** Estado do menu de autocomplete acima do compositor. */
const slash = { open: false, kind: "", matches: [], index: 0 };

/* ---------- daemon ---------- */

function api(caminho) {
  return `${cred.base}${caminho}`;
}

/**
 * Chamada ao daemon. Token que o daemon já não aceita derruba o pareamento e
 * volta pra tela do código: o token é sorteado a cada subida do daemon, então
 * despareaer é normal, não é falha.
 */
async function req(caminho, opts = {}) {
  const res = await fetch(api(caminho), {
    ...opts,
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${cred.token}`,
      ...(opts.headers ?? {}),
    },
  });
  if (res.status === 401) {
    desparear("O computador não reconhece mais este celular. Peça um código novo.");
    throw new Error("unauthorized");
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados.error || `erro ${res.status}`);
  return dados;
}

/* ---------- pareamento ---------- */

/**
 * O código que o QR trouxe, se trouxe. Vive aqui em cima porque o `desparear`
 * depende dele, e ele só é usado no fim: declarar junto do uso deixaria o
 * `desparear` lendo variável em zona morta.
 */
let codigoPendente = "";
const gastarCodigoPendente = () => {
  const c = codigoPendente;
  codigoPendente = "";
  return c;
};

function mostrarErroPar(msg) {
  $("par-erro").textContent = msg || "";
  $("par-erro").classList.toggle("hidden", !msg);
}

function desparear(motivo) {
  esquecer();
  cred = null;
  pararRelogio();
  abortStream?.abort();
  $("app").classList.add("hidden");
  $("tela-par").classList.remove("hidden");
  mostrarErroPar(motivo ?? "");
  // quem chegou por QR trouxe um código junto: se o token guardado morreu, ele
  // resolve sozinho em vez de mandar a pessoa buscar o computador
  if (codigoPendente) void tentarParear(gastarCodigoPendente());
}

async function entrar(credencial) {
  cred = credencial;
  guardar(credencial);
  $("tela-par").classList.add("hidden");
  $("app").classList.remove("hidden");
  mostrarErroPar("");
  await abrirAgora();
}

async function tentarParear(codigo) {
  mostrarErroPar("");
  const r = await parear(codigo);
  if (!r.ok) return mostrarErroPar(r.erro);
  $("codigo").value = "";
  await entrar(r.credencial);
}

$("form-par").addEventListener("submit", (e) => {
  e.preventDefault();
  void tentarParear($("codigo").value);
});

// o teclado numérico do celular deixa passar espaço, traço e ponto
$("codigo").addEventListener("input", () => {
  $("codigo").value = limparCodigo($("codigo").value);
});

/* ---------- agora ---------- */

function pintarRun(faixa) {
  $("run").classList.toggle("hidden", !faixa);
  if (!faixa) return;
  $("run-obj").textContent = faixa.objetivo || "sem objetivo";
  $("run-dot").dataset.on = faixa.rodando ? "1" : "0";
  $("run-dot").dataset.erro = faixa.status === "error" ? "1" : "0";
  $("run-quem").textContent = faixa.rodando ? faixa.agente || "montando…" : faixa.status;
  $("run-passos").textContent = faixa.total ? `${faixa.feitos}/${faixa.total}` : "";
  $("run-ms").textContent = faixa.ms ? fmtDuracao(faixa.ms) : "";
  $("run-fill").style.width = `${faixa.total ? Math.round((faixa.feitos / faixa.total) * 100) : 0}%`;
  const custo = faixa.custoUsd ? `US$ ${faixa.custoUsd.toFixed(4)}` : "";
  $("run-custo").textContent = custo + (faixa.tetoUsd ? ` de US$ ${faixa.tetoUsd}` : "");
  $("run-custo").classList.toggle("hidden", !custo);
}

function corDoUso(uso, bloqueada) {
  if (bloqueada || uso >= 0.95) return "var(--bad)";
  if (uso >= 0.75) return "var(--warn)";
  return "var(--ok)";
}

function pintarContas(contas) {
  const box = $("aneis");
  box.replaceChildren();
  for (const c of contas) {
    const linha = document.createElement("div");
    linha.className = "anel";
    const arco = document.createElement("span");
    arco.className = "arco";
    arco.style.setProperty("--pct", String(Math.round(c.uso * 100)));
    arco.style.setProperty("--cor", corDoUso(c.uso, c.bloqueada));
    const txt = document.createElement("span");
    txt.className = "anel-txt";
    const id = document.createElement("span");
    id.textContent = c.id;
    const pct = document.createElement("span");
    pct.className = "anel-pct";
    pct.textContent = c.bloqueada ? "bloqueada" : `${Math.round(c.uso * 100)}%`;
    txt.append(id, pct);
    linha.append(arco, txt);
    box.append(linha);
  }
  $("contas").classList.toggle("hidden", contas.length === 0);
}

async function puxarAgora() {
  try {
    const [run, contas, agentes, cfg] = await Promise.all([
      req(`/v1/runs/atual${projeto ? `?projectPath=${encodeURIComponent(projeto)}` : ""}`),
      req("/v1/accounts/limits"),
      req("/v1/agents"),
      req("/v1/config"),
    ]);
    // o projeto do celular acompanha o último que o desktop abriu: é o mesmo
    // daemon, e escolher projeto no telefone seria uma tela que não paga
    if (cfg?.lastProject) projeto = cfg.lastProject;
    ultimo = { run, contas, agentes };
    $("motor").dataset.on = "1";
    $("motor").textContent = "ligado";
  } catch {
    // poll que falha não apaga a tela: o retrato anterior vale até a próxima
    $("motor").dataset.on = "0";
    $("motor").textContent = "sem resposta";
  }
  repintarAgora();
}

function repintarAgora() {
  if (!ultimo) return;
  const faixa = faixaDoRun(ultimo.run, Date.now());
  const trabalhando = emVoo(ultimo.agentes, faixa?.rodando ? faixa.id : "");
  const contas = aneisDeConta(ultimo.contas);
  pintarRun(faixa);
  pintarContas(contas);
  $("agora-vazio").classList.toggle("hidden", Boolean(faixa) || trabalhando.length > 0 || contas.length > 0);
}

function comecarRelogio() {
  pararRelogio();
  timer = setInterval(() => void puxarAgora(), PERIODO_MS);
}

function pararRelogio() {
  if (timer) clearInterval(timer);
  timer = 0;
}

/* ---------- conversas ---------- */

async function abrirConversas() {
  mostrar("conversas");
  $("titulo").textContent = "Conversas";
  const ul = $("lista-threads");
  ul.replaceChildren();
  let lista = [];
  try {
    lista = projeto ? await req(`/v1/threads?projectPath=${encodeURIComponent(projeto)}`) : [];
  } catch {
    lista = [];
  }
  /*
   * Agrupado, e não solto: um run de time cria uma conversa por passo, e no
   * telefone — onde caberia meia dúzia de linhas — três runs afogam
   * completamente as conversas de verdade. O `agruparConversas` é o MESMO do
   * desktop, vindo por `/app/comum/`; o que muda aqui é só o desenho.
   */
  for (const item of agruparConversas(lista)) {
    if (item.tipo === "conversa") ul.append(linhaDeConversa(item.thread));
    else ul.append(...linhasDeRun(item));
  }
  $("threads-vazio").classList.toggle("hidden", lista.length > 0);
}

function linhaDeConversa(t, dentroDeRun = false) {
  const li = document.createElement("li");
  if (dentroDeRun) li.className = "aninhada";
  const nome = document.createElement("span");
  nome.className = "nome";
  nome.textContent = t.preview || "Conversa nova";
  const quando = document.createElement("span");
  quando.className = "quando";
  quando.textContent = t.busy ? "trabalhando…" : ago(t.updatedAt);
  li.append(nome, quando);
  li.addEventListener("click", () => void abrirChat(t.id, t.preview, t.profileId));
  return li;
}

/**
 * Um run vira uma linha que abre e fecha.
 *
 * Fechado por padrão, porque o normal é você querer a conversa que estava
 * tendo, não os passos de um time que já rodou. Quem quer o passo toca no run.
 */
function linhasDeRun(grupo) {
  const cab = document.createElement("li");
  cab.className = "grupo";
  const nome = document.createElement("span");
  nome.className = "nome";
  nome.textContent = grupo.titulo;
  const quantos = document.createElement("span");
  quantos.className = "quando";
  quantos.textContent = `${grupo.threads.length} passos`;
  cab.append(nome, quantos);

  const filhas = grupo.threads.map((t) => linhaDeConversa(t, true));
  for (const f of filhas) f.classList.add("hidden");
  cab.addEventListener("click", () => {
    const fechado = filhas[0]?.classList.contains("hidden");
    for (const f of filhas) f.classList.toggle("hidden", !fechado);
    cab.dataset.aberto = fechado ? "1" : "0";
  });
  return [cab, ...filhas];
}

/* ---------- nova conversa ---------- */

function fecharFolha(el) {
  el.classList.add("hidden");
}

function abrirFolha(el) {
  el.classList.remove("hidden");
}

for (const folha of [$("folha-nova"), $("folha-ajustes")]) {
  folha.querySelector("[data-fechar]").addEventListener("click", () => fecharFolha(folha));
}

/** Contas prontas pra receber conversa, e agentes personalizados (cada um já embute a conta dele). */
async function carregarOpcoesDeConversa() {
  const [profiles, agentDefs] = await Promise.all([req("/v1/profiles"), req("/v1/agents/defs")]);
  mencoes.profiles = profiles;
  return { profiles: profiles.filter((p) => p.status === "ready"), agentDefs };
}

function linhaDeOpcao(rotulo, desc, aoTocar) {
  const li = document.createElement("li");
  const nome = document.createElement("span");
  nome.className = "nome";
  nome.textContent = rotulo;
  const d = document.createElement("span");
  d.className = "desc";
  d.textContent = desc;
  li.append(nome, d);
  li.addEventListener("click", aoTocar);
  return li;
}

async function abrirFolhaNova() {
  const ul = $("folha-nova-lista");
  ul.replaceChildren();
  abrirFolha($("folha-nova"));
  let opcoes;
  try {
    opcoes = await carregarOpcoesDeConversa();
  } catch {
    opcoes = { profiles: [], agentDefs: [] };
  }
  $("folha-nova-vazio").classList.toggle("hidden", opcoes.profiles.length > 0 || opcoes.agentDefs.length > 0);
  for (const p of opcoes.profiles) {
    ul.append(
      linhaDeOpcao(p.id, p.engine === "claude" ? p.model || "modelo padrão" : p.engine, () =>
        void criarConversa({ profileId: p.id }, p.id),
      ),
    );
  }
  for (const a of opcoes.agentDefs) {
    ul.append(linhaDeOpcao(`@${a.id}`, a.name, () => void criarConversa({ agentId: a.id }, a.profileId)));
  }
}

async function criarConversa(quem, profileId) {
  fecharFolha($("folha-nova"));
  if (!projeto) return;
  try {
    const t = await req("/v1/threads", { method: "POST", body: JSON.stringify({ projectPath: projeto, ...quem }) });
    await abrirChat(t.id, "Conversa nova", profileId || "");
  } catch (e) {
    mostrar("conversas");
    bolhaErroConversas(e.message);
  }
}

function bolhaErroConversas(msg) {
  const p = document.createElement("p");
  p.className = "vazio";
  p.textContent = msg;
  $("lista-threads").before(p);
}

$("btn-nova").addEventListener("click", () => void abrirFolhaNova());

/* ---------- modelo e esforço ---------- */

function perfilAtual() {
  return mencoes.profiles.find((p) => p.id === threadProfileId);
}

async function abrirFolhaAjustes() {
  if (!threadProfileId) return;
  try {
    mencoes.profiles = await req("/v1/profiles");
  } catch {
    return;
  }
  const p = perfilAtual();
  if (!p || p.engine !== "claude") return;
  $("ajustes-conta").textContent = threadProfileId;
  $("ajuste-modelo").value = ["opus", "sonnet", "haiku", "fable"].includes(p.model || "") ? p.model : "";
  const idx = Math.max(0, EFFORT_STEPS.indexOf(p.effort || ""));
  $("ajuste-esforco").value = String(idx);
  $("ajuste-esforco-label").textContent = EFFORT_NAMES[idx];
  abrirFolha($("folha-ajustes"));
}

async function ajustarPerfil(patch) {
  if (!threadProfileId) return;
  try {
    await req(`/v1/profiles/${encodeURIComponent(threadProfileId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  } catch {
    // celular não é onde se resolve conta sem login/credencial: falha aqui é silenciosa,
    // o painel de contas do computador é que mostra o motivo.
  }
}

$("btn-ajustes").addEventListener("click", () => void abrirFolhaAjustes());
$("ajuste-modelo").addEventListener("change", () => void ajustarPerfil({ model: $("ajuste-modelo").value }));
$("ajuste-esforco").addEventListener("input", () => {
  const idx = Number($("ajuste-esforco").value);
  $("ajuste-esforco-label").textContent = EFFORT_NAMES[idx];
});
$("ajuste-esforco").addEventListener("change", () => {
  const idx = Number($("ajuste-esforco").value);
  void ajustarPerfil({ effort: EFFORT_STEPS[idx] });
});

/* ---------- chat ---------- */

function bolha(de, texto) {
  const div = document.createElement("div");
  div.className = "msg";
  div.dataset.de = de;
  if (de === "assistant") renderMd(div, texto);
  else div.textContent = texto;
  $("msgs").append(div);
  return div;
}

function rolarPraBaixo() {
  $("msgs").scrollTop = $("msgs").scrollHeight;
}

async function abrirChat(id, titulo, profileId = "") {
  threadId = id;
  threadProfileId = profileId;
  fecharSlash();
  mostrar("chat");
  $("titulo").textContent = titulo || "Conversa";
  $("btn-voltar").hidden = false;
  $("btn-ajustes").hidden = !profileId;
  $("msgs").replaceChildren();

  let eventos = [];
  try {
    eventos = await req(`/v1/threads/${id}`);
  } catch (e) {
    bolha("erro", e.message);
    return;
  }
  for (const ev of eventos) {
    if (ev.type === "user" || ev.type === "assistant") bolha(ev.type, ev.text);
    else if (ev.type === "error") bolha("erro", ev.message);
    else if (ev.type === "cleared") bolha("sys", "— contexto cortado —");
  }
  rolarPraBaixo();
  ouvirChat();
}

/**
 * Stream da conversa. O texto chega em pedaço, então a bolha do assistente é
 * criada uma vez e vai crescendo — recriar a cada pedaço perderia a rolagem e
 * piscaria a tela.
 */
function ouvirChat() {
  abortStream?.abort();
  const ac = new AbortController();
  abortStream = ac;
  let atual = null;
  let buf = "";
  fetch(api(`/v1/threads/${threadId}/events`), {
    headers: { Authorization: `Bearer ${cred.token}` },
    signal: ac.signal,
  })
    .then((res) =>
      lerEventos(res, (ev) => {
        if (abortStream !== ac) return;
        if (ev.type === "text") {
          buf += ev.text;
          if (!atual) atual = bolha("assistant", "");
          renderMd(atual, buf);
          rolarPraBaixo();
          return;
        }
        if (ev.type === "done") {
          atual = null;
          buf = "";
          return;
        }
        if (ev.type === "error" || ev.type === "auth") {
          bolha("erro", ev.message || ev.detail || "o motor falhou");
          atual = null;
          buf = "";
          rolarPraBaixo();
          return;
        }
        if (ev.type === "quota") {
          bolha("erro", "A quota da conta acabou. Troque de conta no computador.");
          rolarPraBaixo();
        }
      }),
    )
    .catch((e) => {
      if (e.name === "AbortError" || abortStream !== ac) return;
      bolha("sys", "— stream caiu; reabra a conversa —");
    });
}

$("form-msg").addEventListener("submit", async (e) => {
  e.preventDefault();
  const texto = $("txt").value.trim();
  if (!texto || !threadId) return;
  fecharSlash();
  $("txt").value = "";
  ajustarAltura();
  bolha("user", texto);
  rolarPraBaixo();
  void dispararMencoes(texto);
  try {
    await req(`/v1/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ text: texto }) });
  } catch (err) {
    bolha("erro", err.message);
    rolarPraBaixo();
  }
});

/** O compositor cresce com o texto, até o teto do CSS. */
function ajustarAltura() {
  const el = $("txt");
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
}

/* ---------- "/" (skills) e "@" (agentes/times) no compositor ---------- */

/** Chave de cache das skills: refaz a varredura só quando pasta ou conta muda. */
function skillsKey() {
  return `${projeto}|${threadProfileId}`;
}

async function carregarSkills() {
  const key = skillsKey();
  if (skills.loading || skills.key === key) return;
  skills.loading = true;
  try {
    const qs = new URLSearchParams();
    if (projeto) qs.set("projectPath", projeto);
    if (threadProfileId) qs.set("profileId", threadProfileId);
    skills.list = await req(`/v1/skills?${qs}`);
    skills.key = key;
  } catch {
    skills.list = [];
  } finally {
    skills.loading = false;
  }
}

function ensureSkillsLoaded() {
  if (skills.key === skillsKey() || skills.loading) return;
  void carregarSkills().then(() => {
    if (slash.open) abrirSlashSeNecessario();
  });
}

/** Agentes e times uma vez por sessão, pro autocomplete do "@" e pro disparo de menção. */
let mencoesCarregando = null;
function carregarMencoesDefs() {
  if (mencoes.loaded) return Promise.resolve();
  if (mencoesCarregando) return mencoesCarregando;
  mencoes.loading = true;
  mencoesCarregando = Promise.all([req("/v1/agents/defs"), req("/v1/teams")])
    .then(([agentDefs, teams]) => {
      mencoes.agentDefs = agentDefs;
      mencoes.teams = teams;
      mencoes.loaded = true;
    })
    .catch(() => {})
    .finally(() => {
      mencoes.loading = false;
      mencoesCarregando = null;
    });
  return mencoesCarregando;
}

function ensureMencoesLoaded() {
  if (mencoes.loaded || mencoes.loading) return;
  void carregarMencoesDefs().then(() => {
    if (slash.open) abrirSlashSeNecessario();
  });
}

function slashMatches(fragment) {
  const f = fragment.toLowerCase();
  return skills.list
    .filter((s) => s.name.toLowerCase().startsWith(f))
    .map((s) => ({ cmd: s.name, desc: s.description || "(sem descrição)", grupo: "Skills" }));
}

function mencaoMatches(fragment) {
  const f = fragment.toLowerCase();
  const agentes = mencoes.agentDefs
    .filter((a) => a.id.toLowerCase().startsWith(f))
    .map((a) => ({ cmd: a.id, desc: a.name, grupo: "Agentes" }));
  const times = mencoes.teams
    .filter((t) => t.id.toLowerCase().startsWith(f))
    .map((t) => ({ cmd: t.id, desc: t.name, grupo: "Times" }));
  return [...agentes, ...times];
}

/**
 * O que o cursor está tentando completar: "/skill" só quando é a mensagem
 * inteira (evita casar um "/" no meio de uma frase normal), ou "@agente"/"@time"
 * em qualquer ponto, contanto que ainda não tenha espaço depois do @.
 */
function detectarGatilho() {
  const el = $("txt");
  const value = el.value;
  const cursor = el.selectionStart ?? value.length;
  const cmd = /^\/([a-z0-9-]*)$/i.exec(value);
  if (cmd) return { kind: "cmd", fragment: cmd[1].toLowerCase(), tokenStart: 0, tokenEnd: value.length };
  const antes = value.slice(0, cursor);
  const at = /(?:^|\s)@([a-z0-9_-]{0,40})$/i.exec(antes);
  if (!at) return null;
  return { kind: "mencao", fragment: at[1].toLowerCase(), tokenStart: antes.length - at[1].length - 1, tokenEnd: cursor };
}

function fecharSlash() {
  if (!slash.open) return;
  slash.open = false;
  $("slash-menu").classList.add("hidden");
}

function aplicarSelecaoSlash(idx) {
  const item = slash.matches[idx];
  if (!item) return;
  const el = $("txt");
  if (slash.kind === "mencao") {
    const gat = detectarGatilho();
    if (gat?.kind !== "mencao") return fecharSlash();
    const antes = el.value.slice(0, gat.tokenStart);
    const depois = el.value.slice(gat.tokenEnd);
    const inserido = `@${item.cmd} `;
    el.value = antes + inserido + depois;
    fecharSlash();
    el.focus();
    const pos = antes.length + inserido.length;
    el.setSelectionRange(pos, pos);
    return;
  }
  el.value = `/${item.cmd} `;
  fecharSlash();
  el.focus();
  ajustarAltura();
}

function renderizarSlash() {
  const menu = $("slash-menu");
  const mencao = slash.kind === "mencao";
  if (!slash.matches.length) {
    menu.innerHTML = `<p class="slash-empty">${mencao ? "Nenhum agente ou time bate com isso." : "Nenhuma skill bate com isso."}</p>`;
    return;
  }
  let html = "";
  for (const grupo of mencao ? ["Agentes", "Times"] : ["Skills"]) {
    const itens = slash.matches.filter((m) => m.grupo === grupo);
    if (!itens.length) continue;
    html += `<div class="slash-group"><h4>${grupo}</h4><ul>`;
    for (const item of itens) {
      const idx = slash.matches.indexOf(item);
      html += `<li class="slash-item" data-idx="${idx}"><span class="cmd">${mencao ? "@" : "/"}${escapeHtml(item.cmd)}</span><span class="desc">${escapeHtml(item.desc)}</span></li>`;
    }
    html += `</ul></div>`;
  }
  menu.innerHTML = html;
  for (const el of menu.querySelectorAll(".slash-item")) {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      aplicarSelecaoSlash(Number(el.dataset.idx));
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function abrirSlashSeNecessario() {
  const gat = detectarGatilho();
  if (!gat) return fecharSlash();
  slash.kind = gat.kind;
  let matches;
  if (gat.kind === "cmd") {
    ensureSkillsLoaded();
    matches = slashMatches(gat.fragment);
  } else {
    ensureMencoesLoaded();
    matches = mencaoMatches(gat.fragment);
  }
  slash.matches = matches;
  slash.open = true;
  $("slash-menu").classList.remove("hidden");
  renderizarSlash();
}

/**
 * `@menção` na mensagem dispara um Run de verdade em paralelo ao turno de chat
 * normal — mesmo `POST /v1/runs` que o Team Studio do desktop já usa. Agente
 * avulso vira (ou reaproveita) um time-pipeline-de-1 oculto via
 * `/v1/teams/mencao/:agentId`.
 */
async function dispararMencoes(texto) {
  const { ids, goal } = extrairMencoes(texto);
  if (!ids.length) return;
  await carregarMencoesDefs();
  for (const id of ids) {
    const time = mencoes.teams.find((t) => t.id === id);
    const agente = time ? null : mencoes.agentDefs.find((a) => a.id === id);
    if (!time && !agente) {
      bolha("sys", `@${id} — não achei agente nem time com esse nome.`);
      continue;
    }
    try {
      const teamId = time ? time.id : (await req(`/v1/teams/mencao/${encodeURIComponent(id)}`, { method: "POST" })).id;
      const run = await req("/v1/runs", { method: "POST", body: JSON.stringify({ teamId, projectPath: projeto, goal }) });
      bolha("sys", `→ Run disparado: ${time?.name ?? agente.name} (${run.id})`);
    } catch (err) {
      bolha("sys", `@${id} — run não disparou: ${err.message || "erro"}`);
    }
    rolarPraBaixo();
  }
}

$("txt").addEventListener("input", () => {
  ajustarAltura();
  abrirSlashSeNecessario();
});

$("txt").addEventListener("keydown", (e) => {
  if (!slash.open) return;
  if (e.key === "Escape") {
    fecharSlash();
    return;
  }
  if (e.key === "Enter" && slash.matches.length) {
    e.preventDefault();
    aplicarSelecaoSlash(0);
  }
});

/* ---------- navegação ---------- */

function mostrar(aba) {
  for (const nome of ["agora", "conversas", "chat"]) {
    $(`aba-${nome}`).classList.toggle("hidden", nome !== aba);
  }
  // o chat é FILHO de "conversas": a aba fica acesa, e o voltar é o que diz
  // que se está um nível abaixo. Sem isso nenhuma aba acende e a barra parece
  // desligada.
  const acesa = aba === "chat" ? "conversas" : aba;
  for (const b of $("tabs").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.aba === acesa);
  }
  $("btn-voltar").hidden = aba !== "chat";
  if (aba !== "chat") $("btn-ajustes").hidden = true;
}

async function abrirAgora() {
  mostrar("agora");
  $("titulo").textContent = "Nexo";
  await puxarAgora();
  comecarRelogio();
}

$("tabs").addEventListener("click", (e) => {
  const aba = e.target?.dataset?.aba;
  if (!aba) return;
  abortStream?.abort();
  if (aba === "agora") void abrirAgora();
  else {
    pararRelogio();
    void abrirConversas();
  }
});

$("btn-voltar").addEventListener("click", () => {
  abortStream?.abort();
  fecharSlash();
  threadId = "";
  threadProfileId = "";
  void abrirConversas();
});

/*
 * Celular suspende a aba quando sai da frente: o relógio pararia sem parar, e
 * voltaria mostrando número velho. Parar e repuxar ao voltar é mais honesto —
 * e economiza bateria.
 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return pararRelogio();
  if (cred && !$("aba-agora").classList.contains("hidden")) void abrirAgora();
});

/**
 * Entrada, em ordem de preferência.
 *
 * O token guardado vem ANTES do código do QR, mesmo com um código na URL: quem
 * põe o app na tela de início guarda o atalho com o fragmento dentro, e aí todo
 * abrir traria um código já queimado. Token que funciona vale mais que código
 * que talvez sirva; se o token estiver morto, o `desparear` cai no código.
 */
function pegarCodigoDaUrl() {
  const c = codigoDaUrl();
  if (!c) return "";
  codigoPendente = c;
  limparUrl();
  $("codigo").value = c;
  return c;
}

/**
 * QR escaneado com o app JÁ ABERTO.
 *
 * Trocar só o fragmento não recarrega a página, então nada aqui reexecuta e a
 * tela fica parada — e é o caso comum de quem põe o Nexo na tela de início: o
 * sistema reaproveita a aba em vez de abrir outra. Sem isto, escanear com o app
 * aberto simplesmente não faz nada, e nem erro aparece.
 */
window.addEventListener("hashchange", () => {
  const c = pegarCodigoDaUrl();
  // já dentro e funcionando não precisa de código nenhum: o token vale mais
  if (c && !cred) void tentarParear(gastarCodigoPendente());
});

pegarCodigoDaUrl();

const guardada = credencialGuardada();
if (guardada) void entrar({ ...guardada, base: guardada.base || location.origin });
else if (codigoPendente) void tentarParear(gastarCodigoPendente());
