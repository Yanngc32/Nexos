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
 * `widget-view.js`. Sem cópia — arquivo copiado diverge.
 */

const $ = (id) => document.getElementById(id);
const PERIODO_MS = 3000;

let cred = null;
let projeto = "";
let threadId = "";
let abortStream = null;
let timer = 0;
let ultimo = null;

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
  for (const t of lista) {
    const li = document.createElement("li");
    const nome = document.createElement("span");
    nome.className = "nome";
    nome.textContent = t.preview || "Conversa nova";
    const quando = document.createElement("span");
    quando.className = "quando";
    quando.textContent = t.busy ? "trabalhando…" : ago(t.updatedAt);
    li.append(nome, quando);
    li.addEventListener("click", () => void abrirChat(t.id, t.preview));
    ul.append(li);
  }
  $("threads-vazio").classList.toggle("hidden", lista.length > 0);
}

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

async function abrirChat(id, titulo) {
  threadId = id;
  mostrar("chat");
  $("titulo").textContent = titulo || "Conversa";
  $("btn-voltar").hidden = false;
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
  $("txt").value = "";
  ajustarAltura();
  bolha("user", texto);
  rolarPraBaixo();
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

$("txt").addEventListener("input", ajustarAltura);

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
  threadId = "";
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
codigoPendente = codigoDaUrl();
if (codigoPendente) {
  limparUrl();
  $("codigo").value = codigoPendente;
}

const guardada = credencialGuardada();
if (guardada) void entrar({ ...guardada, base: guardada.base || location.origin });
else if (codigoPendente) void tentarParear(gastarCodigoPendente());
