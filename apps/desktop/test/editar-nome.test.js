// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { editarNome } from "../editar-nome.js";

function alvo(texto = "Nome velho") {
  const el = document.createElement("span");
  el.textContent = texto;
  document.body.append(el);
  return el;
}

const campo = (el) => el.querySelector("input.nome-edicao");
const tecla = (el, key) => campo(el).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

describe("editarNome", () => {
  it("Enter salva o nome sem espaço sobrando", async () => {
    const el = alvo();
    const salvar = vi.fn(async () => {});
    const feito = editarNome(el, { atual: "Nome velho", salvar });
    campo(el).value = "  Nome   novo ";
    tecla(el, "Enter");
    expect(await feito).toBe(true);
    expect(salvar).toHaveBeenCalledWith("Nome novo");
    expect(el.textContent).toBe("Nome novo");
  });

  it("Esc desiste e devolve o texto", async () => {
    const el = alvo();
    const salvar = vi.fn();
    const feito = editarNome(el, { atual: "Nome velho", salvar });
    campo(el).value = "outro";
    tecla(el, "Escape");
    expect(await feito).toBe(false);
    expect(salvar).not.toHaveBeenCalled();
    expect(el.textContent).toBe("Nome velho");
  });

  it("vazio ou igual não salva", async () => {
    const el = alvo();
    const salvar = vi.fn();
    const feito = editarNome(el, { atual: "Nome velho", salvar });
    campo(el).value = "   ";
    tecla(el, "Enter");
    expect(await feito).toBe(false);
    expect(salvar).not.toHaveBeenCalled();
  });

  it("falha ao salvar volta o texto antigo e avisa", async () => {
    const el = alvo();
    const aoFalhar = vi.fn();
    const feito = editarNome(el, {
      atual: "Nome velho",
      salvar: async () => {
        throw new Error("motor fora");
      },
      aoFalhar,
    });
    campo(el).value = "Novo";
    tecla(el, "Enter");
    expect(await feito).toBe(false);
    expect(el.textContent).toBe("Nome velho");
    expect(aoFalhar).toHaveBeenCalled();
  });
});
