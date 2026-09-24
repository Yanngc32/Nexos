/**
 * Animação de "alguém mexeu aqui" pra canvas com pan/zoom: um cursor sintético vai até o alvo,
 * um contorno se desenha em volta e o elemento entra (ou pulsa, ou a linha se desenha).
 * Mesma linguagem e mesmas classes (`.ds-cursor`, `.ds-traco`) da animação do Design System
 * (`canvas-ds.js::rodarFila`); por enquanto só a Tela de Planejamento usa este módulo — unificar
 * com o DS fica pra quando o trabalho dele estiver commitado.
 *
 * Cursor e camada de contorno moram DENTRO do board (mesma transformação de pan/zoom), então as
 * coordenadas são do board e acompanham a vista sem recalcular. O cursor leva contra-escala pra
 * manter o tamanho na tela em qualquer zoom.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {{ doc?: Document, camada: SVGElement, cursor: HTMLElement, escala: () => number,
 *   ligada?: () => boolean, reduzir?: () => boolean, esperar?: (ms:number) => Promise<void> }} deps
 */
export function criarAnimador({
  doc = globalThis.document,
  camada,
  cursor,
  escala,
  ligada = () => true,
  reduzir = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true,
  esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  /** @type {{tipo:"entrar"|"pulso"|"linha", alvo: Element, rect?: {x:number,y:number,w:number,h:number}, ponta?: {x:number,y:number}}[]} */
  const fila = [];
  let rodando = false;

  /** Esconde o que vai entrar ANTES da fila chegar nele (senão pisca inteiro e depois anima). */
  function preparar(item) {
    if (item.tipo === "entrar") {
      item.alvo.style.opacity = "0";
      item.alvo.style.transform = `${item.alvo.style.transform || ""} scale(.97)`.trim();
      item.transformFinal = item.alvo.style.transform.replace(/\s*scale\(\.97\)$/, "");
    }
    if (item.tipo === "linha") {
      const len = typeof item.alvo.getTotalLength === "function" ? item.alvo.getTotalLength() : 0;
      item.len = len;
      if (len) {
        item.alvo.style.strokeDasharray = String(len);
        item.alvo.style.strokeDashoffset = String(len);
      }
    }
  }

  function mostrarSemAnimar(item) {
    if (item.tipo === "entrar") {
      item.alvo.style.opacity = "";
      item.alvo.style.transform = item.transformFinal ?? item.alvo.style.transform;
    }
    if (item.tipo === "linha") {
      item.alvo.style.strokeDasharray = "";
      item.alvo.style.strokeDashoffset = "";
    }
  }

  function enfileirar(itens) {
    const lista = (Array.isArray(itens) ? itens : [itens]).filter((i) => i?.alvo);
    if (!lista.length) return;
    if (!ligada()) return;
    for (const item of lista.slice(0, 60)) {
      preparar(item);
      fila.push(item);
    }
    if (!rodando) void rodar();
  }

  function contorno(r) {
    const rect = doc.createElementNS(SVG_NS, "rect");
    const w = Math.max(2, r.w);
    const h = Math.max(2, r.h);
    rect.setAttribute("x", String(r.x));
    rect.setAttribute("y", String(r.y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", "8");
    const per = 2 * (w + h);
    rect.style.strokeDasharray = String(per);
    rect.style.strokeDashoffset = String(per);
    camada.append(rect);
    void rect.getBoundingClientRect();
    rect.classList.add("desenha");
    setTimeout(() => {
      rect.classList.add("some");
      setTimeout(() => rect.remove(), 400);
    }, 380);
  }

  function moverCursor(x, y) {
    const s = 1 / (escala() || 1);
    cursor.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    cursor.classList.add("on");
  }

  async function rodar() {
    rodando = true;
    try {
      while (fila.length) {
        const item = fila.shift();
        if (!item.alvo.isConnected) continue;
        if (reduzir()) {
          mostrarSemAnimar(item);
          if (item.tipo === "pulso") pulsar(item.alvo);
          continue;
        }
        // fila grande acelera: o fim nunca atrasa muito do que já está no disco
        const passo = fila.length > 20 ? 40 : fila.length > 8 ? 70 : 110;
        if (item.tipo === "linha") {
          const p = item.ponta ?? { x: 0, y: 0 };
          moverCursor(p.x, p.y);
          await esperar(passo);
          item.alvo.classList.add("pl-desenhando");
          item.alvo.style.strokeDashoffset = "0";
          setTimeout(() => {
            if (!item.alvo.isConnected) return;
            item.alvo.classList.remove("pl-desenhando");
            item.alvo.style.strokeDasharray = "";
            item.alvo.style.strokeDashoffset = "";
          }, 420);
          continue;
        }
        const r = item.rect;
        if (r) {
          moverCursor(r.x + Math.min(r.w, 24), r.y + Math.min(r.h, 18));
          await esperar(passo);
          contorno(r);
        }
        if (item.tipo === "entrar") {
          item.alvo.classList.add("pl-entrando");
          item.alvo.style.opacity = "";
          item.alvo.style.transform = item.transformFinal ?? "";
          setTimeout(() => item.alvo.classList.remove("pl-entrando"), 320);
        } else pulsar(item.alvo);
      }
    } finally {
      rodando = false;
      setTimeout(() => {
        if (!rodando) cursor.classList.remove("on");
      }, 500);
    }
  }

  function pulsar(alvo) {
    alvo.classList.remove("pulso");
    void alvo.offsetWidth;
    alvo.classList.add("pulso");
  }

  return { enfileirar, ocupado: () => rodando || fila.length > 0 };
}
