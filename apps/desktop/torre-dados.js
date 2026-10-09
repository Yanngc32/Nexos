/**
 * Torre de magia — os DADOS: tudo o que a aba pede ao motor, sem DOM.
 *
 * - retrato das conversas (`GET /v1/agents`) + limites das contas, a cada poucos segundos
 *   enquanto a aba está aberta (o estado ao vivo vem dos eventos que o renderer já recebe:
 *   `aoEventoAgente`);
 * - SSE de runs (bibliotecário), do Quadro e do vídeo (rolo do Ateliê) dos projetos observados;
 * - consultas por projeto: planos (estrelas), Quadro (mural), aprendizados pendentes.
 *
 * Streams SSE passam pela ponte do processo principal (`fetchStream`): o renderer só abre 6
 * conexões por host e a torre não pode tomar o lugar das outras telas. A aba oculta liga/desliga
 * isto tudo (`pausar`/`retomar`): nenhum timer roda escondido.
 */
import { aplicarEventoAgente, aplicarEventoRun, aplicarEventoVideo, aplicarRetrato, chaveDoProjeto, feedVazio, limparFeed } from "./torre/feed.js";

export const RETRATO_MS = 4_000;
export const PLANOS_MS = 10_000;
const SSE_ATRASO_MIN = 1_500;
const SSE_ATRASO_MAX = 30_000;

/**
 * @param {object} o
 * @param o.req        `(rota, init?) => Promise<json>` do app
 * @param o.api        monta a URL de um stream a partir da rota
 * @param o.headers    cabeçalhos de autenticação
 * @param o.fetchStream `fetch` dos streams (ponte SSE)
 * @param o.lerEventos `lerEventos(res, onEvent)` do sse.js
 * @param o.aprendizadosDe `(projectPath) => número` pendentes (o app já guarda)
 */
export function criarTorreDados({
  req,
  api = (r) => r,
  headers = () => ({}),
  fetchStream = (...a) => globalThis.fetch(...a),
  lerEventos,
  aprendizadosDe = () => 0,
  relogio = () => Date.now(),
  agendar = (f, ms) => setTimeout(f, ms),
  cancelar = (t) => clearTimeout(t),
  log = () => {},
}) {
  const feed = feedVazio();
  let ligado = false;
  let pausado = false;
  let gen = 0;
  let timerRetrato = null;
  let timerPlanos = null;
  /** projectPath → o que observa (streams do Quadro e do vídeo). */
  const observados = new Map();
  /** Streams abertos: nome → AbortController. */
  const streams = new Map();
  let foco = "";
  const ouvintes = { quadro: () => {}, quadroCarregado: () => {}, retrato: () => {} };

  const resetar = () => {
    for (const k of Object.keys(feed)) delete feed[k];
    Object.assign(feed, feedVazio());
  };

  async function retrato() {
    const minha = gen;
    const [agentes, contas, defs, times] = await Promise.all([
      req("/v1/agents"),
      req("/v1/accounts/limits").catch(() => feed.contas),
      feed.defs.size ? Promise.resolve(null) : req("/v1/agents/defs").catch(() => null),
      feed.defs.size ? Promise.resolve(null) : req("/v1/teams").catch(() => null),
    ]);
    if (minha !== gen) return false;
    const agora = relogio();
    aplicarRetrato(feed, agentes, agora);
    if (Array.isArray(contas)) feed.contas = contas;
    // times entram no mesmo mapa: o explorador de `nexo_delegar` leva o nome do time no rótulo
    if (Array.isArray(defs)) feed.defs = new Map([...(Array.isArray(times) ? times.map((t) => [t.id, { name: t.name, color: "" }]) : []), ...defs.map((d) => [d.id, { name: d.name, color: d.color }])]);
    for (const path of observados.keys()) feed.aprendizados.set(chaveDoProjeto(path), aprendizadosDe(path) || 0);
    limparFeed(feed, agora);
    ouvintes.retrato();
    return true;
  }

  function agendarRetrato() {
    cancelar(timerRetrato);
    if (!ligado || pausado) return;
    const minha = gen;
    timerRetrato = agendar(async () => {
      try {
        await retrato();
      } catch (e) {
        log(`torre: retrato falhou (${e?.message ?? e})`);
      }
      if (minha === gen) agendarRetrato();
    }, RETRATO_MS);
  }

  /** Stream com religação (1,5 s → 30 s) enquanto a aba quer ele. */
  function abrirStream(nome, rota, aoEvento) {
    fecharStream(nome);
    if (!ligado || pausado || !lerEventos) return;
    const ac = new AbortController();
    streams.set(nome, ac);
    let atraso = SSE_ATRASO_MIN;
    const religar = () => {
      if (streams.get(nome) !== ac || ac.signal.aborted) return;
      agendar(() => streams.get(nome) === ac && conectar(), atraso);
      atraso = Math.min(SSE_ATRASO_MAX, atraso * 2);
    };
    const conectar = () => {
      fetchStream(api(rota), { headers: headers(), signal: ac.signal })
        .then(async (res) => {
          if (!res.ok || !res.body) throw new Error(`${nome} sse ${res.status}`);
          atraso = SSE_ATRASO_MIN;
          await lerEventos(res, (ev) => aoEvento(ev));
          religar();
        })
        .catch((e) => {
          if (e?.name === "AbortError") return;
          religar();
        });
    };
    conectar();
  }

  function fecharStream(nome) {
    streams.get(nome)?.abort();
    streams.delete(nome);
  }

  const qs = (path) => `projectPath=${encodeURIComponent(path)}`;

  function observar(path) {
    if (observados.has(path)) return;
    observados.set(path, true);
    const chave = chaveDoProjeto(path);
    feed.aprendizados.set(chave, aprendizadosDe(path) || 0);
    if (feed.quadroLigado) abrirStream(`quadro:${chave}`, `/v1/tarefas/events?${qs(path)}`, (ev) => {
      if (!ev?.tarefaId && ev?.tipo !== "colunas") return;
      const agora = relogio();
      feed.muralEm.set(chave, agora);
      ouvintes.quadro(ev, path, agora);
    });
    abrirStream(`video:${chave}`, `/v1/videos/events?${qs(path)}`, (ev) => aplicarEventoVideo(feed, path, ev, relogio()));
  }

  function desobservar(path) {
    if (!observados.delete(path)) return;
    const chave = chaveDoProjeto(path);
    fecharStream(`quadro:${chave}`);
    fecharStream(`video:${chave}`);
  }

  /** Planos do projeto (estrelas do Observatório). */
  async function planos(path) {
    const minha = gen;
    try {
      const lista = await req(`/v1/planejamento?${qs(path)}`);
      if (minha !== gen) return;
      feed.planos.set(chaveDoProjeto(path), Array.isArray(lista) ? lista : []);
      feed.semLeitura.get(chaveDoProjeto(path))?.delete("observatorio");
    } catch (e) {
      if (minha !== gen) return;
      marcarSemLeitura(path, "observatorio");
      log(`torre: planos de ${path} falharam (${e?.message ?? e})`);
    }
  }

  function marcarSemLeitura(path, andar) {
    const chave = chaveDoProjeto(path);
    if (!feed.semLeitura.has(chave)) feed.semLeitura.set(chave, new Set());
    feed.semLeitura.get(chave).add(andar);
  }

  /** Quadro do projeto (mural): colunas + tarefas. */
  async function quadro(path) {
    // módulo Quadro de tarefas desligado: mural vazio, sem consulta
    if (!feed.quadroLigado) return;
    const minha = gen;
    try {
      const [q, tarefas] = await Promise.all([req(`/v1/tarefas/quadro?${qs(path)}`), req(`/v1/tarefas?${qs(path)}`)]);
      if (minha !== gen) return;
      feed.quadros.set(chaveDoProjeto(path), { colunas: q?.colunas ?? [], tarefas: Array.isArray(tarefas) ? tarefas : [] });
      feed.semLeitura.get(chaveDoProjeto(path))?.delete("quadro");
      ouvintes.quadroCarregado(path, q, tarefas);
    } catch (e) {
      if (minha !== gen) return;
      marcarSemLeitura(path, "quadro");
      log(`torre: quadro de ${path} falhou (${e?.message ?? e})`);
    }
  }

  function agendarPlanos() {
    cancelar(timerPlanos);
    if (!ligado || pausado || !foco) return;
    const minha = gen;
    timerPlanos = agendar(async () => {
      if (foco) await planos(foco);
      if (minha === gen) agendarPlanos();
    }, PLANOS_MS);
  }

  return {
    feed,
    /** Quem quer saber: `quadro(ev, path, agora)`, `quadroCarregado(path, quadro, tarefas)`, `retrato()`. */
    ouvir(nome, f) {
      if (nome in ouvintes) ouvintes[nome] = f;
    },
    /** Liga (aba aberta): zera o feed, lê o retrato e abre os streams globais. Devolve false se o motor não respondeu. */
    async ligar() {
      gen++;
      ligado = true;
      pausado = false;
      resetar();
      let ok = true;
      const minha = gen;
      const cfg = await req("/v1/config").catch(() => null);
      if (minha !== gen) return false;
      feed.quadroLigado = cfg?.modulos?.quadroTarefas !== false;
      try {
        await retrato();
      } catch (e) {
        ok = false;
        log(`torre: retrato falhou (${e?.message ?? e})`);
      }
      abrirStream("runs", "/v1/runs/events", (ev) => aplicarEventoRun(feed, ev, relogio()));
      agendarRetrato();
      return ok;
    },
    /** Aba oculta ou fechada: nenhum timer, nenhum stream. */
    pausar() {
      pausado = true;
      cancelar(timerRetrato);
      cancelar(timerPlanos);
      for (const nome of [...streams.keys()]) fecharStream(nome);
      observados.clear();
      foco = "";
    },
    /** Aba voltou: recomeça do retrato de agora (nada reencena o que passou). */
    async retomar(projetos = [], projetoAberto = "") {
      const ok = await this.ligar();
      this.observar(projetos, projetoAberto);
      return ok;
    },
    desligar() {
      this.pausar();
      ligado = false;
      gen++;
    },
    /** Quais projetos acompanhar (Quadro e vídeo) e qual está aberto (consultas de detalhe). */
    observar(projetos, projetoAberto = "") {
      if (!ligado || pausado) return;
      const querem = new Set((projetos ?? []).filter(Boolean));
      if (projetoAberto) querem.add(projetoAberto);
      for (const p of [...observados.keys()]) if (!querem.has(p)) desobservar(p);
      for (const p of querem) observar(p);
      if (projetoAberto !== foco) {
        foco = projetoAberto || "";
        if (foco) {
          void planos(foco);
          void quadro(foco);
        }
        agendarPlanos();
      }
    },
    /** Recarrega as consultas do projeto aberto (depois de uma mudança grande). */
    async atualizarDetalhe() {
      if (foco) await Promise.all([planos(foco), quadro(foco)]);
    },
    /** Evento do SSE global de agentes (o renderer já tem esse stream). */
    aoEventoAgente(ev) {
      if (!ligado || pausado) return false;
      return aplicarEventoAgente(feed, ev, relogio());
    },
    retrato,
    get ligado() {
      return ligado && !pausado;
    },
    get projetoAberto() {
      return foco;
    },
  };
}
