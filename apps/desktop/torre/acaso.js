/**
 * Sorteio com semente pra torre: a mesma conversa sempre ganha a mesma roupa, a mesma chamada
 * `Agent` sempre gera a mesma dungeon. Nada aqui usa `Math.random` — quem quer acaso de verdade
 * (cérebro) injeta o próprio sorteio.
 */

/** FNV-1a de 32 bits: rápido, estável entre máquinas, bom o bastante pra espalhar ids. */
export function hashTexto(texto) {
  let h = 0x811c9dc5;
  const s = String(texto ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: devolve uma função que sorteia [0, 1) a partir da semente (número ou texto). */
export function sorteioDe(semente) {
  let a = typeof semente === "number" ? semente >>> 0 : hashTexto(semente);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inteiro em [min, max] com o sorteio dado. */
export function inteiro(sorteio, min, max) {
  return min + Math.floor(sorteio() * (max - min + 1));
}
