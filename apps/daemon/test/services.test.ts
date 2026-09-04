import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import {
  autostartServices,
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
  trustProject,
} from "../src/services.ts";
import { tempHome } from "./helpers.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-service.mjs");
const node = JSON.stringify(process.execPath);

/** Projeto de mentira com um nexo.json dentro. */
function projeto(services: unknown): string {
  const dir = tempHome();
  writeFileSync(join(dir, "nexo.json"), JSON.stringify({ services }), "utf8");
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
  it("projeto sem nexo.json não tem serviço", () => {
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
    writeFileSync(join(dir, "nexo.json"), "{ isso não é json", "utf8");
    expect(() => readServiceDefs(dir)).toThrow(/inválido/);
    // listServices não propaga: devolve o erro no relatório
    const rel = listServices(dir, tempHome());
    expect(rel.services).toEqual([]);
    expect(rel.error).toMatch(/inválido/);
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
