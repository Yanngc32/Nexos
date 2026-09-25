"""Gera os quadros parados do maguinho (idle*, think*, done*) a partir de mago.txt.

Trabalhar (work*) e dormir (off*) ainda saem do bake.py, a partir da arte original.
Uso: python gerar.py  (grava em apps/desktop/pets/nexo/mago e apps/mobile/pets/nexo/mago)
"""
from pathlib import Path

from PIL import Image

AQUI = Path(__file__).resolve().parent
DESKTOP = AQUI.parent / "mago"
MOBILE = AQUI.parents[3] / "mobile" / "pets" / "nexo" / "mago"
PALETA = {
    "c": (248, 240, 218, 255),
    "s": (207, 196, 175, 255),
    "g": (50, 90, 126, 255),
    "G": (99, 149, 188, 255),
    "w": (255, 250, 230, 255),
}
# Coluna par e 4px de largura: na tela o pet sai em 50%, e assim cada olho vira
# exatamente 2px. Com 5px (ou começo ímpar) um olho saía mais largo que o outro.
OLHO_X = (22, 40)
OLHO_Y = 79
# Onde o pé começa a sumir quando ele entra no chapéu (linhas mantidas).
ENTRA = {"idle-in1": 92, "idle-in2": 85, "idle-hide": 79}
# O celular não tem "entrar no chapéu".
SO_DESKTOP = set(ENTRA)

# "x" = buraco (transparente), "." = mantém o rosto
OLHOS = {
    "normal": ["xxxx"] * 8,
    "cima": ["xxxx"] * 5,
    "meio": ["...."] * 4 + ["xxxx"] * 4,
    # risco em linha ímpar (85): em 50% o navegador pega as linhas ímpares; na 86 sumia
    "fechado": ["...."] * 6 + ["xxxx", "...."],
    "contente": ["...."] * 6 + ["xxxx"] * 2,
}


def ler_base():
    linhas = [l for l in (AQUI / "mago.txt").read_text().splitlines() if l and not l.startswith("#")]
    return [list(l) for l in linhas]


def copia(g):
    return [r[:] for r in g]


def olhos(g, forma="normal", dx=0):
    for x0 in OLHO_X:
        for sy, linha in enumerate(OLHOS[forma]):
            for sx, ch in enumerate(linha):
                if ch == "x":
                    g[OLHO_Y + sy][x0 + sx + dx] = "."
    return g


def desce(g, dy, ate):
    """Cabeça e chapéu (linhas < ate) descem dy px; o corpo fica embaixo."""
    out = copia(g)
    for y in range(ate):
        out[y] = ["."] * len(g[0])
    for y in range(ate - dy):
        for x, ch in enumerate(g[y]):
            if ch != ".":
                out[y + dy][x] = ch
    return out


def pontinhos(g, n):
    for i in range(n):
        for y in range(4, 7):
            for x in range(49 + i * 6, 52 + i * 6):
                g[y][x] = "c"
    return g


def sobe(g, dy, altura):
    """Canvas mais alto (o palco alinha pela base): dy > 0 levanta o maguinho."""
    w = len(g[0])
    topo = altura - len(g) - dy
    return [["."] * w for _ in range(topo)] + copia(g) + [["."] * w for _ in range(dy)]


def brilho(g, grande):
    gemas = [(x, y) for y, r in enumerate(g) for x, ch in enumerate(r) if ch in "gG"]
    cx = sum(x for x, _ in gemas) // len(gemas)
    cy = sum(y for _, y in gemas) // len(gemas)
    pontos = [(-9, -3), (10, -1), (-7, 5), (9, 6)] if grande else [(-8, -2), (9, 2)]
    braco = 2 if grande else 1
    for ox, oy in pontos:
        for t in range(-braco, braco + 1):
            for x, y in ((cx + ox + t, cy + oy), (cx + ox, cy + oy + t)):
                if 0 <= y < len(g) and 0 <= x < len(g[0]):
                    g[y][x] = "w"
    return g


def quadros():
    b = ler_base()
    alto = len(b) + 8
    q = {
        "idle": olhos(copia(b)),
        "idle-blink-half": olhos(copia(b), "meio"),
        "idle-blink": olhos(copia(b), "fechado"),
        "idle-breath": olhos(desce(b, 1, 88)),
        "idle-look-l": olhos(copia(b), dx=-2),
        "idle-look-r": olhos(copia(b), dx=2),
        "think-0": olhos(copia(b), "cima", 1),
    }
    for nome, linhas in ENTRA.items():
        q[nome] = copia(q["idle"])[:linhas]
    for n in (1, 2, 3):
        q[f"think-{n}"] = pontinhos(olhos(copia(b), "cima", 1), n)
    q["done-rest"] = sobe(olhos(copia(b)), 0, alto)
    q["done-squat"] = sobe(olhos(desce(b, 2, 88), "contente"), 0, alto)
    q["done-jump"] = brilho(sobe(olhos(copia(b), "contente"), 7, alto), False)
    q["done-high"] = brilho(sobe(olhos(copia(b), "contente"), 7, alto), True)
    q["done-land"] = sobe(olhos(desce(b, 1, 88), "contente"), 0, alto)
    return q


def png(g):
    im = Image.new("RGBA", (len(g[0]), len(g)))
    p = im.load()
    for y, r in enumerate(g):
        for x, ch in enumerate(r):
            if ch != ".":
                p[x, y] = PALETA[ch]
    return im


def svg(g):
    """SVG do quadro: um retângulo por trecho de cor na linha (fica nítido em qualquer escala)."""
    rects = []
    for y, r in enumerate(g):
        x = 0
        while x < len(r):
            ch = r[x]
            a = x
            while x < len(r) and r[x] == ch:
                x += 1
            if ch != ".":
                cor = "#%02x%02x%02x" % PALETA[ch][:3]
                rects.append(f'<rect x="{a}" y="{y}" width="{x - a}" height="1" fill="{cor}"/>')
    w, h = len(g[0]), len(g)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'shape-rendering="crispEdges">' + "".join(rects) + "</svg>\n")


def main():
    q = quadros()
    for pasta in (DESKTOP, MOBILE):
        pasta.mkdir(parents=True, exist_ok=True)
        for nome, g in q.items():
            if pasta == MOBILE and nome in SO_DESKTOP:
                continue
            png(g).save(pasta / f"{nome}.png")
    (AQUI / "mago.svg").write_text(svg(q["idle"]))
    print(f"{len(q)} quadros")


if __name__ == "__main__":
    main()
