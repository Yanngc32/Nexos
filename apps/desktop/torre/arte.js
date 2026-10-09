/**
 * Torre de magia — a ARTE, desenhada em código (como o maguinho: máscara em texto + paleta).
 *
 * Uma letra por pixel, "." = vazio. As letras da `PALETA` são fixas; `g/G` (gema), `b/B`
 * (estandarte) e `x/X` (cristal) mudam por personagem/projeto/conta — quem pinta passa a paleta
 * completa (`paletaCom`). Tudo na escala da torre: 1 letra = 1 "pixel de torre" (a tela
 * multiplica por 1×, 2× ou 3×, sempre inteiro).
 *
 * Personagens, móveis, props e ícones: desenhados aqui. Só os tiles genéricos da dungeon
 * (`TILES_DUNGEON`) vêm de um pack CC0 (Kenney "Tiny Dungeon"), recoloridos pra esta paleta por
 * pets/torre-fonte/importar-kenney.py — crédito em THIRD_PARTY_NOTICES.md.
 * Pré-visualização em PNG: `node pets/torre-fonte/gerar.mjs` (grava em pets/torre/).
 */

/** Paleta do mago (c/s/g/G/w) estendida pra torre. Escuro perto de `bg`/`surface-3` do DS. */
export const PALETA = {
  c: "#f8f0da", // creme (corpo do mago)
  s: "#cfc4af", // sombra (aba do chapéu)
  w: "#fffae6", // brilho
  g: "#325a7e", // gema
  G: "#6395bc", // gema clara
  k: "#1c1c22", // tinta / contorno
  m: "#26262d", // argamassa (surface-3)
  p: "#34343e", // pedra escura
  P: "#46465a", // pedra
  q: "#5c5c72", // pedra clara
  d: "#5c4030", // madeira escura
  D: "#805c40", // madeira
  e: "#a47c56", // madeira clara
  f: "#e88c3c", // fogo
  F: "#f8c860", // fogo claro / ouro
  a: "#e8dcbc", // pergaminho
  A: "#c4b492", // pergaminho sombra
  l: "#f8d68c", // luz de janela
  y: "#d8a657", // atenção (warning do DS)
  v: "#dd7f77", // erro (danger do DS)
  n: "#5fae74", // pronto (success do DS)
  h: "#9b9ba4", // neutro (muted do DS)
  i: "#56b6c2", // dica (info do DS)
};

/** Estandartes por projeto (`corDoProjeto` → índice); neutro = torre Geral. */
export const ESTANDARTES = [
  ["#c8584e", "#9c3e36"],
  ["#4d8fd0", "#36689c"],
  ["#4fa06a", "#3a7a50"],
  ["#d49a3c", "#a8762a"],
  ["#8a6cc8", "#6a4ea4"],
  ["#3ea8b4", "#2c8088"],
  ["#c06aa4", "#964e7e"],
  ["#a07850", "#7a5838"],
];
export const ESTANDARTE_NEUTRO = ["#9b9ba4", "#71717b"];

export function estandarteDe(cor) {
  return cor >= 0 ? ESTANDARTES[cor % ESTANDARTES.length] : ESTANDARTE_NEUTRO;
}

/** Paleta completa pra pintar: a fixa + as variáveis do personagem. */
export function paletaCom({ gema, estandarte, cristal } = {}) {
  const p = { ...PALETA };
  if (gema) [p.G, p.g] = gema;
  if (estandarte) [p.b, p.B] = estandarte;
  if (cristal) [p.x, p.X] = cristal;
  return p;
}

export function escurecer(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = c((n >> 16) & 255);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Cristal apagado (conta no limite / sem leitura): cinza, sem cor de conta. */
export const CRISTAL_APAGADO = ["#4a4a56", "#34343e"];
/** Só pra prévia/testes: um cristal em cada nível com a cor da primeira conta. */
export const CRISTAIS = {
  cheio: cristalDe(0, "cheio"),
  medio: cristalDe(0, "medio"),
  pouco: cristalDe(0, "pouco"),
  apagado: CRISTAL_APAGADO,
};

/** Cor estável da conta (índice na paleta dos estandartes), derivada do id. */
export function corDaConta(id) {
  const s = String(id ?? "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) % ESTANDARTES.length;
}

/**
 * Cristal de mana: a COR é a da conta; o NÍVEL é o brilho — cheio (claro + brilho), médio,
 * pouco (escuro; a tela põe "!" em cima), apagado (cinza; raio cortado em cima).
 */
export function cristalDe(cor, nivel) {
  if (nivel === "apagado") return CRISTAL_APAGADO;
  const [base, sombra] = ESTANDARTES[((cor % ESTANDARTES.length) + ESTANDARTES.length) % ESTANDARTES.length];
  if (nivel === "cheio") return [clarear(base, 0.35), base];
  if (nivel === "medio") return [base, sombra];
  return [escurecer(base, 0.72), escurecer(sombra, 0.72)];
}

export function clarear(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v + (255 - v) * f)));
  const r = c((n >> 16) & 255);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Deixa todas as linhas da mesma largura (desenho à mão sem contar ponto). */
function pad(linhas) {
  const w = Math.max(...linhas.map((l) => l.length));
  return linhas.map((l) => l.padEnd(w, "."));
}

/* ---------------- o mago da torre ---------------- */

/*
 * O maguinho reduzido pra escala da torre (18×24): redução EXATA do mago.txt (70×96) em blocos de
 * 4×4 px (pets/nexo/mago-fonte), sem retoque — a gema quadrada com o brilho no canto, encostada à
 * direita da ponta do chapéu, e a leve inclinação do original ficam. Sem roupa nem faixa: é o
 * mesmo mago de sempre; quem diz de que conversa ele é são a plaquinha e a gema (cor do agente,
 * como o accent da janela). Os olhos entram por cima (OLHOS), simétricos em torno da ponta.
 */
const MAGO_BASE = pad([
  ".........Gg.......",
  ".........gg.......",
  "........cgg.......",
  "........cc........",
  "........cc........",
  "........ccc.......",
  ".......ccccc......",
  ".......ccccc......",
  ".......ccccc......",
  "......ccccccc.....",
  "......ccccccc.....",
  ".....ccccccccc....",
  ".....ccccccccc....",
  ".....ccccccccc....",
  "....ccccccccccc...",
  "....ccccccccccc...",
  "...ccccccccccccc..",
  "..ccccccccccccccc.",
  ".scccccccccccccccc",
  ".ssssssssssssssss.",
  "....ccccccccccc...",
  "....ccccccccccc...",
  ".....ccccccccc....",
  ".....c......c.....",
]);
export const MAGO_W = MAGO_BASE[0].length;
export const MAGO_H = MAGO_BASE.length;

/** Olhos: pontos (x, y) pintados de tinta, por forma — sempre simétricos em torno da coluna 8. */
const OLHOS = {
  normal: [[7, 20], [7, 21], [11, 20], [11, 21]],
  cima: [[7, 19], [7, 20], [11, 19], [11, 20]],
  baixo: [[7, 21], [7, 22], [11, 21], [11, 22]],
  fechado: [[6, 21], [7, 21], [11, 21], [12, 21]],
  contente: [[7, 20], [6, 21], [8, 21], [11, 20], [10, 21], [12, 21]],
  direita: [[8, 20], [8, 21], [12, 20], [12, 21]],
  esquerda: [[6, 20], [6, 21], [10, 20], [10, 21]],
  // bocejo: olhos fechados e a boca aberta
  bocejo: [[6, 21], [7, 21], [11, 21], [12, 21], [9, 22]],
  // facepalm: olhos fechados, "mão" na cara
  facepalm: [[6, 21], [7, 21], [11, 21], [12, 21], [8, 19], [9, 19], [8, 20], [9, 20]],
};
export const FORMAS_DE_OLHO = Object.keys(OLHOS);

const PERNAS = {
  parado: ".....c......c.....",
  passo: "......c....c......",
  junto: "........cc........",
};
export const FORMAS_DE_PERNA = Object.keys(PERNAS);

/**
 * Máscara do mago com olhos e pernas escolhidos. `corte` = quantas linhas de baixo somem (o mago
 * "entrando no chapéu", como idle-in1/in2/hide da janela): o chapéu fica, o corpo some.
 */
export function mascaraDoMago(olhos = "normal", pernas = "parado", corte = 0) {
  const g = MAGO_BASE.map((l) => l.split(""));
  for (const [x, y] of OLHOS[olhos] ?? OLHOS.normal) g[y][x] = "k";
  g[MAGO_H - 1] = (PERNAS[pernas] ?? PERNAS.parado).padEnd(MAGO_W, ".").split("");
  const n = Math.max(0, Math.min(MAGO_H - 1, Math.floor(corte)));
  for (let y = MAGO_H - n; y < MAGO_H; y++) g[y] = Array(MAGO_W).fill(".");
  return g.map((l) => l.join(""));
}

/** Gema: cor do agente personalizado (claro, escuro); sem agente, a do mago (g/G da paleta). */
export function gemaDe(corDoAgente) {
  if (/^#[0-9a-f]{6}$/i.test(corDoAgente ?? "")) return [corDoAgente.toLowerCase(), escurecer(corDoAgente, 0.62)];
  return [PALETA.G, PALETA.g];
}

/**
 * Os personagens de apoio são o mesmo maguinho; o que os distingue é o que têm na mão e onde
 * estão (tocha na dungeon, livro na Biblioteca, pincel no Ateliê, telescópio no Observatório).
 */
export const PERSONAGENS = ["mago", "explorador", "bibliotecario", "pintor", "astronomo"];

/* ---------------- props (o que fica na mesa, na mão ou no andar) ---------------- */

export const PROPS = {
  mesa: pad([
    "eeeeeeeeeeeeeeee",
    "DDDDDDDDDDDDDDDD",
    ".dd..........dd",
    ".dd..........dd",
    ".dd..........dd",
    ".dd..........dd",
    ".dd..........dd",
  ]),
  banquinho: pad(["eeeeeee", ".d...d.", ".d...d.", ".d...d."]),
  livro: pad(["aaa.aaa", "aAa.aAa", "aaaAaaa", "dDDDDDd"]),
  livroFechado: pad([".gggg", "gGGGg", "gGGGg", "ggggg"]),
  papel: pad(["aaaaa", "aAAAa", "aaaaa", "aAAAa", "aaaaa"]),
  pena: pad(["....w", "...ww", "..ww.", ".k...", "k...."]),
  caldeirao: pad(["kkkkkkk", "kpPPPpk", ".kpppk.", ".kpppk.", "..kkk..", ".f.f.f."]),
  bolhas0: pad([".G...", "...G.", "....."]),
  bolhas1: pad(["...G.", ".G...", "..G.."]),
  bolaDeCristal: pad([".GGG.", "GwGGG", "GGGgG", ".ggg.", "dDDDd"]),
  ampulheta: pad(["DDDDD", ".aFa.", "..F..", ".a.a.", "DDDDD"]),
  ampulhetaVazia: pad(["DDDDD", ".a.a.", "..F..", ".aFa.", "DDDDD"]),
  pontinhos1: pad(["c...."]),
  pontinhos2: pad(["c.c.."]),
  pontinhos3: pad(["c.c.c"]),
  z: pad(["hhh", "..h", ".h.", "hhh"]),
  faisca: pad(["..F..", ".F.F.", "F.w.F", ".F.F.", "..F.."]),
  brilho: pad([".w.", "wFw", ".w."]),
  tocha0: pad([".F.", "fFf", ".f.", ".D.", ".D.", ".d.", ".d."]),
  tocha1: pad(["F..", ".Ff", "fF.", ".D.", ".D.", ".d.", ".d."]),
  pincel: pad(["...v", "..d.", ".d..", "d..."]),
  cavalete: pad([
    "..d.......d.",
    ".aaaaaaaaaa.",
    ".aAAaaaaaaa.",
    ".aAvvvyaaaa.",
    ".aaavvyyaaa.",
    ".aaaaayaGaa.",
    ".aaaaaaGGaa.",
    ".aaaaaaaaaa.",
    "..d......d..",
    "..d......d..",
    ".d........d.",
    ".d........d.",
    "d..........d",
  ]),
  telescopio: pad([
    "..........kk",
    "........kGGk",
    "......kGGgk.",
    "....kGGgk...",
    "..kqqgk.....",
    ".kqqk.......",
    "..kk........",
    "...d.d......",
    "..d...d.....",
    ".d.....d....",
  ]),
  banco: pad(["eeeeeeeeeeee", "DDDDDDDDDDDD", ".d........d.", ".d........d."]),
  pergaminho: pad(["aaaa", "aAAa", "aaaa", "aAAa", "aaaa"]),
  pergaminhoFita: pad(["aaaa", "aAAa", "vvvv", "aAAa", "aaaa"]),
  pergaminhoRasgado: pad(["aaa.", "aAa.", "a.aa", ".aAa", "aa.a"]),
  xicara: pad(["aaa.", "aAaa", "aaa.", ".a.."]),
  "alerta-pequeno": pad(["v", "v", ".", "v"]),
  seloAlta: pad(["vv", "vv"]),
  carimbo: pad([".F.", "FFF", ".F."]),
  rolo0: pad([".kkk.", "kqwqk", "kwkwk", "kqwqk", ".kkk."]),
  rolo1: pad([".kkk.", "kwqwk", "kqkqk", "kwqwk", ".kkk."]),
  estandarte: pad(["k", "kbbbbbb", "kbbbbbb", "kbBBBbb", "kbbbbbb", "kbbbbbb", "kbbbbbb", "kbb..bb", "kb....b", "k", "k"]),
  cristal: pad([
    "...x...",
    "..xXx..",
    ".xxXxx.",
    ".xxXxx.",
    "xxxXxxx",
    "xxxXxxx",
    "xxxXxxx",
    ".xxXxx.",
    ".xxXxx.",
    "..xXx..",
    "..xXx..",
    "...X...",
  ]),
  pedestal: pad(["qqqqqqqqq", ".pPPPPPp.", ".ppppppp."]),
  estrelinha: pad([".F.", "FwF", ".F."]),
  maozinha: pad(["cc", "cc"]),
  dedo: pad(["cccc"]),
  lampada: pad([".FFF.", "FFwFF", ".FFF.", "..k..", "..k.."]),
  balaoFala: pad([".kkkkkkk.", "kaaaaaaak", "kakakakak", "kaaaaaaak", ".kkkkkkk.", "..k......", ".k......."]),
  balaoFala2: pad([".kkkkkkk.", "kaaaaaaak", "kaakakaak", "kaaaaaaak", ".kkkkkkk.", "..k......", ".k......."]),
  suspiro: pad(["h.", ".h", "h."]),
  alcapao: pad(["kkkkkkkkkkkkkk", "kdDDdDDdDDdDDk", "kdDDdDDdDDdDDk", "kkkkkkkkkkkkkk"]),
};

/* ---------------- ícones de estado (balão com símbolo, nunca só cor) ---------------- */

const BALAO = [
  ".kkkkkkk.",
  "koooooook",
  "koooooook",
  "koooooook",
  "koooooook",
  "koooooook",
  "koooooook",
  "koooooook",
  ".kkkkkkk.",
  "...kok...",
  "....k....",
];

const SIMBOLOS = {
  pergunta: [".kkk.", "k...k", "...k.", "..k..", ".....", "..k.."],
  alerta: ["..k..", "..k..", "..k..", "..k..", ".....", "..k.."],
  ampulheta: ["kkkkk", ".kkk.", "..k..", "..k..", ".k.k.", "kkkkk"],
  estrela: ["..k..", ".kkk.", "kkkkk", ".kkk.", ".k.k.", "....."],
  "sem-mana": ["...kk", "..kk.", ".kkkk", "..kk.", ".kk..", "kk..."],
  joinha: [".....", "....k", "...k.", "k.k..", ".k...", "....."],
  ombros: [".....", ".....", "k.k.k", ".....", ".....", "....."],
  voce: ["k...k", "k...k", ".k.k.", ".k.k.", "..k..", "....."],
};
/** Cor do balão por ícone (estado do DS: warning/danger/success/info; neutro = sem mana). */
const FUNDO_DO_ICONE = { pergunta: "y", alerta: "v", ampulheta: "i", estrela: "n", "sem-mana": "h", joinha: "n", ombros: "h", voce: "a" };
export const ICONES = Object.keys(SIMBOLOS);
export const ICONE_W = 9;
export const ICONE_H = BALAO.length;

/** Balão 9×11 com o símbolo do estado. */
export function mascaraDoIcone(nome) {
  const s = SIMBOLOS[nome];
  if (!s) return null;
  const fundo = FUNDO_DO_ICONE[nome];
  const g = BALAO.map((l) => l.replace(/o/g, fundo).split(""));
  s.forEach((linha, y) => {
    for (let x = 0; x < linha.length; x++) if (linha[x] === "k") g[2 + y][2 + x] = "k";
  });
  return g.map((l) => l.join(""));
}

/* ---------------- a torre em miniatura (visão geral e ilha) ---------------- */

/**
 * Torre pequena, 15×30: estandarte em cima, telhado, 4 janelas (Observatório, Salão, Biblioteca,
 * Ateliê, de cima pra baixo) e a porta do porão. As janelas são `1`..`4` e a porta `5`: quem pinta
 * troca por luz acesa (`l`) ou apagada (`m`).
 */
export const TORRE_MINI = pad([
  "......kb",
  "......kbbb",
  "......kbB",
  "......k",
  ".....qqq",
  "....qPPPq",
  "...qPPPPPq",
  "..qPPPPPPPq",
  ".kkkkkkkkkkk",
  "..pPPPPPPPp",
  "..pPP111PPp",
  "..pPP111PPp",
  "..pPPPPPPPp",
  "..pP22222Pp",
  "..pP22222Pp",
  "..pPPPPPPPp",
  "..pPP333PPp",
  "..pPP333PPp",
  "..pPPPPPPPp",
  "..pPP444PPp",
  "..pPP444PPp",
  "..pPPPPPPPp",
  "..pPPPPPPPp",
  "..pPP555PPp",
  "..pPP555PPp",
  ".qqqqqqqqqqq",
]);

/** Máscara da torre pequena com as janelas acesas (`{ observatorio, salao, biblioteca, atelie, porao }`). */
export function mascaraDaTorreMini(janelas = {}) {
  const luz = (on) => (on ? "l" : "m");
  const troca = {
    1: luz(janelas.observatorio),
    2: luz(janelas.salao),
    3: luz(janelas.biblioteca),
    4: luz(janelas.atelie),
    5: janelas.porao ? "f" : "k",
  };
  return TORRE_MINI.map((l) => l.replace(/[1-5]/g, (n) => troca[n]));
}

/* ---------------- tiles da dungeon (Kenney "Tiny Dungeon", CC0, recoloridos) ---------------- */

export const TILES_DUNGEON = {
  // Kenney Tiny Dungeon tile_0049 (CC0)
  chao: [
    "pppppppppppppppp",
    "pppppppppppppppp",
    "pPPppppppppppppp",
    "pPPpppmppppppppp",
    "pppppppppppppppp",
    "pppmpppppppppppp",
    "ppppppmmpppppppp",
    "ppppppmmpppppppp",
    "pppppppppppppppp",
    "pppppppppppppppp",
    "pppppppppppppppp",
    "ppppppppppppmppp",
    "pppppppppppppppp",
    "pppppppppPpppppp",
    "pppppppppppppPpp",
    "pppppppppppppppp",
  ],
  // Kenney Tiny Dungeon tile_0040 (CC0)
  parede: [
    "mmmmmmmmmmmmmmmm",
    "ppppppmpqqqqpmpp",
    "ppppppmppppppmpp",
    "ppppppmppppppmpp",
    "mmmmmmmmmmmmmmmm",
    "qqpmppppppmpqqqq",
    "pppmppppppmppppp",
    "pppmppppppmppppp",
    "mmmmmmmmmmmmmmmm",
    "ppppppmpqqqqpmpp",
    "ppppppmppppppmpp",
    "ppppppmppppppmpp",
    "mmmmmmmmmmmmmmmm",
    "qqpmppppppmpqqqq",
    "pppmppppppmppppp",
    "pppmppppppmppppp",
  ],
  // Kenney Tiny Dungeon tile_0028 (CC0)
  paredeGrade: [
    "PPPPPPPPPPPPPPPP",
    "ppppppPpqqqqpPpp",
    "ppppppPppppppPpp",
    "ppppppPppppppPpp",
    "PPPPPPPPPPPPPPPP",
    "qqpPppppppPpqqqq",
    "pppPppppppPppppp",
    "pppPppppppPppppp",
    "PPPmmPmmmmpmmPPP",
    "pppmmqmmmmqmmppp",
    "pppmmqmmmmqmmppp",
    "pppmmqmmmmqmmppp",
    "PPPqqqqqqqqqqPPP",
    "qqpPppppppPpppqq",
    "pppPppppppPppppp",
    "pppPppppppPppppp",
  ],
  // Kenney Tiny Dungeon tile_0045 (CC0)
  porta: [
    "PPppppppppppppPP",
    "pppppppppppppppp",
    "pppppppPPppppppp",
    "pppPmmmmmmmmPppp",
    "pppmmmmmmmmmmppp",
    "pppmmdDDDDdmmppp",
    "ppqmmDddddDmmqpp",
    "pPPmmDddddDmmPPp",
    "pPPmmDddddDmmPPp",
    "pppmmDddddDmmppp",
    "pppmmDdppdDmmppp",
    "ppqmmDdppdDmmqpp",
    "pPPmmDdmmdDmmPPp",
    "pPPmmDddddDmmPPp",
    "pppmmDddddDmmppp",
    "pppmmDDDDDDmmppp",
  ],
  // Kenney Tiny Dungeon tile_0090 (CC0)
  bau: [
    "................",
    "................",
    ".mmmmmmmmmmmmmm.",
    "mmmmmmmmmmmmmmmm",
    "mmDppDDDDDDppDmm",
    "mmDqqeeeeeeqqDmm",
    "mmDppDqqqqDppDmm",
    "mmqqqPqppqPqqqmm",
    "mmqqqPqppqPqqqmm",
    "mmdmmmqqqqmmmdmm",
    "mmdmmmmmmmmmmdmm",
    "mmDmmmmmmmmmmDmm",
    "mmDDDDDDDDDDDDmm",
    "mmPddddddddddPmm",
    "mmqDDDDDDDDDDqmm",
    "mmqqqqqqqqqqqqmm",
  ],
  // Kenney Tiny Dungeon tile_0091 (CC0)
  bauAberto: [
    ".mmmmmmmmmmmmmm.",
    "mmmmmmmmmmmmmmmm",
    "mmDppDDDDDDppDmm",
    "mmDqqeeeeeeqqDmm",
    "mmDppDqqqqDppDmm",
    "mmqqqPqppqPqqqmm",
    "mmqqqPqppqPqqqmm",
    "mmdmmmqqqqmmmdmm",
    "mmdmmmmmmmmmmdmm",
    "mmdmmmmmmmmmmdmm",
    "mmDmmmmmmmmmmDmm",
    "mmDmmmmmmmmmmDmm",
    "mmDDDDDDDDDDDDmm",
    "mmPddddddddddPmm",
    "mmqDDDDDDDDDDqmm",
    "mmqqqqqqqqqqqqmm",
  ],
  // Kenney Tiny Dungeon tile_0024 (CC0)
  entulho: [
    "pppppppppppppppp",
    "pppppppppppppqpp",
    "ppPpmmppppppqqqp",
    "ppppmmpppppppqpp",
    "pqpppppppqqpmmmp",
    "pppppppppqqpqqpp",
    "pppqqppppmmpqqpp",
    "pppqqppppppppppp",
    "pppppppppppppppp",
    "pppqqqppppppppPp",
    "ppqqqqqpqqpppppp",
    "ppqqqqqpqqpppppp",
    "ppqqqqqppppmmppp",
    "pppqqqpppppmmppp",
    "ppmmmmmppppppppp",
    "pppppppppppppppp",
  ],
};
