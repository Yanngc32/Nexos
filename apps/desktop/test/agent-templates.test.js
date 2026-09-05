import { describe, it, expect } from "vitest";
import { TEMPLATES, aplicarTemplate, lacunas, templatePorId } from "../agent-templates.js";

describe("catálogo", () => {
  it("todo modelo tem id único, nome, resumo e instruções", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(t.nome.length).toBeGreaterThan(0);
      expect(t.resumo.length).toBeGreaterThan(0);
      expect(typeof t.campos.instructions).toBe("string");
    }
  });

  it("o primeiro é o vazio: quem não quer modelo não precisa procurar", () => {
    expect(TEMPLATES[0].id).toBe("blank");
    expect(TEMPLATES[0].campos.instructions).toBe("");
  });

  it("instrução cabe no teto do daemon (AGENT_INSTRUCTIONS_MAX)", () => {
    for (const t of TEMPLATES) {
      expect(t.campos.instructions.length).toBeLessThanOrEqual(8000);
    }
  });

  it("esforço e permissão, quando vêm, são valores que o daemon aceita", () => {
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const modos = ["auto", "manual", "acceptEdits", "plan", "bypassPermissions"];
    for (const t of TEMPLATES) {
      if (t.campos.effort) expect(efforts).toContain(t.campos.effort);
      if (t.campos.permissionMode) expect(modos).toContain(t.campos.permissionMode);
    }
  });

  it("descrição sugerida cabe no teto do daemon", () => {
    for (const t of TEMPLATES) {
      if (t.campos.description) expect(t.campos.description.length).toBeLessThanOrEqual(200);
    }
  });

  it("os modelos que se inspiram no ADK dizem onde o Nexo difere", () => {
    // vender orquestração que não existe seria mentira: quem empresta o formato
    // de um agente composto tem que explicar que aqui é um agente só
    for (const id of ["pipeline", "loop", "coordenador"]) {
      expect(templatePorId(id).nota.length).toBeGreaterThan(40);
    }
  });

  it("templatePorId devolve undefined pra id que não existe", () => {
    expect(templatePorId("nao-existe")).toBeUndefined();
  });
});

describe("aplicarTemplate", () => {
  it("preenche os campos do modelo", () => {
    const out = aplicarTemplate("revisor", {});
    expect(out.instructions).toMatch(/Você revisa/);
    expect(out.permissionMode).toBe("plan");
  });

  it("não apaga o que a pessoa já preencheu e o modelo não menciona", () => {
    const out = aplicarTemplate("task", { name: "Meu agente", profileId: "p1", color: "#ff0000" });
    expect(out.name).toBe("Meu agente");
    expect(out.profileId).toBe("p1");
    expect(out.color).toBe("#ff0000");
  });

  it("trocar de modelo sobrescreve só o que o novo define", () => {
    const primeiro = aplicarTemplate("revisor", { name: "X" });
    const segundo = aplicarTemplate("task", primeiro);
    expect(segundo.name).toBe("X");
    expect(segundo.instructions).toMatch(/agente especialista/);
    expect(segundo.effort).toBe("medium");
  });

  it("o modelo em branco zera a instrução sem levar o resto junto", () => {
    const out = aplicarTemplate("blank", { name: "X", instructions: "velho", effort: "high" });
    expect(out.instructions).toBe("");
    expect(out.name).toBe("X");
    expect(out.effort).toBe("high");
  });

  it("id desconhecido devolve o formulário intacto", () => {
    const atual = { name: "X", instructions: "y" };
    expect(aplicarTemplate("nao-existe", atual)).toEqual(atual);
  });

  it("não altera o objeto recebido", () => {
    const atual = { name: "X" };
    aplicarTemplate("task", atual);
    expect(atual).toEqual({ name: "X" });
  });
});

describe("lacunas", () => {
  it("acha os espaços que o modelo deixou pra preencher", () => {
    expect(lacunas("faz <TAREFA> e devolve <FORMATO>")).toEqual(["<TAREFA>", "<FORMATO>"]);
  });

  it("não repete a mesma lacuna", () => {
    expect(lacunas("<X> e depois <X>")).toEqual(["<X>"]);
  });

  it("ignora comparação e tag minúscula: só maiúscula é lacuna", () => {
    expect(lacunas("a < b e <div> e <html>")).toEqual([]);
  });

  it("texto sem lacuna e entrada vazia devolvem lista vazia", () => {
    expect(lacunas("instrução completa")).toEqual([]);
    expect(lacunas("")).toEqual([]);
    expect(lacunas(undefined)).toEqual([]);
  });

  it("os modelos com lacuna são exatamente os que pedem preenchimento", () => {
    expect(lacunas(templatePorId("task").campos.instructions).length).toBeGreaterThan(0);
    expect(lacunas(templatePorId("revisor").campos.instructions)).toEqual([]);
  });
});
