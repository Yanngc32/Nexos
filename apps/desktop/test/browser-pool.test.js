// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { criarBrowserPool, mesmoHref, hrefDoGuest } from "../browser-pool.js";

function montar() {
  document.body.innerHTML = '<div id="stage"></div>';
  const stage = document.getElementById("stage");
  const pool = criarBrowserPool({
    stage,
    criarGuest() {
      const el = document.createElement("div");
      el.src = "about:blank";
      el.dataset.href = "about:blank";
      return el;
    },
  });
  return { stage, pool };
}

describe("mesmoHref", () => {
  it("URL normalizada é igual a si mesma", () => {
    expect(mesmoHref("http://localhost:5173/", "http://localhost:5173/")).toBe(true);
    expect(mesmoHref("http://localhost:5173", "http://localhost:5173/")).toBe(true);
  });
});

describe("pool", () => {
  it("obter reusa o mesmo guest; mostrar só um visível", () => {
    const { pool, stage } = montar();
    const a = pool.obter("t1", "tab-a");
    const b = pool.obter("t1", "tab-a");
    expect(a).toBe(b);
    pool.obter("t1", "tab-b");
    pool.mostrar("t1", "tab-a");
    expect(a.classList.contains("stowed")).toBe(false);
    expect(stage.querySelectorAll("div").length).toBeGreaterThanOrEqual(2);
    expect(pool.visivel()).toBe(a);
  });

  it("navegar na mesma URL não mexe no src (voltar pra conversa não recarrega)", () => {
    const { pool } = montar();
    const r1 = pool.navegar("t1", "tab-a", "http://localhost:5173/");
    expect(r1.mudou).toBe(true);
    const src1 = r1.el.src;
    const r2 = pool.navegar("t1", "tab-a", "http://localhost:5173/");
    expect(r2.mudou).toBe(false);
    expect(r2.el.src).toBe(src1);
  });

  it("force=true navega de novo mesmo com URL igual", () => {
    const { pool } = montar();
    pool.navegar("t1", "tab-a", "http://localhost:5173/");
    const r = pool.navegar("t1", "tab-a", "http://localhost:5173/", { force: true });
    expect(r.mudou).toBe(true);
  });

  it("duas threads: guests separados, descartar uma não mata a outra", () => {
    const { pool } = montar();
    const a = pool.navegar("t-a", "tab", "http://localhost:5173/").el;
    const b = pool.navegar("t-b", "tab", "http://localhost:5175/").el;
    expect(a).not.toBe(b);
    pool.descartarThread("t-a");
    expect(pool.daThread("t-a")).toBeNull();
    expect(pool.daThread("t-b")).toBe(b);
  });

  it("mostrar só troca o guest visível, não mexe nos outros", () => {
    const { pool } = montar();
    const a = pool.mostrar("t1", "tab-a");
    const b = pool.obter("t1", "tab-b");
    const c = pool.obter("t2", "tab-c");
    expect(a.classList.contains("stowed")).toBe(false);
    expect(b.classList.contains("stowed")).toBe(true);
    expect(c.classList.contains("stowed")).toBe(true);
    pool.mostrar("t2", "tab-c");
    expect(a.classList.contains("stowed")).toBe(true);
    expect(b.classList.contains("stowed")).toBe(true);
    expect(c.classList.contains("stowed")).toBe(false);
    expect(pool.visivel()).toBe(c);
  });

  it("esconder tira o visível sem destruir o guest", () => {
    const { pool } = montar();
    const a = pool.mostrar("t1", "tab-a");
    pool.esconder();
    expect(a.classList.contains("stowed")).toBe(true);
    expect(pool.visivel()).toBeNull();
    expect(pool.daAba("t1", "tab-a")).toBe(a);
  });

  it("hrefDoGuest lê dataset, não chama getURL (IPC síncrono trava a UI)", () => {
    const el = { dataset: { href: "http://localhost:5173/" }, src: "about:blank", getURL: () => "nao-deve" };
    expect(hrefDoGuest(el)).toBe("http://localhost:5173/");
  });

  it("LRU: acima do teto, some o guest de outra thread mais velho", () => {
    document.body.innerHTML = '<div id="stage"></div>';
    const stage = document.getElementById("stage");
    const pool = criarBrowserPool({
      stage,
      maxVivos: 2,
      criarGuest() {
        const el = document.createElement("div");
        el.src = "about:blank";
        el.dataset.href = "about:blank";
        return el;
      },
    });
    const a = pool.obter("t-a", "tab");
    pool.obter("t-b", "tab");
    pool.obter("t-c", "tab");
    expect(pool.daThread("t-a")).toBeNull();
    expect(pool.daAba("t-a", "tab")).toBeNull();
    expect(a.isConnected).toBe(false);
    expect(pool.daThread("t-b")).toBeTruthy();
    expect(pool.daThread("t-c")).toBeTruthy();
  });
});
