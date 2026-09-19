import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http.ts";
import { globalSkillsDir } from "../src/home.ts";
import { addProfile } from "../src/profiles.ts";
import { listSkills } from "../src/skills.ts";
import {
  ErroDeSkill,
  instalarSkills,
  lerSkillInstalada,
  parseAlvoGitHub,
  removerSkill,
  slugDaSkill,
} from "../src/skills-install.ts";
import { tempHome } from "./helpers.ts";

const MD = `---
name: Revisor de PR
description: Lê o diff antes do push.
---

# Revisor

Confere o diff.
`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slugDaSkill", () => {
  it("vira pasta legível, sem acento nem espaço", () => {
    expect(slugDaSkill("Revisor de PR")).toBe("revisor-de-pr");
    expect(slugDaSkill("Memória Ativa")).toBe("memoria-ativa");
  });

  it("nome que tenta subir de pasta não vira caminho", () => {
    // `../../.ssh` escreveria fora da pasta de skills se virasse nome de pasta cru
    expect(slugDaSkill("../../.ssh")).toBe("ssh");
    expect(() => slugDaSkill("../..")).toThrow(ErroDeSkill);
  });
});

describe("parseAlvoGitHub", () => {
  it("aceita os formatos que a pessoa tem em mãos", () => {
    expect(parseAlvoGitHub("dono/repo")).toEqual({ owner: "dono", repo: "repo" });
    expect(parseAlvoGitHub("https://github.com/dono/repo.git")).toEqual({ owner: "dono", repo: "repo" });
    expect(parseAlvoGitHub("https://github.com/dono/repo/tree/main/skills/x")).toEqual({
      owner: "dono",
      repo: "repo",
      ref: "main",
      caminho: "skills/x",
    });
    expect(parseAlvoGitHub("https://github.com/dono/repo/blob/v2/skills/x/SKILL.md")).toEqual({
      owner: "dono",
      repo: "repo",
      ref: "v2",
      caminho: "skills/x/SKILL.md",
    });
    expect(parseAlvoGitHub("https://raw.githubusercontent.com/dono/repo/main/skills/x/SKILL.md")).toEqual({
      owner: "dono",
      repo: "repo",
      ref: "main",
      caminho: "skills/x/SKILL.md",
    });
  });

  it("endereço que não é GitHub é recusado com nome", () => {
    expect(() => parseAlvoGitHub("https://exemplo.com/skill")).toThrow(/não reconheci/);
  });
});

describe("instalar por markdown", () => {
  it("global cai em ~/.nexo/skills e QUALQUER conta enxerga", async () => {
    const home = tempHome();
    addProfile({ id: "conta-a", engine: "claude" }, home, { skipBinCheck: true });
    addProfile({ id: "conta-b", engine: "claude" }, home, { skipBinCheck: true });

    const [skill] = await instalarSkills({ tipo: "markdown", conteudo: MD }, "global", home);
    expect(skill.name).toBe("Revisor de PR");
    expect(existsSync(join(globalSkillsDir(home), "revisor-de-pr", "SKILL.md"))).toBe(true);

    for (const conta of ["conta-a", "conta-b"]) {
      const nomes = listSkills(home, conta, undefined).map((s) => s.name);
      expect(nomes).toContain("Revisor de PR");
    }
  });

  it("escopo projeto grava no .claude/skills do repositório aberto", async () => {
    const home = tempHome();
    const projeto = tempHome();
    const [skill] = await instalarSkills({ tipo: "markdown", conteudo: MD }, "projeto", home, projeto);
    expect(skill.escopo).toBe("projeto");
    expect(existsSync(join(projeto, ".claude", "skills", "revisor-de-pr", "SKILL.md"))).toBe(true);
    // e não vazou pro global
    expect(existsSync(join(globalSkillsDir(home), "revisor-de-pr"))).toBe(false);
    expect(listSkills(home, undefined, projeto).map((s) => s.scope)).toEqual(["projeto"]);
  });

  it("projeto sem projectPath é erro, não instalação silenciosa no global", async () => {
    const home = tempHome();
    await expect(instalarSkills({ tipo: "markdown", conteudo: MD }, "projeto", home)).rejects.toThrow(/projectPath/);
  });

  it("markdown sem name no frontmatter só passa com nome informado", async () => {
    const home = tempHome();
    const semNome = "# skill solta\n\nfaz coisas";
    await expect(instalarSkills({ tipo: "markdown", conteudo: semNome }, "global", home)).rejects.toThrow(/name/);
    const [skill] = await instalarSkills({ tipo: "markdown", conteudo: semNome, nome: "Skill Solta" }, "global", home);
    expect(skill.name).toBe("Skill Solta");
  });

  it("reinstalar não deixa arquivo da versão velha pra trás", async () => {
    const home = tempHome();
    await instalarSkills({ tipo: "markdown", conteudo: MD }, "global", home);
    const dir = join(globalSkillsDir(home), "revisor-de-pr");
    writeFileSync(join(dir, "sobra.md"), "lixo da versão antiga", "utf8");
    await instalarSkills({ tipo: "markdown", conteudo: MD }, "global", home);
    expect(existsSync(join(dir, "sobra.md"))).toBe(false);
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
  });
});

describe("remover e ler", () => {
  it("remove pelo nome, dentro do escopo", async () => {
    const home = tempHome();
    await instalarSkills({ tipo: "markdown", conteudo: MD }, "global", home);
    removerSkill("Revisor de PR", "global", home);
    expect(existsSync(join(globalSkillsDir(home), "revisor-de-pr"))).toBe(false);
    expect(() => removerSkill("Revisor de PR", "global", home)).toThrow(/não encontrada/);
  });

  it("remover não escapa da pasta de skills", async () => {
    const home = tempHome();
    const fora = join(home, "config.json");
    writeFileSync(fora, "{}", "utf8");
    expect(() => removerSkill("../config.json", "global", home)).toThrow(ErroDeSkill);
    expect(existsSync(fora)).toBe(true);
  });

  it("devolve o markdown instalado pra tela poder mostrar antes de confiar", async () => {
    const home = tempHome();
    await instalarSkills({ tipo: "markdown", conteudo: MD }, "global", home);
    expect(lerSkillInstalada("Revisor de PR", "global", home)).toContain("Confere o diff.");
  });
});

/* ---------- GitHub: a rede é falsa, o caminho percorrido é o de verdade ---------- */

type Arquivo = { conteudo: string };
type Repo = Record<string, Arquivo | "dir">;

/** Responde à API de contents e aos downloads crus a partir de um mapa de caminhos. */
function fingeGitHub(repo: Repo): void {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const raw = /^https:\/\/raw\.example\/(.*)$/.exec(url);
    if (raw) {
      const alvo = repo[raw[1]];
      if (!alvo || alvo === "dir") return new Response("nada", { status: 404 });
      return new Response(alvo.conteudo, { status: 200 });
    }
    const api = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/(.*?)(?:\?.*)?$/.exec(url);
    if (!api) return new Response("nada", { status: 404 });
    const dir = decodeURIComponent(api[1]).replace(/\/$/, "");
    const filhos = Object.keys(repo)
      .filter((caminho) => {
        const pai = caminho.includes("/") ? caminho.slice(0, caminho.lastIndexOf("/")) : "";
        return pai === dir;
      })
      .map((caminho) => ({
        name: caminho.split("/").pop(),
        path: caminho,
        type: repo[caminho] === "dir" ? "dir" : "file",
        download_url: repo[caminho] === "dir" ? null : `https://raw.example/${caminho}`,
      }));
    if (!filhos.length) return new Response("nada", { status: 404 });
    return new Response(JSON.stringify(filhos), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("instalar do GitHub", () => {
  it("pasta com SKILL.md instala a skill inteira, com os anexos", async () => {
    const home = tempHome();
    fingeGitHub({
      "skills": "dir",
      "skills/revisor": "dir",
      "skills/revisor/SKILL.md": { conteudo: MD },
      "skills/revisor/referencias": "dir",
      "skills/revisor/referencias/checklist.md": { conteudo: "- olhar o diff" },
    });
    const instaladas = await instalarSkills(
      { tipo: "github", alvo: "https://github.com/dono/repo/tree/main/skills/revisor" },
      "global",
      home,
    );
    expect(instaladas).toHaveLength(1);
    expect(instaladas[0].arquivos).toBe(2);
    const dir = join(globalSkillsDir(home), "revisor-de-pr");
    expect(readFileSync(join(dir, "referencias", "checklist.md"), "utf8")).toBe("- olhar o diff");
  });

  it("repositório-coleção instala todas as skills de dentro de skills/", async () => {
    const home = tempHome();
    fingeGitHub({
      "README.md": { conteudo: "# coleção" },
      "skills": "dir",
      "skills/um": "dir",
      "skills/um/SKILL.md": { conteudo: "---\nname: Um\ndescription: a\n---\n" },
      "skills/dois": "dir",
      "skills/dois/SKILL.md": { conteudo: "---\nname: Dois\ndescription: b\n---\n" },
      "skills/sem-skill": "dir",
      "skills/sem-skill/leia.md": { conteudo: "não é skill" },
    });
    const instaladas = await instalarSkills({ tipo: "github", alvo: "dono/repo" }, "global", home);
    expect(instaladas.map((s) => s.name).sort()).toEqual(["Dois", "Um"]);
  });

  it("repositório sem SKILL.md nenhum falha dizendo o que fazer", async () => {
    const home = tempHome();
    fingeGitHub({ "README.md": { conteudo: "# nada aqui" } });
    await expect(instalarSkills({ tipo: "github", alvo: "dono/repo" }, "global", home)).rejects.toThrow(/SKILL\.md/);
  });

  it("arquivo que tenta escrever fora da pasta da skill é recusado", async () => {
    const home = tempHome();
    // a API do GitHub não devolveria isto, mas quem responde aqui é a rede, e ela é de terceiro
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) {
        return new Response(
          JSON.stringify([
            { name: "SKILL.md", path: "SKILL.md", type: "file", download_url: "https://raw.example/SKILL.md" },
            {
              name: "../../escapou.json",
              path: "../../escapou.json",
              type: "file",
              download_url: "https://raw.example/escapou",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(url.endsWith("escapou") ? "{}" : MD, { status: 200 });
    });
    await expect(instalarSkills({ tipo: "github", alvo: "dono/repo" }, "global", home)).rejects.toThrow(/suspeito/);
    expect(existsSync(join(home, "escapou.json"))).toBe(false);
  });
});

describe("instalar por URL crua", () => {
  it("baixa o SKILL.md e instala", async () => {
    const home = tempHome();
    vi.stubGlobal("fetch", async () => new Response(MD, { status: 200 }));
    const [skill] = await instalarSkills({ tipo: "url", url: "https://exemplo.com/SKILL.md" }, "global", home);
    expect(skill.name).toBe("Revisor de PR");
  });

  it("URL de página do GitHub não vira skill de HTML — cai no caminho da API", async () => {
    const home = tempHome();
    mkdirSync(globalSkillsDir(home), { recursive: true });
    fingeGitHub({
      "skills": "dir",
      "skills/revisor": "dir",
      "skills/revisor/SKILL.md": { conteudo: MD },
    });
    const [skill] = await instalarSkills(
      { tipo: "url", url: "https://github.com/dono/repo/tree/main/skills/revisor" },
      "global",
      home,
    );
    expect(skill.name).toBe("Revisor de PR");
  });
});

/* ---------- pelas rotas, que é como o app usa ---------- */

describe("rotas /v1/skills", () => {
  it("instala por markdown, lista e remove", async () => {
    const home = tempHome();
    const token = "test-token";
    const app = createApp(home, token);
    const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    addProfile({ id: "p1", engine: "claude" }, home, { skipBinCheck: true });

    const post = await app.request("/v1/skills/install", {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({ origem: { tipo: "markdown", conteudo: MD }, escopo: "global" }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()).instaladas[0].name).toBe("Revisor de PR");

    const lista = await (await app.request("/v1/skills?profileId=p1", { headers: hdr })).json();
    expect(lista.map((s: { name: string }) => s.name)).toContain("Revisor de PR");

    const md = await (
      await app.request(`/v1/skills/${encodeURIComponent("Revisor de PR")}/markdown?escopo=global`, { headers: hdr })
    ).json();
    expect(md.markdown).toContain("Confere o diff.");

    const del = await app.request(`/v1/skills/${encodeURIComponent("Revisor de PR")}?escopo=global`, {
      method: "DELETE",
      headers: hdr,
    });
    expect(del.status).toBe(200);
    expect(await (await app.request("/v1/skills?profileId=p1", { headers: hdr })).json()).toEqual([]);
  });

  it("markdown quebrado vira 400 com motivo, não 500", async () => {
    const home = tempHome();
    const token = "test-token";
    const app = createApp(home, token);
    const resp = await app.request("/v1/skills/install", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ origem: { tipo: "markdown", conteudo: "sem frontmatter" }, escopo: "global" }),
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/name/);
  });
});
