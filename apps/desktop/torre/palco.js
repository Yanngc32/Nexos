/**
 * Torre de magia — o PALCO: junta todas as camadas num quadro pintável (puro, sem DOM nem relógio).
 *
 * Fluxo de cada tique: modelo → lugares → eventos → (convívio, idas, mural, entregas, mana, lazer,
 * falas, cérebro) → posição e pose de cada personagem → `s` (o que `pintarTorre` pinta) + áreas de
 * clique. A ORDEM de prioridade de quem manda na posição de um mago é a da "Rotina dos magos":
 * viagem ao mural > ida a um andar > lazer > fila dos cristais > convívio > cérebro (a mesa).
 *
 * Quem chama passa `agora`, `visivel` e `reduzido`:
 * - `recomecarPalco` quando a aba abre ou volta de oculta: ninguém reage ao que perdeu (o primeiro
 *   retrato não gera evento) e o mural aplica tudo direto;
 * - `reduzido` (prefers-reduced-motion): ninguém anda, cada um fica no quadro parado do estado.
 */
import { quadroNoTempo, quadroParado } from "../sprites.js";
import { MAGO_H, MAGO_W } from "./arte.js";
import { FAIXAS_TETO, FAIXA_H, FAIXA_PAREDE, cenaDaTorre } from "./cena.js";
import { aplicarEventosNoCerebro, cerebroNovo, decidir, podarCerebro } from "./cerebro.js";
import { contasDaTorre, textoDoCristal } from "./contas.js";
import { avancarConvivio, convivioNovo, cumprimentar } from "./convivio.js";
import { faixasDosExploradores, gerarDungeon } from "./dungeon.js";
import { aplicarEventosNasEntregas, avancarEntregas, entregasNovo } from "./entregas.js";
import { retratoDaTorre, torreEventos } from "./eventos.js";
import { aplicarEventosNasFalas, avancarFalas, falasNovo } from "./falas.js";
import { autorDaMudanca } from "./feed.js";
import { avancarIdas, idasNovo } from "./idas.js";
import { avancarLazer, lazerNovo } from "./lazer.js";
import { torreLugares } from "./lugares.js";
import { APAGANDO_MS, avancarMana, manaNovo } from "./mana.js";
import { resumoDaTorre, rotuloAcessivel, textoDoEstado, torreVazia } from "./modelo.js";
import { avancar as avancarMural, carregarQuadro, esvaziar as esvaziarMural, faseDaViagem, muralNovo, receberMudanca, textoDoBalao } from "./mural.js";
import { ICONE_DA_REACAO, poseDe } from "./poses.js";
import { dungeonNoTempo, posicoesDoMural } from "./render.js";
import { pontoDaFila, pontoDaMesa, pontoDoAndar, pontoDoLazer, pontoNaRota } from "./trajetos.js";

/** Astrônomo descendo pro Salão quando o plano é enviado. */
export const DESCIDA_ASTRO_MS = 2_600;
/** Explorador descendo da mesa do mago até a dungeon. */
export const DESCIDA_EXP_MS = 1_800;
/** Cada trecho da ronda de quem segura a tocha no apagão. */
export const RONDA_TOCHA_MS = 4_000;
/** Como o nome do gesto do mural vira pose. */
const POSE_DO_GESTO = {
  "escreve-e-prega": "escrevendo",
  "despega-e-prega": "apontando",
  "prega-e-carimba": "comemorando",
  despega: "apontando",
  aponta: "apontando",
};
const ANDANDO = new Set(["andando", "correndo", "subindo-escada", "descendo-escada"]);

function camadasNovas() {
  return { cerebro: cerebroNovo(), convivio: convivioNovo(), idas: idasNovo(), entregas: entregasNovo(), mana: manaNovo(), lazer: lazerNovo(), falas: falasNovo() };
}

/** Estado do palco de UMA torre (`chave` = chave do projeto; "" = Geral). */
export function palcoNovo(chave = "") {
  return {
    chave,
    ...camadasNovas(),
    mural: muralNovo(),
    lugares: null,
    antes: null,
    poseDesde: new Map(),
    faixas: new Map(),
    descendo: new Map(),
    herancas: new Map(),
    /** Conversa que virou Manager do plano: sobe da mesa até o telescópio (chave `astro:…` → mesa de onde saiu). */
    subidas: new Map(),
    viagensVistas: new Set(),
  };
}

/**
 * Abriu a aba (ou voltou de oculta): esquece o que estava em cena — nenhuma reação ao que perdeu —
 * e o mural passa a mostrar o Quadro como está, sem animar.
 */
export function recomecarPalco(p) {
  Object.assign(p, camadasNovas());
  p.antes = null;
  p.poseDesde.clear();
  p.descendo.clear();
  p.herancas.clear();
  p.subidas.clear();
  p.viagensVistas.clear();
  esvaziarMural(p.mural);
}

/** A pessoa clicou no mago: ele acena (1,5 s). Quem chama decide que quem espera sua resposta não larga o "?". */
export function acenarNoPalco(p, chave, agora) {
  return cumprimentar(p.convivio, chave, agora);
}

/** Quadro novo do projeto (consulta): colunas e tarefas. */
export function carregarQuadroNoPalco(p, quadro, tarefas) {
  carregarQuadro(p.mural, quadro, tarefas);
}

/** Mudança no Quadro (SSE): o feed diz quem fez; o mural decide quem leva. */
export function mudancaNoQuadro(p, feed, ev, agora) {
  if (!ev || ev.tipo === "colunas") return;
  receberMudanca(p.mural, ev, autorDaMudanca(feed, ev, agora), agora);
}

function planoDaTorre(torre) {
  const comEstrelas = torre.planos.filter((pl) => pl.estrelas?.length);
  const doManager = comEstrelas.find((pl) => torre.astronomos.some((a) => a.threadId === pl.threadId || a.slug === pl.slug));
  return doManager ?? comEstrelas[0] ?? null;
}

const media = (a, b, f) => Math.round(a + (b - a) * f);

/**
 * Avança o palco e devolve o quadro a pintar.
 * @param {object} o
 * @param o.modelo   `torreModelo(feed, agora, …)`
 * @param o.feed     o feed (idas recentes, agentes — pra cor herdada)
 * @returns `{ chave, cena, s, torre, nome, hits, plaquinhas, falas, contas, resumo, resumoAcessivel, vazia, escondidos }`
 */
export function avancarPalco(p, { modelo, feed, agora, visivel = true, reduzido = false, sorteio = Math.random, tema = "escuro" }) {
  const torre = (modelo?.torres ?? []).find((t) => t.chave === p.chave) ?? torreVazia(p.chave);

  /* ---- eventos (o primeiro retrato não gera nenhum) ---- */
  const retrato = retratoDaTorre(modelo, agora);
  const eventos = torreEventos(p.antes, retrato).filter((e) => !e.torre || e.torre === p.chave);
  p.antes = retrato;
  for (const e of eventos) {
    if (e.tipo === "delegou") p.descendo.set(e.explorador, agora);
    if (e.tipo === "plano-enviado" && !reduzido) p.herancas.set(e.chave, agora);
  }
  aplicarEventosNoCerebro(p.cerebro, eventos, agora);
  aplicarEventosNasEntregas(p.entregas, eventos, agora);

  /* ---- lugares: quem tem mesa fica nela ---- */
  const mesasAntes = p.lugares?.mesas;
  // a conversa que acabou de virar Manager de um plano sobe da mesa dela pro Observatório
  for (const a of torre.astronomos) {
    const i = mesasAntes?.get(`conv:${a.threadId}`);
    if (i !== undefined && !p.subidas.has(a.chave) && !reduzido) p.subidas.set(a.chave, { desde: agora, i });
  }
  for (const [chave, s] of [...p.subidas]) if (agora - s.desde > DESCIDA_ASTRO_MS) p.subidas.delete(chave);
  p.lugares = torreLugares(torre.magos, p.lugares);
  const mesas = p.lugares.mesas;
  const magos = torre.magos.filter((m) => mesas.has(m.chave));
  const porChave = new Map(magos.map((m) => [m.chave, m]));
  podarCerebro(p.cerebro, new Set(magos.map((m) => m.chave)));

  const celulas = contasDaTorre(modelo?.contas ?? [], agora);
  const faixas = faixasDosExploradores(torre.exploradores, p.faixas, FAIXAS_TETO);
  p.faixas = faixas;
  const cena = cenaDaTorre({ faixas: faixas.size ? Math.max(...faixas.values()) + 1 : 1, contas: celulas.length });
  const mover = (de, para, f) => pontoNaRota(cena, de, para, f);
  const ocupar = (chaves, ...mais) => new Set([...chaves, ...mais.flat()]);

  /* ---- camadas ---- */
  // a mana vem primeiro: no apagão ninguém sai pra andar, e logo depois dele todo mundo fica sentado VOLTA_MS
  const mana = avancarMana(p.mana, { magos, contas: celulas, agora });
  const apagado = Boolean(mana.apagao);
  const quietos = apagado || mana.voltando;
  const fora = ocupar(p.lazer.ativas.keys(), p.idas.ativas.keys(), p.mural.viagens.keys(), mana.fila.keys(), p.entregas.leituras.keys());
  const conv = avancarConvivio(p.convivio, { magos: quietos ? [] : magos.filter((m) => !fora.has(m.chave)), mesas, eventos, agora, sorteio, reduzido });
  const idas = avancarIdas(p.idas, { magos, sinais: feed?.idasRecentes ?? [], agora, reduzido, bloqueado: apagado });
  const disponiveis = new Map();
  for (const m of magos) {
    // no escuro ninguém leva pergaminho: a mudança desliza sozinha no mural
    if (apagado || m.estado === "esperando" || m.estado === "sem-mana") continue;
    disponiveis.set(m.chave, { comPressa: m.estado === "trabalhando" || m.estado === "pensando" });
  }
  avancarMural(p.mural, agora, disponiveis, visivel && !reduzido);
  const entregas = avancarEntregas(p.entregas, agora, new Set(mesas.keys()));
  const ocupados = quietos
    ? new Set(magos.map((m) => m.chave))
    : ocupar(conv.keys(), idas.keys(), p.mural.viagens.keys(), mana.fila.keys(), entregas.leitores.keys());
  const lazer = avancarLazer(p.lazer, { magos, agora, sorteio, reduzido, ocupados });

  /* ---- falas ---- */
  const falasEv = [...eventos];
  for (const [chave, v] of p.mural.viagens) {
    const id = `${chave}@${v.desde}`;
    if (p.viagensVistas.has(id)) continue;
    p.viagensVistas.add(id);
    const ev = v.passos[0]?.ev;
    const titulo = p.mural.tarefas.find((t) => t.id === ev?.tarefaId)?.titulo ?? ev?.titulo ?? "";
    falasEv.push({ tipo: "mural", chave, mudanca: ev?.tipo === "moveu" && ev.para === p.mural.colunaFinal ? "concluiu" : ev?.tipo, titulo });
  }
  for (const chave of mana.voltaram) falasEv.push({ tipo: "volta-mana", chave });
  for (const [chave, b] of p.mural.baloes) if (b.n && !p.viagensVistas.has(`bal:${chave}:${b.ate}`)) {
    p.viagensVistas.add(`bal:${chave}:${b.ate}`);
    falasEv.push({ tipo: "mural-excedente", chave, texto: textoDoBalao(b.n) });
  }
  aplicarEventosNasFalas(p.falas, falasEv.filter((e) => e.tipo !== "mural-excedente"), agora, sorteio);
  const proximoReset = celulas.map((c) => c.resetHora).filter(Boolean).sort()[0];
  // "sem mana até HH:MM": a hora da conta do mago; sem ela, o reset mais próximo
  const resetDa = new Map(celulas.map((c) => [c.id, c.resetHora]));
  const magosComReset = magos.map((m) => (m.estado === "sem-mana" ? { ...m, resetHora: resetDa.get(m.profileId) || proximoReset } : m));
  const falasPintadas = avancarFalas(p.falas, magosComReset, agora, sorteio, { apagao: apagado, apagaoHora: proximoReset });
  for (const e of falasEv) if (e.tipo === "mural-excedente") falasPintadas.push({ chave: e.chave, texto: e.texto, prioridade: 20, categoria: "aviso" });
  if (p.viagensVistas.size > 400) p.viagensVistas.clear();
  for (const [chave, desde] of [...p.herancas]) if (agora - desde > DESCIDA_ASTRO_MS) p.herancas.delete(chave);

  /* ---- posição e pose de cada personagem ---- */
  const quadro = (chave, nome, parado = reduzido) => {
    let r = p.poseDesde.get(chave);
    if (!r || r.nome !== nome) {
      r = { nome, em: agora };
      p.poseDesde.set(chave, r);
    }
    const a = poseDe(nome);
    return parado ? quadroParado(a) : quadroNoTempo(a, agora - r.em);
  };
  const atores = [];
  const hits = { magos: [], exploradores: [], astronomos: [], npcs: [] };
  const plaquinhas = [];
  const posDos = new Map();
  const destinoMural = pontoDoAndar(cena, "mural");

  for (const m of magos) {
    const i = mesas.get(m.chave);
    const base = pontoDaMesa(cena, i);
    const cer = decidir(p.cerebro, m, agora, sorteio);
    let pos = cer.lugar === "lado-da-mesa" ? { ...pontoDaMesa(cena, i, true), espelho: false } : { ...base, espelho: false };
    let pose = cer.reacao || cer.pose;
    let icone = ICONE_DA_REACAO[cer.reacao] ?? cer.icone;
    const chave = m.chave;

    const viagem = p.mural.viagens.get(chave);
    const ida = idas.get(chave);
    const laz = lazer.get(chave);
    const fila = mana.fila.get(chave);
    const ci = conv.get(chave);
    const leitura = entregas.leitores.get(chave);
    const heranca = p.herancas.get(chave);

    if (heranca !== undefined) {
      // recém-chegada da implementação: o astrônomo desce até a mesa e só então ela aparece
      pose = "";
    } else if (viagem) {
      const f = faseDaViagem(viagem, agora);
      if (f.fase === "subindo") Object.assign(pos, mover(base, destinoMural, f.progresso));
      else if (f.fase === "no-mural") Object.assign(pos, { ...destinoMural, espelho: false });
      else if (f.fase === "descendo") Object.assign(pos, mover(destinoMural, base, f.progresso));
      pose = f.fase === "no-mural" ? (POSE_DO_GESTO[viagem.passos[f.passo]?.gesto] ?? "apontando") : f.fase === "fim" ? pose : pos.pose;
      icone = "";
    } else if (ida && reduzido) {
      // movimento reduzido: não sai da mesa, só faz o gesto do andar
      pose = ida.pose;
      icone = "";
    } else if (ida) {
      const alvo = pontoDoAndar(cena, ida.andar);
      if (ida.fase === "indo") Object.assign(pos, mover(base, alvo, ida.progresso));
      else if (ida.fase === "voltando") Object.assign(pos, mover(alvo, base, ida.progresso));
      else Object.assign(pos, { ...alvo, espelho: false });
      pose = ida.fase === "la" ? ida.pose : pos.pose;
      icone = "";
    } else if (laz) {
      const alvo = pontoDoLazer(cena, laz.lugar, laz.vaga);
      if (laz.fase === "indo") Object.assign(pos, mover(base, alvo, laz.progresso));
      else if (laz.fase === "voltando" || laz.fase === "correndo") Object.assign(pos, mover(alvo, base, laz.progresso));
      else Object.assign(pos, { ...alvo, espelho: false });
      pose = laz.fase === "la" || laz.fase === "fila" ? laz.pose : laz.fase === "correndo" && !String(pos.pose).includes("escada") ? "correndo" : pos.pose;
      icone = "";
    } else if (fila) {
      Object.assign(pos, { ...pontoDaFila(cena, fila.lugar), espelho: false });
      pose = fila.pose;
    } else if (leitura && cer.modo !== "esperando") {
      // quem espera sua resposta não larga o "?" pra ler o pergaminho
      pose = leitura.pose;
    } else if (ci && cer.modo !== "esperando") {
      pose = ci.pose;
      pos.espelho = Boolean(ci.espelho);
      if (ci.tipo === "espiando" && ci.alvo && mesas.has(ci.alvo) && Math.floor(mesas.get(ci.alvo) / 4) === Math.floor(i / 4)) {
        const alvoPonto = pontoDaMesa(cena, mesas.get(ci.alvo));
        pos.x = media(base.x, alvoPonto.x + (alvoPonto.x > base.x ? -10 : 10), ci.progresso ?? 0);
      }
      icone = "";
    } else if (ci && (ci.tipo === "olhando" || ci.tipo === "levanta-cabeca" || ci.tipo === "olhando-estrela") && !cer.reacao) {
      pose = ci.pose;
    }
    // pós-apagão e fila: quem voltou da fila corre até a mesa
    if (apagado && !viagem && !ida && !ANDANDO.has(pose) && pose !== "") {
      pose = mana.apagao.pose.get(chave) ?? pose;
      icone = "";
      // quem pegou a tocha ronda os andares (mesa → Biblioteca → Ateliê → mesa) enquanto dura a festa
      if (pose === "procurando-com-tocha" && !reduzido) {
        const t = agora - p.mana.apagao.desde - APAGANDO_MS;
        if (t > 0) {
          const pontos = [base, pontoDoAndar(cena, "biblioteca"), pontoDoAndar(cena, "atelie"), base];
          const perna = Math.floor(t / RONDA_TOCHA_MS) % (pontos.length - 1);
          const r = mover(pontos[perna], pontos[perna + 1], (t % RONDA_TOCHA_MS) / RONDA_TOCHA_MS);
          Object.assign(pos, { x: r.x, y: r.y, espelho: r.espelho });
        }
      }
    }
    if (ci?.tipo === "cumprimento" && !viagem && !ida && !laz) pose = "acenando";

    posDos.set(chave, { x: pos.x, y: pos.y });
    const cor = m.cor || (m.herdouDe ? (feed?.agentes?.get?.(m.herdouDe)?.agentColor ?? "") : "");
    const visivelNaMesa = heranca === undefined;
    if (visivelNaMesa) atores.push({ tipo: "mago", chave, x: pos.x, y: pos.y, quadro: quadro(chave, pose), espelho: Boolean(pos.espelho), cor, icone, semente: m.semente });
    plaquinhas.push({ chave, x: base.x - 1, y: cena.mesas[i].chao + 1, texto: m.curto, titulo: m.titulo });
    if (visivelNaMesa) {
      hits.magos.push({
        chave,
        threadId: m.threadId,
        x: pos.x,
        y: pos.y - (icone ? 12 : 0),
        w: MAGO_W,
        h: MAGO_H + (icone ? 12 : 0),
        titulo: m.titulo,
        estado: m.estado,
        texto: textoDoEstado(m.estado),
        rotulo: rotuloAcessivel(m),
        passos: m.passos,
        pergunta: m.pergunta,
        pedidoEm: m.pedidoEm,
        fimEm: m.fimEm,
        agente: m.agente,
      });
    }
  }

  // astrônomo descendo pro Salão (plano enviado): vai do telescópio até a mesa da implementação
  for (const [chave, desde] of p.herancas) {
    const i = mesas.get(chave);
    if (i === undefined) continue;
    const m = porChave.get(chave);
    const de = { x: cena.telescopio.astronomo.x, y: cena.telescopio.astronomo.y };
    const f = Math.min(1, (agora - desde) / DESCIDA_ASTRO_MS);
    const pt = mover(de, pontoDaMesa(cena, i), f);
    const cor = m?.cor || (m?.herdouDe ? (feed?.agentes?.get?.(m.herdouDe)?.agentColor ?? "") : "");
    atores.push({ tipo: "astronomo", chave: `astro:desce:${chave}`, x: pt.x, y: pt.y, quadro: quadro(`astro:desce:${chave}`, pt.pose), espelho: pt.espelho, cor });
  }

  // torre sem ninguém: um mago cochila na primeira mesa (a aba nunca fica "vazia" de vida)
  if (magos.length === 0) {
    const mesa = pontoDaMesa(cena, 0);
    atores.push({ tipo: "mago", chave: "vazio", x: mesa.x, y: mesa.y, quadro: quadro("vazio", "cochilando"), espelho: false });
  }

  /* ---- Observatório: astrônomo(s) do plano ---- */
  torre.astronomos.forEach((a, k) => {
    const trabalhando = a.estado === "trabalhando" || a.estado === "pensando";
    let x = cena.telescopio.astronomo.x + (k ? 20 * k : 0);
    let y = cena.telescopio.astronomo.y;
    let andando = null;
    const subida = p.subidas.get(a.chave);
    if (subida) {
      andando = mover(pontoDaMesa(cena, subida.i), { x, y }, Math.min(1, (agora - subida.desde) / DESCIDA_ASTRO_MS));
      ({ x, y } = andando);
    }
    const icone = a.estado === "esperando" && !andando ? "pergunta" : "";
    const pose = andando ? andando.pose : a.estado === "esperando" ? "segurando" : trabalhando ? "olhando-telescopio" : "descanso";
    const cor = feed?.agentes?.get?.(a.threadId)?.agentColor ?? "";
    atores.push({ tipo: "astronomo", chave: a.chave, x, y, quadro: quadro(a.chave, pose), cor, icone, espelho: Boolean(andando?.espelho) });
    hits.astronomos.push({ chave: a.chave, threadId: a.threadId, slug: a.slug, x, y: y - (icone ? 12 : 0), w: MAGO_W, h: MAGO_H + (icone ? 12 : 0), titulo: a.titulo, estado: a.estado, texto: textoDoEstado(a.estado), rotulo: `Plano ${a.titulo} — ${textoDoEstado(a.estado)}` });
  });

  /* ---- Biblioteca e Ateliê ---- */
  if (torre.bibliotecarios.length) {
    const b = cena.biblioteca.bibliotecario;
    atores.push({ tipo: "bibliotecario", chave: "biblio", x: b.x, y: b.y, quadro: quadro("biblio", "escrevendo-estante") });
  }
  const pintorVisitado = !reduzido && [...idas.values()].some((x) => x.andar === "atelie" && x.fase !== "indo");
  if (torre.pintor && !pintorVisitado) {
    const pt = cena.atelie.pintor;
    atores.push({ tipo: "pintor", chave: "pintor", x: pt.x, y: pt.y, quadro: quadro("pintor", "pintando") });
  }

  /* ---- Porão: exploradores ---- */
  const dungeons = [];
  for (const e of torre.exploradores) {
    const f = faixas.get(e.chave);
    if (f === undefined) continue;
    const mapa = gerarDungeon(e.id);
    const nasceu = p.descendo.get(e.chave);
    const faixaY = cena.dungeon.faixas[f].y;
    const entrada = { x: cena.dungeon.x + 2, y: faixaY + FAIXA_PAREDE - MAGO_H };
    const msTotal = Math.max(0, (e.fim ? e.fim.em : agora) - e.abertaEm);
    let msNaFaixa = msTotal;
    let desc = null;
    if (nasceu !== undefined && !reduzido && agora - nasceu < DESCIDA_EXP_MS && !e.fim) {
      const paiI = mesas.get(e.pai);
      const de = paiI !== undefined ? pontoDaMesa(cena, paiI) : { x: cena.escada.x + 1, y: cena.mesas[4].chao - MAGO_H };
      desc = mover(de, entrada, (agora - nasceu) / DESCIDA_EXP_MS);
      msNaFaixa = 0;
    } else if (nasceu !== undefined) msNaFaixa = Math.max(0, msTotal - DESCIDA_EXP_MS);
    const dg = dungeonNoTempo(cena, f, mapa, reduzido ? 0 : msNaFaixa, e.fim);
    dungeons.push(dg);
    const entrega = entregas.portadores.get(e.chave);
    let pos = { x: dg.explorador.x, y: dg.explorador.y, espelho: dg.explorador.espelho };
    let pose = dg.explorador.noBau ? "no-bau" : "explorando";
    let icone = e.fim?.erro ? "alerta" : "";
    let carga = null;
    if (desc) {
      pos = { x: desc.x, y: desc.y, espelho: desc.espelho };
      pose = desc.pose === "andando" ? "explorando" : desc.pose;
    }
    if (entrega) {
      const pe = { x: cena.escada.x + 1, y: cena.dungeon.y + FAIXA_PAREDE - MAGO_H + f * FAIXA_H };
      const destI = mesas.get(entrega.destino);
      const mesaDest = destI !== undefined ? pontoDaMesa(cena, destI) : null;
      if (mesaDest) {
        const topo = { x: pe.x, y: mesaDest.y };
        const frente = { x: Math.max(pe.x, mesaDest.x - 12), y: mesaDest.y };
        // movimento reduzido: aparece direto na frente da mesa, entregando
        if (reduzido) pos = { ...frente, espelho: false };
        else if (entrega.fase === "subindo") pos = { ...mover(pe, topo, entrega.progresso) };
        else if (entrega.fase === "andando") pos = { ...mover(topo, frente, entrega.progresso) };
        else if (entrega.fase === "entregando") pos = { ...frente, espelho: false };
        else pos = { ...mover(frente, topo, entrega.progresso), espelho: true };
        pose = reduzido ? "entregando" : entrega.fase === "saindo" ? "andando" : entrega.fase === "subindo" ? "subindo-com-pergaminho" : entrega.fase === "andando" ? "andando-com-pergaminho" : "entregando";
        carga = entrega.carga;
        icone = entrega.ok ? "" : "alerta";
      }
    }
    const rotulo = e.rotulo;
    atores.push({ tipo: "explorador", chave: e.chave, x: pos.x, y: pos.y, espelho: Boolean(pos.espelho), quadro: quadro(e.chave, e.fim?.erro && !entrega ? "explorando-ferido" : pose), icone, cor: e.cor });
    hits.exploradores.push({ chave: e.chave, threadId: e.threadId, x: pos.x, y: pos.y - (icone ? 12 : 0), w: MAGO_W, h: MAGO_H + (icone ? 12 : 0), rotulo, tipo: e.tipo, descricao: e.descricao, abertaEm: e.abertaEm, fim: e.fim, background: e.background, carga });
  }

  /* ---- s: o que a pintura recebe ---- */
  const plano = planoDaTorre(torre);
  const pos = posicoesDoMural(cena, { colunas: p.mural.colunas, tarefas: p.mural.tarefas });
  const deslizando = [];
  const deslizandoIds = new Set();
  const m = cena.mural;
  const cw = p.mural.colunas.length ? Math.floor(m.w / p.mural.colunas.length) : 0;
  for (const d of p.mural.deslizes) {
    const destino = pos.get(d.id);
    if (!destino) continue;
    const deIdx = p.mural.colunas.findIndex((c) => c.id === d.de);
    const f = Math.min(1, (agora - d.desde) / (d.ate - d.desde));
    const origem = deIdx >= 0 ? { x: m.x + deIdx * cw + (destino.x - (m.x + destino.coluna * cw)), y: destino.y } : destino;
    deslizandoIds.add(d.id);
    deslizando.push({ id: d.id, x: media(origem.x, destino.x, f), y: media(origem.y, destino.y, f), selo: d.selo });
  }
  const s = {
    tema,
    torre: { chave: torre.chave, cor: torre.cor },
    janelas: torre.janelas,
    contas: celulas.map((c) => ({ id: c.id, uso: c.uso, semana: c.semana, bloqueada: c.bloqueada, semDado: c.semDado })),
    estrelas: plano?.estrelas ?? [],
    planoSlug: plano?.slug ?? "",
    mural: { colunas: p.mural.colunas, tarefas: p.mural.tarefas.map((t) => (deslizandoIds.has(t.id) ? { ...t, emViagem: true } : t)) },
    deslizando,
    aprendizados: torre.aprendizados,
    render: torre.render,
    dungeons,
    atores,
    apagada: false,
    luzes: mana.luzes,
  };

  // textos soltos sobre a arte: o que a pintura não escreve
  const notas = [];
  if (!plano && !torre.planos.length) notas.push({ k: "sem-plano", x: cena.janelaDoCeu.x + 6, y: cena.janelaDoCeu.y + Math.floor(cena.janelaDoCeu.h / 2) - 4, texto: "Nenhum plano" });
  if (torre.aprendizados > 0) notas.push({ k: "pilha", x: cena.biblioteca.pilha.x + 12, y: cena.biblioteca.pilha.y - 16, texto: String(torre.aprendizados), titulo: `${torre.aprendizados} aprendizados pra revisar` });
  if (torre.render) notas.push({ k: "render", x: cena.atelie.rolo.x + 10, y: cena.atelie.rolo.y - 2, texto: `${torre.render.pct}%`, titulo: "Renderizando vídeo" });
  const andares = [...cena.andares.values()].map((a) => ({ id: a.id, rotulo: a.rotulo, x: a.x, y: a.y, w: a.w, h: a.h, semLeitura: torre.semLeitura.has(a.id) }));
  return {
    chave: torre.chave,
    nome: torre.nome,
    cor: torre.cor,
    cena,
    s,
    torre,
    andares,
    hits,
    plaquinhas,
    falas: falasPintadas.map((f) => {
      const at = atores.find((a) => a.chave === f.chave);
      return { ...f, x: (at?.x ?? 0) + MAGO_W / 2, y: (at?.y ?? 0) - 14 };
    }),
    contas: celulas.map((c, i) => ({ ...c, x: cena.cristais[i]?.x ?? 0, y: cena.cristais[i]?.y ?? 0, texto: textoDoCristal(c) })),
    mural: { colunas: p.mural.colunas, tarefas: p.mural.tarefas, rect: { x: m.x, y: m.y, w: m.w, h: m.h } },
    escondidos: p.lugares.escondidos,
    exploradoresEscondidos: torre.exploradoresEscondidos,
    notas,
    resumo: resumoDaTorre(torre),
    vazia: magos.length === 0,
    apagao: apagado,
    luzes: mana.luzes,
  };
}
