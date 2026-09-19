import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, saveConfig } from "./config.ts";
import { globalSkillsDir, profileDir, projectKey } from "./home.ts";
import { assertSlug } from "./ids.ts";
import { getProfile } from "./profiles.ts";

export type SkillDef = {
  name: string;
  description: string;
  /**
   * "projeto" = `.claude/skills` do repo aberto; "perfil" = pasta claude do
   * perfil ativo; "global" = `~/.nexos/skills`, a mesma pra qualquer conta.
   */
  scope: "projeto" | "perfil" | "global";
  /** Pasta da skill — é dela que sai o corpo, e é ela que o modelo lê pra achar arquivo auxiliar. */
  dir: string;
};

/**
 * Frontmatter YAML de SKILL.md é sempre raso (chave: valor, ou bloco `>`/`|`
 * indentado) — não vale puxar uma lib de YAML só pra ler `name`/`description`.
 */
export function parseFrontmatter(raw: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const km = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!km) {
      i++;
      continue;
    }
    const key = km[1];
    let value = km[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const fold = value.startsWith(">");
      const bloco: string[] = [];
      i++;
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        bloco.push(lines[i].trim());
        i++;
      }
      value = fold ? bloco.filter(Boolean).join(" ") : bloco.join("\n");
    } else {
      value = value.replace(/^["']|["']$/g, "");
      i++;
    }
    out[key] = value;
  }
  return out;
}

function scanSkillsDir(dir: string, scope: SkillDef["scope"], seen: Set<string>, out: SkillDef[]): void {
  if (!existsSync(dir)) return;
  let entradas: string[];
  try {
    entradas = readdirSync(dir);
  } catch {
    return;
  }
  for (const entrada of entradas) {
    const md = join(dir, entrada, "SKILL.md");
    if (!existsSync(md)) continue;
    let raw: string;
    try {
      raw = readFileSync(md, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    const name = (fm.name || entrada).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: fm.description || "", scope, dir: join(dir, entrada) });
  }
}

/**
 * Copia cada skill de `~/.nexos/skills` pra dentro da pasta de skills do perfil
 * (`CLAUDE_CONFIG_DIR/skills`, isolada por conta). É a diferença entre uma
 * skill só aparecer no menu "/" do Nexos e o motor de verdade enxergar ela — o
 * CLI só lê skill de dentro do seu próprio `CLAUDE_CONFIG_DIR` ou do
 * `.claude/skills` do projeto aberto, nunca de uma pasta global arbitrária.
 * Roda a cada turno (custo é ler alguns KB de markdown); sobrescreve pra
 * pegar edição, mas nunca apaga skill que só existe no perfil.
 */
export function syncGlobalSkills(destSkillsDir: string, globalDir: string): void {
  if (!existsSync(globalDir)) return;
  let entradas: string[];
  try {
    entradas = readdirSync(globalDir);
  } catch {
    return;
  }
  for (const entrada of entradas) {
    const src = join(globalDir, entrada);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    try {
      mkdirSync(destSkillsDir, { recursive: true });
      cpSync(src, join(destSkillsDir, entrada), { recursive: true, force: true });
    } catch {
      // pasta do perfil pode estar ocupada com o motor de pé; não vale travar o turno por isso.
    }
  }
}

/**
 * Skills que o motor desta conversa enxerga: as do projeto (`.claude/skills`),
 * as do perfil (pasta claude isolada por conta — ver `engineEnv`) e as globais
 * do Nexos (`~/.nexos/skills`, sincronizadas pra dentro do perfil a cada turno
 * por `syncGlobalSkills`). Em empate de nome, projeto > perfil > global.
 *
 * Vale em QUALQUER motor. Só o `claude` lê `SKILL.md` sozinho (o CLI dele
 * interpreta `/nome`); nos outros quem carrega é o Nexos, expandindo o corpo da
 * skill no prompt do turno — ver `expandirSkill`. Antes o menu escondia skill
 * de conta `codex`/`api`, porque não havia esse caminho: quem usava esses
 * motores perdia o menu "/" inteiro.
 */
export function listSkills(home: string, profileId: string | undefined, projectPath: string | undefined): SkillDef[] {
  const out: SkillDef[] = [];
  const seen = new Set<string>();
  if (projectPath) scanSkillsDir(join(projectPath, ".claude", "skills"), "projeto", seen, out);
  const profile = profileId ? getProfile(profileId, home) : undefined;
  if (profile) scanSkillsDir(join(profileDir(profile.id, home), "claude", "skills"), "perfil", seen, out);
  scanSkillsDir(globalSkillsDir(home), "global", seen, out);
  // Desligada no projeto some do menu e do `expandirSkill`. Vale também pra cópia dela dentro do
  // perfil (`syncGlobalSkills`), que aparece como "perfil"; skill do próprio repo não se desliga aqui.
  const off = skillsDesligadasNoProjeto(home, projectPath);
  const visiveis = off.size ? out.filter((s) => s.scope === "projeto" || !off.has(s.name)) : out;
  return visiveis.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** Skills globais desligadas neste projeto (Configurações → Skills). Sem projeto = nenhuma. */
export function skillsDesligadasNoProjeto(home: string, projectPath: string | undefined): Set<string> {
  if (!projectPath) return new Set();
  const chave = projectKey(projectPath);
  const mapa = loadConfig(home).skillsDesligadas;
  return new Set(Object.keys(mapa).filter((nome) => mapa[nome].includes(chave)));
}

/**
 * Liga/desliga UMA skill em UM projeto, lendo e gravando o mapa aqui no daemon — a UI não manda o
 * mapa inteiro, então dois cliques seguidos (ou duas janelas) não se atropelam.
 */
export function definirSkillNoProjeto(
  home: string,
  nome: string,
  projectPath: string,
  ligada: boolean,
): Record<string, string[]> {
  const chave = projectKey(projectPath);
  const mapa = { ...loadConfig(home).skillsDesligadas };
  const atual = new Set(mapa[nome] ?? []);
  if (ligada) atual.delete(chave);
  else atual.add(chave);
  if (atual.size) mapa[nome] = [...atual];
  else delete mapa[nome];
  return saveConfig(home, { skillsDesligadas: mapa }).skillsDesligadas;
}

/** Corpo do `SKILL.md`, sem o frontmatter — que é metadado de listagem, não instrução. */
function corpoDaSkill(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/**
 * Expande `/nome-da-skill` no começo da mensagem, pros motores que não sabem
 * carregar skill sozinhos.
 *
 * No `claude` isto NÃO roda: o CLI dele interpreta `/nome` por conta própria, e
 * expandir aqui mandaria a skill duas vezes. Nos outros, `/nome` chegava como
 * texto literal — o modelo via uma barra e um nome, e mais nada.
 *
 * O caminho da pasta vai junto porque skill séria tem arquivo ao lado
 * (`references/`, script); sem ele o modelo leria o corpo e não teria como
 * chegar no resto.
 */
export function expandirSkill(
  texto: string,
  home: string,
  profileId: string | undefined,
  projectPath: string | undefined,
): string {
  const m = /^\/([a-z0-9][a-z0-9._-]*)[ \t]*([\s\S]*)$/i.exec(texto.trim());
  if (!m) return texto;
  const [, nome, resto] = m;
  const skill = listSkills(home, profileId, projectPath).find((s) => s.name.toLowerCase() === nome.toLowerCase());
  if (!skill) return texto;
  let corpo: string;
  try {
    corpo = corpoDaSkill(readFileSync(join(skill.dir, "SKILL.md"), "utf8"));
  } catch {
    return texto;
  }
  if (!corpo) return texto;
  return [
    `# Skill: ${skill.name}`,
    `(carregada de ${skill.dir} — se o texto abaixo citar arquivo auxiliar, ele está nessa pasta)`,
    "",
    corpo,
    ...(resto.trim() ? ["", "---", "", resto.trim()] : []),
  ].join("\n");
}

/**
 * Instala uma skill escrita na hora (frontmatter + corpo) na pasta global —
 * mesmo destino de `syncGlobalSkills`, então vale pra qualquer conta a partir
 * do próximo turno. Mesmo `nome` sobrescreve (é UPDATE, igual `saveAgent`).
 */
export function instalarSkillDeMarkdown(home: string, nome: string, conteudo: string): string {
  assertSlug(nome);
  if (!conteudo.trim()) throw new Error("conteúdo vazio");
  const destino = join(globalSkillsDir(home), nome, "SKILL.md");
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, conteudo, "utf8");
  return destino;
}

type ArquivoGithub = { path: string; conteudo: string };

/**
 * Contents API do GitHub, recursiva. Sem token (rate limit menor, mas repo
 * público não precisa) — o mesmo trade-off de `ensureCavemanInstalled`
 * (modules.ts), só que genérico pra qualquer owner/repo/caminho em vez de uma
 * URL fixa.
 */
async function baixarArvoreGithub(owner: string, repo: string, caminho: string, ref?: string): Promise<ArquivoGithub[]> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${caminho}${qs}`;
  const resp = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "nexo-daemon" } });
  if (!resp.ok) throw new Error(`GitHub respondeu ${resp.status} em ${owner}/${repo}/${caminho || "/"}`);
  const dados = (await resp.json()) as unknown;
  const itens = (Array.isArray(dados) ? dados : [dados]) as Array<Record<string, unknown>>;
  const out: ArquivoGithub[] = [];
  for (const item of itens) {
    const tipo = item.type as string | undefined;
    const path = item.path as string;
    if (tipo === "dir") {
      out.push(...(await baixarArvoreGithub(owner, repo, path, ref)));
    } else if (tipo === "file") {
      const content = item.content as string | undefined;
      const encoding = item.encoding as string | undefined;
      if (content && encoding === "base64") {
        out.push({ path, conteudo: Buffer.from(content, "base64").toString("utf8") });
      } else {
        const downloadUrl = item.download_url as string | undefined;
        if (!downloadUrl) throw new Error(`GitHub não deu conteúdo nem download_url pra ${path}`);
        const r2 = await fetch(downloadUrl);
        if (!r2.ok) throw new Error(`GitHub respondeu ${r2.status} baixando ${path}`);
        out.push({ path, conteudo: await r2.text() });
      }
    }
  }
  return out;
}

/**
 * Instala uma skill de um repositório GitHub público na pasta global. `caminho`
 * pode apontar direto pro `SKILL.md` ou pra pasta que o contém (junto com
 * script/referência auxiliar, que também são copiados). Igual `instalarSkillDeMarkdown`:
 * mesmo `nome` sobrescreve.
 */
export async function instalarSkillDoGithub(
  home: string,
  nome: string,
  repo: string,
  caminho = "SKILL.md",
  ref?: string,
): Promise<{ destino: string; arquivos: number }> {
  assertSlug(nome);
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(repo.trim());
  if (!m) throw new Error(`repo inválido: "${repo}" — use o formato owner/repo`);
  const [, owner, repoNome] = m;
  const arquivos = await baixarArvoreGithub(owner, repoNome, caminho.trim() || "SKILL.md", ref);
  const skillMd = arquivos.find((a) => a.path.split("/").pop() === "SKILL.md");
  if (!skillMd) throw new Error(`não achei SKILL.md em ${owner}/${repoNome}/${caminho}`);
  const base = skillMd.path.slice(0, skillMd.path.length - "SKILL.md".length);
  const destinoDir = join(globalSkillsDir(home), nome);
  for (const a of arquivos) {
    const rel = a.path.startsWith(base) ? a.path.slice(base.length) : (a.path.split("/").pop() as string);
    const destino = join(destinoDir, rel);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, a.conteudo, "utf8");
  }
  return { destino: join(destinoDir, "SKILL.md"), arquivos: arquivos.length };
}
