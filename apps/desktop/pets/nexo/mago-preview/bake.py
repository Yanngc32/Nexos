"""Bake maguinho frames for the desktop pet. Same pipeline as index.html."""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "mago"


def px(im, x, y):
    return im.getpixel((x, y))


def is_bg(r, g, b, a=255):
    return a < 8 or r + g + b < 60


def is_bar(r, g, b, a=255):
    if is_bg(r, g, b, a):
        return False
    avg = (r + g + b) / 3
    spread = max(r, g, b) - min(r, g, b)
    return avg <= 95 and spread < 20


def is_sprite(r, g, b, a=255):
    return not is_bg(r, g, b, a) and not is_bar(r, g, b, a)


def is_cream(r, g, b, a):
    return a > 200 and r > 160 and g > 140 and b > 110 and r > b + 10


def is_grey(r, g, b, a):
    if a < 200:
        return False
    avg = (r + g + b) / 3
    spread = max(r, g, b) - min(r, g, b)
    return 70 <= avg <= 180 and spread < 22


def is_logo(r, g, b, a):
    if a < 200:
        return False
    avg = (r + g + b) / 3
    spread = max(r, g, b) - min(r, g, b)
    return 185 <= avg <= 240 and spread < 45


def extract(im):
    im = im.convert("RGBA")
    w, h = im.size
    bar_top = h
    bar_hits = 0
    for y in range(h // 3, h):
        n = 0
        for x in range(0, w, 2):
            r, g, b, a = px(im, x, y)
            if is_bar(r, g, b, a):
                n += 1
        if n > bar_hits and n > w * 0.12:
            bar_hits = n
            bar_top = y
    min_x, min_y, max_x, max_y = w, h, 0, -1
    for y in range(bar_top):
        for x in range(w):
            r, g, b, a = px(im, x, y)
            if not is_sprite(r, g, b, a):
                continue
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)
    if max_y < 0:
        return im
    min_x = max(0, min_x - 2)
    min_y = max(0, min_y - 2)
    max_x = min(w - 1, max_x + 2)
    crop = im.crop((min_x, min_y, max_x + 1, max_y + 1))
    pix = crop.load()
    cw, ch = crop.size
    for y in range(ch):
        for x in range(cw):
            r, g, b, a = pix[x, y]
            if is_bg(r, g, b, a) or is_bar(r, g, b, a):
                pix[x, y] = (r, g, b, 0)
    return crop


def to_display(im, dest_h):
    dest_w = max(1, round((im.width * dest_h) / im.height))
    return im.resize((dest_w, dest_h), Image.NEAREST)


def cream_neighbor(pix, w, h, x, y):
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            if not ox and not oy:
                continue
            nx, ny = x + ox, y + oy
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            if is_cream(*pix[nx, ny]):
                return True
    return False


def grey_neighbor(pix, w, h, x, y):
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            if not ox and not oy:
                continue
            nx, ny = x + ox, y + oy
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            if is_grey(*pix[nx, ny]):
                return True
    return False


def blink_sheet(im):
    out = im.copy()
    pix = out.load()
    w, h = out.size
    y0, y1 = h * 55 // 100, h * 91 // 100
    cr = cg = cb = n = 0
    min_x, max_x = w, 0
    for y in range(y0, y1):
        for x in range(w):
            r, g, b, a = pix[x, y]
            if not is_cream(r, g, b, a):
                continue
            cr += r
            cg += g
            cb += b
            n += 1
            min_x = min(min_x, x)
            max_x = max(max_x, x)
    if not n or max_x < min_x:
        return out
    cr, cg, cb = round(cr / n), round(cg / n), round(cb / n)
    pad = round((max_x - min_x) * 0.22)
    x0, x1 = min_x + pad, max_x - pad
    for y in range(y0, y1):
        for x in range(x0, x1 + 1):
            r, g, b, a = pix[x, y]
            if a < 200 or r + g + b >= 200:
                continue
            if grey_neighbor(pix, w, h, x, y):
                continue
            if not cream_neighbor(pix, w, h, x, y):
                continue
            pix[x, y] = (cr, cg, cb, 255)
    return out


def cream_left(pix, w, h):
    min_x = w
    for y in range(h):
        for x in range(w):
            if is_cream(*pix[x, y]):
                min_x = min(min_x, x)
    return min_x


def pulse_laptop(im, delta, extra=0):
    out = im.copy()
    pix = out.load()
    w, h = out.size
    hat_x = cream_left(pix, w, h)
    y_base = h - 4
    seen = set()
    blobs = []
    dirs = ((1, 0), (-1, 0), (0, 1), (0, -1))
    for y in range(y_base):
        for x in range(hat_x):
            if (x, y) in seen or not is_logo(*pix[x, y]):
                continue
            pile = [(x, y)]
            seen.add((x, y))
            blob = []
            while pile:
                cx, cy = pile.pop()
                blob.append((cx, cy))
                for dx, dy in dirs:
                    nx, ny = cx + dx, cy + dy
                    if nx < 0 or ny < 0 or nx >= hat_x or ny >= y_base:
                        continue
                    if (nx, ny) in seen or not is_logo(*pix[nx, ny]):
                        continue
                    seen.add((nx, ny))
                    pile.append((nx, ny))
            blobs.append(blob)
    blobs.sort(key=len, reverse=True)
    add = delta + extra
    for x, y in blobs[0] if blobs else []:
        r, g, b, a = pix[x, y]
        pix[x, y] = (
            max(0, min(255, r + add)),
            max(0, min(255, g + add)),
            max(0, min(255, b + add)),
            a,
        )
    return out


def components(im):
    pix = im.load()
    w, h = im.size
    seen = set()
    parts = []
    dirs = ((1, 0), (-1, 0), (0, 1), (0, -1))
    for y in range(h):
        for x in range(w):
            if (x, y) in seen or pix[x, y][3] <= 160:
                continue
            pile = [(x, y)]
            seen.add((x, y))
            blob = []
            min_x = max_x = x
            min_y = max_y = y
            while pile:
                cx, cy = pile.pop()
                blob.append((cx, cy))
                min_x, max_x = min(min_x, cx), max(max_x, cx)
                min_y, max_y = min(min_y, cy), max(max_y, cy)
                for dx, dy in dirs:
                    nx, ny = cx + dx, cy + dy
                    if nx < 0 or ny < 0 or nx >= w or ny >= h:
                        continue
                    if (nx, ny) in seen or pix[nx, ny][3] <= 160:
                        continue
                    seen.add((nx, ny))
                    pile.append((nx, ny))
            parts.append({"pix": blob, "minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y})
    parts.sort(key=lambda p: len(p["pix"]), reverse=True)
    return parts


def cream_color(im):
    pix = im.load()
    w, h = im.size
    rs = gs = bs = n = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = pix[x, y]
            if not is_cream(r, g, b, a):
                continue
            rs += r
            gs += g
            bs += b
            n += 1
    if not n:
        return (221, 214, 197, 255)
    return (round(rs / n), round(gs / n), round(bs / n), 255)


def find_brim(im):
    pix = im.load()
    w, h = im.size
    counts = [sum(1 for x in range(w) if is_cream(*pix[x, y])) for y in range(h)]
    peak = max(counts) if counts else 0
    last = 0
    for y, n in enumerate(counts):
        if peak and n >= peak * 0.92:
            last = y
    return last


def feet_start(im, brim):
    pix = im.load()
    w, h = im.size
    for y in range(brim + 1, h):
        n = sum(1 for x in range(w) if is_cream(*pix[x, y]))
        if 0 < n <= 12:
            return y
    return h


def crop_bottom(im):
    pix = im.load()
    w, h = im.size
    last = 0
    for y in range(h - 1, -1, -1):
        if any(pix[x, y][3] > 8 for x in range(w)):
            last = y
            break
    return im.crop((0, 0, w, last + 1))


def retract(im, keep):
    """keep: 'face' | 'half' | 'none'. Chapéu igual. Pé some pra dentro."""
    brim = find_brim(im)
    foot = feet_start(im, brim)
    face = max(0, foot - brim - 1)
    if keep == "face":
        cut = brim + 1 + face
    elif keep == "half":
        cut = brim + 1 + max(1, face // 2)
    else:
        cut = brim + 1
    out = im.copy()
    pix = out.load()
    w, h = out.size
    for y in range(cut, h):
        for x in range(w):
            pix[x, y] = (0, 0, 0, 0)
    return crop_bottom(out)


def put_arm(pix, w, h, x, y, col, on_keys=False, hat_l=10**9):
    if not (0 <= x < w and 0 <= y < h):
        return
    if x >= hat_l:
        return
    r, g, b, a = pix[x, y]
    if a > 8 and is_cream(r, g, b, a):
        return
    if a > 8 and (is_grey(r, g, b, a) or is_logo(r, g, b, a)) and not on_keys:
        return
    pix[x, y] = col


def thick_line(pix, w, h, x0, y0, x1, y1, col, thick=3, on_keys=False, hat_l=10**9):
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    x, y = x0, y0
    rad = thick // 2
    while True:
        for oy in range(-rad, thick - rad):
            for ox in range(-rad, thick - rad):
                put_arm(pix, w, h, x + ox, y + oy, col, on_keys, hat_l)
        if x == x1 and y == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy


def hand(pix, w, h, x, y, col, hat_l):
    for oy in range(-1, 2):
        for ox in range(-1, 2):
            put_arm(pix, w, h, x + ox, y + oy, col, True, hat_l)


def add_arms(im, pose):
    """pose -1 / 0 / 1. Notebook igual. Só braço novo."""
    brim = find_brim(im)
    foot = feet_start(im, brim)
    pix_src = im.load()
    w, h = im.size
    hat_l = w
    for y in range(brim + 1, min(brim + 8, h)):
        for x in range(w):
            if is_cream(*pix_src[x, y]):
                hat_l = min(hat_l, x)
    lap_r = 0
    for y in range(max(0, foot - 4), h):
        for x in range(max(0, hat_l - 4)):
            if is_grey(*pix_src[x, y]) or is_logo(*pix_src[x, y]):
                lap_r = max(lap_r, x)
    if hat_l >= w or lap_r < 8:
        return im.copy()
    col = cream_color(im)
    x0 = hat_l - 1
    y0 = brim + 5
    hx = lap_r - 2
    hy = min(h - 3, foot + 1)
    if pose < 0:
        e1, e2 = (hx - 6, hy), (hx + 2, hy - 8)
    elif pose > 0:
        e1, e2 = (hx + 1, hy - 7), (hx - 5, hy)
    else:
        e1, e2 = (hx - 3, hy - 2), (hx + 1, hy - 4)
    out = im.copy()
    pix = out.load()
    thick_line(pix, w, h, x0, y0, e1[0], e1[1], col, 3, hat_l=hat_l)
    thick_line(pix, w, h, x0, y0 + 4, e2[0], e2[1], col, 3, hat_l=hat_l)
    hand(pix, w, h, e1[0], e1[1], col, hat_l)
    hand(pix, w, h, e2[0], e2[1], col, hat_l)
    return out


def drift_z(im, step):
    parts = components(im)
    if len(parts) < 2:
        return im.copy()
    hat = parts[0]
    zs = [
        p
        for i, p in enumerate(parts)
        if i > 0 and p["maxY"] < hat["minY"] + (hat["maxY"] - hat["minY"]) * 0.55
    ]
    if not zs:
        return im.copy()
    lift = step * 6
    pad_t = lift + 2
    pad_l = lift + 2
    hat_im = im.copy()
    hp = hat_im.load()
    for z in zs:
        for x, y in z["pix"]:
            r, g, b, _ = hp[x, y]
            hp[x, y] = (r, g, b, 0)
    out = Image.new("RGBA", (im.width + pad_l, im.height + pad_t), (0, 0, 0, 0))
    out.paste(hat_im, (pad_l, pad_t))
    src = im.load()
    op = out.load()
    for z in zs:
        for x, y in z["pix"]:
            nx, ny = x + pad_l - lift, y + pad_t - lift
            if 0 <= nx < out.width and 0 <= ny < out.height:
                op[nx, ny] = src[x, y]
    return out


def save(im, name):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.png"
    im.save(path)
    print(path.name, im.size)


def main():
    idle_raw = extract(Image.open(HERE / "idle.png"))
    work_raw = extract(Image.open(HERE / "work.png"))
    off_raw = extract(Image.open(HERE / "off.png"))
    scale = 96 / idle_raw.height
    idle = to_display(idle_raw, max(1, round(idle_raw.height * scale)))
    work = to_display(work_raw, max(1, round(work_raw.height * scale)))
    off = to_display(off_raw, max(1, round(off_raw.height * scale)))
    save(idle, "idle")
    save(blink_sheet(idle), "idle-blink")
    save(retract(idle, "face"), "idle-in1")
    save(retract(idle, "half"), "idle-in2")
    save(retract(idle, "none"), "idle-hide")
    work0 = add_arms(work, 0)
    work_a = add_arms(work, -1)
    work_b = add_arms(work, 1)
    save(work0, "work")
    save(blink_sheet(work0), "work-blink")
    save(pulse_laptop(work0, 24, 0), "work-on")
    save(pulse_laptop(work0, -22, 0), "work-dim")
    save(pulse_laptop(work0, 12, 30), "work-logo")
    save(work_a, "work-tap-a")
    save(work_b, "work-tap-b")
    save(pulse_laptop(work_a, 24, 0), "work-tap-a-on")
    save(pulse_laptop(work_b, 12, 30), "work-tap-b-on")
    save(off, "off")
    save(drift_z(off, 1), "off-z1")
    save(drift_z(off, 2), "off-z2")


if __name__ == "__main__":
    main()
