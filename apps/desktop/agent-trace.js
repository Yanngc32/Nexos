/**
 * Traço de um turno: transforma o stream de eventos do motor numa lista de
 * etapas com duração e custo — é o que a bancada de teste desenha.
 *
 * De onde vem o tempo: o stream NÃO carrega carimbo de hora. O daemon manda o
 * evento assim que o motor produz, então a hora é a da chegada aqui. Isso mede
 * tempo de parede (inclui a rede local e a fila do renderer), não tempo de CPU
 * do modelo — para comparar duas instruções é exatamente o que interessa, mas
 * não é um profiler.
 *
 * De onde vem o token: o motor manda `usage` por requisição, não por etapa. Um
 * turno com três ferramentas manda vários `usage`, e cada um cobre tudo que
 * aconteceu desde o anterior. Por isso o número é anexado à etapa aberta quando
 * ele chega e vem marcado como `aproximado` — dizer "esta ferramenta custou X"
 * seria precisão inventada. O total do turno, esse é exato.
 */

/** Eventos que fecham o turno. */
const FINAIS = new Set(["done", "quota", "auth", "error"]);

const ROTULO_FINAL = {
  quota: "Quota estourou",
  auth: "Precisa de login",
  error: "Erro do motor",
};

export function createTrace({ agora = () => Date.now() } = {}) {
  /** @type {Array<object>} */
  let passos = [];
  let inicio = 0;
  let fim = 0;
  let atual = null;
  let totais = zerarTotais();
  let terminou = null;

  function zerarTotais() {
    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0, custoUsd: 0, contextTokens: 0 };
  }

  function fecharAtual(t) {
    if (!atual) return;
    atual.fim = t;
    atual.ms = t - atual.inicio;
    atual = null;
  }

  function abrir(tipo, rotulo, t) {
    fecharAtual(t);
    atual = { tipo, rotulo, inicio: t, desdeInicio: t - inicio, fim: 0, ms: 0 };
    passos.push(atual);
    return atual;
  }

  /** Começa um turno novo. O anterior é descartado: a bancada mede um turno por vez. */
  function iniciar(prompt = "") {
    const t = agora();
    passos = [];
    atual = null;
    totais = zerarTotais();
    terminou = null;
    inicio = t;
    fim = 0;
    if (prompt) {
      // etapa de largada com duração zero: marca o instante do envio na régua
      passos.push({ tipo: "envio", rotulo: "Enviado", inicio: t, desdeInicio: 0, fim: t, ms: 0 });
    }
  }

  /**
   * Aplica um evento. Devolve true quando o desenho precisa ser refeito.
   */
  function aplicar(ev) {
    if (!ev || typeof ev.type !== "string") return false;
    const t = agora();

    switch (ev.type) {
      case "thinking":
        // pensamentos seguidos são uma etapa só: cada token vira um evento
        if (atual?.tipo !== "thinking") abrir("thinking", "Pensando", t);
        if (ev.tokens) atual.tokens = ev.tokens;
        return true;

      case "text":
        if (atual?.tipo !== "text") abrir("text", "Escrevendo", t);
        atual.chars = (atual.chars ?? 0) + String(ev.text ?? "").length;
        return true;

      case "tool":
        // toda ferramenta é uma etapa própria, mesmo duas iguais seguidas
        abrir("tool", ev.name || "ferramenta", t).detalhe = ev.summary || "";
        return true;

      case "context":
        totais.contextTokens = ev.contextTokens ?? totais.contextTokens;
        return true;

      case "usage": {
        totais.input += ev.input ?? 0;
        totais.output += ev.output ?? 0;
        totais.cacheRead += ev.cacheRead ?? 0;
        totais.cacheCreate += ev.cacheCreate ?? 0;
        totais.thinking += ev.thinking ?? 0;
        totais.custoUsd += ev.costUsd ?? 0;
        if (ev.contextTokens) totais.contextTokens = ev.contextTokens;
        // anexa à etapa aberta, marcado como aproximado — ver cabeçalho
        const alvo = atual ?? passos.at(-1);
        if (alvo) {
          alvo.tokens = (alvo.tokens ?? 0) + (ev.input ?? 0) + (ev.output ?? 0);
          alvo.custoUsd = (alvo.custoUsd ?? 0) + (ev.costUsd ?? 0);
          alvo.aproximado = true;
        }
        return true;
      }

      case "session":
        if (ev.model) totais.model = ev.model;
        if (ev.contextWindow) totais.contextWindow = ev.contextWindow;
        return true;

      default:
        if (!FINAIS.has(ev.type)) return false;
        fecharAtual(t);
        fim = t;
        terminou = ev.type;
        if (ev.type !== "done") {
          const rotulo = ROTULO_FINAL[ev.type] ?? "Fim";
          passos.push({
            tipo: "falha",
            rotulo,
            detalhe: String(ev.detail || ev.message || ""),
            inicio: t,
            desdeInicio: t - inicio,
            fim: t,
            ms: 0,
          });
        }
        return true;
    }
  }

  /** Duração do turno: até agora se está rodando, até o fim se acabou. */
  function duracao() {
    if (!inicio) return 0;
    return (fim || agora()) - inicio;
  }

  function resumo() {
    return {
      ms: duracao(),
      rodando: Boolean(inicio) && !fim,
      terminou,
      passos: passos.length,
      ferramentas: passos.filter((p) => p.tipo === "tool").length,
      ...totais,
    };
  }

  /** Etapas com a duração da que ainda está aberta calculada na hora. */
  function lista() {
    const t = agora();
    return passos.map((p) => (p.fim ? p : { ...p, ms: t - p.inicio, aberta: true }));
  }

  return { iniciar, aplicar, lista, resumo };
}

/** Duração legível: ms abaixo de um segundo, senão segundos com uma casa. */
export function fmtDuracao(ms) {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  const min = Math.floor(v / 60_000);
  const seg = Math.round((v % 60_000) / 1000);
  return `${min}m${String(seg).padStart(2, "0")}`;
}

/**
 * Largura da barra de cada etapa, em porcentagem da mais longa. As de duração
 * zero (envio, falha) ficam sem barra: uma barra de 0% some, e uma de 1% mente.
 */
export function larguras(passos) {
  const maior = Math.max(0, ...passos.map((p) => p.ms || 0));
  return passos.map((p) => (!maior || !p.ms ? 0 : Math.max(2, Math.round((p.ms / maior) * 100))));
}
