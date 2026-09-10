import { createApiClient } from "./api.js";
import { fmtDuracao } from "./agent-trace.js";
import { folderName } from "./format.js";
import { aneisDeConta, doProjeto, emVoo, faixaDoRun, porOutrosProjetos, resumoMini } from "./widget-view.js";

/**
 * Painel flutuante: o caminhar das coisas, por cima de tudo.
 *
 * Ele existe porque o resto do Nexo só responde "como vai?" quando você está
 * olhando pra ele — e um time roda por minutos enquanto você está no editor.
 *
 * **Poll, não SSE, e isso é escolha.** Cada fonte aqui tem um stream próprio
 * (run, sessão, serviços) e nenhuma tem um agregado; abrir três streams pra uma
 * faixa de 200px custaria mais em conexão viva do que um GET a cada dois
 * segundos contra um daemon que roda na mesma máquina. Quando o daemon está
 * desligado o poll afrouxa, pra não bater numa porta fechada o dia inteiro.
 */

const PERIODO_MS = 2000;
/** Daemon fora do ar: espaçar evita bater numa porta fechada 30 vezes por minuto. */
const PERIODO_OFF_MS = 8000;

/** No modo cheio a largura é fixa; no mini ela é medida junto com a altura. */
const LARGURA_CHEIA = 264;
/**
 * Folga da janela em volta do cartão, dos dois lados. Vem do CSS (`--folga`)
 * porque é lá que a sombra é dimensionada: número duplicado aqui volta a cortar
 * a sombra no retângulo da janela e desenhar um quadrado em volta da pílula.
 */
const FOLGA = 2 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--folga")) || 10);

const el = (id) => document.getElementById(id);

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Mesmo acento escolhido na janela principal (Configurações → Aparência) — sem isso o painel
 * flutuante ficava preso no azul padrão mesmo com a conta usando outra cor. */
function aplicarAccent(hex) {
  if (HEX.test(hex)) document.documentElement.style.setProperty("--accent", hex);
}

const api = createApiClient({ daemonInfo: () => window.nexo.daemonInfo() });

let timer = 0;
/** Relógio próprio: o tempo do passo aberto cresce entre um poll e outro. */
let ultimo = null;
let mini = false;

function mostrar(id, visivel) {
  el(id).classList.toggle("hidden", !visivel);
}

function corDoUso(uso, bloqueada) {
  if (bloqueada || uso >= 0.95) return "var(--bad)";
  if (uso >= 0.75) return "var(--warn)";
  return "var(--ok)";
}

function pintarContas(contas) {
  const box = el("contas");
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
    id.className = "anel-id";
    id.textContent = c.id;
    const pct = document.createElement("span");
    pct.className = "anel-pct";
    // conta recusada mostra o motivo, não a porcentagem: 100% e "sem login"
    // pedem coisas diferentes de quem está olhando
    pct.textContent = c.bloqueada ? "bloqueada" : `${Math.round(c.uso * 100)}%`;
    txt.append(id, pct);
    linha.append(arco, txt);
    linha.title = `${c.id}${c.engine ? ` · ${c.engine}` : ""}`;
    box.append(linha);
  }
  mostrar("bl-contas", contas.length > 0);
}

function pintarProjetos(grupos) {
  const box = el("projetos");
  box.replaceChildren();
  for (const g of grupos) {
    const linha = document.createElement("div");
    linha.className = "projeto-linha";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.dataset.on = "1";
    const nome = document.createElement("span");
    nome.className = "projeto-nome";
    nome.textContent = folderName(g.projectPath);
    const count = document.createElement("span");
    count.className = "projeto-count";
    count.textContent = `${g.agentes.length} ${g.agentes.length === 1 ? "conversa" : "conversas"}`;
    linha.append(dot, nome, count);
    linha.title = `${g.projectPath} — ${g.agentes.map((a) => a.agentName || a.profileId).join(", ")}`;
    box.append(linha);
  }
  mostrar("bl-outros", grupos.length > 0);
}

function pintarRun(faixa) {
  mostrar("bl-run", Boolean(faixa));
  if (!faixa) return;
  el("run-obj").textContent = faixa.objetivo || "sem objetivo";
  el("run-obj").title = faixa.objetivo;
  el("run-dot").dataset.on = faixa.rodando ? "1" : "0";
  el("run-dot").dataset.erro = faixa.status === "error" ? "1" : "0";
  el("run-quem").textContent = faixa.rodando ? faixa.agente || "montando…" : faixa.status;
  el("run-passos").textContent = faixa.total ? `${faixa.feitos}/${faixa.total}` : "";
  el("run-ms").textContent = faixa.ms ? fmtDuracao(faixa.ms) : "";
  const pct = faixa.total ? Math.round((faixa.feitos / faixa.total) * 100) : 0;
  el("run-fill").style.width = `${pct}%`;
  const custo = faixa.custoUsd ? `US$ ${faixa.custoUsd.toFixed(4)}` : "";
  const teto = faixa.tetoUsd ? ` de US$ ${faixa.tetoUsd}` : "";
  el("run-custo").textContent = custo ? `${custo}${teto}` : "";
  mostrar("run-custo", Boolean(custo));
}

/**
 * Uma linha por conversa em voo — antes era um texto só ("N conversas: a, b, c") que ficava
 * idêntico ao nome já mostrado no anel de conta logo abaixo (`bl-contas`), parecendo repetição.
 * Aqui cada linha soma o que só ELA sabe: há quanto tempo está no ar.
 */
function pintarVoo(agentes) {
  const box = el("voo");
  box.replaceChildren();
  const agora = Date.now();
  for (const a of agentes) {
    const linha = document.createElement("div");
    linha.className = "voo-linha";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.dataset.on = "1";
    const nome = document.createElement("span");
    nome.className = "voo-nome";
    nome.textContent = a.agentName || a.profileId;
    const tempo = document.createElement("span");
    tempo.className = "voo-tempo";
    tempo.textContent = a.startedAt ? fmtDuracao(Math.max(0, agora - a.startedAt)) : "";
    linha.append(dot, nome, tempo);
    // o rabo da saída não cabe na linha, mas continua legível ao pousar o mouse
    if (a.tail) linha.title = a.tail.trim().slice(-160);
    box.append(linha);
  }
  mostrar("bl-voo", agentes.length > 0);
}

function pintarMini(r) {
  el("mini-dot").dataset.on = r.ligado ? "1" : "0";
  el("mini-dot").dataset.erro = r.erro ? "1" : "0";
  // sem passos ainda, o tempo já diz que algo anda; quieto ganha o traço, que
  // ocupa a mesma linha e evita uma pílula de altura estranha
  el("mini-passos").textContent = r.passos || (r.quieto ? "—" : "");
  el("mini-ms").textContent = r.ms ? fmtDuracao(r.ms) : r.quemTrabalha || "";
  // o que a pílula não mostra continua legível ao pousar o mouse
  el("bl-mini").title = r.tituloStatus;
  mostrar("mini-quota", Boolean(r.quota));
  if (!r.quota) return;
  el("mini-arco").style.setProperty("--pct", String(r.quota.pct));
  el("mini-arco").style.setProperty("--cor", corDoUso(r.quota.uso, r.quota.bloqueada));
  el("mini-pct").textContent = r.quota.bloqueada ? "!" : `${r.quota.pct}%`;
  el("mini-pct").dataset.bad = r.quota.bloqueada ? "1" : "0";
  el("mini-quota").title = r.tituloQuota;
}

/**
 * A janela acompanha o conteúdo: painel fixo sobraria espaço ou cortaria linha.
 * No mini a largura também é medida — a pílula é `max-content`, então sobra de
 * janela é sobra de área morta por cima do que está atrás.
 */
function ajustarJanela() {
  const r = el("card").getBoundingClientRect();
  const largura = mini ? Math.ceil(r.width) + FOLGA : LARGURA_CHEIA;
  window.nexo.resizeWidget(largura, Math.ceil(r.height) + FOLGA);
}

function aplicarMini(on) {
  mini = on;
  if (on) document.body.dataset.mini = "1";
  else delete document.body.dataset.mini;
  const b = el("mini");
  b.title = on ? "Expandir" : "Minimizar";
  b.textContent = on ? "+" : "−";
}

function alternarMini(on) {
  aplicarMini(on);
  window.nexo.setWidgetMini(on);
  repintar();
  // repintar não mede a janela sem dados; trocar de modo sempre muda o tamanho
  ajustarJanela();
}

async function atualizar() {
  let ok = false;
  try {
    const info = await window.nexo.daemonInfo();
    ok = Boolean(info?.ok);
  } catch {
    ok = false;
  }
  mostrar("off", !ok);
  if (!ok) {
    ultimo = null;
    pintarRun(null);
    pintarVoo([]);
    pintarContas([]);
    pintarMini(resumoMini(null, [], []));
    mostrar("vazio", true);
    ajustarJanela();
    return agendar(PERIODO_OFF_MS);
  }

  try {
    await api.renovarCredenciais();
    /*
     * O projeto vem do processo principal, que é quem sabe qual janela está com
     * qual pasta — o painel é outra janela e não compartilha estado com ela.
     * Relido a cada volta: trocar de projeto no app muda o painel sem reabrir.
     *
     * O daemon devolve UM run — o do momento, já filtrado por projeto. Pedir a
     * lista pra escolher aqui lia todo `run.json` da máquina e serializava
     * megabytes a cada dois segundos. As conversas em voo vêm todas e o filtro
     * é aqui; a QUOTA não filtra, porque é da conta e não do projeto.
     */
    const projeto = await window.nexo.cwd().catch(() => "");
    const [run, contas, agentes, cfg] = await Promise.all([
      api.req(`/v1/runs/atual${projeto ? `?projectPath=${encodeURIComponent(projeto)}` : ""}`),
      api.req("/v1/accounts/limits"),
      api.req("/v1/agents"),
      api.req("/v1/config").catch(() => null),
    ]);
    if (cfg?.accent) aplicarAccent(cfg.accent);
    ultimo = { run, contas, agentes, projeto };
    // o cabeçalho diz DE QUAL projeto é o que está abaixo: "Nexo" ali não
    // informava nada, e com dois projetos abertos a faixa ficava ambígua
    el("grip").textContent = projeto ? folderName(projeto) : "Nexo";
    el("grip").title = projeto || "nenhum projeto aberto — mostrando tudo";
  } catch {
    // um poll que falha não apaga a tela: o retrato anterior continua valendo
    // até a próxima resposta, e apagar faria o painel piscar a cada soluço
  }
  repintar();
  agendar(PERIODO_MS);
}

function repintar() {
  if (!ultimo) return;
  const faixa = faixaDoRun(ultimo.run, Date.now());
  const agentes = doProjeto(ultimo.agentes, ultimo.projeto);
  const emVooAgora = emVoo(agentes, faixa?.rodando ? faixa.id : "");
  const aneis = aneisDeConta(ultimo.contas);
  const outrosProjetos = porOutrosProjetos(ultimo.agentes, ultimo.projeto);
  pintarRun(faixa);
  pintarVoo(emVooAgora);
  pintarContas(aneis);
  pintarProjetos(outrosProjetos);
  // as duas versões são pintadas sempre: o CSS escolhe qual aparece, e assim
  // voltar do mini não espera o próximo poll pra ter conteúdo
  pintarMini(resumoMini(faixa, emVooAgora, aneis, outrosProjetos));
  mostrar("vazio", !faixa && !emVooAgora.length && !aneis.length && !outrosProjetos.length);
  ajustarJanela();
}

function agendar(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => void atualizar(), ms);
}

/**
 * O modo vem antes do primeiro retrato: nascer cheio e encolher depois faria a
 * janela pular no canto da tela a cada abertura. App sem a API cai no cheio.
 */
async function iniciar() {
  let salvo = null;
  try {
    salvo = await window.nexo.widgetState?.();
  } catch {
    salvo = null;
  }
  aplicarMini(Boolean(salvo?.mini));
  await atualizar();
}

el("fechar").addEventListener("click", () => window.nexo.hideWidget());
el("mini").addEventListener("click", () => alternarMini(!mini));
// entre polls, só o relógio do passo aberto muda — repintar é barato e local
setInterval(repintar, 250);
void iniciar();
