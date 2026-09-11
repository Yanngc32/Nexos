// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createDialogo } from "../dialogo.js";

const HTML = `
  <div id="dlg-modal" class="hidden">
    <p id="dlg-msg"></p>
    <button id="btn-dlg-cancel"></button>
    <button id="btn-dlg-ok"></button>
  </div>
`;

function montar() {
  document.body.innerHTML = HTML;
  const $ = (id) => document.getElementById(id);
  const dialogo = createDialogo({ el: $ });
  dialogo.ligar();
  return { dialogo, $ };
}

describe("confirmar", () => {
  it("mostra a mensagem, o botão Cancelar, e resolve true no OK", async () => {
    const { dialogo, $ } = montar();
    const p = dialogo.confirmar("Apagar isto?");
    expect($("dlg-modal").classList.contains("hidden")).toBe(false);
    expect($("dlg-msg").textContent).toBe("Apagar isto?");
    expect($("btn-dlg-cancel").classList.contains("hidden")).toBe(false);
    $("btn-dlg-ok").click();
    expect(await p).toBe(true);
    expect($("dlg-modal").classList.contains("hidden")).toBe(true);
  });

  it("resolve false no Cancelar", async () => {
    const { dialogo, $ } = montar();
    const p = dialogo.confirmar("Apagar isto?");
    $("btn-dlg-cancel").click();
    expect(await p).toBe(false);
  });

  it("Esc fecha e resolve false", async () => {
    const { dialogo } = montar();
    const p = dialogo.confirmar("Apagar isto?");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await p).toBe(false);
  });

  it("clicar no fundo (fora do card) fecha e resolve false", async () => {
    const { dialogo, $ } = montar();
    const p = dialogo.confirmar("Apagar isto?");
    $("dlg-modal").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await p).toBe(false);
  });
});

describe("avisar", () => {
  it("esconde o botão Cancelar — só informa, sem escolha", async () => {
    const { dialogo, $ } = montar();
    const p = dialogo.avisar("Não deu.");
    expect($("btn-dlg-cancel").classList.contains("hidden")).toBe(true);
    $("btn-dlg-ok").click();
    await p; // não lança, só resolve
  });
});
