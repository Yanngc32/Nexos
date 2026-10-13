/**
 * Aba "Cérebro" — os DADOS: o que a aba pede ao motor, sem DOM.
 *
 * - catálogo do projeto (`GET /v1/cerebro/catalogo`) e linha do tempo (`GET /v1/cerebro/disparos`);
 * - ajustes (`PUT /v1/cerebro/catalogo/:id`): descrição, gatilhos, comoUsar, ligada;
 * - SSE `/v1/cerebro/events` (uso e disparo ao vivo), pela ponte do processo principal
 *   (`fetchStream`), com religação 1,5 s → 30 s; a aba oculta fecha tudo (`pausar`).
 *
 * Eventos ao vivo mexem no catálogo em memória (contadores) e avisam a view (`ouvir("evento")`)
 * pra ela pulsar o nó — sem reconsultar o motor a cada uso.
 */

const SSE_ATRASO_MIN = 1_500;
const SSE_ATRASO_MAX = 30_000;

export function criarCerebroDados({
  req,
  api = (r) => r,
  headers = () => ({}),
  fetchStream = (...a) => globalThis.fetch(...a),
  lerEventos,
  agendar = (f, ms) => setTimeout(f, ms),
  cancelar = (t) => clearTimeout(t),
  log = () => {},
}) {
  let ligado = false;
  let gen = 0;
  /** projectPath do stream aberto ("" = nenhum). */
  let streamDe = null;
  let stream = null;
  const ouvintes = { evento: () => {} };
  const qs = (path) => `projectPath=${encodeURIComponent(path)}`;

  function fecharStream() {
    stream?.abort();
    stream = null;
    streamDe = null;
  }

  function abrirStream(path) {
    if (streamDe === path && stream && !stream.signal.aborted) return;
    fecharStream();
    if (!ligado || !lerEventos) return;
    const ac = new AbortController();
    stream = ac;
    streamDe = path;
    let atraso = SSE_ATRASO_MIN;
    const religar = () => {
      if (stream !== ac || ac.signal.aborted) return;
      agendar(() => stream === ac && conectar(), atraso);
      atraso = Math.min(SSE_ATRASO_MAX, atraso * 2);
    };
    const conectar = () => {
      fetchStream(api(`/v1/cerebro/events?${qs(path)}`), { headers: headers(), signal: ac.signal })
        .then(async (res) => {
          if (!res.ok || !res.body) throw new Error(`cerebro sse ${res.status}`);
          atraso = SSE_ATRASO_MIN;
          await lerEventos(res, (ev) => {
            if (ev && typeof ev === "object" && ev.chave) ouvintes.evento(ev);
          });
          religar();
        })
        .catch((e) => {
          if (e?.name === "AbortError") return;
          log(`cerebro: stream caiu (${e?.message ?? e})`);
          religar();
        });
    };
    conectar();
  }

  return {
    ouvir(nome, f) {
      if (nome in ouvintes) ouvintes[nome] = f;
    },
    /** Catálogo + KPIs do projeto. Sem projeto = chat geral (sem query). */
    async catalogo(path) {
      const r = await req(path ? `/v1/cerebro/catalogo?${qs(path)}` : "/v1/cerebro/catalogo");
      return { itens: Array.isArray(r?.itens) ? r.itens : [], kpis: r?.kpis ?? null };
    },
    async disparos(path, max = 50) {
      const r = await req(`/v1/cerebro/disparos?${path ? `${qs(path)}&` : ""}max=${max}`);
      return Array.isArray(r?.disparos) ? r.disparos : [];
    },
    /** SKILL.md, doc, memória ou descrição do agente, pra pré-visualizar. */
    async conteudo(id, path) {
      return req(`/v1/cerebro/catalogo/${encodeURIComponent(id)}/conteudo${path ? `?${qs(path)}` : ""}`);
    },
    /** Uso de uma capacidade: por conversa, por dia, últimos usos com título, gatilhos sugeridos. */
    async detalhe(id, path) {
      return req(`/v1/cerebro/catalogo/${encodeURIComponent(id)}/uso${path ? `?${qs(path)}` : ""}`);
    },
    async sugestoes(path) {
      const r = await req(`/v1/cerebro/sugestoes${path ? `?${qs(path)}` : ""}`);
      return Array.isArray(r?.sugestoes) ? r.sugestoes : [];
    },
    /** "Testar gatilhos": o que a mensagem acordaria, sem registrar disparo. */
    async testar(texto, path) {
      return req(`/v1/cerebro/testar${path ? `?${qs(path)}` : ""}`, { method: "POST", body: JSON.stringify({ texto }) });
    },
    /** MCP externo do projeto: grava e já tenta listar as ferramentas dele. */
    async salvarMcp(nome, body, path) {
      return req(`/v1/cerebro/mcp/${encodeURIComponent(nome)}?${qs(path)}`, { method: "PUT", body: JSON.stringify(body) });
    },
    async descobrirMcp(nome, path) {
      return req(`/v1/cerebro/mcp/${encodeURIComponent(nome)}/descobrir?${qs(path)}`, { method: "POST" });
    },
    /** Ajuste da pessoa; devolve a capacidade já mesclada. */
    async salvar(id, body, path) {
      return req(`/v1/cerebro/catalogo/${encodeURIComponent(id)}${path ? `?${qs(path)}` : "?escopo=global"}`, { method: "PUT", body: JSON.stringify(body) });
    },
    async removerAjuste(id, path) {
      return req(`/v1/cerebro/catalogo/${encodeURIComponent(id)}${path ? `?${qs(path)}` : "?escopo=global"}`, { method: "DELETE" });
    },
    /** Aba aberta: liga o stream do projeto (troca de projeto = outro stream). */
    acompanhar(path) {
      ligado = true;
      gen++;
      abrirStream(path ?? "");
    },
    /** Aba oculta/fechada: nenhum stream, nenhum timer. */
    pausar() {
      ligado = false;
      gen++;
      fecharStream();
    },
    get ligado() {
      return ligado;
    },
    get projetoDoStream() {
      return streamDe;
    },
  };
}

/**
 * Aplica um evento ao vivo ao catálogo em memória (puro). `uso` soma 7d/30d e marca o último uso;
 * `disparo` soma disparos; `uso` com `usou` soma "usou após disparo". Delegação conta no alvo.
 */
export function aplicarEvento(itens, ev) {
  if (!ev?.chave) return null;
  let id = ev.chave;
  if (id.startsWith("delegar:")) {
    const [alvo, nome] = id.slice("delegar:".length).split("/", 2);
    id = `${alvo === "time" ? "time" : "agente"}:${nome}`;
  }
  const c = itens.find((x) => x.id === id);
  if (!c) return null;
  if (ev.tipo === "uso") {
    c.usos7d = (c.usos7d ?? 0) + 1;
    c.usos30d = (c.usos30d ?? 0) + 1;
    c.ultimoUso = ev.ts;
    if (ev.usou) c.usosAposDisparo30d = (c.usosAposDisparo30d ?? 0) + 1;
  } else if (ev.tipo === "disparo") {
    c.disparos30d = (c.disparos30d ?? 0) + 1;
  }
  return c;
}
