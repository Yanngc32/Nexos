// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createServicesPanel } from "../services.js";

const HTML = `
  <div id="svc-strip"><p id="svc-empty"></p><p id="svc-error"></p>
    <button id="btn-svc-trust"></button><ul id="svc-list"></ul></div>
  <div id="svc-log" class="hidden"><span id="svc-log-title"></span><pre id="svc-log-body"></pre></div>
`;

/** Serviço no formato que o daemon devolve. */
function svc(over = {}) {
  return { id: "web", name: "web", cmd: "npm run dev", cwd: ".", proc: "off", ...over };
}

/** Corpo de SSE a partir de eventos já prontos: mesmo formato do daemon. */
function stream(...eventos) {
  const texto = eventos.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(texto);
  return {
    body: {
      getReader() {
        let entregue = false;
        return {
          async read() {
            if (entregue) return { done: true };
            entregue = true;
            return { value: bytes, done: false };
          },
        };
      },
    },
  };
}

function montar({ req, projectPath = "/proj", ok = true, fetchImpl } = {}) {
  document.body.innerHTML = HTML;
  const erros = [];
  const browser = [];
  const panel = createServicesPanel({
    req: req ?? (async () => ({ services: [] })),
    api: (p) => `http://127.0.0.1:7432${p}`,
    headers: () => ({ authorization: "Bearer t" }),
    getProjectPath: () => projectPath,
    isOk: () => ok,
    el: (id) => document.getElementById(id),
    abrirNoBrowser: (url) => browser.push(url),
    aoErro: (m) => erros.push(m),
    fetchImpl: fetchImpl ?? (async () => new Promise(() => {})),
  });
  return { panel, erros, browser, $: (id) => document.getElementById(id) };
}

describe("pintura", () => {
  it("some sem projeto e some com motor desligado", async () => {
    for (const cfg of [{ projectPath: "" }, { ok: false }]) {
      const { panel, $ } = montar(cfg);
      await panel.load();
      expect($("svc-strip").classList.contains("hidden")).toBe(true);
    }
  });

  it("lista vazia aparece em vez de sumir", async () => {
    const { panel, $ } = montar();
    await panel.load();
    expect($("svc-strip").classList.contains("hidden")).toBe(false);
    expect($("svc-empty").classList.contains("hidden")).toBe(false);
  });

  it("monta uma linha por serviço, com porta e comando no title", async () => {
    const { panel, $ } = montar({
      req: async () => ({ services: [svc({ portNumber: 5173, url: "http://127.0.0.1:5173" })] }),
    });
    await panel.load();
    const li = $("svc-list").querySelector("li");
    expect(li.querySelector(".svc-name").textContent).toBe("web");
    expect(li.querySelector(".svc-name").title).toBe("npm run dev (.)");
    expect(li.querySelector(".svc-port").textContent).toBe("5173");
  });

  it("nome de serviço com HTML entra como texto", async () => {
    const { panel, $ } = montar({
      req: async () => ({ services: [svc({ name: "<img src=x onerror=1>" })] }),
    });
    await panel.load();
    expect($("svc-list").querySelector("img")).toBeNull();
    expect($("svc-list").querySelector(".svc-name").textContent).toBe("<img src=x onerror=1>");
  });

  it("botão de confiar só aparece com autostart declarado e projeto não confiável", async () => {
    const casos = [
      [{ services: [svc()], trusted: false }, true],
      [{ services: [svc({ autostart: true })], trusted: true }, true],
      [{ services: [svc({ autostart: true })], trusted: false }, false],
    ];
    for (const [resp, escondido] of casos) {
      const { panel, $ } = montar({ req: async () => resp });
      await panel.load();
      expect($("btn-svc-trust").classList.contains("hidden")).toBe(escondido);
    }
  });
});

describe("bolinha de status", () => {
  const dot = async (s, probeOk) => {
    const { panel, $ } = montar({
      req: async (rota) =>
        rota.startsWith("/v1/probe") ? { ok: probeOk } : { services: [s], trusted: false },
    });
    await panel.load();
    await Promise.resolve();
    return $("svc-list").querySelector(".svc-dot").dataset.state;
  };

  it("sem url, quem manda é o processo", async () => {
    expect(await dot(svc({ proc: "running" }))).toBe("up");
    expect(await dot(svc({ proc: "off" }))).toBe("");
    expect(await dot(svc({ proc: "exited", exitCode: 1 }))).toBe("down");
  });

  it("com url, processo parado é down mesmo assim", async () => {
    expect(await dot(svc({ proc: "off", url: "http://127.0.0.1:5173" }))).toBe("down");
  });

  it("com url e rodando, quem manda é a porta responder", async () => {
    const rodando = svc({ proc: "running", url: "http://127.0.0.1:5173" });
    expect(await dot(rodando, true)).toBe("up");
    // porta muda não é "down": processo de pé com porta calada é o estado normal
    // enquanto o servidor sobe. Marcar como caído seria alarme falso.
    expect(await dot(rodando, false)).toBe("waiting");
  });

  it("saída com código vai no title", async () => {
    const { panel, $ } = montar({ req: async () => ({ services: [svc({ proc: "exited", exitCode: 137 })] }) });
    await panel.load();
    expect($("svc-list").querySelector(".svc-dot").title).toBe("saiu com código 137");
  });
});

describe("carga", () => {
  it("erro 404 explica que o motor é antigo, em vez de parecer projeto sem serviço", async () => {
    const { panel, $ } = montar({
      req: async () => {
        throw new Error("404 not found");
      },
    });
    await panel.load();
    expect($("svc-error").textContent).toMatch(/Motor antigo/);
    expect($("svc-error").classList.contains("hidden")).toBe(false);
  });

  it("outro erro aparece como veio", async () => {
    const { panel, $ } = montar({
      req: async () => {
        throw new Error("nexo.json inválido: linha 3");
      },
    });
    await panel.load();
    expect($("svc-error").textContent).toBe("nexo.json inválido: linha 3");
  });

  it("erro de parse vindo do daemon também aparece", async () => {
    const { panel, $ } = montar({ req: async () => ({ services: [], error: "id repetido" }) });
    await panel.load();
    expect($("svc-error").textContent).toBe("id repetido");
    expect($("svc-empty").classList.contains("hidden")).toBe(true);
  });
});

describe("ações", () => {
  it("o botão manda start ou stop conforme o estado", async () => {
    const chamadas = [];
    const { panel, $ } = montar({
      req: async (rota, opts) => {
        chamadas.push(rota);
        return opts ? {} : { services: [svc({ proc: "running" })] };
      },
    });
    await panel.load();
    $("svc-list").querySelector(".svc-act").click();
    await vi.waitFor(() => expect(chamadas).toContain("/v1/services/web/stop"));
  });

  it("falha de ação vira erro visível, não silêncio", async () => {
    const { panel, erros } = montar({
      req: async (rota) => {
        if (rota.includes("/start")) throw new Error("porta ocupada");
        return { services: [svc()] };
      },
    });
    await panel.acionar("web", "start");
    expect(erros).toEqual(["porta ocupada"]);
  });

  it("confiar chama a rota e recarrega", async () => {
    const chamadas = [];
    const { panel } = montar({
      req: async (rota) => {
        chamadas.push(rota);
        return { services: [] };
      },
    });
    await panel.confiar();
    expect(chamadas[0]).toBe("/v1/services/trust");
    expect(chamadas[1]).toMatch(/^\/v1\/services\?/);
  });

  it("falha ao confiar não recarrega", async () => {
    const chamadas = [];
    const { panel, erros } = montar({
      req: async (rota) => {
        chamadas.push(rota);
        throw new Error("negado");
      },
    });
    await panel.confiar();
    expect(chamadas).toEqual(["/v1/services/trust"]);
    expect(erros).toEqual(["negado"]);
  });

  it("o botão de abrir manda a url pro browser", async () => {
    const { panel, browser, $ } = montar({
      req: async () => ({ services: [svc({ url: "http://127.0.0.1:5173" })] }),
    });
    await panel.load();
    const botoes = $("svc-list").querySelectorAll(".svc-act");
    botoes[botoes.length - 1].click();
    expect(browser).toEqual(["http://127.0.0.1:5173"]);
  });
});

describe("log", () => {
  it("abre, mostra e fecha", async () => {
    const { panel, $ } = montar({ req: async () => ({ log: "linha 1\n" }) });
    await panel.load();
    $("svc-log-body").textContent = "";
    await panel.load();

    const { panel: p2, $: $2 } = montar({
      req: async (rota) => (rota.includes("/logs") ? { log: "saída" } : { services: [svc()] }),
    });
    await p2.load();
    $2("svc-list").querySelector(".svc-name").click();
    await vi.waitFor(() => expect($2("svc-log-body").textContent).toBe("saída"));
    expect($2("svc-log").classList.contains("hidden")).toBe(false);
    expect($2("svc-log-title").textContent).toBe("web");

    p2.fecharLog();
    expect($2("svc-log").classList.contains("hidden")).toBe(true);
  });

  it("log vazio e log ilegível têm cada um seu recado", async () => {
    const a = montar({ req: async (r) => (r.includes("/logs") ? { log: "" } : { services: [svc()] }) });
    await a.panel.load();
    a.$("svc-list").querySelector(".svc-name").click();
    await vi.waitFor(() => expect(a.$("svc-log-body").textContent).toBe("(sem saída ainda)"));

    const b = montar({
      req: async (r) => {
        if (r.includes("/logs")) throw new Error("x");
        return { services: [svc()] };
      },
    });
    await b.panel.load();
    b.$("svc-list").querySelector(".svc-name").click();
    await vi.waitFor(() => expect(b.$("svc-log-body").textContent).toBe("(não consegui ler o log)"));
  });
});

describe("stream de eventos", () => {
  it("evento de status troca só o serviço que mudou", async () => {
    const evento = { type: "status", service: svc({ id: "web", proc: "running" }) };
    const { panel, $ } = montar({
      req: async () => ({ services: [svc({ id: "web" }), svc({ id: "api", name: "api" })] }),
      fetchImpl: async () => stream(evento),
    });
    await panel.load();
    panel.listen();
    await vi.waitFor(() => {
      const dots = $("svc-list").querySelectorAll(".svc-dot");
      expect(dots[0].dataset.state).toBe("up");
      expect(dots[1].dataset.state).toBe("");
    });
    expect(panel.servicos().map((s) => s.id)).toEqual(["web", "api"]);
  });

  it("evento de log só entra se for do log aberto", async () => {
    const { panel, $ } = montar({
      req: async (r) => (r.includes("/logs") ? { log: "base:" } : { services: [svc()] }),
      fetchImpl: async () =>
        stream({ type: "log", id: "outro", chunk: "NÃO" }, { type: "log", id: "web", chunk: "SIM" }),
    });
    await panel.load();
    $("svc-list").querySelector(".svc-name").click();
    await vi.waitFor(() => expect($("svc-log-body").textContent).toBe("base:"));
    panel.listen();
    await vi.waitFor(() => expect($("svc-log-body").textContent).toBe("base:SIM"));
  });

  it("não abre stream sem projeto nem com motor desligado", async () => {
    for (const cfg of [{ projectPath: "" }, { ok: false }]) {
      const fetchImpl = vi.fn();
      const { panel } = montar({ ...cfg, fetchImpl });
      panel.listen();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("abrir de novo aborta o stream anterior", async () => {
    const sinais = [];
    const { panel } = montar({
      fetchImpl: async (_u, opts) => {
        sinais.push(opts.signal);
        return new Promise(() => {});
      },
    });
    panel.listen();
    panel.listen();
    expect(sinais[0].aborted).toBe(true);
    expect(sinais[1].aborted).toBe(false);
  });

  it("manda o cabeçalho de autorização: EventSource não daria conta", async () => {
    let visto;
    const { panel } = montar({
      fetchImpl: async (url, opts) => {
        visto = { url, headers: opts.headers };
        return new Promise(() => {});
      },
    });
    panel.listen();
    expect(visto.url).toContain("/v1/services/events?projectPath=");
    expect(visto.headers.authorization).toBe("Bearer t");
  });
});

describe("troca de projeto", () => {
  it("limparPortas descarta a sonda da pasta antiga", async () => {
    const { panel, $ } = montar({
      req: async (r) => (r.startsWith("/v1/probe") ? { ok: true } : { services: [svc({ proc: "running", url: "http://127.0.0.1:5173" })] }),
    });
    await panel.load();
    await vi.waitFor(() => expect($("svc-list").querySelector(".svc-dot").dataset.state).toBe("up"));
    panel.limparPortas();
    panel.paint();
    expect($("svc-list").querySelector(".svc-dot").dataset.state).toBe("waiting");
  });
});
