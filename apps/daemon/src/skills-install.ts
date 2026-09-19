import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { globalSkillsDir } from "./home.ts";
import { parseFrontmatter } from "./skills.ts";

/**
 * Instalação de skill de terceiro — por markdown colado/arquivo, por URL de um
 * SKILL.md cru, ou por um endereço do GitHub (repo, pasta dentro do repo, ou
 * link direto pro arquivo).
 *
 * Onde a skill cai:
 *
 * - `global` → `~/.nexo/skills/<slug>`. É a pasta que `syncGlobalSkills`
 *   (engines/cli.ts) copia pra dentro do `CLAUDE_CONFIG_DIR` isolado de CADA
 *   perfil antes de nascer o processo do motor. Ou seja: instalou uma vez,
 *   vale pra todas as contas, que é o que se espera de skill global.
 * - `projeto` → `<projeto>/.claude/skills/<slug>`, que é o ÚNICO lugar de onde
 *   o CLI lê skill por projeto. Isso mora dentro do repositório da pessoa e
 *   aparece no `git status` — é uma consequência do formato, não uma escolha
 *   nossa, e por isso a tela avisa antes.
 *
 * Nada aqui executa nada do que foi baixado: a instalação só escreve arquivo.
 * Mas o conteúdo de uma skill é INSTRUÇÃO que o modelo vai seguir, então
 * instalar skill de terceiro é um ato de confiança como instalar dependência —
 * a tela diz isso com todas as letras.
 */

export type OrigemSkill =
  | { tipo: "markdown"; conteudo: string; nome?: string }
  | { tipo: "url"; url: string }
  | { tipo: "github"; alvo: string };

export type EscopoSkill = "global" | "projeto";

export type SkillInstalada = {
  name: string;
  description: string;
  escopo: EscopoSkill;
  dir: string;
  arquivos: number;
};

/** Teto por skill. Skill é markdown com alguns anexos; o que passa disso não é skill. */
const MAX_ARQUIVOS = 60;
const MAX_BYTES_TOTAL = 4 * 1024 * 1024;
const MAX_PROFUNDIDADE = 4;
/** Quantas skills uma pasta de coleção pode instalar de uma vez. */
const MAX_SKILLS_POR_INSTALACAO = 24;

export class ErroDeSkill extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Nome de pasta a partir do `name` do frontmatter. Além de deixar legível, é o
 * que impede `name: ../../.ssh` de escrever fora da pasta de skills.
 */
export function slugDaSkill(nome: string): string {
  const slug = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug) throw new ErroDeSkill(`nome de skill inválido: ${JSON.stringify(nome)}`);
  return slug;
}

/** Raiz de onde a skill vai morar, conforme o escopo pedido. */
export function raizDoEscopo(escopo: EscopoSkill, home: string, projectPath?: string): string {
  if (escopo === "global") return globalSkillsDir(home);
  const projeto = (projectPath || "").trim();
  if (!projeto) throw new ErroDeSkill("escopo 'projeto' precisa de projectPath");
  if (!existsSync(projeto)) throw new ErroDeSkill(`projeto não existe: ${projeto}`);
  return join(projeto, ".claude", "skills");
}

/**
 * Caminho de arquivo DENTRO da pasta da skill, recusando `..`, caminho absoluto
 * e link que aponte pra fora. O nome do arquivo vem de um repositório de
 * terceiro; sem isto, `../../settings.json` sobrescreveria config do usuário.
 */
function destinoSeguro(dirDaSkill: string, relativo: string): string {
  const alvo = resolve(dirDaSkill, relativo);
  const raiz = resolve(dirDaSkill);
  if (alvo !== raiz && !alvo.startsWith(raiz + sep)) {
    throw new ErroDeSkill(`caminho de arquivo suspeito na skill: ${relativo}`);
  }
  return alvo;
}

type ArquivoDaSkill = { caminho: string; conteudo: Buffer };

/** Um SKILL.md + o que vier junto (referências, scripts, imagens). */
type SkillBaixada = { slug: string; name: string; description: string; arquivos: ArquivoDaSkill[] };

function lerCabecalho(md: string, nomeSugerido?: string): { name: string; description: string } {
  const fm = parseFrontmatter(md);
  const name = (fm.name || nomeSugerido || "").trim();
  if (!name) {
    throw new ErroDeSkill(
      "SKILL.md sem `name` no frontmatter — informe um nome ou corrija o arquivo (--- name: … ---)",
    );
  }
  return { name, description: (fm.description || "").trim() };
}

/* ---------- GitHub ---------- */

export type AlvoGitHub = { owner: string; repo: string; ref?: string; caminho?: string };

/**
 * Aceita o que a pessoa tem em mãos, sem exigir um formato:
 *
 *   owner/repo
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/skills/minha-skill
 *   https://github.com/owner/repo/blob/main/skills/minha-skill/SKILL.md
 *   https://raw.githubusercontent.com/owner/repo/main/skills/x/SKILL.md
 */
export function parseAlvoGitHub(entrada: string): AlvoGitHub {
  const texto = entrada.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!texto) throw new ErroDeSkill("endereço vazio");

  const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(texto);
  if (raw) return { owner: raw[1], repo: raw[2], ref: raw[3], caminho: raw[4] };

  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/.exec(texto);
  if (url) {
    const alvo: AlvoGitHub = { owner: url[1], repo: url[2] };
    if (url[4]) alvo.ref = url[4];
    if (url[5]) alvo.caminho = url[5];
    return alvo;
  }

  const curto = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(texto);
  if (curto) {
    const alvo: AlvoGitHub = { owner: curto[1], repo: curto[2] };
    if (curto[3]) alvo.caminho = curto[3];
    return alvo;
  }

  throw new ErroDeSkill(`não reconheci este endereço do GitHub: ${entrada}`);
}

type EntradaGitHub = { name: string; path: string; type: "file" | "dir"; download_url: string | null; size?: number };

function cabecalhosGitHub(): HeadersInit {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "nexo",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function pegarJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { headers: cabecalhosGitHub() });
  if (resp.status === 404) throw new ErroDeSkill("não achei esse repositório/pasta no GitHub (ou é privado)", 404);
  if (resp.status === 403) {
    throw new ErroDeSkill(
      "GitHub recusou (limite de requisição sem token). Tente de novo mais tarde ou defina GITHUB_TOKEN no daemon.",
      429,
    );
  }
  if (!resp.ok) throw new ErroDeSkill(`GitHub respondeu ${resp.status}`, 502);
  return (await resp.json()) as T;
}

async function listarPasta(alvo: AlvoGitHub, caminho: string): Promise<EntradaGitHub[]> {
  const base = `https://api.github.com/repos/${alvo.owner}/${alvo.repo}/contents/${caminho}`;
  const url = alvo.ref ? `${base}?ref=${encodeURIComponent(alvo.ref)}` : base;
  const dados = await pegarJson<EntradaGitHub | EntradaGitHub[]>(url);
  return Array.isArray(dados) ? dados : [dados];
}

async function baixarArquivo(entrada: EntradaGitHub): Promise<Buffer> {
  if (!entrada.download_url) throw new ErroDeSkill(`não consegui baixar ${entrada.path}`);
  const resp = await fetch(entrada.download_url, { headers: { "User-Agent": "nexo" } });
  if (!resp.ok) throw new ErroDeSkill(`não consegui baixar ${entrada.path} (HTTP ${resp.status})`, 502);
  return Buffer.from(await resp.arrayBuffer());
}

/** Baixa a pasta inteira da skill, com teto de arquivo, tamanho e profundidade. */
async function baixarPastaDaSkill(alvo: AlvoGitHub, raiz: string): Promise<ArquivoDaSkill[]> {
  const arquivos: ArquivoDaSkill[] = [];
  let bytes = 0;

  async function andar(caminho: string, prefixo: string, nivel: number): Promise<void> {
    if (nivel > MAX_PROFUNDIDADE) return;
    for (const entrada of await listarPasta(alvo, caminho)) {
      if (entrada.type === "dir") {
        await andar(entrada.path, prefixo ? `${prefixo}/${entrada.name}` : entrada.name, nivel + 1);
        continue;
      }
      if (entrada.type !== "file") continue;
      if (arquivos.length >= MAX_ARQUIVOS) throw new ErroDeSkill(`skill com mais de ${MAX_ARQUIVOS} arquivos`);
      const conteudo = await baixarArquivo(entrada);
      bytes += conteudo.byteLength;
      if (bytes > MAX_BYTES_TOTAL) throw new ErroDeSkill("skill maior que 4 MB");
      arquivos.push({ caminho: prefixo ? `${prefixo}/${entrada.name}` : entrada.name, conteudo });
    }
  }

  await andar(raiz, "", 0);
  return arquivos;
}

function montarSkill(arquivos: ArquivoDaSkill[], nomeSugerido?: string): SkillBaixada {
  const md = arquivos.find((a) => a.caminho.toLowerCase() === "skill.md");
  if (!md) throw new ErroDeSkill("não achei SKILL.md nesta pasta");
  const { name, description } = lerCabecalho(md.conteudo.toString("utf8"), nomeSugerido);
  return { slug: slugDaSkill(name), name, description, arquivos };
}

/**
 * Onde estão as skills no que a pessoa apontou. Três casos, nesta ordem:
 * a própria pasta tem SKILL.md; existe uma pasta `skills/` dentro; ou as
 * subpastas de primeiro nível é que são as skills (repositório-coleção).
 */
async function acharSkillsNoGitHub(alvo: AlvoGitHub): Promise<SkillBaixada[]> {
  const raiz = (alvo.caminho || "").replace(/\/SKILL\.md$/i, "");
  const entradas = await listarPasta(alvo, raiz);

  if (entradas.some((e) => e.type === "file" && e.name.toLowerCase() === "skill.md")) {
    return [montarSkill(await baixarPastaDaSkill(alvo, raiz))];
  }

  const pastaSkills = entradas.find((e) => e.type === "dir" && e.name.toLowerCase() === "skills");
  const candidatas = pastaSkills
    ? (await listarPasta(alvo, pastaSkills.path)).filter((e) => e.type === "dir")
    : entradas.filter((e) => e.type === "dir" && !e.name.startsWith("."));

  const achadas: SkillBaixada[] = [];
  for (const dir of candidatas) {
    if (achadas.length >= MAX_SKILLS_POR_INSTALACAO) break;
    let filhos: EntradaGitHub[];
    try {
      filhos = await listarPasta(alvo, dir.path);
    } catch {
      continue;
    }
    if (!filhos.some((f) => f.type === "file" && f.name.toLowerCase() === "skill.md")) continue;
    achadas.push(montarSkill(await baixarPastaDaSkill(alvo, dir.path)));
  }

  if (!achadas.length) {
    throw new ErroDeSkill("não achei nenhum SKILL.md aí — aponte a pasta da skill ou um repositório de skills");
  }
  return achadas;
}

/* ---------- instalação ---------- */

async function baixarDaOrigem(origem: OrigemSkill): Promise<SkillBaixada[]> {
  if (origem.tipo === "markdown") {
    const conteudo = origem.conteudo || "";
    if (!conteudo.trim()) throw new ErroDeSkill("markdown vazio");
    const { name, description } = lerCabecalho(conteudo, origem.nome);
    return [
      {
        slug: slugDaSkill(name),
        name,
        description,
        arquivos: [{ caminho: "SKILL.md", conteudo: Buffer.from(conteudo, "utf8") }],
      },
    ];
  }

  if (origem.tipo === "url") {
    const url = (origem.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new ErroDeSkill("URL precisa começar com http:// ou https://");
    // URL do github.com (não-raw) é endereço de PÁGINA: cai no caminho do GitHub,
    // senão a skill instalada seria o HTML da página.
    if (/^https?:\/\/(www\.)?github\.com\//i.test(url)) return acharSkillsNoGitHub(parseAlvoGitHub(url));
    const resp = await fetch(url, { headers: { "User-Agent": "nexo" } });
    if (!resp.ok) throw new ErroDeSkill(`não consegui baixar (HTTP ${resp.status})`, 502);
    const texto = await resp.text();
    const { name, description } = lerCabecalho(texto);
    return [
      {
        slug: slugDaSkill(name),
        name,
        description,
        arquivos: [{ caminho: "SKILL.md", conteudo: Buffer.from(texto, "utf8") }],
      },
    ];
  }

  return acharSkillsNoGitHub(parseAlvoGitHub(origem.alvo));
}

function gravar(skill: SkillBaixada, raiz: string, escopo: EscopoSkill): SkillInstalada {
  const dir = join(raiz, skill.slug);
  // reinstalar não deixa arquivo da versão velha pra trás
  rmSync(dir, { recursive: true, force: true });
  for (const arquivo of skill.arquivos) {
    const destino = destinoSeguro(dir, arquivo.caminho);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, arquivo.conteudo);
  }
  return { name: skill.name, description: skill.description, escopo, dir, arquivos: skill.arquivos.length };
}

/**
 * Instala uma ou mais skills. Escopo `global` vale pra todas as contas (é a
 * pasta que o daemon sincroniza pra dentro de cada perfil); `projeto` grava no
 * `.claude/skills` do repositório aberto, que é de onde o CLI lê skill de
 * projeto.
 */
export async function instalarSkills(
  origem: OrigemSkill,
  escopo: EscopoSkill,
  home: string,
  projectPath?: string,
): Promise<SkillInstalada[]> {
  const raiz = raizDoEscopo(escopo, home, projectPath);
  const baixadas = await baixarDaOrigem(origem);
  mkdirSync(raiz, { recursive: true });
  return baixadas.map((skill) => gravar(skill, raiz, escopo));
}

/** Apaga a pasta da skill. Só dentro da raiz do escopo — nunca um caminho arbitrário. */
export function removerSkill(nome: string, escopo: EscopoSkill, home: string, projectPath?: string): void {
  const raiz = raizDoEscopo(escopo, home, projectPath);
  const dir = destinoSeguro(raiz, slugDaSkill(nome));
  if (!existsSync(join(dir, "SKILL.md"))) throw new ErroDeSkill(`skill não encontrada: ${nome}`, 404);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Markdown da skill instalada, pra tela poder mostrar o que foi instalado antes
 * de a pessoa confiar naquilo. Truncado: o que interessa é a leitura, e tem
 * skill de dezenas de KB.
 */
export function lerSkillInstalada(nome: string, escopo: EscopoSkill, home: string, projectPath?: string): string {
  const raiz = raizDoEscopo(escopo, home, projectPath);
  const md = join(destinoSeguro(raiz, slugDaSkill(nome)), "SKILL.md");
  if (!existsSync(md)) throw new ErroDeSkill(`skill não encontrada: ${nome}`, 404);
  return readFileSync(md, "utf8").slice(0, 200_000);
}
