// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createCloneModal } from "../clone-modal.js";

const HTML = `
  <div id="clone-modal" class="hidden">
    <input id="cl-url" />
    <input id="cl-pasta" />
    <button id="btn-cl-pasta"></button>
    <p id="cl-progresso" class="hidden"></p>
    <p id="cl-err" class="hidden"></p>
    <button id="btn-cl-clonar">Clonar</button>
    <button id="btn-cl-fechar"></button>
  </div>
`;

/**
 * `lerEventos` de mentira: entrega os eventos que o teste quis, na ordem, como
 * o SSE do daemon entregaria. O de verdade é testado em sse.test.js.
 */
function eventosDe(lista) {
  return async (_res, onEvent) => {
    for (const ev of lista) onEvent(ev);
  };
}

function montar({ eventos = [], pasta = "/home/eu/codigo", fetchImpl } = {}) {
  document.body.innerHTML = HTML;
  const $ = (id) => document.getElementById(id);
  const aoClonar = vi.fn();
  const pickFolder = vi.fn(async () => pasta);
  const modal = createCloneModal({
    el: $,
    api: (p) => `http://127.0.0.1:7432${p}`,
    headers: () => ({ authorization: "Bearer t" }),
    lerEventos: eventosDe(eventos),
    pickFolder,
    aoClonar,
    fetchImpl: fetchImpl ?? vi.fn(async () => ({ ok: true })),
  });
  modal.ligar();
  return { modal, $, aoClonar, pickFolder };
}

describe("validação antes de chamar o daemon", () => {
  it("sem link, não chama nada e diz o que falta", async () => {
    const fetchImpl = vi.fn();
    const { modal, $ } = montar({ fetchImpl });
    modal.abrir();
    $("cl-pasta").value = "/home/eu/codigo";
    await modal.clonar();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect($("cl-err").textContent).toMatch(/link/i);
    expect($("cl-err").classList.contains("hidden")).toBe(false);
  });

  it("sem pasta, não chama nada", async () => {
    const fetchImpl = vi.fn();
    const { modal, $ } = montar({ fetchImpl });
    modal.abrir();
    $("cl-url").value = "https://github.com/dono/projeto.git";
    await modal.clonar();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect($("cl-err").textContent).toMatch(/pasta/i);
  });
});

describe("clone", () => {
  it("manda link e pasta, mostra progresso e entrega o destino", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const { modal, $, aoClonar } = montar({
      fetchImpl,
      eventos: [
        { type: "progresso", linha: "Cloning into 'projeto'..." },
        { type: "progresso", linha: "Receiving objects:  50%" },
        { type: "ok", dir: "/home/eu/codigo/projeto" },
      ],
    });
    modal.abrir();
    $("cl-url").value = "https://github.com/dono/projeto.git";
    $("cl-pasta").value = "/home/eu/codigo";

    expect(await modal.clonar()).toBe(true);

    const [, opts] = fetchImpl.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({
      url: "https://github.com/dono/projeto.git",
      destinoPai: "/home/eu/codigo",
    });
    expect(aoClonar).toHaveBeenCalledWith("/home/eu/codigo/projeto");
    // fecha sozinho: o destino já virou o projeto aberto
    expect($("clone-modal").classList.contains("hidden")).toBe(true);
  });

  it("erro vem como EVENTO, não como status — quando o stream abre, o 200 já foi", async () => {
    const { modal, $, aoClonar } = montar({
      eventos: [{ type: "erro", message: "já existe uma pasta `projeto` com conteúdo" }],
    });
    modal.abrir();
    $("cl-url").value = "https://github.com/dono/projeto.git";
    $("cl-pasta").value = "/home/eu/codigo";

    expect(await modal.clonar()).toBe(false);
    expect($("cl-err").textContent).toMatch(/já existe uma pasta/);
    expect(aoClonar, "nada a adicionar na lista se não clonou").not.toHaveBeenCalled();
    expect($("clone-modal").classList.contains("hidden"), "fica aberto pra corrigir").toBe(false);
  });

  it("enquanto roda, o botão trava — senão dá pra disparar dois clones na mesma pasta", async () => {
    let durante;
    const { modal, $ } = montar({
      fetchImpl: vi.fn(async () => {
        durante = { travado: $("btn-cl-clonar").disabled, texto: $("btn-cl-clonar").textContent };
        return { ok: true };
      }),
      eventos: [{ type: "ok", dir: "/home/eu/codigo/projeto" }],
    });
    modal.abrir();
    $("cl-url").value = "https://github.com/dono/projeto.git";
    $("cl-pasta").value = "/home/eu/codigo";
    await modal.clonar();
    expect(durante.travado).toBe(true);
    expect(durante.texto).toMatch(/Clonando/);
    expect($("btn-cl-clonar").disabled, "destravado no fim").toBe(false);
  });
});

describe("abrir/fechar", () => {
  it("abrir limpa o que sobrou do clone anterior", () => {
    const { modal, $ } = montar();
    $("cl-url").value = "sujeira";
    $("cl-err").textContent = "erro velho";
    $("cl-err").classList.remove("hidden");
    modal.abrir();
    expect($("cl-url").value).toBe("");
    expect($("cl-err").classList.contains("hidden")).toBe(true);
    expect($("clone-modal").classList.contains("hidden")).toBe(false);
  });

  it("escolher pasta preenche o campo", async () => {
    const { $, pickFolder } = montar({ pasta: "/tmp/destino" });
    $("btn-cl-pasta").click();
    await vi.waitFor(() => expect($("cl-pasta").value).toBe("/tmp/destino"));
    expect(pickFolder).toHaveBeenCalled();
  });

  it("clique no fundo fecha", () => {
    const { modal, $ } = montar();
    modal.abrir();
    $("clone-modal").click();
    expect($("clone-modal").classList.contains("hidden")).toBe(true);
  });
});
