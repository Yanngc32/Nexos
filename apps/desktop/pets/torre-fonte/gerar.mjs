/**
 * Pré-visualização da arte da torre: cada máscara de torre/arte.js vira PNG em pets/torre/
 * (1 letra = 1 pixel) e uma folha `folha.png` ampliada com tudo junto, pra conferir de olho.
 * Mesmo processo do maguinho (mago.txt + gerar.py): a fonte é o texto, o PNG é derivado.
 *
 * Uso: node pets/torre-fonte/gerar.mjs   (sem dependência: PNG montado com zlib do Node)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  CRISTAIS,
  ICONES,
  PROPS,
  TILES_DUNGEON,
  estandarteDe,
  mascaraDaTorreMini,
  mascaraDoIcone,
  mascaraDoMago,
  FORMAS_DE_OLHO,
  FORMAS_DE_PERNA,
  gemaDe,
  paletaCom,
} from "../../torre/arte.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SAIDA = join(AQUI, "..", "torre");

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function bloco(tipo, dados) {
  const t = Buffer.from(tipo, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, dados])));
  return Buffer.concat([len, t, dados, crc]);
}
/** RGBA (w×h) → PNG. */
export function png(w, h, rgba) {
  const linhas = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    linhas[y * (w * 4 + 1)] = 0;
    rgba.copy(linhas, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco("IHDR", ihdr),
    bloco("IDAT", deflateSync(linhas)),
    bloco("IEND", Buffer.alloc(0)),
  ]);
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Máscara → RGBA na escala `z`. */
function rasterizar(linhas, paleta, z = 1) {
  const w = Math.max(...linhas.map((l) => l.length)) * z;
  const h = linhas.length * z;
  const buf = Buffer.alloc(w * h * 4);
  linhas.forEach((l, y) => {
    [...l].forEach((ch, x) => {
      if (ch === ".") return;
      const [r, g, b] = rgb(paleta[ch]);
      for (let dy = 0; dy < z; dy++)
        for (let dx = 0; dx < z; dx++) {
          const i = ((y * z + dy) * w + x * z + dx) * 4;
          buf[i] = r;
          buf[i + 1] = g;
          buf[i + 2] = b;
          buf[i + 3] = 255;
        }
    });
  });
  return { w, h, buf };
}

const paleta = paletaCom({ estandarte: estandarteDe(2), cristal: CRISTAIS.cheio });
const pecas = [];
for (const o of FORMAS_DE_OLHO) pecas.push([`mago-${o}`, mascaraDoMago(o)]);
for (const pr of FORMAS_DE_PERNA) pecas.push([`mago-pernas-${pr}`, mascaraDoMago("normal", pr)]);
pecas.push(["mago-gema-agente", mascaraDoMago("normal"), paletaCom({ gema: gemaDe("#dd7f77") })]);
for (const [nome, m] of Object.entries(PROPS)) pecas.push([nome, m]);
for (const i of ICONES) pecas.push([`icone-${i}`, mascaraDoIcone(i)]);
for (const [nome, m] of Object.entries(TILES_DUNGEON)) pecas.push([`dungeon-${nome}`, m]);
pecas.push(["torre-mini-acesa", mascaraDaTorreMini({ observatorio: 1, salao: 1, biblioteca: 1, atelie: 1, porao: 1 })]);
pecas.push(["torre-mini-apagada", mascaraDaTorreMini({})]);
for (const [nivel, c] of Object.entries(CRISTAIS)) pecas.push([`cristal-${nivel}`, PROPS.cristal, paletaCom({ cristal: c })]);

mkdirSync(SAIDA, { recursive: true });
const Z = 4;
const rasters = pecas.map(([nome, m, p]) => {
  const r = rasterizar(m, p ?? paleta, 1);
  writeFileSync(join(SAIDA, `${nome}.png`), png(r.w, r.h, r.buf));
  return { nome, ...rasterizar(m, p ?? paleta, Z) };
});

// folha: tudo lado a lado em linhas de até 900 px, sobre o fundo da torre (bg do DS)
const LARG = 900;
let x = 8;
let y = 8;
let alturaLinha = 0;
const posicoes = [];
for (const r of rasters) {
  if (x + r.w + 8 > LARG) {
    x = 8;
    y += alturaLinha + 12;
    alturaLinha = 0;
  }
  posicoes.push({ r, x, y });
  x += r.w + 12;
  alturaLinha = Math.max(alturaLinha, r.h);
}
const H = y + alturaLinha + 8;
const folha = Buffer.alloc(LARG * H * 4);
for (let i = 0; i < LARG * H; i++) folha.set([0x14, 0x14, 0x17, 255], i * 4);
for (const { r, x: px, y: py } of posicoes) {
  for (let yy = 0; yy < r.h; yy++)
    for (let xx = 0; xx < r.w; xx++) {
      const s = (yy * r.w + xx) * 4;
      if (!r.buf[s + 3]) continue;
      r.buf.copy(folha, ((py + yy) * LARG + px + xx) * 4, s, s + 4);
    }
}
writeFileSync(join(SAIDA, "folha.png"), png(LARG, H, folha));
console.log(`${pecas.length} peças → ${SAIDA}`);
