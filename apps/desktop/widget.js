import { createApiClient } from "./api.js";
import { fmtDuracao } from "./agent-trace.js";
import { aneisDeConta, emVoo, faixaDoRun } from "./widget-view.js";

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

const el = (id) => document.getElementById(id);

const api = createApiClient({ daemonInfo: () => window.nexo.daemonInfo() });

let timer = 0;
/** Relógio próprio: o tempo do passo aberto cresce entre um poll e outro. */
let ultimo = null;

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

function pintarVoo(agentes) {
  const n = agentes.length;
  mostrar("bl-voo", n > 0);
  if (!n) return;
  const nomes = agentes.map((a) => a.agentName || a.profileId).join(", ");
  el("voo-txt").textContent = `${n} ${n === 1 ? "conversa trabalhando" : "conversas trabalhando"}: ${nomes}`;
  el("voo-txt").title = nomes;
}

/** A janela acompanha o conteúdo: painel fixo sobraria espaço ou cortaria linha. */
function ajustarAltura() {
  const altura = Math.ceil(el("card").getBoundingClientRect().height) + 12;
  window.nexo.resizeWidget(altura);
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
    mostrar("vazio", true);
    ajustarAltura();
    return agendar(PERIODO_OFF_MS);
  }

  try {
    await api.renovarCredenciais();
    const [runs, contas, agentes] = await Promise.all([
      api.req("/v1/runs"),
      api.req("/v1/accounts/limits"),
      api.req("/v1/agents"),
    ]);
    ultimo = { runs, contas, agentes };
  } catch {
    // um poll que falha não apaga a tela: o retrato anterior continua valendo
    // até a próxima resposta, e apagar faria o painel piscar a cada soluço
  }
  repintar();
  agendar(PERIODO_MS);
}

function repintar() {
  if (!ultimo) return;
  const faixa = faixaDoRun(ultimo.runs, Date.now());
  pintarRun(faixa);
  pintarVoo(emVoo(ultimo.agentes, faixa?.rodando ? faixa.id : ""));
  pintarContas(aneisDeConta(ultimo.contas));
  mostrar("vazio", !faixa && !emVoo(ultimo.agentes).length && !aneisDeConta(ultimo.contas).length);
  ajustarAltura();
}

function agendar(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => void atualizar(), ms);
}

el("fechar").addEventListener("click", () => window.nexo.hideWidget());
// entre polls, só o relógio do passo aberto muda — repintar é barato e local
setInterval(repintar, 250);
void atualizar();
