/**
 * A ilha do painel de borda: quando ela está recolhida (só o traço), compacta (mago + passo atual)
 * ou aberta (cards), e de que tamanho fica. Ideia do Coucou (github.com/Louis-CFM/coucou, MIT):
 * trabalho comum só revela o compacto; o que pede resposta abre e fica aberto.
 *
 * Nada aqui mexe no DOM nem faz requisição — o painel.js pinta o que isto decide.
 */

/** Tamanhos em px da página (a escala das Configurações é zoom da janela, não entra aqui). */
export const ILHA = {
  /** Traço recolhido: comprimento ao longo da borda × espessura. */
  tracoComp: 56,
  tracoEsp: 5,
  compactoW: 300,
  compactoH: 36,
  abertoW: 660,
  /** Folga entre a ilha e o limite da janela (a sombra precisa de espaço). */
  margem: 8,
};

/** Depois que o mouse sai do compacto: tempo pra voltar ao traço. */
export const COMPACTO_SOME_MS = 1200;
/** Depois que o mouse sai da ilha aberta: tempo pra voltar ao compacto. */
export const ABERTO_RECOLHE_MS = 6000;

/**
 * Máquina de estados da ilha. `piso` é o menor modo permitido: "recolhido" no painel dinâmico,
 * "compacto" no fixo. `pinado` = há pergunta na tela esperando resposta: não fecha sozinha.
 * `fixado` = a pessoa pediu "manter aberto".
 */
export class Ilha {
  modo = "recolhido";
  piso = "recolhido";
  dentro = false;
  pinado = false;
  fixado = false;
  /** Quando a ilha aberta vai recolher sozinha (ms de relógio), ou 0 — é a barrinha de contagem. */
  recolheEm = 0;
  aoMudar = null;
  #timer = 0;

  #ir(modo) {
    if (modo === "recolhido" && this.piso === "compacto") modo = "compacto";
    if (modo === this.modo) return;
    const antes = this.modo;
    this.modo = modo;
    if (modo !== "aberto") this.pinado = false;
    this.aoMudar?.(antes, modo);
  }

  #cancelar() {
    clearTimeout(this.#timer);
    this.#timer = 0;
    this.recolheEm = 0;
  }

  /** Sem mouse em cima: agenda o próximo degrau pra baixo (aberto → compacto → recolhido). */
  #agendar(ms) {
    this.#cancelar();
    if (this.dentro) return;
    if (this.modo === "aberto") {
      if (this.pinado || this.fixado) return;
      const espera = ms ?? ABERTO_RECOLHE_MS;
      this.recolheEm = Date.now() + espera;
      this.#timer = setTimeout(() => {
        this.#ir("compacto");
        this.#agendar();
      }, espera);
      // a contagem mudou sem o modo mudar: quem pinta precisa saber
      this.aoMudar?.(this.modo, this.modo);
    } else if (this.modo === "compacto" && this.piso === "recolhido") {
      this.#timer = setTimeout(() => this.#ir("recolhido"), ms ?? COMPACTO_SOME_MS);
    }
  }

  definirPiso(piso) {
    this.piso = piso === "compacto" ? "compacto" : "recolhido";
    if (this.piso === "compacto" && this.modo === "recolhido") this.#ir("compacto");
    this.#agendar();
  }

  entrou() {
    this.dentro = true;
    const tinhaContagem = this.recolheEm > 0;
    this.#cancelar();
    if (this.modo === "recolhido") this.#ir("compacto");
    else if (tinhaContagem) this.aoMudar?.(this.modo, this.modo);
  }

  saiu() {
    this.dentro = false;
    this.#agendar();
  }

  /** Clique no compacto abre; aberto, clique é dos botões de dentro. */
  clicar() {
    if (this.modo !== "compacto") return false;
    this.abrir();
    return true;
  }

  /** `pinado`: fica aberta até alguém responder ou recolher. `ms`: tempo do espiar. */
  abrir({ pinado = false, ms } = {}) {
    this.#cancelar();
    this.#ir("aberto");
    this.pinado = pinado;
    this.#agendar(ms);
  }

  /** Botão recolher, ou a pergunta que segurava a ilha foi respondida. */
  recolher() {
    this.#cancelar();
    this.pinado = false;
    this.fixado = false;
    this.#ir("compacto");
    this.#agendar();
  }

  /** Conversa começou a trabalhar: mostra o compacto por `ms` e volta pro traço. */
  espiar(ms) {
    if (this.modo !== "recolhido") return;
    this.#ir("compacto");
    this.#agendar(ms);
  }

  fixar(on) {
    this.fixado = Boolean(on);
    if (this.fixado) this.#cancelar();
    else this.#agendar();
    this.aoMudar?.(this.modo, this.modo);
  }

  /** Painel desligado/escondido: nada de timer pendurado. */
  parar() {
    this.#cancelar();
  }
}

const vertical = (borda) => borda === "direita" || borda === "esquerda";

/** Largura × altura da ilha no modo dado. `alt` = altura medida do conteúdo aberto. */
export function tamanhoDaIlha(modo, borda, alt = 0) {
  if (modo === "aberto") return { w: ILHA.abertoW, h: Math.max(ILHA.compactoH, Math.round(alt)) };
  if (modo === "compacto") return { w: ILHA.compactoW, h: ILHA.compactoH };
  return vertical(borda) ? { w: ILHA.tracoEsp, h: ILHA.tracoComp } : { w: ILHA.tracoComp, h: ILHA.tracoEsp };
}

/**
 * Onde a ilha fica dentro da janela (px da página): encostada na borda, centrada em `centro` ao
 * longo dela, sem sair da janela. Devolve também o `centro` já limitado — é ele que o CSS usa.
 */
export function caixaDaIlha(borda, centro, janela, tam) {
  const ao = vertical(borda) ? tam.h : tam.w;
  const total = vertical(borda) ? janela.h : janela.w;
  const meio = ao / 2 + ILHA.margem;
  const c = Math.min(Math.max(centro, meio), Math.max(meio, total - meio));
  const inicio = Math.round(c - ao / 2);
  const caixa =
    borda === "direita"
      ? { x: janela.w - tam.w, y: inicio }
      : borda === "esquerda"
        ? { x: 0, y: inicio }
        : borda === "baixo"
          ? { x: inicio, y: janela.h - tam.h }
          : { x: inicio, y: 0 };
  return { ...caixa, w: tam.w, h: tam.h, centro: Math.round(c) };
}

/** Faixa que só desperta a ilha recolhida (o clique ali ainda atravessa pra janela de trás). */
export function faixaDeDespertar(borda, centro, janela, profundidade = 24, comprimento = 120) {
  const tam = vertical(borda) ? { w: profundidade, h: comprimento } : { w: comprimento, h: profundidade };
  const { x, y, w, h } = caixaDaIlha(borda, centro, janela, tam);
  return { x, y, w, h };
}
