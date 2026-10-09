/**
 * Sprites em pixel do Nexos: o maguinho da janela, o da ilha e os personagens da torre.
 *
 * O NÚCLEO é puro (sem DOM, testável): uma animação é `{ quadros: [{ q, ms }], total, loop }` e
 * `quadroNoTempo(anim, t)` devolve o quadro da vez dado o tempo — ninguém mais precisa de um
 * `setTimeout` por quadro. Um quadro (`q`) é o que a tela souber pintar: o nome do PNG do mago
 * (`"idle-blink"`) ou a descrição de um quadro da torre (`{ olhos: "fechado", dy: 1 }`).
 *
 * A parte de DOM fica no fim e só roda no navegador: máscara em texto + paleta → canvas (com
 * cache por paleta), e o "pode animar?" (aba visível, sem `prefers-reduced-motion`).
 */

/* ---------------- núcleo ---------------- */

/**
 * Monta uma animação. Aceita os dois formatos que já existiam no app:
 * - clipe `[[quadro, ms], ...]` (painel da ilha) — `ms` 0 = quadro final, a animação para nele;
 * - lista de quadros + um `ms` pra todos (pet da janela).
 */
export function anim(quadros, ms, loop = true) {
  const lista = (Array.isArray(quadros) ? quadros : []).map((x) =>
    Array.isArray(x) && ms === undefined ? { q: x[0], ms: Math.max(0, Number(x[1]) || 0) } : { q: x, ms: Math.max(0, Number(ms) || 0) },
  );
  // um quadro de 0 ms no meio do clipe é "para aqui": não tem loop depois dele
  const parada = lista.findIndex((f) => f.ms === 0);
  const ativos = parada >= 0 ? lista.slice(0, parada + 1) : lista;
  const total = ativos.reduce((s, f) => s + f.ms, 0);
  return { quadros: ativos, total, loop: loop && parada < 0 && total > 0 };
}

/** Índice do quadro no tempo `t` (ms desde que a animação começou). */
export function indiceNoTempo(a, t) {
  const n = a?.quadros?.length ?? 0;
  if (!n) return -1;
  if (!(a.total > 0)) return 0;
  let resto = Math.max(0, Number(t) || 0);
  if (a.loop) resto %= a.total;
  else if (resto >= a.total) return n - 1;
  for (let i = 0; i < n; i++) {
    if (resto < a.quadros[i].ms) return i;
    resto -= a.quadros[i].ms;
  }
  return n - 1;
}

/** O quadro (`q`) da vez no tempo `t`. */
export function quadroNoTempo(a, t) {
  const i = indiceNoTempo(a, t);
  return i < 0 ? undefined : a.quadros[i].q;
}

/** Quanto falta pro próximo quadro (pra agendar o redesenho); `Infinity` = parou de mudar. */
export function proximaTroca(a, t) {
  const n = a?.quadros?.length ?? 0;
  if (n <= 1 || !(a.total > 0)) return Infinity;
  let resto = Math.max(0, Number(t) || 0);
  if (a.loop) resto %= a.total;
  else if (resto >= a.total) return Infinity;
  for (let i = 0; i < n; i++) {
    if (resto < a.quadros[i].ms) return a.quadros[i].ms - resto;
    resto -= a.quadros[i].ms;
  }
  return Infinity;
}

/** Quadro parado (movimento reduzido): o primeiro, que é a pose de descanso de cada estado. */
export function quadroParado(a) {
  return a?.quadros?.[0]?.q;
}

/**
 * Máscara em texto (um caractere por pixel, "." vazio) → trechos de cor por linha, `{ x, y, w, cor }`.
 * Letra fora da paleta vira erro: assim um desenho errado quebra o teste, não a tela.
 */
export function trechosDaMascara(linhas, paleta) {
  const out = [];
  (linhas ?? []).forEach((linha, y) => {
    let x = 0;
    while (x < linha.length) {
      const ch = linha[x];
      const a = x;
      while (x < linha.length && linha[x] === ch) x++;
      if (ch === "." || ch === " ") continue;
      const cor = paleta[ch];
      if (!cor) throw new Error(`cor "${ch}" fora da paleta (linha ${y})`);
      out.push({ x: a, y, w: x - a, cor });
    }
  });
  return out;
}

/** Largura × altura da máscara (a linha mais comprida manda). */
export function tamanhoDaMascara(linhas) {
  return { w: Math.max(0, ...(linhas ?? []).map((l) => l.length)), h: (linhas ?? []).length };
}

/* ---------------- tabelas do maguinho (janela e ilha) ---------------- */

/**
 * O maguinho da ilha de borda: clipes curtos, só indicador de estado. Quadros em pets/nexo/mago.
 * (Era a tabela `MAGO` do painel.js — mesmos quadros, mesmos tempos.)
 */
export const MAGO_ILHA = {
  off: [["off", 0]],
  parado: [["idle", 2600], ["idle-breath", 700], ["idle", 1800], ["idle-blink-half", 70], ["idle-blink", 110], ["idle-blink-half", 70]],
  trabalhando: [["work", 240], ["work-tap-a", 90], ["work-on", 110], ["work-tap-b", 90], ["work-dim", 70], ["work-tap-a-on", 90], ["work", 200], ["work-tap-b", 90], ["work-blink", 120]],
  esperando: [["wait-0", 900], ["wait-1", 650], ["wait-2", 650], ["wait-3", 650], ["wait-blink", 110], ["wait-3", 650], ["wait-flip", 260]],
  // o pulinho acontece uma vez; depois ele fica parado
  terminou: [["done-rest", 200], ["done-squat", 120], ["done-jump", 90], ["done-high", 140], ["done-high", 140], ["done-land", 110], ["idle", 0]],
};

/** Um passo do clipe da ilha: o quadro `i` (dando a volta) e quanto ele dura (0 = para). */
export function passoDoClipe(clipe, i) {
  const [nome, ms] = clipe[i % clipe.length];
  return { nome, ms };
}

/*
 * O maguinho da janela (canto do composer). Estados: off / wake / idle / think / work / done /
 * espera / sai / fora. Os "temperos" variam o idle e o work pra ele não repetir igual.
 * (Eram PET_* do renderer.js — mesmos quadros, mesmos tempos.)
 */
const PET_REST = "idle";
const PET_BLINK = ["idle-blink-half", "idle-blink", "idle-blink-half"];
export const PET_IDLE_SPICE = [
  [PET_REST, "idle-breath", PET_REST, ...PET_BLINK, PET_REST],
  [PET_REST, "idle-look-l", "idle-look-l", PET_REST, "idle-look-r", "idle-look-r", PET_REST, ...PET_BLINK, PET_REST],
  [PET_REST, "idle-in1", "idle-in2", "idle-hide", "idle-hide", "idle-in2", "idle-in1", PET_REST, ...PET_BLINK, PET_REST],
];
export const PET_WORK_SPICE = [
  ["work", "work-tap-a", "work-on", "work-tap-b", "work-dim", "work-tap-a-on", "work", "work-tap-b", "work-logo", "work-tap-a", "work-blink", "work-tap-b-on", "work"],
  ["work", "work-tap-b", "work-on", "work-tap-a", "work-dim", "work-tap-b-on", "work-logo", "work-tap-a", "work-blink", "work"],
];
export const PET_FRAMES = {
  off: ["off", "off-z1", "off-z2", "off-z1"],
  wake: ["idle-hide", "idle-in2", "idle-in1", ...PET_BLINK, PET_REST],
  idle: PET_IDLE_SPICE[0],
  think: ["think-0", "think-1", "think-2", "think-3", "think-3"],
  work: PET_WORK_SPICE[0],
  done: ["done-rest", "done-squat", "done-jump", "done-high", "done-high", "done-land", "done-rest"],
  espera: ["wait-0", "wait-1", "wait-2", "wait-3", "wait-blink", "wait-3", "wait-flip"],
  // Configurações abertas: entra no chapéu aqui (o chapéu fica) e sai dele lá
  sai: [PET_REST, "idle-in1", "idle-in2", "idle-hide"],
  fora: ["idle-hide"],
};
export const PET_NEXT = { wake: "idle", done: "idle", sai: "fora" };
export const PET_FRAME_MS = { off: 700, wake: 220, idle: 400, think: 380, work: 120, done: 120, sai: 140, espera: 650 };

/* ---------------- DOM (só no navegador) ---------------- */

const cacheDeCanvas = new Map();

/**
 * Máscara + paleta → canvas do tamanho exato da máscara (1 pixel por letra). Cacheado pela
 * chave dada: a mesma roupa não é redesenhada a cada quadro.
 */
export function canvasDaMascara(chave, linhas, paleta) {
  const hit = cacheDeCanvas.get(chave);
  if (hit) return hit;
  const { w, h } = tamanhoDaMascara(linhas);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, w);
  cv.height = Math.max(1, h);
  const ctx = cv.getContext("2d");
  for (const t of trechosDaMascara(linhas, paleta)) {
    ctx.fillStyle = t.cor;
    ctx.fillRect(t.x, t.y, t.w, 1);
  }
  cacheDeCanvas.set(chave, cv);
  return cv;
}

/** Esvazia o cache (troca de tema: a paleta mudou). */
export function esquecerCanvases() {
  cacheDeCanvas.clear();
}

/** Pode animar agora? Aba escondida ou janela minimizada = não; movimento reduzido = não. */
export function podeAnimar(doc = globalThis.document, win = globalThis.window) {
  if (doc?.hidden) return false;
  return !win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}
