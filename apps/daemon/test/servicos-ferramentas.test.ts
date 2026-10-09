import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { declararServico, listServices, resetServicesForTest, stopAllServices } from "../src/services.ts";
import { listarServicos, pararServico, subirServico } from "../src/servicos-ferramentas.ts";
import { createThread } from "../src/threads.ts";
import { tempHome } from "./helpers.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-service.mjs");
const node = JSON.stringify(process.execPath);

function portaLivre(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

function conversa() {
  const home = tempHome();
  const proj = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  const threadId = createThread({ projectPath: proj, profileId: "p1" }, home).id;
  return { home, proj, threadId };
}

afterEach(() => {
  stopAllServices();
  resetServicesForTest();
});

describe("declararServico", () => {
  it("cria o nexos.json, atualiza pelo id e preserva o resto (outras chaves, autostart da pessoa)", () => {
    const proj = tempHome();
    writeFileSync(
      join(proj, "nexos.json"),
      JSON.stringify({ outra: 1, services: [{ id: "web", cmd: "velho", url: "http://localhost:1", autostart: true }] }),
    );
    expect(declararServico(proj, { id: "web", cmd: "novo", url: "http://localhost:2" }).mudou).toBe(true);
    expect(declararServico(proj, { id: "web", cmd: "novo", url: "http://localhost:2" }).mudou).toBe(false);
    declararServico(proj, { id: "api", cmd: "py", url: "http://localhost:3" });
    const json = JSON.parse(readFileSync(join(proj, "nexos.json"), "utf8"));
    expect(json.outra).toBe(1);
    expect(json.services).toEqual([
      { id: "web", cmd: "novo", cwd: ".", url: "http://localhost:2", autostart: true },
      { id: "api", cmd: "py", cwd: ".", url: "http://localhost:3" },
    ]);
  });

  it("recusa cwd fora do projeto e projeto só com o nexo.json antigo", () => {
    const proj = tempHome();
    expect(() => declararServico(proj, { id: "web", cmd: "x", cwd: "../fora" })).toThrow(/escapa/);
    const antigo = tempHome();
    writeFileSync(join(antigo, "nexo.json"), JSON.stringify({ services: [] }));
    expect(() => declararServico(antigo, { id: "web", cmd: "x" })).toThrow(/nexo\.json antigo/);
  });
});

describe("nexo_servico_subir / parar / listar", () => {
  it("sobe pelo motor, espera a URL responder, registra no nexos.json e é idempotente", async () => {
    const { home, proj, threadId } = conversa();
    const porta = await portaLivre();
    const args = { id: "web", cmd: `${node} ${JSON.stringify(fixture)} listen ${porta}`, url: `http://127.0.0.1:${porta}` };
    const r = await subirServico(threadId, args, home, { passoMs: 50 });
    expect(r.ok).toBe(true);
    expect(r.texto).toMatch(/de pé em/);
    expect(listServices(proj, home).services[0]).toMatchObject({ id: "web", proc: "running" });
    expect(JSON.parse(readFileSync(join(proj, "nexos.json"), "utf8")).services[0].id).toBe("web");

    const de_novo = await subirServico(threadId, args, home, { passoMs: 50 });
    expect(de_novo.texto).toMatch(/já estava de pé/);

    expect(listarServicos(threadId, home).texto).toMatch(/web: rodando/);
    expect(pararServico(threadId, { id: "web" }, home).ok).toBe(true);
    expect(listServices(proj, home).services[0].proc).not.toBe("running");
  }, 20_000);

  it("processo que cai antes de responder devolve erro com o log", async () => {
    const { home, threadId } = conversa();
    const porta = await portaLivre();
    const r = await subirServico(
      threadId,
      { id: "quebra", cmd: `${node} ${JSON.stringify(fixture)} exit 3`, url: `http://127.0.0.1:${porta}` },
      home,
      { passoMs: 50 },
    );
    expect(r.ok).toBe(false);
    expect(r.texto).toMatch(/saiu antes de responder/);
    expect(r.texto).toMatch(/saindo com 3/);
  }, 20_000);

  it("rodando mas sem responder: devolve no teto, sem travar o turno", async () => {
    const { home, threadId } = conversa();
    const porta = await portaLivre();
    const r = await subirServico(
      threadId,
      { id: "mudo", cmd: `${node} ${JSON.stringify(fixture)}`, url: `http://127.0.0.1:${porta}` },
      home,
      { esperaMs: 300, passoMs: 50 },
    );
    expect(r.ok).toBe(true);
    expect(r.texto).toMatch(/ainda não respondeu/);
  }, 20_000);

  it("faltou url ou id inválido: erro claro, nada gravado", async () => {
    const { home, threadId } = conversa();
    expect((await subirServico(threadId, { id: "web", cmd: "x" }, home)).ok).toBe(false);
    expect((await subirServico(threadId, { id: "Web Errado", cmd: "x", url: "http://localhost:1" }, home)).texto).toMatch(/id inválido/);
  });
});
