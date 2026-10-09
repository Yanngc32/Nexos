"""Converte os tiles genéricos da dungeon (Kenney "Tiny Dungeon", CC0) em máscaras da paleta do mago.

Só os tiles genéricos (chão, parede, porta, baú, entulho) vêm do pack; personagens, móveis e ícones
são desenhados em código (torre/arte.js). Cada cor do tile vira a letra da paleta mais próxima DENTRO
da rampa certa (pedra fria, madeira, contorno), então o pack sai recolorido pro tom da torre.

Uso: python importar-kenney.py <pasta Tiles do pack>   (imprime o bloco pra colar em torre/arte.js)
Crédito: THIRD_PARTY_NOTICES.md (CC0 não exige, mas fica registrado).
"""
import colorsys
import sys
from pathlib import Path

from PIL import Image

# tile do pack → nome na torre (e se a madeira vira pedra: o chão de areia vira lajota)
TILES = {
    49: ("chao", True),
    40: ("parede", False),
    28: ("paredeGrade", False),
    45: ("porta", False),
    90: ("bau", False),
    91: ("bauAberto", False),
    24: ("entulho", True),
}
# rampas, da mais escura pra mais clara (letras de torre/arte.js)
PEDRA = "mpPq"
MADEIRA = "dDe"
METAL = "pPqs"


def rampa(cor, so_pedra):
    r, g, b = (c / 255 for c in cor[:3])
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if l < 0.16:
        return "k", l
    quente = s > 0.25 and (h < 0.14 or h > 0.95)
    if quente and not so_pedra:
        return MADEIRA, l
    if quente:
        return PEDRA, l * 0.8
    return METAL if l > 0.55 else PEDRA, l


def converter(path, so_pedra):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    usadas = {}
    for y in range(h):
        for x in range(w):
            if px[x, y][3] < 128:
                continue
            letras, l = rampa(px[x, y], so_pedra)
            usadas.setdefault(letras, set()).add(round(l, 3))
    # dentro de cada rampa: distribui as luminâncias vistas pelas letras disponíveis
    mapa = {}
    for letras, ls in usadas.items():
        ordem = sorted(ls)
        for i, l in enumerate(ordem):
            k = letras if letras == "k" else letras[min(len(letras) - 1, i * len(letras) // max(1, len(ordem)))]
            mapa[(letras, l)] = k
    linhas = []
    for y in range(h):
        linha = ""
        for x in range(w):
            if px[x, y][3] < 128:
                linha += "."
                continue
            letras, l = rampa(px[x, y], so_pedra)
            linha += mapa[(letras, round(l, 3))]
        linhas.append(linha)
    return linhas


def main():
    pasta = Path(sys.argv[1])
    print("export const TILES_DUNGEON = {")
    for n, (nome, so_pedra) in TILES.items():
        linhas = converter(pasta / f"tile_{n:04d}.png", so_pedra)
        print(f"  // Kenney Tiny Dungeon tile_{n:04d} (CC0)")
        print(f"  {nome}: [")
        for l in linhas:
            print(f'    "{l}",')
        print("  ],")
    print("};")


if __name__ == "__main__":
    main()
