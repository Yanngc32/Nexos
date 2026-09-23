"use strict";
/**
 * Geometria do painel de borda — usada pelo processo principal (main.cjs), que é quem move a
 * janela. CommonJS porque o main é CommonJS.
 */

const BORDAS = ["direita", "esquerda", "topo", "baixo"];

/**
 * Borda mais perto do ponto dentro da área útil do monitor, e a posição AO LONGO dela (0..1).
 * É o "solta perto de uma borda e ele gruda" do arrastar.
 */
function bordaMaisProxima(ponto, area) {
  const dist = {
    esquerda: ponto.x - area.x,
    direita: area.x + area.width - ponto.x,
    topo: ponto.y - area.y,
    baixo: area.y + area.height - ponto.y,
  };
  const borda = BORDAS.reduce((a, b) => (dist[b] < dist[a] ? b : a));
  const vertical = borda === "direita" || borda === "esquerda";
  const pos = vertical ? (ponto.y - area.y) / area.height : (ponto.x - area.x) / area.width;
  return { borda, pos: Math.min(1, Math.max(0, pos)) };
}

/**
 * Retângulo da janela do painel encostada na borda: `w`×`h` é o tamanho na orientação vertical
 * (bordas laterais); no topo/baixo ele gira. `pos` centraliza a janela no ponto da borda, sem
 * deixar sair da área útil.
 */
function retanguloNaBorda(borda, pos, area, w, h) {
  const vertical = borda === "direita" || borda === "esquerda";
  const largura = vertical ? w : h;
  const altura = vertical ? h : w;
  const limitar = (v, min, max) => Math.round(Math.min(Math.max(v, min), Math.max(min, max)));
  if (vertical) {
    const y = limitar(area.y + pos * area.height - altura / 2, area.y, area.y + area.height - altura);
    const x = borda === "direita" ? area.x + area.width - largura : area.x;
    return { x: Math.round(x), y, width: largura, height: altura };
  }
  const x = limitar(area.x + pos * area.width - largura / 2, area.x, area.x + area.width - largura);
  const y = borda === "baixo" ? area.y + area.height - altura : area.y;
  return { x, y: Math.round(y), width: largura, height: altura };
}

module.exports = { BORDAS, bordaMaisProxima, retanguloNaBorda };
