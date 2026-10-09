/**
 * Torre de magia — o PINTOR de canvas (o do app; o de buffer, em render.js, é o do Node).
 * Mesma interface — `ret` e `masc` em pixels de torre — com a escala INTEIRA já aplicada e o
 * pixel nunca suavizado.
 */
import { canvasDaMascara } from "../sprites.js";

export function pintorDeCanvas(ctx, escala = 1) {
  ctx.imageSmoothingEnabled = false;
  return {
    escala,
    ret(x, y, w, h, cor) {
      ctx.fillStyle = cor;
      ctx.fillRect(x * escala, y * escala, w * escala, h * escala);
    },
    masc(chave, linhas, paleta, x, y, espelho = false) {
      const cv = canvasDaMascara(chave, linhas, paleta);
      const w = cv.width * escala;
      const h = cv.height * escala;
      if (!espelho) {
        ctx.drawImage(cv, x * escala, y * escala, w, h);
        return;
      }
      ctx.save();
      ctx.translate(x * escala + w, y * escala);
      ctx.scale(-1, 1);
      ctx.drawImage(cv, 0, 0, w, h);
      ctx.restore();
    },
  };
}
