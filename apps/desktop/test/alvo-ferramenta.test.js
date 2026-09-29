import { describe, it, expect } from "vitest";
import { alvoDaFerramenta, rotuloDoAlvo } from "../alvo-ferramenta.js";

describe("alvoDaFerramenta", () => {
  it("tarefa salva: id do resultado, senão do input", () => {
    expect(alvoDaFerramenta("mcp__nexo__nexo_tarefa_salvar", { titulo: "X" }, "tarefa tk_12 salva — [A fazer] X")).toEqual({
      tipo: "tarefa",
      id: "tk_12",
    });
    expect(alvoDaFerramenta("mcp__nexo__nexo_tarefa_salvar", { id: "tk_9" }, "")).toEqual({ tipo: "tarefa", id: "tk_9" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_tarefa_salvar", { titulo: "X" }, "coluna inválida")).toBeNull();
  });

  it("checklist/comentário/commits apontam pra tarefaId do input", () => {
    expect(alvoDaFerramenta("mcp__nexo__nexo_tarefa_checklist", { tarefaId: "tk_3", acao: "marcar" }, "ok")).toEqual({ tipo: "tarefa", id: "tk_3" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_tarefa_comentar", {}, "ok")).toBeNull();
  });

  it("tela de mock / card do DS: card e sistema do resultado", () => {
    const r =
      'Card criado: login (seção telas, largura 1) no DS "Mocks" (id ds-mocks). Sem avisos do lint.\nPainel de mocks "Mocks" (sistema ds-mocks) — 2 tela(s).';
    expect(alvoDaFerramenta("mcp__nexo__nexo_mock_salvar", {}, r)).toEqual({ tipo: "tela", sistema: "ds-mocks", card: "login" });
    expect(
      alvoDaFerramenta("mcp__nexo__nexo_ds_card_salvar", {}, 'Card atualizado: botao (seção comp, largura 1/2) no DS "Base (v2)" (id base).'),
    ).toEqual({ tipo: "tela", sistema: "base", card: "botao" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_mock_salvar", {}, "html obrigatório")).toBeNull();
  });

  it("cards do plano: criar, atualizar, ambiguidade", () => {
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_card_criar", {}, "card criado: [[Login]] — id `c_1`, rev 1")).toEqual({ tipo: "plano-card", id: "c_1" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_card_atualizar", {}, "card `c_1` salvo (rev 2)")).toEqual({ tipo: "plano-card", id: "c_1" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_ambiguidade_abrir", {}, "ambiguidade aberta: [[A]] — id `c_2`, rev 1")).toEqual({
      tipo: "plano-card",
      id: "c_2",
    });
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_ambiguidade_resolver", {}, "ambiguidade `c_2` resolvida (rev 3)")).toEqual({
      tipo: "plano-card",
      id: "c_2",
    });
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_card_atualizar", {}, "conflito de rev — releia e refaça")).toBeNull();
  });

  it("plano iniciado: só quando criou ou reaproveitou", () => {
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_iniciar", {}, 'plano "App" criado; o Agent Manager já recebeu')).toEqual({ tipo: "plano" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_iniciar", {}, 'esta conversa já tinha aberto o plano "App"')).toEqual({ tipo: "plano" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_plano_iniciar", {}, "não criou o plano: x")).toBeNull();
  });

  it("aceita nome sem prefixo mcp e ignora o resto", () => {
    expect(alvoDaFerramenta("nexo_tarefa_salvar", {}, "tarefa a1 salva")).toEqual({ tipo: "tarefa", id: "a1" });
    expect(alvoDaFerramenta("mcp__nexo__nexo_tarefa_listar", {}, "tarefa a1 salva")).toBeNull();
    expect(alvoDaFerramenta("Bash", {}, "")).toBeNull();
    expect(alvoDaFerramenta(undefined, null, undefined)).toBeNull();
  });

  it("rótulo acessível por tipo", () => {
    expect(rotuloDoAlvo({ tipo: "tarefa" })).toBe("Ir até a tarefa no Quadro");
    expect(rotuloDoAlvo(null)).toBe("Ir até");
  });
});
