// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

beforeAll(() => {
  execFileSync(process.execPath, [join(raiz, "scripts", "build.mjs")]);
  globalThis.chrome = { runtime: { sendMessage: vi.fn() } };
  document.body.innerHTML = `
    <main><h1>Extrato</h1>
      <form><input id="ini" name="ini" placeholder="Início"><button type="button" id="filtrar">Filtrar</button></form>
      <p>Saldo disponível na conta corrente depois dos lançamentos do mês.</p>
    </main>`;
  // happy-dom devolve 0x0 em todo elemento, e o leitor descarta o que tem tamanho zero
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 80, height: 20 });
  const bundle = readFileSync(join(raiz, "dist", "nexos-chrome", "pagina-bundle.js"), "utf8");
  // duas vezes: o service worker reinjeta a cada comando e não pode quebrar
  (0, eval)(bundle);
  (0, eval)(bundle);
});

describe("pagina-bundle", () => {
  it("lê a página com refs e clica pelo ref", () => {
    const itens = globalThis.__nexo.ler();
    const botao = itens.find((i) => i.texto === "Filtrar");
    expect(botao).toMatchObject({ papel: expect.any(String), ref: expect.stringMatching(/^ref_\d+$/) });
    const clique = vi.fn();
    document.getElementById("filtrar").addEventListener("click", clique);
    expect(globalThis.__nexo.clicarSintetico(botao.ref)).toBe("clicado");
    expect(clique).toHaveBeenCalledOnce();
  });

  it("digita pelo setter nativo e dispara input", () => {
    const itens = globalThis.__nexo.ler();
    const campo = itens.find((i) => i.texto.includes("Início"));
    const input = document.getElementById("ini");
    const ouvir = vi.fn();
    input.addEventListener("input", ouvir);
    globalThis.__nexo.digitarSintetico(campo.ref, "01/09/2026", false);
    expect(input.value).toBe("01/09/2026");
    expect(ouvir).toHaveBeenCalled();
  });

  it("ref velho é erro claro", () => {
    expect(() => globalThis.__nexo.clicarSintetico("ref_999")).toThrow(/releia a página/);
  });

  it("markdown usa Readability/Turndown do bundle", () => {
    const md = globalThis.__nexo.markdown();
    expect(md).toContain("Extrato");
  });
});
