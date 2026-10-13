import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentDef, TeamDef } from "@nexos/shared";
import { listAgents } from "./agents.ts";
import { ferramentasDeAutoria } from "./autoria.ts";
import { relatorioDeUso, type UsoDeCapacidade } from "./cerebro-uso.ts";
import { ferramentasExternasEmCache, listarMcpExternos } from "./cerebro-mcp-externos.ts";
import { ferramentasDoChrome } from "./chrome.ts";
import { loadConfig } from "./config.ts";
import { ferramentaDeDelegar } from "./delegar.ts";
import { ferramentaDePrintDoDs } from "./ds-print.ts";
import { ferramentaDeEntregar } from "./entregar-arquivo.ts";
import { log } from "./log.ts";
import type { Ferramenta } from "./mcp.ts";
import { globalMemoriaPath, memoriaPath, readMemoria, readMemoriaGlobal } from "./memoria.ts";
import { ferramentasDeNavegador } from "./navegador.ts";
import { ferramentaDePainel, ferramentaDePlanejar } from "./paineis.ts";
import { ferramentaDePerguntar } from "./perguntas.ts";
import { projectDir } from "./projeto-dir.ts";
import { ferramentaDeResumo } from "./repo-map-enriquecimento.ts";
import { ferramentasDeRepoMap } from "./repo-map-simbolos.ts";
import { ferramentasDeServicos } from "./servicos-ferramentas.ts";
import { listSkills } from "./skills.ts";
import { ferramentasDeTarefas } from "./tarefas.ts";
import { listTeams } from "./teams.ts";
import { lerTextoEmCache, esquecerTexto } from "./texto-em-cache.ts";
import { ferramentasDeVideo } from "./video-ferramentas.ts";
import { ferramentasDeControleDoWindows } from "./windows-control.ts";

/**
 * Cérebro — catálogo de capacidades: fonte única do que o agente sabe usar.
 *
 * Uma capacidade por item: ferramenta `nexo_*`, skill, agente (subagente ou delegável), time,
 * memória, doc do projeto, ferramenta de MCP externo. A parte AUTO é montada do que já existe
 * (conjuntos de ferramentas, pastas de skill, agents.json, teams.json, MEMORIA.md, `.md` do
 * repo) e cacheada por pouco tempo; a parte da PESSOA (descrição, gatilhos, `comoUsar`, ligada)
 * fica por cima e nunca é sobrescrita pela regeneração — mesma regra das skills do Nexos.
 *
 * Armazenamento: `projectDir/cerebro/catalogo.json` (sincroniza; entra em `DADOS_DO_PROJETO`) e
 * `~/.nexos/cerebro/catalogo.json` (global, vale em todo projeto; o do projeto ganha).
 */

export type TipoDeCapacidadeDoCatalogo = "ferramenta" | "skill" | "agente" | "time" | "memoria" | "doc" | "mcp-externo";

export type Capacidade = {
  /** `tipo:nome` — mesmo formato das chaves do contador de uso (cerebro-uso.ts). */
  id: string;
  tipo: TipoDeCapacidadeDoCatalogo;
  nome: string;
  /** 1 linha, ≤ `DESCRICAO_MAX`. */
  descricao: string;
  /** Termos/situações que lembram o modelo desta capacidade (ver gatilhos por mensagem). */
  gatilhos: string[];
  /** 1–2 linhas: o que chamar. */
  comoUsar: string;
  escopo: "global" | "projeto";
  origem: "auto" | "pessoa";
  ligada: boolean;
  /** Arquivo de onde a capacidade vem (SKILL.md, doc, MEMORIA.md), quando há. */
  caminho?: string;
  usos7d: number;
  usos30d: number;
  disparos30d: number;
  usosAposDisparo30d: number;
  ultimoUso?: string;
  /** Usos e disparos por dia (14 dias, hoje por último) — tendência na tabela da aba. */
  porDia?: number[];
  disparosPorDia?: number[];
};

export const DESCRICAO_MAX = 120;
export const GATILHO_MAX = 60;
export const GATILHOS_MAX = 12;
export const COMO_USAR_MAX = 240;
const DOCS_MAX = 40;
const CACHE_AUTO_MS = 20_000;

/** Ajuste da pessoa por cima do item auto — ou item inteiro criado por ela (`tipo` + `nome`). */
export type Ajuste = {
  tipo?: TipoDeCapacidadeDoCatalogo;
  nome?: string;
  descricao?: string;
  gatilhos?: string[];
  comoUsar?: string;
  ligada?: boolean;
  caminho?: string;
  atualizadoEm: string;
};
type ArquivoDoCatalogo = { versao: 1; itens: Record<string, Ajuste> };

/**
 * Gatilhos curados da primeira versão: poucos, pras capacidades menos usadas e mais valiosas.
 * Expandir só depois de medir "disparou × usou" (cerebro-uso.ts). Termos em minúsculas; o casamento
 * é por palavra/trecho na mensagem da pessoa (cerebro-gatilhos.ts).
 */
export const GATILHOS_CURADOS: Record<string, string[]> = {
  "ferramenta:nexo_perguntar": ["decisão", "escolher", "qual opção", "o que prefere"],
  "ferramenta:nexo_tarefa_listar": ["vários pedidos", "e depois", "também", "lista de coisas"],
  "ferramenta:nexo_mapa_simbolos": ["ler um arquivo de código", "explorar uma pasta", "como está implementado", "onde está a função"],
  "ferramenta:nexo_mock_salvar": ["mock", "protótipo", "wireframe", "como ficaria"],
  "ferramenta:nexo_servico_subir": ["dev server", "localhost", "sobe o servidor", "npm run dev", "pnpm dev"],
  "ferramenta:nexo_arquivo_entregar": ["pra baixar", "exporta", "gera um pdf", "gera um arquivo"],
  "ferramenta:nexo_video_criar": ["vídeo", "release video", "brag"],
  "ferramenta:nexo_delegar": ["delega", "chama o time", "manda o agente"],
  "skill:make-interfaces-feel-better": ["ui", "tela", "componente", "front", "css", "layout"],
  "skill:nexo-times": ["cria um agente", "monta um time", "novo agente"],
  "agente:explorador": ["onde fica", "varredura", "procura em todo", "mapeia o código", "como funciona"],
  "agente:revisor": ["revisa", "review", "revisão", "antes de commitar"],
  "agente:testador": ["roda os testes", "testes passando", "build passa", "quebrou algum teste"],
};

export function cerebroDirDoProjeto(projectPath: string, home: string): string {
  return join(projectDir(projectPath, home), "cerebro");
}
function catalogoPath(projectPath: string | undefined, home: string): string {
  return projectPath ? join(cerebroDirDoProjeto(projectPath, home), "catalogo.json") : join(home, "cerebro", "catalogo.json");
}

function umaLinha(texto: string, max = DESCRICAO_MAX): string {
  const t = texto.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  // corta no fim de frase, se der; senão na última palavra
  const ponto = t.lastIndexOf(". ", max - 1);
  if (ponto > max / 2) return t.slice(0, ponto + 1);
  const espaco = t.lastIndexOf(" ", max - 1);
  return `${t.slice(0, espaco > max / 2 ? espaco : max - 1)}…`;
}

function lerArquivo(caminho: string): ArquivoDoCatalogo {
  const vazio: ArquivoDoCatalogo = { versao: 1, itens: {} };
  let lido: { texto: string } | null;
  try {
    lido = lerTextoEmCache(caminho);
  } catch (err) {
    log.aviso("cerebro", "não consegui ler catalogo.json", { caminho, erro: String(err) });
    return vazio;
  }
  if (!lido) return vazio;
  try {
    const raw = JSON.parse(lido.texto) as Partial<ArquivoDoCatalogo>;
    if (raw && typeof raw === "object" && raw.versao === 1 && raw.itens && typeof raw.itens === "object") return { versao: 1, itens: raw.itens };
  } catch (err) {
    log.aviso("cerebro", "catalogo.json ilegível, ignorando ajustes", { caminho, erro: String(err) });
  }
  return vazio;
}

function gravarArquivo(caminho: string, a: ArquivoDoCatalogo): void {
  mkdirSync(join(caminho, ".."), { recursive: true });
  writeFileSync(`${caminho}.tmp`, JSON.stringify(a, null, 2), "utf8");
  renameSync(`${caminho}.tmp`, caminho);
  esquecerTexto(caminho);
}

/* ---------------------------------------------------------------------------
 * Parte AUTO
 * ------------------------------------------------------------------------- */

type ItemAuto = Pick<Capacidade, "id" | "tipo" | "nome" | "descricao" | "comoUsar" | "escopo"> & { caminho?: string; gatilhos?: string[] };

/** Id de conversa fictício: os conjuntos só o usam ao EXECUTAR, aqui só listamos. */
const THREAD_DO_CATALOGO = "cerebro-catalogo";

/**
 * Todas as ferramentas que uma conversa normal de projeto pode ver (espelho do `POST /v1/mcp` com
 * tudo ligado). Cada conjunto entra protegido: um que falhe (quadro no Drive fora do ar) não
 * derruba o catálogo inteiro.
 */
function ferramentasCatalogaveis(projectPath: string | undefined, home: string): Ferramenta[] {
  const out: Ferramenta[] = [];
  const pp = projectPath ?? "";
  const t = THREAD_DO_CATALOGO;
  const conjuntos: Array<[string, () => Ferramenta[]]> = [
    ["autoria", () => ferramentasDeAutoria(home)()],
    ["repo-map", () => (pp ? ferramentasDeRepoMap(pp, home)() : [])],
    ["resumo", () => (pp ? ferramentaDeResumo(pp, home)() : [])],
    ["tarefas", () => (pp && loadConfig(home).modulos.quadroTarefas ? ferramentasDeTarefas(pp, home)() : [])],
    ["perguntar", () => ferramentaDePerguntar(t, home)()],
    ["delegar", () => (pp ? ferramentaDeDelegar(t, pp, "liberado", home)() : [])],
    ["navegador", () => ferramentasDeNavegador(t, home, "liberado")()],
    ["chrome", () => ferramentasDoChrome(t, home, "liberado")()],
    ["ds", () => (pp ? ferramentaDePrintDoDs(t, pp, home)() : [])],
    ["video", () => (pp ? ferramentasDeVideo(pp, home)() : [])],
    ["painel", () => ferramentaDePainel(t, "liberado", home)()],
    ["entregar", () => ferramentaDeEntregar(t, home)()],
    ["servicos", () => (pp ? ferramentasDeServicos(t, home)() : [])],
    ["planejar", () => (pp ? ferramentaDePlanejar(t, home)() : [])],
    ["windows", () => (loadConfig(home).windowsControlEnabled ? ferramentasDeControleDoWindows()() : [])],
  ];
  const vistos = new Set<string>();
  for (const [nome, montar] of conjuntos) {
    try {
      for (const f of montar()) {
        if (vistos.has(f.name)) continue;
        vistos.add(f.name);
        out.push(f);
      }
    } catch (err) {
      log.avisoUmaVez(`cerebro-conjunto:${nome}`, "cerebro", `conjunto ${nome} ficou fora do catálogo`, { erro: String(err) });
    }
  }
  return out;
}

function primeiraLinhaDeTexto(md: string): string {
  const semFrontmatter = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const linha of semFrontmatter.split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith("#") || t.startsWith("---") || t.startsWith("<") || t.startsWith("![") || t.startsWith("|")) continue;
    return t.replace(/[*_`>]/g, "");
  }
  return "";
}

function docsDoProjeto(projectPath: string): ItemAuto[] {
  const out: ItemAuto[] = [];
  const candidatos: string[] = [];
  const varrer = (dir: string, profundidade: number) => {
    let nomes: string[];
    try {
      nomes = readdirSync(dir);
    } catch {
      return;
    }
    for (const nome of nomes.sort()) {
      if (candidatos.length >= DOCS_MAX) return;
      const p = join(dir, nome);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (profundidade === 0 && (nome === "docs" || nome === "doc")) varrer(p, 1);
        else if (profundidade >= 1 && profundidade < 3 && !nome.startsWith(".") && nome !== "node_modules") varrer(p, profundidade + 1);
      } else if (/\.md$/i.test(nome) && (profundidade > 0 || !/^(CHANGELOG|LICENSE|THIRD_PARTY)/i.test(nome))) {
        candidatos.push(p);
      }
    }
  };
  varrer(projectPath, 0);
  for (const p of candidatos) {
    const rel = relative(projectPath, p).split("\\").join("/");
    let texto = "";
    try {
      texto = readFileSync(p, "utf8").slice(0, 4000);
    } catch {
      continue;
    }
    out.push({
      id: `doc:${rel}`,
      tipo: "doc",
      nome: rel,
      descricao: umaLinha(primeiraLinhaDeTexto(texto) || `Documento ${rel} do projeto`),
      comoUsar: `Read ${rel}`,
      escopo: "projeto",
      caminho: p,
    });
  }
  return out;
}

function itemDeAgente(a: AgentDef, projectPath: string | undefined): ItemAuto {
  const comoUsar = a.subagente
    ? `Agent com subagent_type=\`${a.id}\` (roda em paralelo, devolve conclusão)`
    : `nexo_delegar com agentId=\`${a.id}\` (espera o resultado)`;
  const noProjeto = !a.projetos?.length || (projectPath !== undefined && a.projetos.includes(projectPath));
  return {
    id: `agente:${a.id}`,
    tipo: "agente",
    nome: a.name || a.id,
    descricao: umaLinha(a.description || a.instructions?.split("\n")[0] || `Agente ${a.name}`),
    comoUsar: noProjeto ? comoUsar : `${comoUsar} — subagente fora deste projeto`,
    escopo: a.projetos?.length ? "projeto" : "global",
  };
}

function itemDeTime(t: TeamDef): ItemAuto {
  const membros = t.members.map((m) => m.agentId).join(", ");
  return {
    id: `time:${t.id}`,
    tipo: "time",
    nome: t.name || t.id,
    descricao: umaLinha(t.description || `Time ${t.topology} com ${membros}`),
    comoUsar: `nexo_delegar com teamId=\`${t.id}\` (${t.topology}: ${membros})`,
    escopo: "global",
  };
}

const cacheAuto = new Map<string, { em: number; itens: ItemAuto[] }>();

function parteAuto(projectPath: string | undefined, home: string, agora = Date.now()): ItemAuto[] {
  const chave = projectPath ?? "";
  const c = cacheAuto.get(chave);
  if (c && agora - c.em < CACHE_AUTO_MS) return c.itens;
  const itens: ItemAuto[] = [];
  for (const f of ferramentasCatalogaveis(projectPath, home)) {
    itens.push({
      id: `ferramenta:${f.name}`,
      tipo: "ferramenta",
      nome: f.name,
      descricao: umaLinha(f.description),
      comoUsar: `chame \`${f.name}\` (ferramenta MCP do Nexos; se vier adiada, ToolSearch select:${f.name})`,
      escopo: "global",
    });
  }
  try {
    for (const s of listSkills(home, undefined, projectPath)) {
      itens.push({
        id: `skill:${s.name}`,
        tipo: "skill",
        nome: s.name,
        descricao: umaLinha(s.description || `Skill ${s.name}`),
        comoUsar: `Skill \`${s.name}\``,
        escopo: s.scope === "projeto" ? "projeto" : "global",
        caminho: join(s.dir, "SKILL.md"),
      });
    }
  } catch (err) {
    log.avisoUmaVez("cerebro-skills", "cerebro", "skills ficaram fora do catálogo", { erro: String(err) });
  }
  for (const a of listAgents(home)) itens.push(itemDeAgente(a, projectPath));
  for (const t of listTeams(home)) if (!t.origem) itens.push(itemDeTime(t));
  if (projectPath) {
    const memoria = readMemoria(projectPath, home).trim();
    if (memoria) {
      itens.push({
        id: "memoria:projeto",
        tipo: "memoria",
        nome: "Memória do projeto",
        descricao: umaLinha(primeiraLinhaDeTexto(memoria) || "MEMORIA.md do projeto: decisões, estado e aprendizados acumulados"),
        comoUsar: "Já entra no pack (teto 8 KB); o arquivo inteiro: Read do MEMORIA.md",
        escopo: "projeto",
        caminho: memoriaPath(projectPath, home),
      });
    }
    itens.push(...docsDoProjeto(projectPath));
  }
  // MCP externos do projeto: cada ferramenta descoberta vira capacidade (cerebro-mcp-externos.ts)
  if (projectPath) {
    const cache = ferramentasExternasEmCache(projectPath, home);
    for (const m of listarMcpExternos(projectPath, home)) {
      const lista = cache[m.nome]?.ferramentas ?? [];
      if (!lista.length) {
        itens.push({
          id: `mcp-externo:${m.nome}`,
          tipo: "mcp-externo",
          nome: m.nome,
          descricao: umaLinha(m.descricao || `Servidor MCP ${m.nome} (${m.transporte})${cache[m.nome]?.erro ? " — descoberta falhou" : " — ferramentas ainda não descobertas"}`),
          comoUsar: `ferramentas \`mcp__${m.nome}__*\`${m.ligado ? "" : " (desligado neste projeto)"}`,
          escopo: "projeto",
        });
        continue;
      }
      for (const f of lista) {
        itens.push({
          id: `mcp-externo:${m.nome}/${f.name}`,
          tipo: "mcp-externo",
          nome: `${m.nome}/${f.name}`,
          descricao: umaLinha(f.description || `${f.name} do servidor ${m.nome}`),
          comoUsar: `chame \`mcp__${m.nome}__${f.name}\` (MCP externo ${m.nome}; se vier adiada, ToolSearch select:mcp__${m.nome}__${f.name})`,
          escopo: "projeto",
        });
      }
    }
  }
  const global = readMemoriaGlobal(home).trim();
  if (global) {
    itens.push({
      id: "memoria:global",
      tipo: "memoria",
      nome: "Memória geral",
      descricao: umaLinha(primeiraLinhaDeTexto(global) || "Memória das conversas sem projeto"),
      comoUsar: "Entra no pack do chat geral; o arquivo inteiro: Read do MEMORIA.md global",
      escopo: "global",
      caminho: globalMemoriaPath(home),
    });
  }
  for (const i of itens) {
    const g = GATILHOS_CURADOS[i.id];
    if (g) i.gatilhos = g;
  }
  cacheAuto.set(chave, { em: agora, itens });
  return itens;
}

/** Esquece o cache da parte auto (teste, ou depois de criar skill/agente). */
export function esquecerCatalogo(): void {
  cacheAuto.clear();
}

/* ---------------------------------------------------------------------------
 * Catálogo = auto + ajustes + uso
 * ------------------------------------------------------------------------- */

const TIPOS: TipoDeCapacidadeDoCatalogo[] = ["ferramenta", "skill", "agente", "time", "memoria", "doc", "mcp-externo"];

/** Chaves do contador que apontam pra mesma capacidade (delegação conta no agente/time alvo). */
function chaveDeUso(u: UsoDeCapacidade): string {
  if (u.tipo === "delegar") {
    const [alvo, id] = u.nome.split("/", 2);
    return alvo === "time" ? `time:${id}` : `agente:${id}`;
  }
  return u.chave;
}

/** Ajuste da pessoa por cima do item: texto editado marca `origem: pessoa`; só ligar/desligar não. */
function aplicarAjuste(base: Capacidade, aj: Ajuste | undefined): Capacidade {
  if (!aj) return base;
  const out = { ...base };
  if (typeof aj.descricao === "string" && aj.descricao.trim()) out.descricao = umaLinha(aj.descricao);
  if (Array.isArray(aj.gatilhos)) out.gatilhos = aj.gatilhos;
  if (typeof aj.comoUsar === "string" && aj.comoUsar.trim()) out.comoUsar = aj.comoUsar.trim();
  if (typeof aj.ligada === "boolean") out.ligada = aj.ligada;
  if (aj.caminho) out.caminho = aj.caminho;
  if (aj.descricao !== undefined || aj.gatilhos !== undefined || aj.comoUsar !== undefined) out.origem = "pessoa";
  return out;
}

/**
 * O catálogo deste projeto (ou do chat geral, sem projeto) com uso de 7/30 dias. Ordem: usos 30d
 * desc, depois nome. Só memória/disco — nunca chama modelo.
 */
export function catalogoDoCerebro(projectPath: string | undefined, home: string, opts: { agora?: number } = {}): Capacidade[] {
  const auto = parteAuto(projectPath, home, opts.agora);
  const global = lerArquivo(catalogoPath(undefined, home)).itens;
  const projeto = projectPath ? lerArquivo(catalogoPath(projectPath, home)).itens : {};
  const porId = new Map<string, Capacidade>();
  for (const i of auto) {
    porId.set(i.id, {
      ...i,
      gatilhos: i.gatilhos ?? [],
      origem: "auto",
      ligada: true,
      usos7d: 0,
      usos30d: 0,
      disparos30d: 0,
      usosAposDisparo30d: 0,
    });
  }
  // itens criados pela pessoa (não existem na parte auto)
  for (const [escopo, itens] of [["global", global], ["projeto", projeto]] as const) {
    for (const [id, aj] of Object.entries(itens)) {
      if (porId.has(id) || !aj.tipo || !TIPOS.includes(aj.tipo)) continue;
      porId.set(id, {
        id,
        tipo: aj.tipo,
        nome: aj.nome || id.slice(id.indexOf(":") + 1),
        descricao: umaLinha(aj.descricao || ""),
        gatilhos: aj.gatilhos ?? [],
        comoUsar: aj.comoUsar?.trim() || "",
        escopo,
        origem: "pessoa",
        ligada: aj.ligada ?? true,
        ...(aj.caminho ? { caminho: aj.caminho } : {}),
        usos7d: 0,
        usos30d: 0,
        disparos30d: 0,
        usosAposDisparo30d: 0,
      });
    }
  }
  for (const [id, cap] of porId) porId.set(id, aplicarAjuste(aplicarAjuste(cap, global[id]), projeto[id]));
  const uso = relatorioDeUso(home, projectPath !== undefined ? { projectPath, ...(opts.agora ? { agora: opts.agora } : {}) } : opts.agora ? { agora: opts.agora } : {});
  for (const u of uso.capacidades) {
    const cap = porId.get(chaveDeUso(u));
    if (!cap) continue;
    cap.usos7d += u.usos7d;
    cap.usos30d += u.usos30d;
    cap.disparos30d += u.disparos30d;
    cap.usosAposDisparo30d += u.usosAposDisparo30d;
    if (u.ultimoUso && (!cap.ultimoUso || cap.ultimoUso < u.ultimoUso)) cap.ultimoUso = u.ultimoUso;
    cap.porDia = somarSeries(cap.porDia, u.porDia);
    cap.disparosPorDia = somarSeries(cap.disparosPorDia, u.disparosPorDia);
  }
  return [...porId.values()].sort((a, b) => b.usos30d - a.usos30d || a.nome.localeCompare(b.nome, "pt-BR"));
}

function somarSeries(a: number[] | undefined, b: number[]): number[] {
  return b.map((n, i) => n + (a?.[i] ?? 0));
}

export type KpisDoCatalogo = {
  total: number;
  auto: number;
  pessoa: number;
  usadas7d: number;
  nuncaUsadas: number;
  disparos30d: number;
  usosAposDisparo30d: number;
};

export function kpisDoCatalogo(itens: Capacidade[]): KpisDoCatalogo {
  const k: KpisDoCatalogo = { total: itens.length, auto: 0, pessoa: 0, usadas7d: 0, nuncaUsadas: 0, disparos30d: 0, usosAposDisparo30d: 0 };
  for (const i of itens) {
    if (i.origem === "pessoa") k.pessoa += 1;
    else k.auto += 1;
    if (i.usos7d > 0) k.usadas7d += 1;
    if (!i.ultimoUso && i.usos30d === 0) k.nuncaUsadas += 1;
    k.disparos30d += i.disparos30d;
    k.usosAposDisparo30d += i.usosAposDisparo30d;
  }
  return k;
}

/* ---------------------------------------------------------------------------
 * Edição pela pessoa
 * ------------------------------------------------------------------------- */

function erro(status: number, msg: string): Error {
  return Object.assign(new Error(msg), { status });
}

const ID_RE = /^(ferramenta|skill|agente|time|memoria|doc|mcp-externo):[^\s]{1,160}$/;

function validarAjuste(body: Record<string, unknown>): Omit<Ajuste, "atualizadoEm"> {
  const out: Omit<Ajuste, "atualizadoEm"> = {};
  if (body.descricao !== undefined) {
    if (typeof body.descricao !== "string") throw erro(400, "descricao tem que ser texto");
    if (body.descricao.trim().length > DESCRICAO_MAX) throw erro(400, `descricao: no máximo ${DESCRICAO_MAX} caracteres`);
    out.descricao = body.descricao.trim();
  }
  if (body.gatilhos !== undefined) {
    if (!Array.isArray(body.gatilhos) || body.gatilhos.some((g) => typeof g !== "string")) throw erro(400, "gatilhos tem que ser lista de textos");
    const lista = [...new Set((body.gatilhos as string[]).map((g) => g.trim().toLowerCase()).filter(Boolean))];
    if (lista.length > GATILHOS_MAX) throw erro(400, `gatilhos: no máximo ${GATILHOS_MAX}`);
    if (lista.some((g) => g.length > GATILHO_MAX)) throw erro(400, `gatilho: no máximo ${GATILHO_MAX} caracteres`);
    out.gatilhos = lista;
  }
  if (body.comoUsar !== undefined) {
    if (typeof body.comoUsar !== "string") throw erro(400, "comoUsar tem que ser texto");
    if (body.comoUsar.trim().length > COMO_USAR_MAX) throw erro(400, `comoUsar: no máximo ${COMO_USAR_MAX} caracteres`);
    out.comoUsar = body.comoUsar.trim();
  }
  if (body.ligada !== undefined) {
    if (typeof body.ligada !== "boolean") throw erro(400, "ligada tem que ser boolean");
    out.ligada = body.ligada;
  }
  if (body.caminho !== undefined) {
    if (typeof body.caminho !== "string") throw erro(400, "caminho tem que ser texto");
    out.caminho = body.caminho.trim();
  }
  return out;
}

/**
 * Grava um ajuste da pessoa por cima de uma capacidade. `escopo` diz em qual arquivo: `projeto`
 * (precisa de `projectPath`) ou `global`. Campo que não vier fica como estava.
 */
export function ajustarCapacidade(
  id: string,
  body: Record<string, unknown>,
  opts: { projectPath?: string; escopo?: "projeto" | "global" },
  home: string,
): Capacidade {
  if (!ID_RE.test(id)) throw erro(400, "id inválido (tipo:nome)");
  const escopo = opts.escopo ?? (opts.projectPath ? "projeto" : "global");
  if (escopo === "projeto" && !opts.projectPath) throw erro(400, "projectPath obrigatório pra ajuste no projeto");
  const caminho = catalogoPath(escopo === "projeto" ? opts.projectPath : undefined, home);
  const a = lerArquivo(caminho);
  const atual = a.itens[id] ?? ({} as Partial<Ajuste>);
  const novo = validarAjuste(body);
  const existeAuto = parteAuto(opts.projectPath, home).some((i) => i.id === id);
  const criando = !existeAuto && !atual.tipo;
  if (criando) {
    const tipo = body.tipo as TipoDeCapacidadeDoCatalogo | undefined;
    if (!tipo || !TIPOS.includes(tipo)) throw erro(400, "capacidade nova precisa de tipo válido");
    if (tipo !== id.slice(0, id.indexOf(":"))) throw erro(400, "tipo não bate com o id");
    if (typeof body.nome !== "string" || !body.nome.trim()) throw erro(400, "capacidade nova precisa de nome");
    if (!novo.descricao) throw erro(400, "capacidade nova precisa de descricao");
    if (tipo === "doc" && !novo.caminho) throw erro(400, "doc precisa de caminho do .md");
    a.itens[id] = { ...novo, tipo, nome: body.nome.trim(), atualizadoEm: new Date().toISOString() };
  } else {
    a.itens[id] = { ...atual, ...novo, atualizadoEm: new Date().toISOString() } as Ajuste;
  }
  gravarArquivo(caminho, a);
  const cap = catalogoDoCerebro(opts.projectPath, home).find((c) => c.id === id);
  if (!cap) throw erro(500, "capacidade sumiu depois de gravar");
  return cap;
}

/** Tira o ajuste da pessoa (capacidade auto volta ao gerado; criada por ela some). */
export function removerAjuste(id: string, opts: { projectPath?: string; escopo?: "projeto" | "global" }, home: string): boolean {
  const escopo = opts.escopo ?? (opts.projectPath ? "projeto" : "global");
  const caminho = catalogoPath(escopo === "projeto" ? opts.projectPath : undefined, home);
  if (!existsSync(caminho)) return false;
  const a = lerArquivo(caminho);
  if (!(id in a.itens)) return false;
  delete a.itens[id];
  gravarArquivo(caminho, a);
  return true;
}

/** Conteúdo de uma capacidade (SKILL.md, doc, memória, descrição de agente) — pra `nexo_cerebro ler`. */
export function conteudoDaCapacidade(id: string, projectPath: string | undefined, home: string): { texto: string; caminho?: string } | null {
  const cap = catalogoDoCerebro(projectPath, home).find((c) => c.id === id);
  if (!cap) return null;
  if (cap.caminho) {
    try {
      return { texto: readFileSync(cap.caminho, "utf8"), caminho: cap.caminho };
    } catch (err) {
      log.aviso("cerebro", "não consegui ler o conteúdo da capacidade", { id, caminho: cap.caminho, erro: String(err) });
    }
  }
  if (cap.tipo === "agente") {
    const a = listAgents(home).find((x) => `agente:${x.id}` === id);
    if (a) return { texto: [`# ${a.name}`, a.description ?? "", "", a.instructions ?? ""].join("\n").trim() };
  }
  if (cap.tipo === "time") {
    const t = listTeams(home).find((x) => `time:${x.id}` === id);
    if (t) return { texto: [`# ${t.name}`, t.description ?? "", `topologia: ${t.topology}`, ...t.members.map((m) => `- ${m.agentId}${m.papel ? `: ${m.papel}` : ""}`)].join("\n") };
  }
  return { texto: [`# ${cap.nome}`, cap.descricao, "", `Como usar: ${cap.comoUsar}`, cap.gatilhos.length ? `Gatilhos: ${cap.gatilhos.join(", ")}` : ""].join("\n").trim() };
}
