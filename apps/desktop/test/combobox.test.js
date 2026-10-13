// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { initCombobox } from "../combobox.js";

const HTML = `
  <select id="m">
    <option value="">Modelo: padrão</option>
    <option value="opus">Opus</option>
    <optgroup label="Modelos antigos" data-recolhivel>
      <option value="claude-opus-4-8">Opus 4.8</option>
      <option value="claude-sonnet-4-6">Sonnet 4.6</option>
    </optgroup>
  </select>
`;

const sel = () => document.getElementById("m");
const lista = () => document.querySelector(".cb-list");
const grupo = () => lista().querySelector(".cb-grupo");
const visiveis = () => [...lista().children].filter((li) => !li.hidden).map((li) => li.textContent);
const tecla = (key) => sel().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
const abrir = () => sel().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

beforeAll(() => initCombobox());
beforeEach(() => {
  // lista que um teste deixou aberta fecha pelo caminho normal (o módulo guarda o estado)
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.body.innerHTML = HTML;
});

describe("combobox: optgroup recolhível", () => {
  it("abre com o grupo fechado e mostra só o título dele", () => {
    abrir();
    expect(visiveis()).toEqual(["Modelo: padrão", "Opus", "Modelos antigos"]);
    expect(grupo().getAttribute("aria-expanded")).toBe("false");
  });

  it("clicar no título abre o grupo sem fechar a lista nem trocar o valor", () => {
    abrir();
    grupo().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(lista()).not.toBeNull();
    expect(visiveis()).toContain("Sonnet 4.6");
    expect(sel().value).toBe("");
  });

  it("teclado: desce até o título, abre com Enter e escolhe a opção de dentro", () => {
    let mudou = 0;
    sel().addEventListener("change", () => mudou++);
    sel().focus();
    tecla("ArrowDown"); // abre a lista
    tecla("ArrowDown");
    tecla("ArrowDown"); // título do grupo
    tecla("Enter"); // abre o grupo
    expect(grupo().getAttribute("aria-expanded")).toBe("true");
    tecla("ArrowDown");
    tecla("Enter");
    expect(sel().value).toBe("claude-opus-4-8");
    expect(mudou).toBe(1);
    expect(lista()).toBeNull();
  });

  it("seta pula as opções do grupo fechado", () => {
    sel().focus();
    tecla("ArrowDown");
    tecla("ArrowDown");
    tecla("ArrowDown");
    tecla("ArrowDown"); // já está no último visível: não entra no grupo fechado
    expect(lista().querySelector(".ativa").textContent).toBe("Modelos antigos");
  });

  it("valor escolhido dentro do grupo: a lista já abre com ele aberto", () => {
    sel().value = "claude-sonnet-4-6";
    abrir();
    expect(grupo().getAttribute("aria-expanded")).toBe("true");
    expect(lista().querySelector(".ativa").textContent).toBe("Sonnet 4.6");
  });
});
