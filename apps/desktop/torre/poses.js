/**
 * Torre de magia — as POSES: cada pose é uma animação (sprites.js) cujos quadros descrevem o que
 * pintar por cima do maguinho: olhos (`o`), pernas (`p`), deslocamento vertical (`dy`), corte do
 * corpo (`corte`, o mago entrando no chapéu) e objetos (`props`, com posição relativa ao canto de
 * cima/esquerda do mago, em pixels de torre).
 *
 * O PRIMEIRO quadro de cada pose é a pose de descanso: é o que fica na tela com movimento reduzido.
 * A mesa fica à direita do mago (tampo em y = 15): os objetos da mesa nascem dali.
 */
import { anim } from "../sprites.js";

/** Tampo da mesa, relativo ao mago (o mago fica em pé do lado esquerdo dela). */
export const MESA_X = 17;
export const MESA_Y = 15;

const q = (o, extra = {}) => ({ o, p: "parado", dy: 0, props: [], ...extra });
const naMesa = (nome, x, h) => [nome, MESA_X + x, MESA_Y - h];
const LIVRO = [naMesa("livro", 3, 4)];
const CALDEIRAO = naMesa("caldeirao", 4, 6);

export const POSES = {
  /* ---- ócio (o cérebro sorteia entre eles) ---- */
  descanso: anim([[q("normal"), 2600], [q("fechado"), 120], [q("normal"), 1800], [q("direita"), 900], [q("normal"), 600], [q("esquerda"), 900]]),
  lendo: anim([
    [q("baixo", { props: LIVRO }), 2400],
    [q("fechado", { props: LIVRO }), 120],
    [q("baixo", { props: LIVRO }), 1900],
    [q("baixo", { dy: 1, props: LIVRO }), 500],
  ]),
  cochilando: anim([
    [q("fechado", { props: [["z", 14, -3]] }), 900],
    [q("fechado", { dy: 1, props: [["z", 15, -5]] }), 900],
  ]),
  bocejando: anim([
    [q("normal"), 300],
    [q("bocejo", { dy: -1 }), 500],
    [q("bocejo", { dy: -1, props: [["z", 14, -4]] }), 700],
    [q("fechado"), 400],
    [q("normal"), 300],
  ]),
  espreguicando: anim([
    [q("normal"), 200],
    [q("fechado", { dy: -1, props: [["maozinha", -2, 8], ["maozinha", 17, 8]] }), 500],
    [q("fechado", { dy: -2, props: [["maozinha", -2, 5], ["maozinha", 17, 5]] }), 700],
    [q("contente", { dy: -1 }), 300],
    [q("normal"), 400],
  ]),
  "no-chapeu": anim([
    [q("normal"), 400],
    [q("normal", { corte: 4 }), 160],
    [q("normal", { corte: 11 }), 160],
    [q("normal", { corte: 17 }), 1800],
    [q("normal", { corte: 11 }), 160],
    [q("normal", { corte: 4 }), 160],
    [q("normal"), 300],
    [q("fechado"), 120],
  ]),
  "balancando-pernas": anim([[q("normal", { p: "passo" }), 500], [q("normal", { p: "parado" }), 500], [q("direita", { p: "passo" }), 500], [q("normal", { p: "parado" }), 700]]),

  /* ---- trabalho ---- */
  pensando: anim([
    [q("cima"), 380],
    [q("cima", { props: [["pontinhos1", 13, -2]] }), 380],
    [q("cima", { props: [["pontinhos2", 13, -2]] }), 380],
    [q("cima", { props: [["pontinhos3", 13, -2]] }), 600],
  ]),
  ideia: anim([[q("cima", { props: [["lampada", 12, -6]] }), 300], [q("contente", { dy: -1, props: [["lampada", 12, -7]] }), 500]], undefined, false),
  escrevendo: anim([
    [q("direita", { props: [naMesa("papel", 4, 5), naMesa("pena", 7, 9)] }), 140],
    [q("direita", { dy: 1, props: [naMesa("papel", 4, 5), naMesa("pena", 8, 8)] }), 140],
    [q("direita", { props: [naMesa("papel", 4, 5), naMesa("pena", 6, 9)] }), 140],
    [q("direita", { dy: 1, props: [naMesa("papel", 4, 5), naMesa("pena", 7, 8)] }), 140],
  ]),
  "escrevendo-devagar": anim([
    [q("baixo", { props: [naMesa("papel", 4, 5), naMesa("pena", 7, 9)] }), 420],
    [q("baixo", { dy: 1, props: [naMesa("papel", 4, 5), naMesa("pena", 8, 8)] }), 420],
  ]),
  folheando: anim([
    [q("direita", { props: LIVRO }), 320],
    [q("baixo", { props: [naMesa("livroFechado", 4, 4)] }), 180],
    [q("direita", { props: LIVRO }), 420],
  ]),
  caldeirao: anim([
    [q("direita", { props: [CALDEIRAO, naMesa("bolhas0", 5, 9)] }), 240],
    [q("direita", { dy: 1, props: [CALDEIRAO, naMesa("bolhas1", 5, 9)] }), 240],
    [q("direita", { props: [CALDEIRAO, naMesa("bolhas0", 5, 9)] }), 240],
    [q("fechado", { dy: 1, props: [CALDEIRAO, naMesa("faisca", 5, 11)] }), 160],
  ]),
  tamborilando: anim([
    [q("direita", { props: [CALDEIRAO] }), 600],
    [q("fechado", { props: [CALDEIRAO] }), 120],
    [q("direita", { dy: 1, props: [CALDEIRAO] }), 300],
    [q("direita", { props: [CALDEIRAO] }), 300],
  ]),
  "bola-de-cristal": anim([
    [q("direita", { props: [naMesa("bolaDeCristal", 4, 5)] }), 500],
    [q("direita", { props: [naMesa("bolaDeCristal", 4, 5), naMesa("brilho", 7, 8)] }), 200],
    [q("direita", { props: [naMesa("bolaDeCristal", 4, 5), naMesa("brilho", 4, 9)] }), 200],
    [q("direita", { props: [naMesa("bolaDeCristal", 4, 5), naMesa("brilho", 6, 10)] }), 200],
  ]),
  despachando: anim([
    [q("baixo", { props: [naMesa("papel", 4, 5)] }), 400],
    [q("direita", { props: [naMesa("papel", 4, 5)] }), 400],
  ]),
  ampulheta: anim([
    [q("cima", { props: [naMesa("ampulheta", 5, 5)] }), 650],
    [q("cima", { dy: 1, props: [naMesa("ampulheta", 5, 5)] }), 650],
    [q("fechado", { props: [naMesa("ampulhetaVazia", 5, 5)] }), 120],
    [q("cima", { props: [naMesa("ampulhetaVazia", 5, 5)] }), 650],
  ]),
  "sentado-banco": anim([[q("normal"), 2400], [q("fechado"), 140], [q("cima"), 1200]]),

  /* ---- fim, espera ---- */
  comemorando: anim([
    [q("contente"), 300],
    [q("contente", { dy: 1 }), 120],
    [q("contente", { dy: -4, props: [["brilho", -3, 6], ["brilho", 17, 4]] }), 140],
    [q("contente", { dy: -6, props: [["brilho", -4, 3], ["brilho", 18, 1]] }), 200],
    [q("contente", { dy: -3 }), 110],
    [q("contente", { dy: 1 }), 110],
    [q("contente"), 700],
  ]),
  segurando: anim([[q("cima"), 900], [q("normal"), 700]]),
  pulinho: anim([
    [q("contente"), 100],
    [q("contente", { dy: -2 }), 100],
    [q("contente", { dy: -3 }), 120],
    [q("contente", { dy: -2 }), 100],
    [q("contente"), 80],
  ]),

  /* ---- deslocamento ---- */
  andando: anim([[q("direita", { p: "passo" }), 180], [q("direita", { p: "parado", dy: 1 }), 180]]),
  "subindo-escada": anim([[q("cima", { p: "passo", dy: -1 }), 200], [q("cima", { p: "parado" }), 200]]),
  "descendo-escada": anim([[q("baixo", { p: "passo", dy: 1 }), 200], [q("baixo", { p: "parado" }), 200]]),
  levantando: anim([[q("normal", { dy: 1, p: "junto" }), 150], [q("normal") , 150]], undefined, false),
  sentando: anim([[q("normal"), 150], [q("normal", { dy: 1, p: "junto" }), 150]], undefined, false),
  ferido: anim([[q("fechado", { p: "junto", dy: 1 }), 320], [q("normal", { p: "parado" }), 260]]),
  explorando: anim([
    [q("direita", { p: "passo", props: [["tocha0", 16, 8]] }), 200],
    [q("direita", { p: "parado", dy: 1, props: [["tocha1", 16, 9]] }), 200],
  ]),
  "explorando-ferido": anim([
    [q("fechado", { p: "junto", dy: 1, props: [["tocha1", 16, 10]] }), 320],
    [q("normal", { p: "parado", props: [["tocha0", 16, 9]] }), 260],
  ]),
  "no-bau": anim([[q("contente", { props: [["tocha0", 16, 8]] }), 400], [q("contente", { dy: -1, props: [["tocha1", 16, 7]] }), 300]]),
  "olhando-telescopio": anim([[q("cima"), 1600], [q("fechado"), 120], [q("cima", { dy: 1 }), 900]]),
  pintando: anim([
    [q("direita", { props: [["pincel", 16, 8]] }), 220],
    [q("direita", { dy: 1, props: [["pincel", 17, 9]] }), 220],
    [q("direita", { props: [["pincel", 16, 10]] }), 220],
  ]),

  /* ---- entregas (a informação viaja com o personagem) ---- */
  "subindo-com-pergaminho": anim([
    [q("cima", { p: "passo", dy: -1, props: [["pergaminho", 15, 9]] }), 200],
    [q("cima", { p: "parado", props: [["pergaminho", 15, 10]] }), 200],
  ]),
  "andando-com-pergaminho": anim([
    [q("direita", { p: "passo", props: [["pergaminho", 16, 10]] }), 180],
    [q("direita", { p: "parado", dy: 1, props: [["pergaminho", 16, 11]] }), 180],
  ]),
  entregando: anim([[q("direita", { props: [["pergaminho", 17, 9]] }), 300], [q("contente", { props: [["pergaminho", 19, 8]] }), 500]], undefined, false),
  "lendo-entrega": anim([[q("baixo", { props: [["pergaminho", 12, 11]] }), 600], [q("baixo", { dy: 1, props: [["pergaminho", 12, 12]] }), 500], [q("contente", { props: [["pergaminho", 12, 11]] }), 700]]),
  "lendo-entrega-ruim": anim([[q("baixo", { props: [["pergaminhoRasgado", 12, 11]] }), 700], [q("fechado", { dy: 1, props: [["pergaminhoRasgado", 12, 12]] }), 600], [q("baixo", { props: [["pergaminhoRasgado", 12, 11]] }), 500]]),

  /* ---- lazer com saída, fila dos cristais, apagão ---- */
  "olhando-janela": anim([[q("cima"), 1800], [q("cima", { dy: -1 }), 500], [q("fechado"), 140], [q("cima"), 1200]]),
  "lendo-estante": anim([[q("baixo", { props: [["livro", 12, 10]] }), 1600], [q("fechado", { props: [["livro", 12, 10]] }), 140], [q("baixo", { dy: 1, props: [["livro", 12, 11]] }), 700]]),
  "escrevendo-estante": anim([[q("baixo", { props: [["papel", 12, 10], ["pena", 15, 7]] }), 300], [q("baixo", { dy: 1, props: [["papel", 12, 11], ["pena", 16, 8]] }), 300]]),
  "servindo-cha": anim([[q("direita", { props: [["xicara", 15, 11]] }), 400], [q("direita", { dy: 1, props: [["xicara", 15, 12]] }), 400]]),
  "bebendo-cha": anim([[q("normal", { props: [["xicara", 13, 13]] }), 1500], [q("fechado", { dy: -1, props: [["xicara", 12, 9]] }), 900], [q("contente", { props: [["xicara", 13, 13]] }), 600]]),
  "cochilando-banco": anim([[q("fechado", { dy: 1, props: [["z", 14, -2]] }), 1000], [q("fechado", { dy: 2, props: [["z", 15, -4]] }), 1000]]),
  "esperando-de-pe": anim([[q("normal"), 1400], [q("direita"), 600], [q("normal", { dy: 1 }), 400], [q("fechado"), 120]]),
  correndo: anim([[q("direita", { p: "passo", dy: -1 }), 90], [q("direita", { p: "parado" }), 90], [q("direita", { p: "junto", dy: -1 }), 90]]),
  "olhando-cima": anim([[q("cima"), 1000], [q("cima", { dy: -1 }), 600]]),
  susto: anim([[q("cima", { dy: -2, props: [["alerta-pequeno", 13, -4]] }), 350], [q("cima", { dy: 0 }), 350]], undefined, false),
  dancando: anim([
    [q("contente", { p: "passo" }), 180],
    [q("contente", { p: "parado", dy: -2, props: [["brilho", -2, 4]] }), 180],
    [q("contente", { p: "passo", dy: 0 }), 180],
    [q("contente", { p: "junto", dy: -2, props: [["brilho", 18, 2]] }), 180],
  ]),
  "procurando-com-tocha": anim([
    [q("direita", { p: "passo", props: [["tocha0", 16, 6]] }), 220],
    [q("cima", { p: "parado", dy: 1, props: [["tocha1", 16, 5]] }), 220],
    [q("direita", { p: "passo", props: [["tocha0", 16, 6]] }), 220],
    [q("baixo", { p: "parado", props: [["tocha1", 16, 8]] }), 400],
  ]),

  /* ---- convívio ---- */
  conversando: anim([
    [q("direita", { props: [["balaoFala", 12, -7]] }), 700],
    [q("direita"), 500],
    [q("direita", { props: [["balaoFala2", 12, -7]] }), 700],
    [q("fechado"), 150],
    [q("direita", { dy: 1 }), 500],
  ]),
  ouvindo: anim([[q("direita"), 900], [q("direita", { dy: 1 }), 400], [q("contente"), 600]]),
  espiando: anim([[q("baixo", { dy: -1 }), 600], [q("baixo"), 400], [q("direita", { dy: -1 }), 500]]),
  acenando: anim([[q("contente", { props: [["maozinha", 16, 9]] }), 180], [q("contente", { props: [["maozinha", 17, 7]] }), 180]]),
  apontando: anim([[q("direita", { props: [["dedo", 15, 13]] }), 500], [q("direita", { dy: 1, props: [["dedo", 15, 14]] }), 500]]),
  olhando: anim([[q("direita"), 1000]]),
  "comemorando-junto": anim([
    [q("contente"), 150],
    [q("contente", { dy: -3, props: [["brilho", 17, 3]] }), 160],
    [q("contente", { dy: -4 }), 140],
    [q("contente", { dy: -2 }), 120],
    [q("contente"), 600],
  ]),
};

/** Reações curtas (1–2 s) por cima da pose. */
export const REACOES = {
  "levanta-cabeca": anim([[q("cima", { dy: -1 }), 400], [q("cima"), 400]]),
  faisca: anim([[q("fechado", { props: [["faisca", 12, -5]] }), 150], [q("fechado", { dy: 1, props: [["faisca", 13, -6]] }), 150]]),
  facepalm: anim([[q("facepalm", { dy: 1 }), 700], [q("fechado"), 400]]),
  joinha: anim([[q("contente", { dy: -1, props: [["maozinha", 16, 10]] }), 300], [q("contente", { props: [["maozinha", 16, 10]] }), 300]]),
  ombros: anim([[q("normal", { dy: 1 }), 400], [q("normal"), 400]]),
  suspiro: anim([[q("baixo", { dy: 1, props: [["suspiro", 13, 12]] }), 600], [q("baixo", { dy: 1 }), 400]]),
  "olha-ampulheta": anim([[q("cima", { props: [["ampulheta", 14, -7]] }), 500], [q("cima", { props: [["ampulhetaVazia", 14, -7]] }), 500]]),
};

/** Ícone que a reação põe sobre a cabeça (além do do estado). */
export const ICONE_DA_REACAO = { joinha: "joinha", ombros: "ombros", faisca: "alerta", facepalm: "alerta" };

/** Poses de ócio que o cérebro sorteia (peso = quantas vezes aparece). */
export const POSES_DE_OCIO = ["lendo", "lendo", "lendo", "descanso", "descanso", "cochilando", "bocejando", "espreguicando", "no-chapeu", "balancando-pernas"];

export function poseDe(nome) {
  return REACOES[nome] ?? POSES[nome] ?? POSES.descanso;
}
