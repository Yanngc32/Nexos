/**
 * Torre de magia — camada 2: o MODELO.
 *
 * `torreModelo(feed, agora)` transforma o feed em torres (uma por projeto) e personagens com
 * CHAVE ESTÁVEL — `conv:<threadId>` (mago do Salão), `astro:<slug>` (Manager do plano, no
 * Observatório), `exp:<id da chamada Agent>` (explorador), `biblio:<runId>` (hook de memória/repo
 * map), `pintor:<projeto>` (Ateliê). Nada aqui decide lugar nem animação: só quem existe, em que
 * estado, e o que cada andar tem.
 */
import { folderName } from "../format.js";
import { hashTexto } from "./acaso.js";
import { VOLTA_MS, chaveDoProjeto } from "./feed.js";

/** Conversa parada continua no Salão por este tempo depois do fim (depois some). */
export const ATIVA_MS = 10 * 60_000;
/** Comemoração do fim do turno (como o `DONE_MS` do escritório). */
export const DONE_MS = 15_000;
/** Sem sinal nenhum por este tempo, com turno aberto = travou. */
export const STALL_MS = 2 * 60_000;
/** Pintor fica no cavalete por este tempo depois de mexer em DS/mock/vídeo. */
export const ATELIE_MS = 10_000;
/** Janela do Observatório acende por este tempo depois do mural mudar. */
export const MURAL_ACESO_MS = 10_000;
/** Teto de exploradores desenhados (o resto vira "+N"). */
export const EXPLORADORES_TETO = 6;
/** Quantas cores de estandarte existem (a paleta mora em arte.js). */
export const CORES_DE_ESTANDARTE = 8;
export const CHAVE_GERAL = "";

/** Pendência: estado que segura o mago na mesa (nunca cede lugar, nunca dorme). */
export const ESTADOS_PENDENTES = new Set(["esperando", "trabalhando", "pensando", "segundo-plano", "sem-mana"]);

/**
 * Estado de uma conversa na torre. Sempre um destes (com ícone na pintura, nunca só cor):
 * esperando · sem-mana · pensando · trabalhando · segundo-plano · erro · terminou · ocioso.
 */
export function estadoDaConversa(a, fase) {
  if (a?.aguardando) return "esperando";
  if (a?.pendingQuota) return "sem-mana";
  if (a?.busy) return fase?.fase === "pensando" ? "pensando" : "trabalhando";
  if (a?.emEspera > 0) return "segundo-plano";
  if (a?.lastTerminal === "error" || a?.lastTerminal === "auth") return "erro";
  if (a?.lastTerminal === "done") return "terminou";
  return "ocioso";
}

const TEXTO_DO_ESTADO = {
  esperando: "esperando sua resposta",
  "sem-mana": "sem mana — conta no limite",
  pensando: "pensando",
  trabalhando: "trabalhando",
  "segundo-plano": "esperando tarefa em 2º plano",
  erro: "parou com erro",
  terminou: "terminou",
  ocioso: "parado",
};

export function textoDoEstado(estado) {
  return TEXTO_DO_ESTADO[estado] ?? "parado";
}

/** Nome curto da torre. Conversa sem projeto mora na torre "Geral". */
export function nomeDaTorre(projectPath) {
  return chaveDoProjeto(projectPath) ? folderName(projectPath) : "Geral";
}

/** Cor estável do estandarte (índice na paleta), derivada do nome do projeto. `-1` = neutro (Geral). */
export function corDoProjeto(projectPath) {
  const chave = chaveDoProjeto(projectPath);
  if (!chave) return -1;
  return hashTexto(folderName(projectPath).toLowerCase()) % CORES_DE_ESTANDARTE;
}

/** Título que cabe na plaquinha (~18 caracteres). */
export function tituloCurto(texto, max = 18) {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim() || "Conversa";
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function torreVazia(projectPath) {
  return {
    chave: chaveDoProjeto(projectPath),
    projectPath: projectPath ?? "",
    nome: nomeDaTorre(projectPath),
    cor: corDoProjeto(projectPath),
    magos: [],
    astronomos: [],
    exploradores: [],
    exploradoresEscondidos: 0,
    bibliotecarios: [],
    pintor: null,
    render: null,
    planos: [],
    quadro: null,
    aprendizados: 0,
    semLeitura: new Set(),
    contagem: { trabalhando: 0, esperando: 0, exploradores: 0, segundoPlano: 0, semMana: 0 },
    janelas: { observatorio: false, salao: 0, biblioteca: false, atelie: false, porao: 0 },
    ultimaAtividade: 0,
  };
}

/** Quando a conversa parou (pra janela de 10 min): o fim visto ao vivo, senão a última gravação. */
function fimDa(a, feed) {
  const visto = feed.terminouEm.get(a.threadId);
  if (visto) return visto;
  const t = Date.parse(a.updatedAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

/** Rótulo do explorador: `tipo: descrição`, curto. */
export function rotuloDoExplorador(c, defs) {
  const def = defs?.get?.(c.tipo);
  const tipo = def?.name || c.tipo || "Explore";
  const desc = c.descricao ? `: ${c.descricao}` : "";
  const t = `${tipo}${desc}`;
  return t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t;
}

/**
 * Planos do projeto → Manager de cada um (`threadId`) e a conversa de implementação. Junta o que
 * as consultas trouxeram com o que os retratos dizem (`handoff` na conversa de implementação).
 */
function planosDoProjeto(feed, chave, conversas) {
  const planos = (feed.planos.get(chave) ?? []).map((p) => ({ ...p, estrelas: Array.isArray(p.estrelas) ? p.estrelas : [] }));
  const porSlug = new Map(planos.map((p) => [p.slug, p]));
  for (const a of conversas) {
    const slugM = a.planejamento?.slug;
    if (slugM) {
      const p = porSlug.get(slugM) ?? { slug: slugM, titulo: "", estrelas: [] };
      p.threadId ??= a.threadId;
      porSlug.set(slugM, p);
    }
    const slugI = a.handoff?.slug;
    if (slugI) {
      const p = porSlug.get(slugI) ?? { slug: slugI, titulo: "", estrelas: [] };
      p.implementacaoThreadId ??= a.threadId;
      porSlug.set(slugI, p);
    }
  }
  return [...porSlug.values()];
}

/**
 * O modelo inteiro. `opts.projetosConhecidos` (caminhos) garante torre pros projetos recentes
 * mesmo sem atividade — a visão geral mostra todos apagados em vez de tela vazia.
 */
export function torreModelo(feed, agora, opts = {}) {
  const torres = new Map();
  const torreDe = (projectPath) => {
    const chave = chaveDoProjeto(projectPath);
    let t = torres.get(chave);
    if (!t) {
      t = torreVazia(projectPath);
      torres.set(chave, t);
    }
    return t;
  };
  for (const p of opts.projetosConhecidos ?? []) torreDe(p);

  const porProjeto = new Map();
  for (const a of feed.agentes.values()) {
    if (a.projectPath === undefined) continue; // só evento, sem retrato ainda: espera a consulta
    const chave = chaveDoProjeto(a.projectPath);
    if (!porProjeto.has(chave)) porProjeto.set(chave, []);
    porProjeto.get(chave).push(a);
  }
  for (const [chave, lista] of porProjeto) {
    const t = torreDe(lista[0].projectPath);
    t.planos = planosDoProjeto(feed, chave, lista);
  }
  // projeto sem conversa viva mas com torre (recente): o Observatório ainda mostra o plano
  for (const chave of feed.planos.keys()) {
    const t = torres.get(chave);
    if (t && !porProjeto.has(chave)) t.planos = planosDoProjeto(feed, chave, []);
  }

  // implementação herda a aparência do Manager (o astrônomo desce e senta na mesa dela)
  const sementeHerdada = new Map();
  const managers = new Set();
  for (const t of torres.values()) {
    for (const p of t.planos) {
      if (p.threadId) managers.add(p.threadId);
      if (p.threadId && p.implementacaoThreadId) sementeHerdada.set(p.implementacaoThreadId, p.threadId);
    }
  }
  const enviado = new Set([...sementeHerdada.values()]);

  for (const a of feed.agentes.values()) {
    if (a.projectPath === undefined) continue;
    const t = torreDe(a.projectPath);
    const fase = feed.fase.get(a.threadId);
    const estado = estadoDaConversa(a, fase);
    const fim = ESTADOS_PENDENTES.has(estado) ? agora : fimDa(a, feed);
    t.ultimaAtividade = Math.max(t.ultimaAtividade, fim);

    // passo de hook/time: não senta no Salão (o hook vira bibliotecário)
    if (a.runId) {
      if (a.oculta && (a.busy || a.emEspera > 0)) {
        t.bibliotecarios.push({ chave: `biblio:${a.runId}`, runId: a.runId, threadId: a.threadId, time: a.runTitle ?? "", ativo: true });
      }
      continue;
    }
    if (a.oculta) continue; // geração do DS e afins: não é conversa da pessoa

    const ativa = ESTADOS_PENDENTES.has(estado) || agora - fim < ATIVA_MS;
    const ehManager = Boolean(a.planejamento?.slug) || managers.has(a.threadId);
    if (ehManager && !enviado.has(a.threadId)) {
      if (!ativa) continue;
      t.astronomos.push({
        chave: `astro:${a.planejamento?.slug ?? a.threadId}`,
        threadId: a.threadId,
        slug: a.planejamento?.slug ?? "",
        titulo: a.preview || "Plano",
        estado,
        semente: hashTexto(a.threadId),
      });
      continue;
    }
    if (!ativa) continue;
    const herdou = sementeHerdada.get(a.threadId);
    const sinal = feed.sinalEm.get(a.threadId) ?? 0;
    t.magos.push({
      chave: `conv:${a.threadId}`,
      threadId: a.threadId,
      titulo: a.preview || a.agentName || "Conversa",
      curto: tituloCurto(a.preview || a.agentName),
      estado,
      fase: fase?.fase ?? "",
      ferramenta: estado === "trabalhando" ? (fase?.ferramenta ?? "") : "",
      faseEm: fase?.em ?? 0,
      // Manager que voltou pro Salão depois de enviar o plano ganha outra roupa: a dele foi pra implementação
      semente: herdou ? hashTexto(herdou) : hashTexto(enviado.has(a.threadId) ? `${a.threadId}~` : a.threadId),
      // threadId do Manager: o astrônomo dele desce pro Salão quando esta mesa aparece
      ...(herdou ? { herdouDe: herdou } : {}),
      cor: a.agentColor ?? "",
      agente: a.agentName ?? "",
      passos: Array.isArray(a.passos) ? a.passos : [],
      pergunta: a.pergunta ?? null,
      emEspera: a.emEspera ?? 0,
      pedidoEm: feed.pedidoEm.get(a.threadId) ?? 0,
      fimEm: fim,
      travado: estado === "trabalhando" && sinal > 0 && agora - sinal > STALL_MS,
      sinalEm: sinal,
      comemorando: estado === "terminou" && agora - (feed.terminouEm.get(a.threadId) ?? -Infinity) < DONE_MS,
      profileId: a.profileId ?? "",
    });
    if (estado === "esperando") t.contagem.esperando++;
    if (estado === "trabalhando" || estado === "pensando") t.contagem.trabalhando++;
    if (estado === "segundo-plano") t.contagem.segundoPlano++;
    if (estado === "sem-mana") t.contagem.semMana++;
  }

  // exploradores: chamadas `Agent` abertas (e as que voltaram há pouco, subindo a escada)
  const pais = new Map();
  for (const t of torres.values()) for (const m of t.magos) pais.set(m.threadId, t);
  for (const t of torres.values()) for (const m of t.astronomos) if (!pais.has(m.threadId)) pais.set(m.threadId, t);
  const exploradores = new Map();
  for (const c of feed.chamadas.values()) {
    if (c.fim && agora - c.fim.em > VOLTA_MS) continue;
    const t = pais.get(c.threadId);
    if (!t) continue;
    if (!exploradores.has(t)) exploradores.set(t, []);
    exploradores.get(t).push({
      chave: `exp:${c.id}`,
      id: c.id,
      threadId: c.threadId,
      pai: `conv:${c.threadId}`,
      tipo: c.tipo,
      descricao: c.descricao,
      rotulo: rotuloDoExplorador(c, feed.defs),
      cor: feed.defs?.get?.(c.tipo)?.color ?? "",
      abertaEm: c.abertaEm,
      background: c.background,
      fim: c.fim ?? null,
    });
  }
  for (const [t, lista] of exploradores) {
    lista.sort((a, b) => b.abertaEm - a.abertaEm);
    t.exploradores = lista.slice(0, EXPLORADORES_TETO);
    t.exploradoresEscondidos = Math.max(0, lista.length - EXPLORADORES_TETO);
    t.contagem.exploradores = lista.filter((e) => !e.fim).length;
  }

  // hooks vistos pelo SSE de runs (duram segundos: a consulta sozinha não pegaria)
  for (const r of feed.runs.values()) {
    if (!r.hook || !r.ativo) continue;
    const t = torreDe(r.projectPath);
    if (t.bibliotecarios.some((b) => b.runId === r.runId)) continue;
    t.bibliotecarios.push({ chave: `biblio:${r.runId}`, runId: r.runId, time: r.time, ativo: true });
  }

  for (const t of torres.values()) {
    const at = feed.atelieEm.get(t.chave);
    const render = feed.render.get(t.chave) ?? null;
    if ((at && agora - at.em < ATELIE_MS) || render) {
      t.pintor = { chave: `pintor:${t.chave}`, tipo: render ? "video" : (at?.tipo ?? "ds"), ativo: true };
    }
    t.render = render;
    t.quadro = feed.quadros.get(t.chave) ?? null;
    t.aprendizados = feed.aprendizados.get(t.chave) ?? 0;
    t.semLeitura = feed.semLeitura.get(t.chave) ?? new Set();
    const muralEm = feed.muralEm.get(t.chave) ?? 0;
    t.janelas = {
      observatorio: t.astronomos.some((a) => a.estado === "trabalhando" || a.estado === "pensando") || agora - muralEm < MURAL_ACESO_MS,
      salao: t.contagem.trabalhando,
      biblioteca: t.bibliotecarios.length > 0,
      atelie: Boolean(t.pintor),
      porao: t.contagem.exploradores,
    };
    if (t.bibliotecarios.length || t.pintor) t.ultimaAtividade = Math.max(t.ultimaAtividade, agora);
    // esperando você também conta no Observatório (Manager com pergunta)
    t.contagem.esperando += t.astronomos.filter((a) => a.estado === "esperando").length;
  }

  return { torres: [...torres.values()], contas: feed.contas ?? [] };
}

/** "3 trabalhando · 1 esperando você · 2 exploradores" (só o que é > 0). */
export function resumoDaTorre(t) {
  const c = t.contagem;
  const partes = [];
  if (c.trabalhando) partes.push(`${c.trabalhando} trabalhando`);
  if (c.esperando) partes.push(`${c.esperando} esperando você`);
  if (c.exploradores) partes.push(`${c.exploradores} ${c.exploradores === 1 ? "explorador" : "exploradores"}`);
  if (c.segundoPlano) partes.push(`${c.segundoPlano} em 2º plano`);
  return partes.join(" · ");
}

/** Texto do botão de um personagem pro leitor de tela: "Conversa X — esperando sua resposta". */
export function rotuloAcessivel(m) {
  return `Conversa ${m.titulo} — ${textoDoEstado(m.estado)}`;
}
