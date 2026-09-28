import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  createThread,
  createThreadNaBranch,
  appendEvent,
  readThread,
  listThreads,
  removeThread,
  activeAgentId,
  threadHead,
  conversaEspelhoPath,
  retentarEspelhosApagados,
  espelhosEmDia,
  importarConversas,
  renomearThread,
} from "../src/threads.ts";
import { projetosRoot } from "../src/projeto-dir.ts";
import { addProfile } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

/* Casos com branch/worktree rodam git de verdade — mesmo motivo de worktree.test.ts. */
vi.setConfig({ testTimeout: 30_000 });

/** Repositório de verdade num temp, com um segundo branch com conteúdo diferente. */
function repoComBranches(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexo-threads-branch-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "teste@nexo");
  git("config", "user.name", "Teste");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "main", "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "inicial");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), "feature", "utf8");
  git("commit", "-q", "-am", "na feature");
  git("checkout", "-q", "main");
  return dir;
}

describe("threads", () => {
  it("grava meta e recarrega igual", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    appendEvent({ ts: "2026-01-01T00:00:00.000Z", type: "user", threadId: t.id, text: "oi" }, home);
    const events = readThread(t.id, home);
    expect(events[0]?.type).toBe("thread_meta");
    expect(events[1]?.type).toBe("user");
    expect(listThreads("/proj", home)).toHaveLength(1);
  });

  it("append é visível depois de reload", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    appendEvent({ ts: "t", type: "assistant", threadId: t.id, text: "resp" }, home);
    expect(readThread(t.id, home).at(-1)).toMatchObject({ type: "assistant", text: "resp" });
  });

  it("listThreads não serve cabeçalho velho depois de um append", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    expect(listThreads("/proj", home)[0]?.preview).toBe("Conversa nova");
    appendEvent({ ts: "2099-01-01T00:00:00.000Z", type: "user", threadId: t.id, text: "primeiro pedido" }, home);
    expect(listThreads("/proj", home)[0]).toMatchObject({ preview: "primeiro pedido", updatedAt: "2099-01-01T00:00:00.000Z" });
  });

  it("renomear: o último nome vale e o automático não passa por cima do manual", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    appendEvent({ ts: "2026-01-01T00:00:01.000Z", type: "user", threadId: t.id, text: "oi tudo bem" }, home);
    expect(renomearThread(t.id, "Ajuste do login", "auto", home)).toBe(true);
    expect(threadHead(t.id, home)).toMatchObject({ preview: "Ajuste do login", tituloOrigem: "auto" });
    expect(renomearThread(t.id, "  Meu   nome ", "manual", home)).toBe(true);
    expect(threadHead(t.id, home)?.preview).toBe("Meu nome");
    expect(renomearThread(t.id, "Outro automático", "auto", home)).toBe(false);
    expect(renomearThread(t.id, "Meu nome", "manual", home)).toBe(false); // igual: não grava
    expect(threadHead(t.id, home)).toMatchObject({ preview: "Meu nome", tituloOrigem: "manual" });
  });

  it("removeThread apaga o jsonl", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    removeThread(t.id, home);
    expect(listThreads("/proj", home)).toHaveLength(0);
  });

  it("activeAgentId: sem agente na criação e sem atribuição depois, é undefined", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    expect(activeAgentId(readThread(t.id, home))).toBeUndefined();
    expect(threadHead(t.id, home)?.agentId).toBeUndefined();
  });

  it("activeAgentId: agent_assigned depois da criação passa a valer (roteamento por typesafe.ai)", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1" }, home);
    appendEvent({ ts: "2026-01-01T00:00:01.000Z", type: "user", threadId: t.id, text: "revisa o PR" }, home);
    appendEvent({ ts: "2026-01-01T00:00:02.000Z", type: "agent_assigned", threadId: t.id, agentId: "revisor" }, home);
    expect(activeAgentId(readThread(t.id, home))).toBe("revisor");
    expect(threadHead(t.id, home)?.agentId).toBe("revisor");
  });

  it("activeAgentId: agentId explícito na criação nunca é sobrescrito por engano", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = createThread({ projectPath: "/proj", profileId: "p1", agentId: "explorador" }, home);
    expect(activeAgentId(readThread(t.id, home))).toBe("explorador");
  });

  it("createThreadNaBranch sem branch é igual a createThread (sem worktree)", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = await createThreadNaBranch({ projectPath: "/proj", profileId: "p1" }, home);
    expect(threadHead(t.id, home)?.worktreeDir).toBeUndefined();
  });

  it("branch igual à corrente da pasta principal não isola nada", async () => {
    const home = tempHome();
    const dir = repoComBranches();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "main" }, home);
    const head = threadHead(t.id, home);
    expect(head?.branch).toBeUndefined();
    expect(head?.worktreeDir).toBeUndefined();
  });

  it("branch diferente isola numa git worktree própria", async () => {
    const home = tempHome();
    const dir = repoComBranches();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "feature" }, home);
    const head = threadHead(t.id, home);
    expect(head?.branch).toBe("feature");
    expect(head?.worktreeDir).toBeTruthy();
    expect(existsSync(join(head!.worktreeDir!, "a.txt"))).toBe(true);
    // a pasta principal nunca saiu de `main` — é essa a garantia de isolamento
    const headMain = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    expect(headMain).toBe("main");
  });

  it("segunda conversa na mesma branch reaproveita a worktree da primeira", async () => {
    const home = tempHome();
    const dir = repoComBranches();
    addProfile({ id: "p1", engine: "stub" }, home);
    const a = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "feature" }, home);
    const b = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "feature" }, home);
    expect(threadHead(b.id, home)?.worktreeDir).toBe(threadHead(a.id, home)?.worktreeDir);
  });

  it("branch já aberta numa worktree de fora (outra instalação) é reaproveitada, e apagar a conversa não a remove", async () => {
    const home = tempHome();
    const dir = repoComBranches();
    addProfile({ id: "p1", engine: "stub" }, home);
    // árvore criada por outro dono (ex.: o motor do `run.bat dev`), fora de `<home>/worktrees`
    const deFora = join(mkdtempSync(join(tmpdir(), "wt-fora-")), "arvore");
    execFileSync("git", ["worktree", "add", deFora, "feature"], { cwd: dir });
    const t = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "feature" }, home);
    const head = threadHead(t.id, home);
    expect(head?.branch).toBe("feature");
    expect(realpathSync.native(head!.worktreeDir!).toLowerCase()).toBe(realpathSync.native(deFora).toLowerCase());
    await removeThread(t.id, home);
    expect(existsSync(join(deFora, "a.txt"))).toBe(true);
  });

  it("branch inexistente falha em vez de criar uma nova sem querer", async () => {
    const home = tempHome();
    const dir = repoComBranches();
    addProfile({ id: "p1", engine: "stub" }, home);
    await expect(createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "nao-existe" }, home)).rejects.toThrow();
  });

  it("apagar a última conversa de uma branch isolada remove a worktree do disco", async () => {
    const home = tempHome();
    const dir = repoComBranches();
    addProfile({ id: "p1", engine: "stub" }, home);
    const t = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "feature" }, home);
    const wt = threadHead(t.id, home)!.worktreeDir!;
    expect(existsSync(wt)).toBe(true);
    await removeThread(t.id, home);
    expect(existsSync(wt)).toBe(false);
  });

  it("apagar uma de duas conversas na mesma worktree preserva a pasta pra outra", async () => {
    const home = tempHome();
    const dir = repoComBranches();
    addProfile({ id: "p1", engine: "stub" }, home);
    const a = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "feature" }, home);
    const b = await createThreadNaBranch({ projectPath: dir, profileId: "p1", branch: "feature" }, home);
    const wt = threadHead(a.id, home)!.worktreeDir!;
    await removeThread(a.id, home);
    expect(existsSync(wt)).toBe(true);
    await removeThread(b.id, home);
    expect(existsSync(wt)).toBe(false);
  });

  it("threadId com .. não escreve fora do home", () => {
    const home = tempHome();
    const fora = join(home, "..", "escapou.jsonl");
    expect(() =>
      appendEvent({ ts: "t", type: "user", threadId: "../escapou", text: "x" }, home),
    ).toThrow(/slug inválido/);
    expect(existsSync(fora)).toBe(false);
  });
});

describe("threads sem projeto (chat geral)", () => {
  it("createThread sem projectPath grava thread_meta sem o campo", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const { id } = createThread({ profileId: "p1" }, home);
    const meta = readThread(id, home).find((e) => e.type === "thread_meta");
    expect(meta && meta.type === "thread_meta" ? meta.projectPath : "tinha meta?").toBeUndefined();
  });

  it("listThreads(undefined) lista só as globais, não as de projeto", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const global = createThread({ profileId: "p1" }, home);
    const doProjeto = createThread({ projectPath: "C:/proj/x", profileId: "p1" }, home);

    const globais = listThreads(undefined, home).map((t) => t.id);
    expect(globais).toContain(global.id);
    expect(globais).not.toContain(doProjeto.id);

    const doProjetoLista = listThreads("C:/proj/x", home).map((t) => t.id);
    expect(doProjetoLista).toContain(doProjeto.id);
    expect(doProjetoLista).not.toContain(global.id);
  });

  it("threadHead de conversa global não quebra e projectPath vem undefined", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const { id } = createThread({ profileId: "p1" }, home);
    const head = threadHead(id, home);
    expect(head?.projectPath).toBeUndefined();
  });

  it("removeThread apaga conversa global sem tentar mexer em worktree/espelho", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const { id } = createThread({ profileId: "p1" }, home);
    await expect(removeThread(id, home)).resolves.not.toThrow();
    expect(() => readThread(id, home)).toThrow();
  });

  it("removeThread tira o espelho do slug atual e o que ficou em pasta de slug antigo", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const projectPath = mkdtempSync(join(tmpdir(), "nexo-espelho-"));
    const { id } = createThread({ profileId: "p1", projectPath }, home);
    await espelhosEmDia();
    const atual = conversaEspelhoPath(id, projectPath, home);
    expect(existsSync(atual)).toBe(true);
    const antigo = join(projetosRoot(home), "slug-antigo", "conversas", `${id}.jsonl`);
    mkdirSync(join(antigo, ".."), { recursive: true });
    writeFileSync(antigo, "{}", "utf8");
    await removeThread(id, home);
    expect(existsSync(atual)).toBe(false);
    expect(existsSync(antigo)).toBe(false);
    expect(existsSync(join(home, "espelhos-a-apagar.json"))).toBe(false);
  });

  it("conversa que só existe na pasta de projetos aparece aqui; apagada que o espelho não saiu, não volta", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const projectPath = mkdtempSync(join(tmpdir(), "nexo-espelho-"));
    const { id } = createThread({ profileId: "p1", projectPath }, home);
    await espelhosEmDia();
    const dir = join(conversaEspelhoPath(id, projectPath, home), "..");
    const conversa = (tid: string, texto: string) =>
      [
        { ts: "2026-03-01T00:00:00Z", type: "thread_meta", threadId: tid, projectPath: "D:/outro/pc", profileId: "p1" },
        { ts: "2026-03-01T00:00:01Z", type: "user", threadId: tid, text: texto },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n";
    writeFileSync(join(dir, "t-de-fora.jsonl"), conversa("t-de-fora", "feita em outro PC"), "utf8");
    writeFileSync(join(dir, "t-apagada.jsonl"), conversa("t-apagada", "apagada aqui"), "utf8");
    writeFileSync(join(home, "espelhos-a-apagar.json"), JSON.stringify({ "t-apagada": projectPath }), "utf8");
    expect(await importarConversas(home)).toBe(1);
    const ids = listThreads(projectPath, home).map((t) => t.id);
    expect(ids).toContain("t-de-fora");
    expect(ids).not.toContain("t-apagada");
    expect(await importarConversas(home)).toBe(0); // arquivo igual: nem relê
  });

  it("espelho que não sai na hora fica na lista e sai na próxima tentativa", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const projectPath = mkdtempSync(join(tmpdir(), "nexo-espelho-"));
    const { id } = createThread({ profileId: "p1", projectPath }, home);
    // pasta no lugar do arquivo: rmSync sem recursive falha, como arquivo preso pelo Drive
    const preso = join(projetosRoot(home), "slug-antigo", "conversas", `${id}.jsonl`);
    mkdirSync(join(preso, "x"), { recursive: true });
    await removeThread(id, home);
    expect(existsSync(join(home, "espelhos-a-apagar.json"))).toBe(true);
    rmSync(preso, { recursive: true });
    expect(retentarEspelhosApagados(home)).toBe(1);
    expect(existsSync(join(home, "espelhos-a-apagar.json"))).toBe(false);
  });

  it("createThreadNaBranch sem projectPath ignora branch e cria conversa global normal", async () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home);
    const { id } = await createThreadNaBranch({ profileId: "p1", branch: "feature" }, home);
    const head = threadHead(id, home);
    expect(head?.projectPath).toBeUndefined();
    expect(head?.worktreeDir).toBeUndefined();
  });
});
