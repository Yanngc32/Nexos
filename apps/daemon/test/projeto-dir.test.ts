import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it, expect } from "vitest";
import { saveConfig } from "../src/config.ts";
import { googleAuthPath, projectKey } from "../src/home.ts";
import { migrarArmazenamento, migrarProjeto, migrarRaizLegadaRemovida, projectDir, projectSlug, projetosRoot } from "../src/projeto-dir.ts";
import { tempHome } from "./helpers.ts";

function tempProjeto(): string {
  return mkdtempSync(join(tmpdir(), "nexo-projdir-"));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initGit(dir: string, remote?: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
  if (remote) git(dir, "remote", "add", "origin", remote);
}

describe("projetosRoot", () => {
  it("default é <home>/projetos", () => {
    const home = tempHome();
    expect(projetosRoot(home)).toBe(join(home, "projetos"));
  });

  it("config.projetosDir sobrescreve o default", () => {
    const home = tempHome();
    saveConfig(home, { projetosDir: "G:/Meu Drive/nexo-projetos" });
    expect(projetosRoot(home)).toBe("G:/Meu Drive/nexo-projetos");
  });
});

describe("projectSlug", () => {
  it("remote HTTPS e SSH do mesmo owner/repo dão o mesmo slug", () => {
    const home = tempHome();
    const a = tempProjeto();
    const b = tempProjeto();
    initGit(a, "https://github.com/Yanngc32/Nexos.git");
    initGit(b, "git@github.com:Yanngc32/Nexos.git");
    expect(projectSlug(a, home)).toEqual({ slug: "yanngc32-nexos", origem: "git" });
    expect(projectSlug(b, home)).toEqual({ slug: "yanngc32-nexos", origem: "git" });
  });

  it("sem remote, cai pro nome da pasta", () => {
    const home = tempHome();
    const dir = tempProjeto();
    initGit(dir);
    const { slug, origem } = projectSlug(dir, home);
    expect(origem).toBe("pasta");
    expect(slug).toBe(basename(dir).toLowerCase());
  });

  it("override manual sempre vence, mesmo com remote", () => {
    const home = tempHome();
    const dir = tempProjeto();
    initGit(dir, "https://github.com/Yanngc32/Nexos.git");
    const chave = projectKey(dir);
    saveConfig(home, { slugOverrides: { [chave]: "meu-nome" } });
    expect(projectSlug(dir, home)).toEqual({ slug: "meu-nome", origem: "manual" });
  });

  it("colisão de fallback (dois projetos sem remote, mesmo nome de pasta) gera sufixo", () => {
    const home = tempHome();
    const raizA = mkdtempSync(join(tmpdir(), "nexo-colisao-"));
    const raizB = mkdtempSync(join(tmpdir(), "nexo-colisao-"));
    const a = join(raizA, "app");
    const b = join(raizB, "app");
    mkdirSync(a);
    mkdirSync(b);
    initGit(a);
    initGit(b);
    projectDir(a, home); // registra "app" como dono de a
    const { slug, origem } = projectSlug(b, home);
    expect(slug).not.toBe("app");
    expect(slug.startsWith("app-")).toBe(true);
    expect(origem).toBe("pasta");
  });
});

describe("migrarProjeto", () => {
  function hashLegado(projectPath: string): string {
    return createHash("sha1").update(projectKey(projectPath)).digest("hex");
  }

  it("move memoria/tarefas/repo-map do layout antigo pro novo, e apaga a origem", () => {
    const home = tempHome();
    const projeto = tempProjeto();
    const hash = hashLegado(projeto);

    const memAntiga = join(home, "memoria", hash);
    mkdirSync(memAntiga, { recursive: true });
    writeFileSync(join(memAntiga, "MEMORIA.md"), "# fatos", "utf8");

    const tarefasAntiga = join(home, "tarefas", hash);
    mkdirSync(tarefasAntiga, { recursive: true });
    writeFileSync(join(tarefasAntiga, "quadro.md"), "quadro", "utf8");

    const grafoAntiga = join(home, "grafo", hash);
    mkdirSync(grafoAntiga, { recursive: true });
    writeFileSync(join(grafoAntiga, "indice.json"), "{}", "utf8");

    migrarProjeto(projeto, home);

    const dir = projectDir(projeto, home);
    expect(readFileSync(join(dir, "memoria", "MEMORIA.md"), "utf8")).toBe("# fatos");
    expect(readFileSync(join(dir, "tarefas", "quadro.md"), "utf8")).toBe("quadro");
    expect(readFileSync(join(dir, "repo-map", "indice.json"), "utf8")).toBe("{}");
    expect(existsSync(memAntiga)).toBe(false);
    expect(existsSync(tarefasAntiga)).toBe(false);
    expect(existsSync(grafoAntiga)).toBe(false);
  });

  it("nunca sobrescreve: se a pasta nova já existe, a antiga fica intacta e não migra", () => {
    const home = tempHome();
    const projeto = tempProjeto();
    const hash = hashLegado(projeto);

    const memAntiga = join(home, "memoria", hash);
    mkdirSync(memAntiga, { recursive: true });
    writeFileSync(join(memAntiga, "MEMORIA.md"), "versão antiga", "utf8");

    const memNova = join(projectDir(projeto, home), "memoria");
    mkdirSync(memNova, { recursive: true });
    writeFileSync(join(memNova, "MEMORIA.md"), "versão nova", "utf8");

    migrarProjeto(projeto, home);

    expect(readFileSync(join(memNova, "MEMORIA.md"), "utf8")).toBe("versão nova");
    expect(existsSync(memAntiga)).toBe(true);
    expect(readFileSync(join(memAntiga, "MEMORIA.md"), "utf8")).toBe("versão antiga");
  });

  it("tipo com override explícito (memoriaDir configurado) nunca migra", () => {
    const home = tempHome();
    const projeto = tempProjeto();
    const hash = hashLegado(projeto);

    saveConfig(home, { memoriaDir: join(home, "memoria") });
    const memAntiga = join(home, "memoria", hash);
    mkdirSync(memAntiga, { recursive: true });
    writeFileSync(join(memAntiga, "MEMORIA.md"), "fica aqui mesmo", "utf8");

    migrarProjeto(projeto, home);

    expect(existsSync(memAntiga)).toBe(true);
    expect(existsSync(join(projetosRoot(home), projectSlug(projeto, home).slug, "memoria"))).toBe(false);
  });

  it("sem pasta antiga nenhuma, não cria nada", () => {
    const home = tempHome();
    const projeto = tempProjeto();
    migrarProjeto(projeto, home);
    expect(existsSync(projetosRoot(home))).toBe(false);
  });
});

describe("migrarRaizLegadaRemovida", () => {
  function hashLegado(projectPath: string): string {
    return createHash("sha1").update(projectKey(projectPath)).digest("hex");
  }

  it("traz o conteúdo da raiz que a pessoa apagou do config — `migrarProjeto` sozinho não acha", () => {
    const home = tempHome();
    const projeto = tempProjeto();
    // Raiz escolhida pela pessoa (ex.: uma pasta do Drive), FORA de `~/.nexos`.
    const raizEscolhida = mkdtempSync(join(tmpdir(), "nexo-drive-"));
    const antiga = join(raizEscolhida, hashLegado(projeto));
    mkdirSync(antiga, { recursive: true });
    writeFileSync(join(antiga, "MEMORIA.md"), "# fatos do drive", "utf8");

    // Pré-condição: com o campo já apagado, `migrarProjeto` não tem como saber dessa raiz.
    migrarProjeto(projeto, home);
    expect(existsSync(antiga)).toBe(true);

    migrarRaizLegadaRemovida("memoriaDir", raizEscolhida, [projeto], home);

    expect(readFileSync(join(projectDir(projeto, home), "memoria", "MEMORIA.md"), "utf8")).toBe("# fatos do drive");
    expect(existsSync(antiga)).toBe(false);
  });

  it("nunca sobrescreve o que já está no layout novo", () => {
    const home = tempHome();
    const projeto = tempProjeto();
    const raizEscolhida = mkdtempSync(join(tmpdir(), "nexo-drive-"));
    const antiga = join(raizEscolhida, hashLegado(projeto));
    mkdirSync(antiga, { recursive: true });
    writeFileSync(join(antiga, "MEMORIA.md"), "antiga", "utf8");
    const nova = join(projectDir(projeto, home), "memoria");
    mkdirSync(nova, { recursive: true });
    writeFileSync(join(nova, "MEMORIA.md"), "nova", "utf8");

    migrarRaizLegadaRemovida("memoriaDir", raizEscolhida, [projeto], home);

    expect(readFileSync(join(nova, "MEMORIA.md"), "utf8")).toBe("nova");
    expect(existsSync(antiga)).toBe(true);
  });

  it("raiz vazia ou campo desconhecido não faz nada", () => {
    const home = tempHome();
    const projeto = tempProjeto();
    migrarRaizLegadaRemovida("memoriaDir", "", [projeto], home);
    expect(existsSync(projetosRoot(home))).toBe(false);
  });
});

describe("projectSlug — cache do remote git", () => {
  it("segunda chamada não spawna git de novo (remote removido depois ainda dá o mesmo slug)", () => {
    const home = tempHome();
    const dir = tempProjeto();
    initGit(dir, "https://github.com/Yanngc32/Nexos.git");
    expect(projectSlug(dir, home)).toEqual({ slug: "yanngc32-nexos", origem: "git" });
    git(dir, "remote", "remove", "origin");
    // se não tivesse cache, essa segunda chamada veria "sem remote" e cairia pro nome da pasta
    expect(projectSlug(dir, home)).toEqual({ slug: "yanngc32-nexos", origem: "git" });
  });
});

describe("projectDir", () => {
  it("cria meta.json na primeira chamada e reaproveita depois", () => {
    const home = tempHome();
    const dir = tempProjeto();
    initGit(dir, "https://github.com/Yanngc32/Nexos.git");
    const p1 = projectDir(dir, home);
    expect(existsSync(join(p1, "meta.json"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(p1, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ projectPath: dir, slug: "yanngc32-nexos", origem: "git" });
    const p2 = projectDir(dir, home);
    expect(p2).toBe(p1);
  });
});

describe("Google Drive conectado", () => {
  it("a raiz passa a ser a pasta do Nexos e a pasta manual não vale (dois sincronizadores no mesmo lugar)", () => {
    const home = tempHome();
    saveConfig(home, { projetosDir: "G:\Meu Drive\Nexos" });
    expect(projetosRoot(home)).toBe("G:\Meu Drive\Nexos");
    writeFileSync(googleAuthPath(home), JSON.stringify({ refreshToken: "rt", email: "a@b" }));
    expect(projetosRoot(home)).toBe(join(home, "drive"));
  });
});

describe("armazenamento no próprio projeto", () => {
  function repoGit(): string {
    const p = mkdtempSync(join(tmpdir(), "nexo-arm-"));
    execFileSync("git", ["init", "-q"], { cwd: p });
    return p;
  }

  it("modo projeto: dados em <projeto>/.nexos, .nexos/ no .gitignore (uma vez só, sem apagar o que havia)", () => {
    const home = tempHome();
    const p = repoGit();
    writeFileSync(join(p, ".gitignore"), "node_modules");
    saveConfig(home, { armazenamento: "projeto" });
    expect(projectDir(p, home)).toBe(join(p, ".nexos"));
    expect(existsSync(join(p, ".nexos", "meta.json"))).toBe(true);
    const gi = readFileSync(join(p, ".gitignore"), "utf8");
    expect(gi.startsWith("node_modules\n")).toBe(true);
    expect(gi.match(/^\.nexos\/$/gm)).toHaveLength(1);
    rmSyncSeguro(join(p, ".nexos"));
    projectDir(p, home); // cria de novo: não duplica a linha
    expect(readFileSync(join(p, ".gitignore"), "utf8").match(/^\.nexos\/$/gm)).toHaveLength(1);
  });

  it("trocar de modo copia os dados de cada projeto e mantém o antigo de backup", () => {
    const home = tempHome();
    const p = repoGit();
    const naPasta = projectDir(p, home);
    mkdirSync(join(naPasta, "memoria"), { recursive: true });
    writeFileSync(join(naPasta, "memoria", "MEMORIA.md"), "lembrete");
    expect(migrarArmazenamento("pasta", "projeto", [p], home)).toBe(1);
    expect(readFileSync(join(p, ".nexos", "memoria", "MEMORIA.md"), "utf8")).toBe("lembrete");
    expect(existsSync(join(naPasta, "memoria", "MEMORIA.md"))).toBe(true);
    expect(readFileSync(join(p, ".gitignore"), "utf8")).toContain(".nexos/");
    // de novo: destino já tem dados, não sobrescreve
    writeFileSync(join(p, ".nexos", "memoria", "MEMORIA.md"), "editado no projeto");
    expect(migrarArmazenamento("pasta", "projeto", [p], home)).toBe(0);
    expect(readFileSync(join(p, ".nexos", "memoria", "MEMORIA.md"), "utf8")).toBe("editado no projeto");
  });
});

function rmSyncSeguro(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
