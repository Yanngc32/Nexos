import { describe, expect, it } from "vitest";
import { aplicarEventoNaPonte, ponteDosEventos, textoDaPonte } from "../ponte-plano.js";

describe("ponte com o Agent Manager", () => {
  it("conversa sem plano não tem ponte", () => {
    expect(ponteDosEventos([{ type: "user", text: "oi" }])).toBeNull();
    expect(textoDaPonte(null)).toBe("");
  });

  it("plano_ligado liga; plano_ponte alterna; o último plano vale", () => {
    const eventos = [
      { type: "plano_ligado", slug: "a", managerThreadId: "t-a", titulo: "Plano A" },
      { type: "plano_ponte", ligada: false },
    ];
    expect(ponteDosEventos(eventos)).toEqual({ slug: "a", managerThreadId: "t-a", titulo: "Plano A", ligada: false });
    const depois = aplicarEventoNaPonte(ponteDosEventos(eventos), { type: "plano_ligado", slug: "b", managerThreadId: "t-b", titulo: "" });
    expect(depois).toEqual({ slug: "b", managerThreadId: "t-b", titulo: "b", ligada: true });
    expect(textoDaPonte(depois)).toContain("vai pra ele");
  });

  it("plano_ponte sem plano antes não inventa ponte", () => {
    expect(aplicarEventoNaPonte(null, { type: "plano_ponte", ligada: true })).toBeNull();
  });
});
