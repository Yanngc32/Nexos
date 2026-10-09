/**
 * Torre de magia — camada 6: a PINTURA. Só pinta; não decide nada.
 *
 * Pinta através de um "pintor" com duas operações — `ret(x, y, w, h, cor)` e
 * `masc(chave, linhas, paleta, x, y, espelho)` — em pixels de torre. No app o pintor é um canvas
 * (com a escala inteira já aplicada); no Node (mock do Canvas e testes) é um buffer RGBA. Assim o
 * mock que a pessoa aprova é a mesma pintura que roda na aba.
 */
import { trechosDaMascara } from "../sprites.js";
import { sorteioDe } from "./acaso.js";
import {
  ICONE_W,
  PALETA,
  PROPS,
  TILES_DUNGEON,
  corDaConta,
  cristalDe,
  estandarteDe,
  gemaDe,
  mascaraDaTorreMini,
  mascaraDoIcone,
  mascaraDoMago,
  paletaCom,
} from "./arte.js";
import { FAIXA_PAREDE, LAJE, MAGO_H, MAGO_W, TILE } from "./cena.js";
import { posicaoNaDungeon } from "./dungeon.js";
import { MESA_X } from "./poses.js";

/** Cores de fundo por tema (o claro é espelho: céu de dia). */
export const TEMAS = {
  escuro: { ceu: "#141417", estrela: "#3a3a46", interior: "#1d1d22", interiorFundo: "#202026", escuro: "#0b0b0e" },
  claro: { ceu: "#cfe0ee", estrela: "#cfe0ee", interior: "#2a2a31", interiorFundo: "#30303a", escuro: "#0b0b0e" },
};

/* ---------------- pintor em buffer (Node: mock e testes) ---------------- */

function rgba(cor) {
  const h = cor.replace("#", "");
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

/** Pintor sobre um RGBA (`Uint8Array` w×h×4), com mistura de alfa. */
export function pintorDeBuffer(w, h, escala = 1) {
  const buf = new Uint8Array(w * escala * h * escala * 4);
  const W = w * escala;
  const H = h * escala;
  const ponto = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    buf[i] = Math.round(buf[i] * (1 - a) + r * a);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
    buf[i + 3] = 255;
  };
  const ret = (x, y, rw, rh, cor) => {
    const c = rgba(cor);
    for (let yy = Math.max(0, y * escala); yy < Math.min(H, (y + rh) * escala); yy++)
      for (let xx = Math.max(0, x * escala); xx < Math.min(W, (x + rw) * escala); xx++) ponto(xx, yy, c);
  };
  return {
    w: W,
    h: H,
    buf,
    ret,
    masc(_chave, linhas, paleta, x, y, espelho = false) {
      const largura = Math.max(...linhas.map((l) => l.length));
      for (const t of trechosDaMascara(linhas, paleta)) {
        const x0 = espelho ? largura - t.x - t.w : t.x;
        ret(x + x0, y + t.y, t.w, 1, t.cor);
      }
    },
  };
}

/* ---------------- peças ---------------- */

const P = PALETA;

function chaveDaPaleta(p) {
  return `${p.G}${p.b ?? ""}${p.x ?? ""}`;
}

function props(p, nome, x, y, paleta = P, espelho = false) {
  const m = PROPS[nome];
  if (m) p.masc(`prop:${nome}:${chaveDaPaleta(paleta)}:${espelho}`, m, paleta, x, y, espelho);
}

/** Parede de pedra em blocos (tijolos 8×4 desencontrados). */
function pedra(p, x, y, w, h, base = P.P, junta = P.p) {
  p.ret(x, y, w, h, base);
  for (let yy = 0; yy < h; yy += 4) {
    p.ret(x, y + yy, w, 1, junta);
    const des = (yy / 4) % 2 ? 4 : 0;
    for (let xx = des; xx < w; xx += 8) p.ret(x + xx, y + yy, 1, Math.min(4, h - yy), junta);
  }
}

/** Janela pequena na parede de fora: acesa (luz) ou apagada. */
function janela(p, x, y, acesa) {
  p.ret(x, y + 1, 4, 6, P.k);
  p.ret(x + 1, y, 2, 1, P.k);
  p.ret(x + 1, y + 2, 2, 4, acesa ? P.l : P.m);
  if (acesa) p.ret(x + 1, y + 2, 1, 1, P.w);
}

function ceu(p, cena, tema, semente) {
  const T = TEMAS[tema] ?? TEMAS.escuro;
  p.ret(0, 0, cena.w, cena.h, T.ceu);
  if (tema === "claro") return;
  const s = sorteioDe(`ceu:${semente}`);
  for (let i = 0; i < 26; i++) p.ret(Math.floor(s() * cena.w), Math.floor(s() * 60), 1, 1, T.estrela);
}

function telhado(p, cena, torre) {
  const { x, w } = cena.torre;
  const base = cena.telhado.h - 2;
  // telhado em degraus, do beiral até a ponta
  for (let i = 0; i < 14; i++) {
    const ww = w - i * 10;
    if (ww <= 4) break;
    p.ret(x + (w - ww) / 2, base - (i + 1) * 2, ww, 2, i % 2 ? P.q : P.P);
  }
  p.ret(x - 3, base - 1, w + 6, 3, P.k);
  const est = cena.telhado.estandarte;
  const paleta = paletaCom({ estandarte: estandarteDe(torre?.cor ?? -1) });
  p.masc(`estandarte:${chaveDaPaleta(paleta)}`, PROPS.estandarte, paleta, est.x, est.y + 2);
}

/** Paredes externas, fundo interno, lajes e a escada em zigue-zague. */
function estrutura(p, cena, s) {
  const T = TEMAS[s.tema] ?? TEMAS.escuro;
  const { x, w } = cena.torre;
  const topo = cena.telhado.h;
  const fundo = cena.dungeon.y;
  pedra(p, x, topo, w, fundo - topo);
  for (const a of cena.andares.values()) {
    p.ret(a.x, a.y, a.w, a.h, T.interior);
    // rodapé de pedra escura e um friso no alto: o andar tem cara de sala
    p.ret(a.x, a.piso - 2, a.w, 2, T.interiorFundo);
    p.ret(a.x, a.piso, a.w, LAJE, P.d);
    p.ret(a.x, a.piso, a.w, 1, P.e);
    const aceso = s.janelas?.[a.id];
    janela(p, x + 1, a.y + Math.floor(a.h / 2) - 4, aceso);
    janela(p, x + w - 5, a.y + Math.floor(a.h / 2) - 4, aceso);
  }
  // mezanino entre as duas fileiras de mesas do Salão
  const m = cena.mesas[0];
  p.ret(cena.escada.x + cena.escada.w, m.chao, cena.andares.get("salao").w - cena.escada.w, 2, P.d);
  // escada: um degrau a cada 4 px, indo e voltando a cada andar
  const e = cena.escada;
  for (const a of cena.andares.values()) {
    p.ret(e.x, a.y, e.w, a.h, T.interiorFundo);
    for (let yy = 4; yy < a.h + LAJE; yy += 4) {
      const ida = Math.floor((a.y + yy) / 4) % 2;
      const dx = Math.round(((yy / (a.h + LAJE)) * (e.w - 6)) / 1);
      p.ret(e.x + (ida ? dx : e.w - 6 - dx), a.y + yy - 1, 6, 2, P.D);
    }
    p.ret(e.x + e.w - 1, a.y, 1, a.h, P.p);
  }
}

/* ---------------- andares ---------------- */

/** Nível do cristal pela mana restante (janela de 5 h). */
export function nivelDoCristal(celula) {
  if (!celula || celula.semDado) return "apagado";
  if (celula.bloqueada || celula.uso >= 1) return "apagado";
  if (celula.uso >= 0.8) return "pouco";
  if (celula.uso >= 0.5) return "medio";
  return "cheio";
}

function andarMana(p, cena, s, t) {
  const mana = cena.andares.get("mana");
  for (const [i, c] of cena.cristais.entries()) {
    const cel = s.contas?.[i];
    if (!cel && i > 0) continue;
    const nivel = nivelDoCristal(cel);
    props(p, "pedestal", c.x - 1, mana.piso - 3);
    // a cor é a da conta; o nível é o brilho + ícone (nunca só cor)
    const cor = corDaConta(cel?.id ?? "");
    const paleta = paletaCom({ cristal: cristalDe(cor, nivel) });
    const pulso = nivel === "cheio" && Math.floor(t / 900) % 2 ? -1 : 0;
    p.masc(`cristal:${cor}:${nivel}`, PROPS.cristal, paleta, c.x, mana.piso - 15 + pulso);
    // barrinha da semana no pedestal: o que ainda resta
    const resta = Math.max(0, Math.min(1, 1 - (cel?.semana ?? 1)));
    p.ret(c.x, mana.piso - 2, 7, 1, P.k);
    if (cel && !cel.semDado) p.ret(c.x, mana.piso - 2, Math.round(7 * resta), 1, resta > 0.2 ? P.i : P.y);
    if (nivel === "cheio" || nivel === "medio") p.ret(c.x + 1, mana.piso - 13 + pulso, 1, 1, P.w);
    const icone = nivel === "pouco" ? "alerta" : nivel === "apagado" && cel && !cel.semDado ? "sem-mana" : "";
    if (icone) p.masc(`icone:${icone}`, mascaraDoIcone(icone), P, c.x - 1, mana.piso - 28);
  }
  props(p, "banco", cena.banco.x, cena.banco.y);
  props(p, "banco", cena.banco.x + 12, cena.banco.y);
}

function andarObservatorio(p, cena, s, t) {
  const j = cena.janelaDoCeu;
  // janela da cúpula com o mapa estelar do plano
  p.ret(j.x - 2, j.y - 2, j.w + 4, j.h + 4, P.k);
  p.ret(j.x, j.y, j.w, j.h, "#10121c");
  const estrelas = s.estrelas ?? [];
  if (estrelas.length) {
    const sorteio = sorteioDe(`estrelas:${s.planoSlug ?? ""}`);
    const pts = estrelas.map(() => ({ x: j.x + 3 + Math.floor(sorteio() * (j.w - 6)), y: j.y + 3 + Math.floor(sorteio() * (j.h - 6)) }));
    for (let i = 1; i < pts.length; i++) linha(p, pts[i - 1], pts[i], "#2a3050");
    estrelas.forEach((e, i) => {
      const { x, y } = pts[i];
      if (e === "feita") {
        p.ret(x - 1, y, 3, 1, P.F);
        p.ret(x, y - 1, 1, 3, P.F);
        p.ret(x, y, 1, 1, P.w);
      } else if (e === "em_andamento") p.ret(x, y, 1, 1, Math.floor(t / 500) % 2 ? P.F : P.q);
      else p.ret(x, y, 1, 1, P.q);
    });
  } else {
    const sorteio = sorteioDe("ceu-vazio");
    for (let i = 0; i < 8; i++) p.ret(j.x + 2 + Math.floor(sorteio() * (j.w - 4)), j.y + 2 + Math.floor(sorteio() * (j.h - 4)), 1, 1, "#2a3050");
  }
  props(p, "telescopio", cena.telescopio.x, cena.telescopio.y);
  if (s.mural !== undefined) muralDoQuadro(p, cena, s.mural);
  // pergaminhos que mudam de coluna sozinhos (mudança feita por você ou sem dono)
  for (const d of s.deslizando ?? []) {
    props(p, "pergaminho", d.x, d.y);
    if (d.selo === "voce") p.masc("icone:voce", mascaraDoIcone("voce"), P, d.x - 2, d.y - 12);
  }
}

/** Linha de 1 px entre dois pontos (Bresenham). */
function linha(p, a, b, cor) {
  let { x: x0, y: y0 } = a;
  const { x: x1, y: y1 } = b;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let n = 0; n < 400; n++) {
    p.ret(x0, y0, 1, 1, cor);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Até 8 pergaminhos por coluna (2 × 4); o resto vira "+N" (texto fica com a tela). */
export const PERGAMINHOS_POR_COLUNA = 8;

/** Onde cada pergaminho do mural fica (pra coreografia levar o mago até lá). */
export function posicoesDoMural(cena, mural) {
  const out = new Map();
  if (!mural?.colunas?.length) return out;
  const m = cena.mural;
  const cw = Math.floor(m.w / mural.colunas.length);
  mural.colunas.forEach((col, ci) => {
    const daColuna = mural.tarefas.filter((t) => t.colunaId === col.id);
    daColuna.slice(0, PERGAMINHOS_POR_COLUNA).forEach((tarefa, i) => {
      out.set(tarefa.id, { x: m.x + ci * cw + 2 + (i % 2) * 6, y: m.y + 6 + Math.floor(i / 2) * 7, coluna: ci });
    });
  });
  return out;
}

function muralDoQuadro(p, cena, mural) {
  const m = cena.mural;
  p.ret(m.x - 1, m.y - 1, m.w + 2, m.h + 2, P.d);
  p.ret(m.x, m.y, m.w, m.h, P.D);
  if (!mural?.colunas?.length) return;
  const cw = Math.floor(m.w / mural.colunas.length);
  mural.colunas.forEach((_, ci) => {
    p.ret(m.x + ci * cw + 1, m.y + 1, cw - 2, 3, P.e);
    if (ci > 0) p.ret(m.x + ci * cw, m.y + 1, 1, m.h - 2, P.d);
  });
  const pos = posicoesDoMural(cena, mural);
  for (const tarefa of mural.tarefas) {
    const q = pos.get(tarefa.id);
    if (!q || tarefa.emViagem) continue;
    props(p, tarefa.fita ? "pergaminhoFita" : "pergaminho", q.x, q.y);
    if (tarefa.alta) props(p, "seloAlta", q.x + 3, q.y - 1);
    if (tarefa.carimbo) props(p, "carimbo", q.x + 1, q.y + 1);
  }
}

function estante(p, x, y, w, h, semente) {
  p.ret(x, y, w, h, P.d);
  const s = sorteioDe(`estante:${semente}`);
  const cores = [P.v, P.g, P.n, P.y, P.G, P.D, P.i, P.q];
  for (let yy = y + 2; yy + 8 <= y + h; yy += 9) {
    p.ret(x + 1, yy + 7, w - 2, 1, P.e);
    for (let xx = x + 2; xx < x + w - 3; ) {
      const lw = 2 + Math.floor(s() * 2);
      const lh = 4 + Math.floor(s() * 3);
      if (s() < 0.85) p.ret(xx, yy + 7 - lh, lw, lh, cores[Math.floor(s() * cores.length)]);
      xx += lw + (s() < 0.2 ? 1 : 0);
    }
  }
}

function andarBiblioteca(p, cena, s) {
  const b = cena.biblioteca;
  for (const [i, e] of b.estantes.entries()) estante(p, e.x, e.y, e.w, e.h, i);
  props(p, "mesa", b.mesa.x, b.mesa.y);
  // pilha de pergaminhos = aprendizados pendentes (até 6 desenhados)
  const n = Math.min(6, s.aprendizados ?? 0);
  for (let i = 0; i < n; i++) props(p, "pergaminho", b.pilha.x + (i % 2) * 2, b.pilha.y - 5 - i * 3);
}

function andarAtelie(p, cena, s, t) {
  const a = cena.atelie;
  props(p, "cavalete", a.cavalete.x, a.cavalete.y);
  props(p, "mesa", a.bancada.x, a.bancada.y);
  if (s.render) props(p, Math.floor(t / 150) % 2 ? "rolo1" : "rolo0", a.rolo.x, a.rolo.y);
  else props(p, "rolo0", a.rolo.x, a.rolo.y);
  props(p, "pincel", a.bancada.x + 10, a.bancada.y - 4);
}

function andarPorao(p, cena) {
  const a = cena.andares.get("porao");
  props(p, "alcapao", cena.alcapao.x, cena.alcapao.y);
  props(p, "caldeirao", cena.caldeirao.x, cena.caldeirao.y);
  // barris e caixas encostados
  p.ret(a.x + a.w - 24, a.piso - 10, 9, 10, P.D);
  p.ret(a.x + a.w - 24, a.piso - 7, 9, 1, P.d);
  p.ret(a.x + a.w - 13, a.piso - 8, 10, 8, P.d);
  p.ret(a.x + a.w - 12, a.piso - 7, 8, 6, P.D);
}

/* ---------------- dungeon ---------------- */

function faixaDaDungeon(p, cena, faixa, dungeon, t) {
  const d = cena.dungeon;
  const y = faixa.y;
  const mapa = dungeon?.mapa;
  for (let c = 0; c * TILE < d.w; c++) {
    const parede = mapa?.paredes[c] ?? "parede";
    p.masc(`tile:${parede}`, TILES_DUNGEON[parede], P, d.x + c * TILE, y);
    p.masc("tile:parede", TILES_DUNGEON.parede, P, d.x + c * TILE, y + TILE);
    const chao = mapa?.chao[c] ?? "chao";
    p.masc(`tile:${chao}`, TILES_DUNGEON[chao], P, d.x + c * TILE, y + FAIXA_PAREDE);
  }
  if (mapa) {
    for (const col of mapa.portas) p.masc("tile:porta", TILES_DUNGEON.porta, P, d.x + col * TILE, y + FAIXA_PAREDE - TILE);
    const aberto = dungeon.bauAberto;
    p.masc(`tile:${aberto ? "bauAberto" : "bau"}`, TILES_DUNGEON[aberto ? "bauAberto" : "bau"], P, d.x + mapa.bau * TILE, y + FAIXA_PAREDE - TILE + 2);
  }
  // escuridão: tudo apagado, menos o raio da tocha; sala visitada fica em penumbra
  const luz = dungeon?.luz;
  for (let yy = 0; yy < FAIXA_PAREDE + 6; yy += 3) {
    for (let xx = 0; xx < d.w; xx += 3) {
      const cx = d.x + xx + 1;
      const cy = y + yy + 1;
      let a = 0.9;
      if (mapa && dungeon.visitadas?.has(salaDaColunaRapida(mapa, xx / TILE))) a = 0.62;
      if (luz) {
        const dist = Math.hypot(cx - luz.x, cy - luz.y);
        const tremor = Math.floor(t / 180) % 2;
        if (dist < 15 + tremor) a = 0;
        else if (dist < 24 + tremor) a = Math.min(a, 0.42);
      }
      if (a > 0) p.ret(d.x + xx, y + yy, 3, 3, `#0b0b0e${Math.round(a * 255).toString(16).padStart(2, "0")}`);
    }
  }
}

function salaDaColunaRapida(mapa, col) {
  const c = Math.floor(col);
  for (let i = 0; i < mapa.salas.length; i++) if (c >= mapa.salas[i].ini && c <= mapa.salas[i].fim) return i;
  return -1;
}

/* ---------------- personagens ---------------- */

/**
 * Um personagem: `{ x, y, quadro: { o, p, dy, corte, props }, cor (do agente, vai na gema), espelho, icone }`.
 */
export function pintarPersonagem(p, a) {
  const gema = gemaDe(a.cor);
  const paleta = paletaCom({ gema });
  const q = a.quadro ?? { o: "normal", p: "parado", dy: 0, props: [] };
  const y = a.y + (q.dy ?? 0);
  const corte = q.corte ?? 0;
  const m = mascaraDoMago(q.o, q.p, corte);
  p.masc(`mago:${q.o}:${q.p}:${corte}:${gema[0]}:${a.espelho ? 1 : 0}`, m, paleta, a.x, y, a.espelho);
  for (const [nome, px, py] of q.props ?? []) {
    const largura = Math.max(...(PROPS[nome] ?? [""]).map((l) => l.length));
    const x = a.espelho ? a.x + MAGO_W - px - largura : a.x + px;
    props(p, nome, x, a.y + py, paleta, a.espelho);
  }
  if (a.icone) {
    const ic = mascaraDoIcone(a.icone);
    if (ic) p.masc(`icone:${a.icone}`, ic, P, a.x + Math.floor((MAGO_W - ICONE_W) / 2), y - 12);
  }
}

/* ---------------- a torre inteira ---------------- */

/**
 * Pinta a torre de um projeto.
 * @param s `{ tema, torre, janelas, contas: [{id, uso, semana, bloqueada, semDado}], estrelas, planoSlug,
 *   mural, aprendizados, render, dungeons: [{ faixa, mapa, luz, visitadas, bauAberto }], atores: [...], apagada }`
 */
export function pintarTorre(p, cena, s, t = 0) {
  const tema = s.tema ?? "escuro";
  ceu(p, cena, tema, s.torre?.chave ?? "");
  telhado(p, cena, s.torre);
  estrutura(p, cena, s);
  andarMana(p, cena, s, t);
  andarObservatorio(p, cena, s, t);
  for (const mesa of cena.mesas) props(p, "mesa", mesa.mago.x + MESA_X, mesa.chao - 7);
  andarBiblioteca(p, cena, s);
  andarAtelie(p, cena, s, t);
  andarPorao(p, cena);
  for (const f of cena.dungeon.faixas) {
    const dg = s.dungeons?.find((d) => d.faixa === f.i);
    faixaDaDungeon(p, cena, f, dg, t);
  }
  // apagão: luzes caem; quem está na festa continua visível por cima do escuro
  if (s.luzes !== undefined && s.luzes < 1) p.ret(0, 0, cena.w, cena.h, `#05050a${Math.round((1 - s.luzes) * 0xb0).toString(16).padStart(2, "0")}`);
  for (const a of s.atores ?? []) pintarPersonagem(p, a);
  if (s.apagada) p.ret(0, 0, cena.w, cena.h, "#0b0b0e99");
}

/** Estado da dungeon de um explorador no tempo (pra pintura): onde está, baú, luz da tocha. */
export function dungeonNoTempo(cena, faixa, mapa, msNaFaixa, fim) {
  const pos = posicaoNaDungeon(mapa, msNaFaixa);
  const x = cena.dungeon.x + Math.round(pos.col * TILE);
  const y = cena.dungeon.faixas[faixa].y + FAIXA_PAREDE - MAGO_H;
  return {
    faixa,
    mapa,
    visitadas: pos.visitadas,
    bauAberto: Boolean(fim && !fim.erro) || pos.noBau,
    luz: { x: x + MAGO_W - 1, y: y + 10 },
    explorador: { x, y, espelho: pos.espelho, noBau: pos.noBau },
  };
}

/* ---------------- torres pequenas (visão geral e ilha) ---------------- */

/** Torre da visão geral (15×26 com escala 1): janelas acesas por andar; esmaecida se parada. */
export function pintarTorreMini(p, x, y, torre, t = 0) {
  const paleta = paletaCom({ estandarte: estandarteDe(torre.cor) });
  const j = torre.janelas ?? {};
  const m = mascaraDaTorreMini(j);
  p.masc(`mini:${m.join("")}:${chaveDaPaleta(paleta)}`, m, paleta, x, y);
  // pontinhos de luz na janela do Salão: um por mago trabalhando (até 5)
  for (let i = 0; i < Math.min(5, j.salao ?? 0); i++) p.ret(x + 4 + i, y + 13 + (i % 2), 1, 1, P.w);
  if (j.porao && Math.floor(t / 300) % 2) p.ret(x + 6, y + 23, 1, 1, P.F);
}
