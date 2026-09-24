// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createNewThreadModal } from "../new-thread-modal.js";

const HTML = `
  <div id="new-thread-modal" class="hidden">
    <div id="nt-branch-field" class="hidden">
      <input id="nt-branch-filtro" class="hidden" />
      <div id="nt-branch-list"></div>
      <p id="nt-branch-dica"></p>
    </div>
    <p id="nt-err" class="hidden"></p>
    <button id="btn-nt-criar">Criar conversa</button>
    <button id="btn-nt-fechar"></button>
  </div>
`;

function montar({ req } = {}) {
  document.body.innerHTML = HTML;
  const $ = (id) => document.getElementById(id);
  const aoCriar = vi.fn();
  const modal = createNewThreadModal({ el: $, req, aoCriar });
  modal.ligar();
  return { modal, $, aoCriar };
}

const itens = ($) => [...$("nt-branch-list").querySelectorAll(".nt-branch")];
const selecionada = ($) => itens($).find((b) => b.getAttribute("aria-selected") === "true")?.dataset.branch;
const corpoDoPost = (req) => JSON.parse(req.mock.calls.find(([p]) => p === "/v1/threads")[1].body);

function reqCom(locais, atual = "main", id = "t1") {
  return vi.fn(async (path) => {
    if (path.startsWith("/v1/git/branches")) return { atual, locais };
    return { id };
  });
}

describe("sem escolha a fazer: cria direto, sem modal", () => {
  it("repo com uma branch só", async () => {
    const req = reqCom(["main"]);
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    expect($("new-thread-modal").classList.contains("hidden")).toBe(true);
    expect(corpoDoPost(req)).toEqual({ projectPath: "/proj", profileId: "p1" });
    expect(aoCriar).toHaveBeenCalledWith("t1");
  });

  it("não é repositório git", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) throw new Error("o projeto não é um repositório git");
      return { id: "t4" };
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj-sem-git", profileId: "p1" });
    expect($("new-thread-modal").classList.contains("hidden")).toBe(true);
    expect(aoCriar).toHaveBeenCalledWith("t4");
  });

  it("chat geral: não consulta branches e cria sem projectPath nem branch", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) throw new Error("não deveria consultar branches sem projeto");
      return { id: "tg1" };
    });
    const { modal, aoCriar } = montar({ req });
    await modal.abrir({ profileId: "p1" });
    expect(corpoDoPost(req)).toEqual({ profileId: "p1" });
    expect(aoCriar).toHaveBeenCalledWith("tg1");
  });

  it("erro na criação direta abre o modal pra mostrar o erro", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) return { atual: "main", locais: ["main"] };
      throw new Error("sem conta pronta");
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    expect($("new-thread-modal").classList.contains("hidden")).toBe(false);
    expect($("nt-err").textContent).toMatch(/sem conta pronta/);
    expect(aoCriar).not.toHaveBeenCalled();
  });
});

describe("várias branches", () => {
  it("mostra a lista com a atual primeiro e pré-selecionada", async () => {
    const { modal, $ } = montar({ req: reqCom(["feature", "main"]) });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    expect($("new-thread-modal").classList.contains("hidden")).toBe(false);
    expect(itens($).map((b) => b.dataset.branch)).toEqual(["main", "feature"]);
    expect(selecionada($)).toBe("main");
    expect(itens($)[0].textContent).toMatch(/atual/);
    expect($("nt-branch-dica").textContent).toMatch(/branch atual/);
  });

  it("escolher outra branch manda `branch` no POST e a dica fala da worktree", async () => {
    const req = reqCom(["main", "feature"], "main", "t2");
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    itens($).find((b) => b.dataset.branch === "feature").click();
    expect(selecionada($)).toBe("feature");
    expect($("nt-branch-dica").textContent).toMatch(/worktree/);

    $("btn-nt-criar").click();
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
    expect(corpoDoPost(req)).toEqual({ projectPath: "/proj", profileId: "p1", branch: "feature" });
  });

  it("voltar pra branch atual não manda `branch` (sem isolar à toa)", async () => {
    const req = reqCom(["main", "feature"], "main", "t3");
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    itens($).find((b) => b.dataset.branch === "feature").click();
    itens($).find((b) => b.dataset.branch === "main").click();
    $("btn-nt-criar").click();
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
    expect(corpoDoPost(req)).toEqual({ projectPath: "/proj", profileId: "p1" });
  });

  it("setas andam na seleção e Enter cria", async () => {
    const req = reqCom(["main", "a", "b"], "main", "t5");
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    const tecla = (key) => $("new-thread-modal").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    tecla("ArrowDown");
    tecla("ArrowDown");
    expect(selecionada($)).toBe("b");
    tecla("ArrowUp");
    expect(selecionada($)).toBe("a");
    tecla("Enter");
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
    expect(corpoDoPost(req).branch).toBe("a");
  });

  it("muitas branches: aparece filtro, e filtrar seleciona a primeira que casa", async () => {
    const locais = ["main", "feat/a", "feat/b", "fix/c", "fix/d", "chore/e", "docs/f"];
    const { modal, $ } = montar({ req: reqCom(locais) });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    expect($("nt-branch-filtro").classList.contains("hidden")).toBe(false);
    $("nt-branch-filtro").value = "fix";
    $("nt-branch-filtro").dispatchEvent(new Event("input"));
    expect(itens($).map((b) => b.dataset.branch)).toEqual(["fix/c", "fix/d"]);
    expect(selecionada($)).toBe("fix/c");
    $("nt-branch-filtro").value = "nada-disso";
    $("nt-branch-filtro").dispatchEvent(new Event("input"));
    expect($("nt-branch-list").textContent).toMatch(/Nenhuma branch/);
  });

  it("poucas branches: sem filtro", async () => {
    const { modal, $ } = montar({ req: reqCom(["main", "x"]) });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    expect($("nt-branch-filtro").classList.contains("hidden")).toBe(true);
  });

  it("erro do daemon fica visível e não fecha o modal", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) return { atual: "main", locais: ["main", "feature"] };
      throw new Error("não deu pra fixar a branch: já em uso em outra árvore");
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    $("btn-nt-criar").click();
    await vi.waitFor(() => expect($("nt-err").textContent).toMatch(/não deu pra fixar/));
    expect(aoCriar).not.toHaveBeenCalled();
    expect($("new-thread-modal").classList.contains("hidden")).toBe(false);
  });
});

describe("abrir/fechar", () => {
  it("Fechar, Esc e clique no fundo fecham", async () => {
    const { modal, $ } = montar({ req: reqCom(["main", "x"]) });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    $("btn-nt-fechar").click();
    expect($("new-thread-modal").classList.contains("hidden")).toBe(true);

    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    $("new-thread-modal").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("new-thread-modal").classList.contains("hidden")).toBe(true);

    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    $("new-thread-modal").click();
    expect($("new-thread-modal").classList.contains("hidden")).toBe(true);
  });
});
