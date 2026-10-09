/**
 * Torre de magia — TRAJETOS (geometria pura): pra onde cada coisa leva o personagem e como ele
 * chega lá. Todo deslocamento entre andares passa pela escada (esquerda da torre): anda no chão
 * até ela, sobe/desce, anda até o destino. Pontos são o canto de cima/esquerda do sprite, em
 * pixels de torre (o mesmo de `cena.mesas[i].mago`).
 */
import { MAGO_H } from "./arte.js";

/** Pé do mago na escada (x) — o mesmo `x` pra qualquer andar. */
const escadaX = (cena) => cena.escada.x + 1;
const chaoDe = (cena, andar) => cena.andares.get(andar).piso - MAGO_H;

/** Mesa `i` do Salão: o ponto do mago sentado (`lado`: de pé na frente da mesa, esperando você). */
export function pontoDaMesa(cena, i, lado = false) {
  const m = cena.mesas[Math.max(0, Math.min(cena.mesas.length - 1, i))];
  return lado ? m.lado : m.mago;
}

/** Onde o mago da conversa fica quando vai a um andar (`mural`, `estante`, `ateliê`, `telescopio`). */
export function pontoDoAndar(cena, andar) {
  switch (andar) {
    case "observatorio":
      return { x: cena.telescopio.x + 12, y: chaoDe(cena, "observatorio") };
    case "mural":
      return { x: cena.mural.x + 6, y: chaoDe(cena, "observatorio") };
    case "biblioteca":
      return { x: cena.biblioteca.estantes[0].x + 4, y: chaoDe(cena, "biblioteca") };
    case "atelie":
      return { x: cena.atelie.pintor.x, y: cena.atelie.pintor.y };
    default:
      return pePelaEscadaDe(cena, andar);
  }
}

function pePelaEscadaDe(cena, andar) {
  return { x: escadaX(cena), y: chaoDe(cena, cena.andares.has(andar) ? andar : "salao") };
}

/** Lugares do lazer (lazer.js) e da fila dos cristais (mana.js): vaga `n` de cada um. */
export function pontoDoLazer(cena, lugar, vaga = 0) {
  switch (lugar) {
    case "janela":
      return { x: cena.janelaDoCeu.x + 2 + vaga * 18, y: chaoDe(cena, "observatorio") };
    case "estante": {
      const [a, b] = cena.biblioteca.estantes;
      return { x: [a.x + 2, a.x + 14, b.x + 8][vaga % 3], y: chaoDe(cena, "biblioteca") };
    }
    case "caldeirao":
      return { x: cena.caldeirao.x - 16 - vaga * 12, y: chaoDe(cena, "porao") };
    case "banco":
      return pontoDaFila(cena, vaga === 0 ? "banco-0" : "banco-1");
    default:
      return pePelaEscadaDe(cena, "salao");
  }
}

/** Fila dos cristais (mana.js `LUGARES`): 2 no banco, 2 de pé atrás. */
export function pontoDaFila(cena, lugar) {
  const y = chaoDe(cena, "mana");
  const b = cena.banco;
  return { banco: { x: b.x - 4, y }, "banco-0": { x: b.x - 4, y }, "banco-1": { x: b.x + 8, y }, "pe-0": { x: b.x - 26, y }, "pe-1": { x: b.x - 44, y } }[lugar] ?? { x: b.x, y };
}

/**
 * Pontos de passagem de `de` até `para`: se estão no mesmo andar (mesma altura), reta; senão
 * até a escada, ao longo dela e até o destino.
 */
export function pontosDaRota(cena, de, para) {
  if (Math.abs(de.y - para.y) < 2) return [de, para];
  const ex = escadaX(cena);
  return [de, { x: ex, y: de.y }, { x: ex, y: para.y }, para];
}

/** Tamanho (px) de cada trecho e o total. */
function trechos(pontos) {
  const t = [];
  for (let i = 1; i < pontos.length; i++) t.push(Math.abs(pontos[i].x - pontos[i - 1].x) + Math.abs(pontos[i].y - pontos[i - 1].y));
  return { t, total: t.reduce((a, b) => a + b, 0) };
}

/**
 * Onde o personagem está a `p` (0..1) do caminho.
 * @returns `{ x, y, espelho, pose, andar }` — `pose`: "andando" (chão) ou "subindo-escada"/"descendo-escada";
 *   `espelho`: anda pra esquerda; `andar`: "escada" enquanto sobe/desce.
 */
export function pontoNaRota(cena, de, para, p, espelhoAnterior = false) {
  const pontos = pontosDaRota(cena, de, para);
  const { t, total } = trechos(pontos);
  if (total === 0 || p <= 0) return { ...de, espelho: espelhoAnterior, pose: "andando", andar: "chao" };
  if (p >= 1) return { ...para, espelho: pontos.length > 1 && para.x < pontos.at(-2).x, pose: "andando", andar: "chao" };
  let resta = p * total;
  for (let i = 0; i < t.length; i++) {
    if (resta <= t[i] || i === t.length - 1) {
      const a = pontos[i];
      const b = pontos[i + 1];
      const f = t[i] ? Math.min(1, resta / t[i]) : 1;
      const vertical = a.x === b.x && a.y !== b.y;
      return {
        x: Math.round(a.x + (b.x - a.x) * f),
        y: Math.round(a.y + (b.y - a.y) * f),
        espelho: vertical ? espelhoAnterior : b.x < a.x,
        pose: vertical ? (b.y > a.y ? "descendo-escada" : "subindo-escada") : "andando",
        andar: vertical ? "escada" : "chao",
      };
    }
    resta -= t[i];
  }
  return { ...para, espelho: false, pose: "andando", andar: "chao" };
}
