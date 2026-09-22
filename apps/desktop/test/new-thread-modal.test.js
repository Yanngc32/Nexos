// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createNewThreadModal } from "../new-thread-modal.js";

const HTML = `
  <div id="new-thread-modal" class="hidden">
    <label class="field hidden" id="nt-branch-field">
      <div id="nt-branch-dd">
        <button id="nt-branch-trigger"></button>
        <div id="nt-branch-list" class="hidden"></div>
      </div>
    </label>
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

describe("carrega branches ao abrir", () => {
  it("repo com uma branch só: some o seletor e cria direto sem mandar branch", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) return { atual: "main", locais: ["main"] };
      return { id: "t1" };
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    expect($("nt-branch-field").classList.contains("hidden")).toBe(true);

    $("btn-nt-criar").click();
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
    const [, opts] = req.mock.calls.find(([p]) => p === "/v1/threads");
    expect(JSON.parse(opts.body)).toEqual({ projectPath: "/proj", profileId: "p1" });
    expect(aoCriar).toHaveBeenCalledWith("t1");
  });

  it("repo com várias branches: mostra o seletor com a atual pré-selecionada", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) return { atual: "main", locais: ["main", "feature"] };
      return { id: "t1" };
    });
    const { modal, $ } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    expect($("nt-branch-field").classList.contains("hidden")).toBe(false);
    expect($("nt-branch-trigger").textContent).toMatch(/main/);
    expect($("nt-branch-trigger").dataset.branch).toBe("main");
  });

  it("escolher outra branch manda `branch` no POST", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) return { atual: "main", locais: ["main", "feature"] };
      return { id: "t2" };
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });

    $("nt-branch-trigger").click();
    const itens = $("nt-branch-list").querySelectorAll("button");
    const feature = [...itens].find((b) => b.textContent === "feature");
    feature.click();
    expect($("nt-branch-trigger").dataset.branch).toBe("feature");

    $("btn-nt-criar").click();
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
    const [, opts] = req.mock.calls.find(([p]) => p === "/v1/threads");
    expect(JSON.parse(opts.body)).toEqual({ projectPath: "/proj", profileId: "p1", branch: "feature" });
  });

  it("escolher de volta a branch atual não manda `branch` (sem isolar à toa)", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) return { atual: "main", locais: ["main", "feature"] };
      return { id: "t3" };
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });

    $("nt-branch-trigger").click();
    const itens = $("nt-branch-list").querySelectorAll("button");
    [...itens].find((b) => b.textContent.includes("main")).click();

    $("btn-nt-criar").click();
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
    const [, opts] = req.mock.calls.find(([p]) => p === "/v1/threads");
    expect(JSON.parse(opts.body)).toEqual({ projectPath: "/proj", profileId: "p1" });
  });

  it("não é repositório git: some o seletor e ainda dá pra criar", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) throw new Error("o projeto não é um repositório git");
      return { id: "t4" };
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ projectPath: "/proj-sem-git", profileId: "p1" });
    expect($("nt-branch-field").classList.contains("hidden")).toBe(true);

    $("btn-nt-criar").click();
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
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

describe("sem projeto (chat geral)", () => {
  it("abre sem carregar branches e cria sem projectPath nem branch no corpo", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) throw new Error("não deveria consultar branches sem projeto");
      return { id: "tg1" };
    });
    const { modal, $, aoCriar } = montar({ req });
    await modal.abrir({ profileId: "p1" });
    expect($("nt-branch-field").classList.contains("hidden")).toBe(true);

    $("btn-nt-criar").click();
    await vi.waitFor(() => expect(aoCriar).toHaveBeenCalled());
    const [, opts] = req.mock.calls.find(([p]) => p === "/v1/threads");
    expect(JSON.parse(opts.body)).toEqual({ profileId: "p1" });
    expect(aoCriar).toHaveBeenCalledWith("tg1");
  });
});

describe("abrir/fechar", () => {
  it("fechar não deixa ctx velho vazar pra próxima abertura", async () => {
    const req = vi.fn(async (path) => {
      if (path.startsWith("/v1/git/branches")) return { atual: "main", locais: ["main"] };
      return { id: "tx" };
    });
    const { modal, $ } = montar({ req });
    await modal.abrir({ projectPath: "/a", profileId: "p1" });
    modal.fechar();
    expect($("new-thread-modal").classList.contains("hidden")).toBe(true);
  });

  it("clique no fundo fecha", async () => {
    const req = vi.fn(async () => ({ atual: "main", locais: ["main"] }));
    const { modal, $ } = montar({ req });
    await modal.abrir({ projectPath: "/proj", profileId: "p1" });
    $("new-thread-modal").click();
    expect($("new-thread-modal").classList.contains("hidden")).toBe(true);
  });
});
