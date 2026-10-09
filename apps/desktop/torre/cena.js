/**
 * Torre de magia — a CENA: geometria pura da torre em corte lateral (onde fica cada andar, cada
 * mesa, a escada, o mural, os cristais, as faixas da dungeon). Tudo em "pixels de torre"; a tela
 * multiplica pela escala inteira. Sem DOM: a pintura (render.js), os botões por cima (view.js) e o
 * mock do Canvas usam a mesma conta.
 */
import { MAGO_H, MAGO_W } from "./arte.js";
import { MESAS_TETO } from "./lugares.js";

export const PAREDE = 6;
export const ESCADA_W = 16;
export const MESA_CELULA_W = 34;
export const MESAS_POR_FILEIRA = 4;
export const INTERIOR_W = ESCADA_W + MESAS_POR_FILEIRA * MESA_CELULA_W;
export const TORRE_W = INTERIOR_W + 2 * PAREDE;
/** Céu dos lados da torre (pra o estandarte e as janelas respirarem). */
export const MARGEM = 10;
export const CENA_W = TORRE_W + 2 * MARGEM;
export const LAJE = 3;
export const TILE = 16;
/** Altura de uma faixa da dungeon: parede (24) + chão (6) — o tile do chão aparece só no topo. */
export const FAIXA_H = 30;
export const FAIXA_PAREDE = 24;
export const FAIXAS_TETO = 6;

/** Andares de cima pra baixo e a altura de cada um (sem a laje). */
export const ANDARES = [
  { id: "mana", rotulo: "Cristais de mana", h: 46 },
  { id: "observatorio", rotulo: "Observatório", h: 52 },
  { id: "salao", rotulo: "Salão dos magos", h: 8 + 2 * 36 },
  { id: "biblioteca", rotulo: "Biblioteca", h: 40 },
  { id: "atelie", rotulo: "Ateliê", h: 40 },
  { id: "porao", rotulo: "Porão", h: 30 },
];
const TELHADO_H = 34;

/**
 * A cena inteira. `faixas` = quantas faixas de dungeon (≥ 1: sem explorador ela fica lá, escura).
 * @returns `{ w, h, torre: {x, w}, telhado, andares: Map(id → {x, y, w, h, piso}), mesas, escada,
 *   mural, telescopio, janelaDoCeu, cristais(n), banco, biblioteca, atelie, alcapao, dungeon }`
 */
export function cenaDaTorre({ faixas = 1, contas = 0 } = {}) {
  const nFaixas = Math.max(1, Math.min(FAIXAS_TETO, faixas));
  const x0 = MARGEM + PAREDE;
  const andares = new Map();
  let y = TELHADO_H;
  for (const a of ANDARES) {
    andares.set(a.id, { id: a.id, rotulo: a.rotulo, x: x0, y, w: INTERIOR_W, h: a.h, piso: y + a.h });
    y += a.h + LAJE;
  }
  const dungeonY = y;
  const h = dungeonY + nFaixas * FAIXA_H + 6;

  const salao = andares.get("salao");
  const mesas = [];
  for (let i = 0; i < MESAS_TETO; i++) {
    const fileira = Math.floor(i / MESAS_POR_FILEIRA);
    const col = i % MESAS_POR_FILEIRA;
    const cx = x0 + ESCADA_W + col * MESA_CELULA_W;
    // chão da fileira: a de cima tem um mezanino (laje fina), a de baixo é o piso do andar
    const chao = salao.y + 8 + (fileira + 1) * 36;
    // esperando você: de pé na frente da própria mesa (não invade a do vizinho)
    mesas.push({ i, fileira, x: cx + 2, chao, mago: { x: cx + 1, y: chao - MAGO_H }, lado: { x: cx + 9, y: chao - MAGO_H } });
  }

  const obs = andares.get("observatorio");
  const mana = andares.get("mana");
  const nContas = Math.max(1, contas);
  const espacoCristal = Math.min(30, Math.floor((INTERIOR_W - ESCADA_W - 30) / nContas));
  const cristais = Array.from({ length: nContas }, (_, i) => ({
    x: x0 + ESCADA_W + 6 + i * espacoCristal,
    y: mana.piso - 15,
    w: 9,
  }));

  const porao = andares.get("porao");
  return {
    w: CENA_W,
    h,
    torre: { x: MARGEM, w: TORRE_W, topo: TELHADO_H - 2 },
    telhado: { y: 0, h: TELHADO_H, estandarte: { x: MARGEM + TORRE_W / 2 - 1, y: 0 } },
    andares,
    mesas,
    escada: { x: x0, w: ESCADA_W },
    telescopio: { x: x0 + ESCADA_W + 15, y: obs.piso - 10, astronomo: { x: x0 + ESCADA_W + 1, y: obs.piso - MAGO_H } },
    janelaDoCeu: { x: x0 + ESCADA_W + 30, y: obs.y + 4, w: 42, h: 30 },
    mural: { x: x0 + ESCADA_W + 76, y: obs.y + 5, w: INTERIOR_W - ESCADA_W - 80, h: obs.h - 9 },
    cristais,
    banco: { x: x0 + INTERIOR_W - 34, y: mana.piso - 4, w: 24 },
    biblioteca: (() => {
      const b = andares.get("biblioteca");
      return {
        estantes: [
          { x: x0 + ESCADA_W + 4, y: b.y + 4, w: 34, h: b.h - 4 },
          { x: x0 + INTERIOR_W - 38, y: b.y + 4, w: 34, h: b.h - 4 },
        ],
        mesa: { x: x0 + ESCADA_W + 62, y: b.piso - 7 },
        bibliotecario: { x: x0 + ESCADA_W + 45, y: b.piso - MAGO_H },
        pilha: { x: x0 + ESCADA_W + 66, y: b.piso - 7 },
      };
    })(),
    atelie: (() => {
      const a = andares.get("atelie");
      return {
        cavalete: { x: x0 + ESCADA_W + 34, y: a.piso - 13 },
        pintor: { x: x0 + ESCADA_W + 14, y: a.piso - MAGO_H },
        bancada: { x: x0 + INTERIOR_W - 48, y: a.piso - 7 },
        rolo: { x: x0 + INTERIOR_W - 40, y: a.piso - 12 },
      };
    })(),
    alcapao: { x: x0 + ESCADA_W + 10, y: porao.piso - 1, w: 14 },
    caldeirao: { x: x0 + 100, y: porao.piso - 6 },
    dungeon: {
      x: x0,
      y: dungeonY,
      w: INTERIOR_W,
      faixas: Array.from({ length: nFaixas }, (_, i) => ({ i, y: dungeonY + i * FAIXA_H, h: FAIXA_H })),
    },
  };
}

/** Escala inteira que cabe na largura (1×, 2× ou 3×); abaixo de ~420 px é sempre 1×. */
export function escalaPara(larguraPx) {
  if (!(larguraPx > 0) || larguraPx < 420) return 1;
  return Math.max(1, Math.min(3, Math.floor(larguraPx / CENA_W)));
}

/** Andar em que um ponto (y em pixels de torre) cai; `dungeon` abaixo do porão. */
export function andarEm(cena, y) {
  for (const a of cena.andares.values()) if (y >= a.y && y < a.piso + LAJE) return a.id;
  if (y >= cena.dungeon.y) return "dungeon";
  return y < (cena.andares.get("mana")?.y ?? 0) ? "telhado" : "";
}

/** Ponto do pé na escada em cada andar (por onde os personagens sobem e descem). */
export function pePelaEscada(cena, andarId) {
  if (andarId === "dungeon") return { x: cena.escada.x + 2, y: cena.dungeon.y + FAIXA_PAREDE - MAGO_H };
  const a = cena.andares.get(andarId);
  return { x: cena.escada.x + 1, y: (andarId === "salao" ? cena.mesas[MESAS_POR_FILEIRA].chao : a.piso) - MAGO_H };
}

export { MAGO_W, MAGO_H };
