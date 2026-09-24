import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import {
  autostartServices,
  comandoNaPorta,
  isTrusted,
  listServices,
  portOf,
  probeUrl,
  readServiceDefs,
  resetServicesForTest,
  serviceLogs,
  startService,
  stopAllServices,
  stopService,
  trocarPorta,
  trustProject,
} from "../src/services.ts";
import { tempHome } from "./helpers.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-service.mjs");
const node = JSON.stringify(process.execPath);

/** Projeto de mentira com um nexos.json dentro. */
function projeto(services: unknown): string {
  const dir = tempHome();
  writeFileSync(join(dir, "nexos.json"), JSON.stringify({ services }), "utf8");
  return dir;
}

function esperar(cond: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const fim = Date.now() + ms;
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() > fim) {
        clearInterval(t);
        reject(new Error("timeout"));
      }
    }, 25);
  });
}

afterEach(() => {
  stopAllServices();
  resetServicesForTest();
});

describe("readServiceDefs", () => {
  it("projeto sem nexos.json não tem serviço", () => {
    expect(readServiceDefs(tempHome())).toEqual([]);
  });

  it("preenche padrão de cwd, name e autostart", () => {
    const dir = projeto([{ id: "web", cmd: "npm run dev", url: "http://localhost:5173" }]);
    expect(readServiceDefs(dir)).toEqual([
      { id: "web", cmd: "npm run dev", cwd: ".", url: "http://localhost:5173", autostart: false },
    ]);
  });

  it("recusa id repetido, id inválido, cmd ausente e cwd que escapa", () => {
    expect(() => readServiceDefs(projeto([{ id: "a", cmd: "x" }, { id: "a", cmd: "y" }]))).toThrow(/repetido/);
    expect(() => readServiceDefs(projeto([{ id: "Web App", cmd: "x" }]))).toThrow(/id inválido/);
    expect(() => readServiceDefs(projeto([{ id: "web" }]))).toThrow(/sem "cmd"/);
    expect(() => readServiceDefs(projeto([{ id: "web", cmd: "x", cwd: "../fora" }]))).toThrow(/escapa/);
  });

  it("json quebrado vira erro legível, não crash", () => {
    const dir = tempHome();
    writeFileSync(join(dir, "nexos.json"), "{ isso não é json", "utf8");
    expect(() => readServiceDefs(dir)).toThrow(/inválido/);
    // listServices não propaga: devolve o erro no relatório
    const rel = listServices(dir, tempHome());
    expect(rel.services).toEqual([]);
    expect(rel.error).toMatch(/inválido/);
  });

  it("projeto com o nome antigo (nexo.json, produto se chamava Nexos até a v0.1.0) continua funcionando", () => {
    const dir = tempHome();
    writeFileSync(dir + "/nexo.json", JSON.stringify({ services: [{ id: "web", cmd: "npm run dev" }] }), "utf8");
    expect(readServiceDefs(dir)).toEqual([
      { id: "web", cmd: "npm run dev", cwd: ".", url: undefined, autostart: false },
    ]);
  });

  it("os dois nomes juntos: o novo (nexos.json) ganha", () => {
    const dir = projeto([{ id: "novo", cmd: "a" }]);
    writeFileSync(dir + "/nexo.json", JSON.stringify({ services: [{ id: "velho", cmd: "b" }] }), "utf8");
    expect(readServiceDefs(dir).map((s) => s.id)).toEqual(["novo"]);
  });
});

describe("portOf", () => {
  it("tira a porta da url, com padrão por protocolo", () => {
    expect(portOf("http://localhost:5173")).toBe(5173);
    expect(portOf("http://127.0.0.1:8003/docs")).toBe(8003);
    expect(portOf("https://example.com")).toBe(443);
    expect(portOf(undefined)).toBeUndefined();
    expect(portOf("nem url")).toBeUndefined();
  });
});

describe("comandoNaPorta", () => {
  it("troca a porta onde ela aparece, repassa --port pro script do npm e desiste do resto", () => {
    expect(comandoNaPorta("python -m uvicorn main:app --host 127.0.0.1 --port 8004", 8004, 8010)).toBe(
      "python -m uvicorn main:app --host 127.0.0.1 --port 8010",
    );
    // não pega 8004 dentro de outro número nem de versão
    expect(comandoNaPorta("serve --port 18004 --v 1.8004", 8004, 8010)).toBeNull();
    expect(comandoNaPorta("npm run dev", 5173, 5180)).toBe("npm run dev -- --port 5180");
    expect(comandoNaPorta("npm run dev -- --host", 5173, 5180)).toBe("npm run dev -- --host --port 5180");
    expect(comandoNaPorta("pnpm dev", 5173, 5180)).toBe("pnpm dev --port 5180");
    expect(comandoNaPorta("docker compose up -d api", 8000, 8001)).toBeNull();
  });
});

/** Porta livre agora (o SO escolhe; fecha na hora). */
async function portaLivre(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const porta = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return porta;
}

describe("porta dos serviços", () => {
  it.runIf(process.platform === "win32")("porta ocupada: não sobe, diz quem segura e oferece uma livre; matar libera", async () => {
    const home = tempHome();
    const porta = await portaLivre();
    const ocupante = spawn(process.execPath, [fixture, "listen", String(porta)], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((r) => ocupante.stdout.once("data", () => r()));
      const dir = projeto([{ id: "svc", cmd: `${node} ${JSON.stringify(fixture)}`, url: `http://127.0.0.1:${porta}` }]);
      const barrado = startService(dir, "svc", home);
      expect(barrado.proc).toBe("off");
      expect(barrado.conflito?.porta).toBe(porta);
      expect(barrado.conflito?.processos.map((p) => p.pid)).toContain(ocupante.pid);
      expect(barrado.conflito?.processos[0]?.nome).toMatch(/node/i);
      expect(barrado.conflito?.livre).toBeGreaterThan(porta);

      const subiu = startService(dir, "svc", home, { matar: true });
      expect(subiu.proc).toBe("running");
      expect(subiu.conflito).toBeUndefined();
      await esperar(() => ocupante.exitCode !== null || ocupante.signalCode !== null);
    } finally {
      ocupante.kill();
    }
  });

  it("trocar a porta vale no cmd, na url e no PORT; a porta original desfaz", async () => {
    const home = tempHome();
    const dir = projeto([{ id: "svc", cmd: `${node} ${JSON.stringify(fixture)} --port 8004`, url: "http://127.0.0.1:8004/docs" }]);
    expect(listServices(dir, home).services[0]?.podeTrocarPorta).toBe(true);
    const trocado = await trocarPorta(dir, "svc", 8010, home);
    expect(trocado.portNumber).toBe(8010);
    expect(trocado.url).toBe("http://127.0.0.1:8010/docs");
    expect(trocado.portaTrocada).toBe(true);
    startService(dir, "svc", home, { ignorarPorta: true });
    await esperar(() => serviceLogs(dir, "svc").includes("PORT=8010 ARGS=--port 8010"));
    stopService(dir, "svc", home);

    const volta = await trocarPorta(dir, "svc", 8004, home);
    expect(volta.portNumber).toBe(8004);
    expect(volta.portaTrocada).toBeUndefined();
  });

  it("não troca porta de comando que não a carrega nem porta inválida", async () => {
    const home = tempHome();
    const dir = projeto([{ id: "api", cmd: "docker compose up -d api", url: "http://localhost:8000" }]);
    expect(listServices(dir, home).services[0]?.podeTrocarPorta).toBeUndefined();
    await expect(trocarPorta(dir, "api", 8001, home)).rejects.toThrow(/não sei onde a porta entra/);
    await expect(trocarPorta(dir, "api", 70000, home)).rejects.toThrow(/porta inválida/);
  });
});

describe("ciclo do serviço", () => {
  it("sobe, aparece como running com pid, e para", async () => {
    const home = tempHome();
    const dir = projeto([{ id: "svc", cmd: `${node} ${JSON.stringify(fixture)}` }]);
    const started = startService(dir, "svc", home);
    expect(started.proc).toBe("running");
    expect(started.pid).toBeGreaterThan(0);

    await esperar(() => serviceLogs(dir, "svc").includes("servico no ar"));

    const stopped = stopService(dir, "svc", home);
    expect(stopped.proc).toBe("exited");
  });

  it("start é idempotente: não sobe segundo processo", async () => {
    const home = tempHome();
    const dir = projeto([{ id: "svc", cmd: `${node} ${JSON.stringify(fixture)}` }]);
    const um = startService(dir, "svc", home);
    const dois = startService(dir, "svc", home);
    expect(dois.pid).toBe(um.pid);
  });

  it("comando que sai sozinho vira exited com o código", async () => {
    const home = tempHome();
    const dir = projeto([{ id: "svc", cmd: `${node} ${JSON.stringify(fixture)} exit 3` }]);
    startService(dir, "svc", home);
    await esperar(() => listServices(dir, home).services[0]?.proc === "exited");
    expect(listServices(dir, home).services[0]?.exitCode).toBe(3);
  });

  it("roda no cwd declarado e com o env declarado", async () => {
    const home = tempHome();
    const dir = projeto([
      { id: "svc", cmd: `${node} ${JSON.stringify(fixture)}`, cwd: "sub", env: { MARCA: "aqui" } },
    ]);
    mkdirSync(join(dir, "sub"), { recursive: true });
    startService(dir, "svc", home);
    await esperar(() => serviceLogs(dir, "svc").includes("MARCA=aqui"));
    expect(serviceLogs(dir, "svc")).toContain("sub");
  });

  it("serviço não declarado dá 404", () => {
    const home = tempHome();
    const dir = projeto([{ id: "web", cmd: "x" }]);
    expect(() => startService(dir, "nao-existe", home)).toThrow(/não declarado/);
  });
});

describe("confiança do projeto", () => {
  it("autostart não roda nada em projeto não confiável", () => {
    const home = tempHome();
    const dir = projeto([{ id: "svc", cmd: `${node} ${JSON.stringify(fixture)}`, autostart: true }]);
    expect(isTrusted(dir, home)).toBe(false);
    expect(autostartServices(dir, home)).toEqual([]);
    expect(listServices(dir, home).services[0]?.proc).toBe("off");
  });

  it("depois de confiar, autostart sobe o que está marcado", async () => {
    const home = tempHome();
    const dir = projeto([
      { id: "sobe", cmd: `${node} ${JSON.stringify(fixture)}`, autostart: true },
      { id: "fica", cmd: `${node} ${JSON.stringify(fixture)}` },
    ]);
    trustProject(dir, home);
    expect(isTrusted(dir, home)).toBe(true);
    const subiram = autostartServices(dir, home);
    expect(subiram.map((s) => s.id)).toEqual(["sobe"]);
    expect(listServices(dir, home).services.find((s) => s.id === "fica")?.proc).toBe("off");
  });

  it("confiar duas vezes não duplica a entrada", () => {
    const home = tempHome();
    const dir = projeto([]);
    trustProject(dir, home);
    const lista = trustProject(dir, home);
    expect(lista.filter((p) => p.toLowerCase().includes(dir.toLowerCase().slice(-8)))).toHaveLength(1);
  });

  it("config carrega trustedProjects gravado", () => {
    const home = tempHome();
    saveConfig(home, { trustedProjects: ["C:/projetos/um"] });
    expect(isTrusted("C:/projetos/um", home)).toBe(true);
    expect(isTrusted("C:/projetos/outro", home)).toBe(false);
  });
});

describe("probeUrl", () => {
  it("recusa host fora de loopback e protocolo estranho", async () => {
    await expect(probeUrl("http://example.com")).rejects.toThrow(/loopback/);
    await expect(probeUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(probeUrl("nem url")).rejects.toThrow(/inválida/);
  });

  it("porta fechada devolve ok=false", async () => {
    const r = await probeUrl("http://127.0.0.1:1/");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("servidor no ar devolve ok com status", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await probeUrl(`http://127.0.0.1:${port}/`);
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
