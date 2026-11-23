import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tempHome } from "./helpers.ts";
import { addProfile } from "../src/profiles.ts";
import { createThread } from "../src/threads.ts";
import { definirRodarDasMemorias, emitirMemoriaSalva, getLive, postMessage, sessionBus, type SessionEvent } from "../src/session.ts";
import { StubEngine } from "../src/engines/stub.ts";
import { memoriaPath } from "../src/memoria.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { decisaoDaMemoria, prepararHooksDoMotor } from "../src/gate-plano.ts";
import { rodarModeloLateral } from "../src/memorias/motor.ts";
import { memoriasDir } from "../src/memorias/caminho.ts";
import { MARCA_CATALOGO } from "../src/memorias/injecao.ts";
import { lerMemoria, proporMemoria } from "../src/memorias/nucleo.ts";

const token = "tok-memorias";

function criar(home: string, relPath: string, titulo: string, gancho: string, corpo: string) {
  const r = proporMemoria(home, { op: "create", relPath, titulo, gancho, corpo, origem: "agente" });
  if (!r.ok) throw new Error(`não criou ${relPath}: ${r.motivo}`);
}

function semMemoriaDoUsuario(home: string) {
  saveConfig(home, { modulos: { ...loadConfig(home).modulos, memoriaUsuario: false } } as unknown as Parameters<typeof saveConfig>[1]);
}

// seleção sem modelo (léxica, determinística) e memorista parado: nenhum CLI de verdade nos testes
beforeEach(() => definirRodarDasMemorias(null));
afterEach(() => definirRodarDasMemorias(rodarModeloLateral));

describe("memórias no turno", () => {
  it("pack leva o [CATÁLOGO DE MEMÓRIAS]; sem MEMORIA.md legado, sem o bloco antigo", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    criar(home, "deploy.md", "Deploy do servidor", "quando for publicar ou fazer deploy", "Deploy via deploy.sh.");
    const t = createThread({ projectPath: "/proj-mem-cat", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const pack = (getLive(t.id)?.engine as StubEngine).lastStart?.contextPack ?? "";
    expect(pack).toContain(MARCA_CATALOGO);
    expect(pack).toContain("deploy.md");
    expect(pack).not.toContain("# Memória do projeto");
  });

  it("MEMORIA.md legado ainda no lugar (migração não concluiu) continua no pack", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    writeFileSync(memoriaPath("/proj-mem-leg", home), "fato legado do MEMORIA.md", "utf8");
    const t = createThread({ projectPath: "/proj-mem-leg", profileId: "p1" }, home);
    await postMessage(t.id, "oi", home);
    const pack = (getLive(t.id)?.engine as StubEngine).lastStart?.contextPack ?? "";
    expect(pack).toContain(MARCA_CATALOGO);
    expect(pack).toContain("fato legado do MEMORIA.md");
  });

  it("catálogo é refeito na sessão retomada: memória nova aparece na mensagem seguinte", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj-mem-vivo", profileId: "p1" }, home);
    await postMessage(t.id, "primeira", home);
    const antes = (getLive(t.id)?.engine as StubEngine).lastStart?.contextPack ?? "";
    expect(antes).toContain(MARCA_CATALOGO);
    expect(antes).not.toContain("cafe-novo.md");
    criar(home, "cafe-novo.md", "Café", "preferência de bebida", "Expresso.");
    await postMessage(t.id, "segunda", home);
    expect((getLive(t.id)?.engine as StubEngine).lastStart?.contextPack).toContain("cafe-novo.md");
  });

  it("excerto relevante vai antes do texto do usuário, com o prefixo; a mesma versão não repete na conversa", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    criar(home, "deploy.md", "Deploy do servidor", "quando for publicar ou fazer deploy", "Deploy sempre via deploy.sh, nunca scp.");
    const t = createThread({ projectPath: "/proj-mem-exc", profileId: "p1" }, home);
    const msg = "como faço o deploy do servidor?";
    await postMessage(t.id, msg, home);
    const stub = getLive(t.id)?.engine as StubEngine;
    expect(stub.lastSend).toContain("--- Memória relevante: deploy.md ---\nDeploy sempre via deploy.sh");
    expect(stub.lastSend?.endsWith(msg)).toBe(true);
    expect(stub.lastSend?.indexOf("--- Memória relevante")).toBeLessThan(stub.lastSend?.indexOf(msg) ?? -1);
    await postMessage(t.id, msg, home);
    expect((getLive(t.id)?.engine as StubEngine).lastSend).toBe(msg);
  });

  it("módulo desligado: sem catálogo e sem excerto", async () => {
    const home = tempHome();
    semMemoriaDoUsuario(home);
    addProfile({ id: "p1", engine: "stub" }, home);
    criar(home, "deploy.md", "Deploy do servidor", "quando for publicar ou fazer deploy", "Deploy via deploy.sh.");
    const t = createThread({ projectPath: "/proj-mem-off", profileId: "p1" }, home);
    await postMessage(t.id, "deploy do servidor", home);
    const stub = getLive(t.id)?.engine as StubEngine;
    expect(stub.lastStart?.contextPack).not.toContain(MARCA_CATALOGO);
    expect(stub.lastSend).toBe("deploy do servidor");
  });

  it("emitirMemoriaSalva publica memoria.salva na conversa e no global", () => {
    const naConversa: SessionEvent[] = [];
    const noGlobal: SessionEvent[] = [];
    const a = (e: SessionEvent) => naConversa.push(e);
    const b = (e: SessionEvent) => noGlobal.push(e);
    sessionBus.on("t-mem-sse", a);
    sessionBus.on("*", b);
    try {
      emitirMemoriaSalva({ relPath: "deploy.md", titulo: "Deploy", op: "create", origem: "agente", threadId: "t-mem-sse" });
      emitirMemoriaSalva({ relPath: "x.md", titulo: "X", op: "update", origem: "curador" });
    } finally {
      sessionBus.off("t-mem-sse", a);
      sessionBus.off("*", b);
    }
    expect(naConversa).toEqual([{ type: "memoria.salva", threadId: "t-mem-sse", relPath: "deploy.md", titulo: "Deploy", op: "create", origem: "agente" }]);
    expect(noGlobal.filter((e) => e.type === "memoria.salva")).toHaveLength(2);
    expect(noGlobal.at(-1)).toMatchObject({ type: "memoria.salva", threadId: "", relPath: "x.md", op: "update" });
  });
});

describe("recusa de escrita direta na pasta de memórias", () => {
  it("decisaoDaMemoria: Write/Edit dentro da pasta = deny; fora ou leitura = allow", () => {
    const home = tempHome();
    const dir = memoriasDir(home);
    expect(decisaoDaMemoria(dir, { tool_name: "Write", tool_input: { file_path: join(dir, "x.md") } })).toBe("deny");
    expect(decisaoDaMemoria(dir, { tool_name: "Edit", tool_input: { file_path: join(dir, "sub", "y.md") } })).toBe("deny");
    expect(decisaoDaMemoria(dir, { tool_name: "Write", tool_input: { file_path: join(home, "outro.md") } })).toBe("allow");
    expect(decisaoDaMemoria(dir, { tool_name: "Read", tool_input: { file_path: join(dir, "x.md") } })).toBe("allow");
  });

  it("vale mesmo com gatePlano:false — settings tem o hook e o script recusa de verdade", () => {
    const home = tempHome();
    const settings = prepararHooksDoMotor(home, { gatePlano: false, memorias: true });
    expect(settings).toBeTruthy();
    const json = JSON.parse(readFileSync(settings!, "utf8")) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
    expect(json.hooks.PreToolUse).toHaveLength(1);
    const comando = json.hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(comando).toContain("memoria-escrita.cjs");
    expect(comando).not.toContain("gate-plano.cjs");
    expect(prepararHooksDoMotor(home, { gatePlano: false, memorias: false })).toBeUndefined();

    const script = join(home, "run", "memoria-escrita.cjs");
    const dir = memoriasDir(home);
    const rodar = (alvo: string) =>
      spawnSync(process.execPath, [script, dir], {
        input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: alvo } }),
        encoding: "utf8",
      }).stdout;
    expect(JSON.parse(rodar(join(dir, "x.md")))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(rodar(join(home, "fora.md"))).toBe("");
  });
});

describe("rotas HTTP de memórias", () => {
  const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  it("GET /v1/memorias lista sem corpo; /arquivo devolve com segredo mascarado", async () => {
    const home = tempHome();
    criar(home, "deploy.md", "Deploy", "quando publicar", "Via deploy.sh.");
    const r0 = proporMemoria(home, {
      op: "create",
      relPath: "banco.md",
      titulo: "Banco",
      gancho: "acesso ao banco",
      corpo: "Senha: {{secret:banco.senha}}",
      segredos: [{ nome: "banco.senha", valor: "hunter2-muito-longa" }],
      origem: "agente",
    });
    expect(r0.ok).toBe(true);
    const tokenGh = `ghp_${"a1B2".repeat(9)}`;
    appendFileSync(join(memoriasDir(home), "banco.md"), `\nToken colado à mão: ${tokenGh}\n`, "utf8");
    expect(lerMemoria(home, "banco.md")?.corpo).toContain(tokenGh);

    const app = createApp(home, token);
    const lista = await app.request("/v1/memorias", { headers: hdr });
    expect(lista.status).toBe(200);
    const corpoLista = (await lista.json()) as { dir: string; itens: { relPath: string }[] };
    expect(corpoLista.dir).toBe(memoriasDir(home));
    expect(corpoLista.itens.map((i) => i.relPath).sort()).toEqual(["banco.md", "deploy.md"]);
    expect(JSON.stringify(corpoLista)).not.toContain("hunter2");

    const arq = await app.request("/v1/memorias/arquivo?path=banco.md", { headers: hdr });
    expect(arq.status).toBe(200);
    const txt = await arq.text();
    expect(txt).not.toContain("hunter2");
    expect(txt).not.toContain(tokenGh);
    expect(txt).toContain("[segredo redigido]");
    expect(txt).toContain("{{secret:banco.senha}}");

    expect((await app.request("/v1/memorias/arquivo", { headers: hdr })).status).toBe(400);
    expect((await app.request("/v1/memorias/arquivo?path=nao-existe.md", { headers: hdr })).status).toBe(404);
  });

  it("tools/list do MCP oferece memory_* por padrão e some com o módulo desligado", async () => {
    const listar = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const nomes = async (home: string) => {
      const res = await createApp(home, token).request("/v1/mcp", { method: "POST", headers: hdr, body: listar });
      return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    };
    const ligado = tempHome();
    expect(await nomes(ligado)).toEqual(expect.arrayContaining(["memory_list", "memory_propose", "memory_status", "memory_secret_get"]));
    const desligado = tempHome();
    semMemoriaDoUsuario(desligado);
    expect((await nomes(desligado)).some((n) => n.startsWith("memory_"))).toBe(false);
  });
});
