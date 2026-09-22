/**
 * Barra "trabalhando" acima do input: os times/subagentes que ESTE chat chamou (menção, roteador
 * aceito, `nexo_delegar`), com o passo atual e quem está trabalhando. Os passos não aparecem mais
 * soltos na barra lateral — pertencem ao chat de origem (`thread_meta.origemThreadId`), e é por
 * aqui que a pessoa acompanha e abre cada um.
 *
 * Dados: `GET /v1/threads/:id/runs` ao abrir o chat e, ao vivo, o evento `run_evento` que o
 * daemon manda no stream do PRÓPRIO chat (runs.ts `emit`) — sem stream extra por run.
 *
 * Mesmo idioma dos outros componentes: dependências por parâmetro, funções puras exportadas.
 */
import { aplicarEventoDeRun, passoEmVoo, resumoDoRun } from "./run-view.js";
import { fmtDuracao } from "./agent-trace.js";

/** Quanto tempo um run que terminou continua na barra (pra pessoa ver que acabou). */
export const MOSTRAR_FECHADO_MS = 8000;

/** Runs que merecem aparecer: em curso, ou que acabaram há pouco. Mais recente primeiro. */
export function runsVisiveis(runs, agora = Date.now()) {
  return [...(runs || [])]
    .filter((r) => r.status === "running" || (r.endedAt && agora - Date.parse(r.endedAt) < MOSTRAR_FECHADO_MS))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Frase curta do estado do run. "na fila" = já criado, esperando o time anterior deste chat
 * acabar (runs.ts `executarNoChat`): nenhum passo começou ainda.
 */
export function fraseDoRun(run, nomeDoAgente = (id) => id) {
  if (run.status === "done") return "terminou";
  if (run.status === "aborted") return "cancelado";
  if (run.status === "error") return "falhou";
  const passo = passoEmVoo(run);
  const total = run.steps?.length || 0;
  if (!passo) {
    const algum = (run.steps || []).some((s) => s.status && s.status !== "pending");
    return algum ? "passando pro próximo" : "na fila";
  }
  const pos = total > 1 ? `passo ${passo.index + 1}/${total} · ` : "";
  return `${pos}${nomeDoAgente(passo.agentId)} trabalhando`;
}

export function createBarraTimes({ el, req, doc = document, nomeDoAgente = (id) => id, nomeDoTime = (id) => id, aoAbrirPasso = () => {} }) {
  /** runId → run (do daemon, atualizado pelos eventos) */
  let runs = new Map();
  let threadAtual = "";
  const abertos = new Set();
  let relogio = 0;

  async function carregar(threadId) {
    threadAtual = threadId || "";
    runs = new Map();
    pintar();
    if (!threadAtual) return;
    try {
      const lista = await req(`/v1/threads/${encodeURIComponent(threadAtual)}/runs`);
      if (threadAtual !== threadId) return; // trocou de conversa no meio
      runs = new Map((lista || []).map((r) => [r.id, r]));
    } catch {
      runs = new Map();
    }
    pintar();
  }

  /** Evento `run_evento` do stream do chat. Run que a barra ainda não conhece é buscado inteiro. */
  async function aplicar(ev) {
    if (!ev || ev.threadId !== threadAtual || !ev.runId || !ev.ev) return;
    let run = runs.get(ev.runId);
    if (!run) {
      try {
        run = await req(`/v1/runs/${encodeURIComponent(ev.runId)}`);
      } catch {
        return;
      }
      if (ev.threadId !== threadAtual) return;
      runs.set(run.id, run);
    }
    aplicarEventoDeRun(run, ev.ev);
    pintar();
  }

  function pintar() {
    const barra = el("times-bar");
    if (!barra) return;
    const visiveis = runsVisiveis([...runs.values()]);
    barra.classList.toggle("hidden", visiveis.length === 0);
    barra.replaceChildren();
    for (const run of visiveis) barra.append(linhaDoRun(run));
    // relógio só enquanto houver algo rodando (ou esperando sumir)
    clearInterval(relogio);
    if (visiveis.length) relogio = setInterval(pintarTempos, 1000);
  }

  function pintarTempos() {
    const barra = el("times-bar");
    if (!barra) return;
    const visiveis = runsVisiveis([...runs.values()]);
    if (visiveis.length !== barra.querySelectorAll(".tb-run").length) {
      pintar();
      return;
    }
    for (const n of barra.querySelectorAll(".tb-run")) {
      const run = runs.get(n.dataset.run);
      if (run) n.querySelector(".tb-tempo").textContent = fmtDuracao(resumoDoRun(run).ms);
    }
  }

  function linhaDoRun(run) {
    const caixa = doc.createElement("div");
    caixa.className = "tb-run";
    caixa.dataset.run = run.id;
    caixa.dataset.status = run.status;
    const aberto = abertos.has(run.id);
    const cab = doc.createElement("button");
    cab.type = "button";
    cab.className = "tb-cab";
    cab.setAttribute("aria-expanded", aberto ? "true" : "false");
    cab.innerHTML = `<span class="tb-dot" aria-hidden="true"></span><strong class="tb-nome"></strong><span class="tb-frase"></span><span class="tb-tempo"></span><span class="tb-seta" aria-hidden="true">▸</span>`;
    cab.querySelector(".tb-nome").textContent = nomeDoTime(run.teamId);
    cab.querySelector(".tb-frase").textContent = fraseDoRun(run, nomeDoAgente);
    cab.querySelector(".tb-tempo").textContent = fmtDuracao(resumoDoRun(run).ms);
    cab.addEventListener("click", () => {
      if (abertos.has(run.id)) abertos.delete(run.id);
      else abertos.add(run.id);
      pintar();
    });
    const linha = doc.createElement("div");
    linha.className = "tb-linha";
    linha.append(cab);
    if (run.status === "running") {
      // na fila = ainda não começou: "Cancelar"; em curso: "Parar" o time inteiro
      const naFila = fraseDoRun(run) === "na fila";
      linha.append(
        botaoParar(naFila ? "Cancelar" : "Parar time", naFila ? "Tirar este time da fila" : "Parar o time inteiro", () =>
          req(`/v1/runs/${encodeURIComponent(run.id)}/abort`, { method: "POST", body: "{}" }),
        ),
      );
    }
    caixa.append(linha);
    if (aberto) {
      const lista = doc.createElement("ol");
      lista.className = "tb-passos";
      for (const passo of run.steps || []) {
        if (!passo) continue;
        const li = doc.createElement("li");
        li.dataset.status = passo.status || "pending";
        const nome = doc.createElement("span");
        nome.className = "tb-passo-nome";
        nome.textContent = `${passo.index + 1}. ${nomeDoAgente(passo.agentId)}${passo.papel ? ` — ${passo.papel}` : ""}`;
        const estado = doc.createElement("span");
        estado.className = "tb-passo-estado";
        estado.textContent =
          passo.status === "running" ? "trabalhando" : passo.status === "done" ? "pronto" : passo.status === "error" ? "erro" : passo.status === "skipped" ? "pulado" : "na fila";
        li.append(nome, estado);
        // colunas fixas (estado | parar | ver): vaga vazia quando o botão não se aplica, senão as
        // linhas desalinham entre si
        const vaga = () => {
          const v = doc.createElement("span");
          v.className = "tb-vaga";
          return v;
        };
        li.append(
          passo.status === "running"
            ? botaoParar("Parar", "Parar só este agente", () =>
                req(`/v1/runs/${encodeURIComponent(run.id)}/steps/${passo.index}/parar`, { method: "POST", body: "{}" }),
              )
            : vaga(),
        );
        if (passo.threadId) {
          const ver = doc.createElement("button");
          ver.type = "button";
          ver.className = "ghost tb-ver";
          ver.textContent = "Ver conversa";
          ver.addEventListener("click", () => aoAbrirPasso(passo.threadId));
          li.append(ver);
        } else li.append(vaga());
        lista.append(li);
      }
      caixa.append(lista);
    }
    return caixa;
  }

  /** Botão de parar: desabilita no clique; quem atualiza o estado é o evento que o daemon manda depois. */
  function botaoParar(rotulo, titulo, acao) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "ghost tb-parar";
    b.textContent = rotulo;
    b.title = titulo;
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      b.disabled = true;
      b.textContent = "Parando…";
      try {
        await acao();
      } catch {
        b.disabled = false;
        b.textContent = rotulo;
      }
    });
    return b;
  }

  return { carregar, aplicar, pintar, _runs: () => runs };
}
