// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import {
  JS_RELAYOUT_GUEST,
  uaChromeAPartirDe,
  pedirRelayoutGuest,
  sincronizarPixels,
  avisarGuestDepoisDoPaint,
} from "../guest-relayout.js";

describe("uaChromeAPartirDe", () => {
  it("tira Electron e guarda a versão do Chrome", () => {
    const ua = uaChromeAPartirDe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Electron/33.4.5 Safari/537.36",
    );
    expect(ua).toContain("Chrome/130.0.6723.191");
    expect(ua).not.toMatch(/Electron/i);
    expect(ua).toContain("Windows NT 10.0");
  });

  it("Mac e Linux saem com o OS certo", () => {
    expect(uaChromeAPartirDe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0")).toContain(
      "Macintosh; Intel Mac OS X 10_15_7",
    );
    expect(uaChromeAPartirDe("Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0")).toContain("X11; Linux x86_64");
  });

  it("sem Chrome na string, cai numa versão conhecida", () => {
    expect(uaChromeAPartirDe("")).toContain("Chrome/130.0.0.0");
  });
});

describe("pedirRelayoutGuest", () => {
  it("sem executeJavaScript, não lança", () => {
    expect(() => pedirRelayoutGuest(null)).not.toThrow();
    expect(() => pedirRelayoutGuest({})).not.toThrow();
  });

  it("manda o JS de resize no guest", () => {
    const el = { executeJavaScript: vi.fn(() => Promise.resolve()) };
    pedirRelayoutGuest(el);
    expect(el.executeJavaScript).toHaveBeenCalledWith(JS_RELAYOUT_GUEST);
    expect(JS_RELAYOUT_GUEST).toContain("dispatchEvent(new Event('resize'))");
  });

  it("executeJavaScript rejeitando não vira unhandled rejection", async () => {
    const el = { executeJavaScript: vi.fn(() => Promise.reject(new Error("guest morto"))) };
    pedirRelayoutGuest(el);
    await Promise.resolve();
  });
});

describe("sincronizarPixels", () => {
  it("copia o retângulo do pai em px", () => {
    const pai = document.createElement("div");
    const el = document.createElement("div");
    pai.append(el);
    pai.getBoundingClientRect = () => ({ width: 640.4, height: 400.6 });
    expect(sincronizarPixels(el)).toBe(true);
    expect(el.style.width).toBe("640px");
    expect(el.style.height).toBe("401px");
  });

  it("pai sem tamanho: não zera o guest", () => {
    const pai = document.createElement("div");
    const el = document.createElement("div");
    pai.append(el);
    el.style.width = "100%";
    pai.getBoundingClientRect = () => ({ width: 0, height: 0 });
    expect(sincronizarPixels(el)).toBe(false);
    expect(el.style.width).toBe("100%");
  });
});

describe("avisarGuestDepoisDoPaint", () => {
  it("no próximo frame sincroniza px e dispara resize — sem jiggle no clique", async () => {
    const pai = document.createElement("div");
    const el = document.createElement("div");
    document.body.append(pai);
    pai.append(el);
    pai.getBoundingClientRect = () => ({ width: 800, height: 600 });
    el.executeJavaScript = vi.fn(() => Promise.resolve());
    avisarGuestDepoisDoPaint(el);
    expect(el.executeJavaScript).not.toHaveBeenCalled();
    await new Promise((r) => requestAnimationFrame(r));
    expect(el.style.width).toBe("800px");
    expect(el.style.height).toBe("600px");
    expect(el.executeJavaScript).toHaveBeenCalledWith(JS_RELAYOUT_GUEST);
  });
});
