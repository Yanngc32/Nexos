// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createAutomacaoModal } from "../automacao-modal.js";

const HTML = `
  <div id="automacao-modal" class="hidden">
    <ul id="am-lista"></ul>
    <p id="am-vazio" class="hidden"></p>
    <button id="btn-am-nova"></button>
    <input id="am-nome" />
    <input id="am-descricao" />
    <select id="am-coluna"><option value="">qualquer coluna</option></select>
    <select id="am-alvo-tipo">
      <option value="agente">agente</option>
      <option value="time">time</option>
    </select>
    <div id="am-agent-wrap"><select id="am-agent"></select></div>
    <div id="am-team-wrap" class="hidden"><select id="am-team"></select></div>
    <p id="am-err" class="hidden"></p>
    <button id="btn-am-salvar"></button>
    <button id="btn-am-excluir" class="hidden"></button>
    <button id="btn-am-fechar"></button>
  </div>
`;

function montar({ req, projectPath = "/repo/a", agents = [{ id: "ag-1", name: "Agente 1" }], teams = [] } = {}) {
  document.body.innerHTML = HTML;
  const $ = (id) => document.getElementById(id);
  const aoSalvar = vi.fn();
  const modal = createAutomacaoModal({
    req,
    el: $,
    getProjectPath: () => projectPath,
    getAgents: () => agents,
    getTeams: () => teams,
    aoSalvar,
  });
  modal.ligar();
  return { modal, $, aoSalvar };
}

describe("abrir", () => {
  it("carrega colunas do quadro e filtra regras só do evento/projeto atual", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/tarefas/quadro")) return { colunas: [{ id: "cl-1", nome: "A fazer" }] };
      if (path === "/v1/hooks/rules") {
        return [
          { id: "hr-1", evento: "tarefa.mudou-coluna", escopo: { tipo: "projeto", projectPath: "/repo/a" }, nome: "Minha regra", agentId: "ag-1" },
          { id: "hr-2", evento: "tarefa.mudou-coluna", escopo: { tipo: "projeto", projectPath: "/outro" }, agentId: "ag-1" },
          { id: "hr-3", evento: "git.post-commit", escopo: { tipo: "global" }, agentId: "ag-1" },
        ];
      }
      throw new Error(`rota inesperada: ${path}`);
    });
    const { modal, $ } = montar({ req });
    await modal.abrir();
    expect($("automacao-modal").classList.contains("hidden")).toBe(false);
    expect($("am-coluna").children.length).toBe(2);
    expect($("am-lista").children.length).toBe(1);
    expect($("am-lista").textContent).toContain("Minha regra");
    expect($("am-vazio").classList.contains("hidden")).toBe(true);
  });

  it("sem regras existentes mostra o vazio", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/tarefas/quadro")) return { colunas: [] };
      return [];
    });
    const { modal, $ } = montar({ req });
    await modal.abrir();
    expect($("am-vazio").classList.contains("hidden")).toBe(false);
  });
});

describe("salvar", () => {
  it("cria com escopo do projeto atual e evento fixo tarefa.mudou-coluna", async () => {
    const req = vi.fn(async (path, opts) => {
      if (path.startsWith("/v1/tarefas/quadro")) return { colunas: [{ id: "cl-1", nome: "A fazer" }] };
      if (path === "/v1/hooks/rules" && !opts) return [];
      if (path === "/v1/hooks/rules" && opts?.method === "POST") return { id: "hr-novo" };
      throw new Error(`rota inesperada: ${path}`);
    });
    const { modal, $, aoSalvar } = montar({ req });
    await modal.abrir();
    $("am-nome").value = "Notificar";
    $("am-coluna").value = "cl-1";
    $("am-agent").value = "ag-1";
    const ok = await modal.salvar();
    expect(ok).toBe(true);
    const chamada = req.mock.calls.find(([p, o]) => p === "/v1/hooks/rules" && o?.method === "POST");
    const body = JSON.parse(chamada[1].body);
    expect(body.evento).toBe("tarefa.mudou-coluna");
    expect(body.escopo).toEqual({ tipo: "projeto", projectPath: "/repo/a" });
    expect(body.colunaId).toBe("cl-1");
    expect(body.agentId).toBe("ag-1");
    expect(aoSalvar).toHaveBeenCalled();
  });

  it("recusa sem agente nem time", async () => {
    const req = vi.fn(async (path) => (path.startsWith("/v1/tarefas/quadro") ? { colunas: [] } : []));
    const { modal, $ } = montar({ req, agents: [] });
    await modal.abrir();
    $("am-agent").value = "";
    const ok = await modal.salvar();
    expect(ok).toBe(false);
    expect($("am-err").classList.contains("hidden")).toBe(false);
  });
});
