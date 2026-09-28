import { describe, expect, it } from "vitest";
import {
  VOLUME_EFEITO,
  VOLUME_MUSICA,
  duracaoEfetivaDaMusica,
  fmtMin,
  fmtS,
  maximoDaTransicao,
  moverNaOrdem,
  musicaMaisCurtaQueOVideo,
  passoParaBatida,
  pedidoDeTransicao,
  picosParaCaminhoSvg,
  rotuloDaTransicao,
  volumeEfeitoForaDaFaixa,
  volumeMusicaAcima,
} from "../canvas-video.js";

describe("painel de vídeo: helpers", () => {
  it("formata segundos com vírgula e uma casa", () => {
    expect(fmtS(3)).toBe("3,0 s");
    expect(fmtS(22.45)).toBe("22,5 s");
  });

  it("chip do conector: corte, preset com duração, personalizada com ✦", () => {
    expect(rotuloDaTransicao(null)).toBe("Corte");
    expect(rotuloDaTransicao({ tipo: "fade", duracao: 0.6 })).toBe("Fade 0,6 s");
    expect(rotuloDaTransicao({ tipo: "fundo", duracao: 0.4 })).toBe("Pelo fundo 0,4 s");
    expect(rotuloDaTransicao({ tipo: "personalizada", duracao: 0.8, nome: "Giro + logo" })).toBe("✦ Giro + logo");
  });

  it("limite da transição: metade da cena mais curta", () => {
    expect(maximoDaTransicao(4, 2.4)).toBe(1.2);
    expect(maximoDaTransicao(3, 3)).toBe(1.5);
  });

  it("mover na ordem (arrastar e Alt+setas)", () => {
    expect(moverNaOrdem(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moverNaOrdem(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moverNaOrdem(["a", "b", "c"], "b", 9)).toEqual(["a", "c", "b"]);
  });

  it("prompt da transição leva o contexto pro chat", () => {
    const video = {
      id: "v",
      nome: "Nexos v0.11.0",
      cenas: [
        { id: "chats", nome: "Três chats lado a lado", duracao: 4 },
        { id: "mago", nome: "O mago", duracao: 3 },
      ],
      linha: { transicoes: [{ de: "chats", para: "mago", tipo: "fade", duracao: 0.6 }] },
    };
    const t = pedidoDeTransicao(video, "chats", "mago", "sai girando e entra pelo logo");
    expect(t).toContain('cena 1 "Três chats lado a lado" (chats, 4,0 s)');
    expect(t).toContain('cena 2 "O mago" (mago, 3,0 s)');
    expect(t).toContain("Efeito atual: Fade 0,6 s");
    expect(t).toContain("Máximo: 1,5 s");
    expect(t).toContain("Pedido: sai girando e entra pelo logo");
    expect(t).toContain("nexo_video_transicao");
  });
});

describe("trilha de áudio: helpers", () => {
  it("formata duração de música mm:ss", () => {
    expect(fmtMin(60)).toBe("1:00");
    expect(fmtMin(108)).toBe("1:48");
    expect(fmtMin(9)).toBe("0:09");
  });

  it("volume da música: aviso só acima de 0,5 (padrão 0,35 não avisa)", () => {
    expect(volumeMusicaAcima(VOLUME_MUSICA.padrao)).toBe(false);
    expect(volumeMusicaAcima(0.5)).toBe(false);
    expect(volumeMusicaAcima(0.51)).toBe(true);
  });

  it("volume de efeito: aviso fora de 0,55–0,85", () => {
    expect(volumeEfeitoForaDaFaixa(VOLUME_EFEITO.padrao)).toBe(false);
    expect(volumeEfeitoForaDaFaixa(0.55)).toBe(false);
    expect(volumeEfeitoForaDaFaixa(0.85)).toBe(false);
    expect(volumeEfeitoForaDaFaixa(0.5)).toBe(true);
    expect(volumeEfeitoForaDaFaixa(0.9)).toBe(true);
  });

  it("música mais curta que o vídeo: só quando não repete e acaba antes", () => {
    expect(musicaMaisCurtaQueOVideo({ duracao: 18, repetir: false }, 22.5)).toBe(true);
    expect(musicaMaisCurtaQueOVideo({ duracao: 18, repetir: true }, 22.5)).toBe(false);
    expect(musicaMaisCurtaQueOVideo({ duracao: 30, repetir: false }, 22.5)).toBe(false);
    expect(musicaMaisCurtaQueOVideo(null, 22.5)).toBe(false);
    // duração desconhecida (música do Nexos ainda sem número): trata como do tamanho do vídeo
    expect(duracaoEfetivaDaMusica({ fonte: "nexos:x" }, 22.5)).toBe(22.5);
  });

  it("Shift+seta no marcador de efeito pula pra próxima batida (ou ±0,1 s sem batida por perto)", () => {
    const batidas = [{ t: 1 }, { t: 2.5 }, { t: 7 }];
    expect(passoParaBatida(3, 1, batidas)).toBeCloseTo(4, 5);
    expect(passoParaBatida(3, -1, batidas)).toBeCloseTo(-0.5, 5);
    expect(passoParaBatida(3, 1, [])).toBeCloseTo(0.1, 5);
    expect(passoParaBatida(3, -1, [])).toBeCloseTo(-0.1, 5);
  });

  it("forma de onda vira um path de uma peça por pico", () => {
    expect(picosParaCaminhoSvg([])).toBe("");
    expect(picosParaCaminhoSvg([0, 1, 0.5])).toBe("M0 28 L1 2 L2 15");
  });
});
