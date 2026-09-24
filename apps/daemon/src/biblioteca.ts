import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ID_RE, TEAM_ID_RE, type AgentDef, type TeamDef } from "@nexos/shared";
import * as agentes from "./agents.ts";
import { agentsPath, bibliotecaSyncStatePath, globalSkillsDir, hooksPath, teamsPath } from "./home.ts";
import { listarRegras, sincronizarHooksGlobal, writeAll as gravarRegras, type RegraHook } from "./hooks.ts";
import { listProfiles } from "./profiles.ts";
import { projectSlug, projetosRoot } from "./projeto-dir.ts";
import { decidir, PASTA_BIBLIOTECA } from "./sync-decisao.ts";
import * as times from "./teams.ts";
import { projetosConhecidos } from "./threads.ts";

/**
 * Biblioteca = agentes, times, Nexos Hooks e skills globais: o que a pessoa monta uma vez e quer
 * em todo PC. Fica espelhada em `<projetosRoot>/_biblioteca/`, um arquivo (ou pasta, pra skill) por
 * item — assim ela viaja com a mesma pasta que já leva memória e conversas: pelo sync do Google
 * Drive (drive-sync.ts chama isto antes e depois de cada rodada) ou por `projetosDir` apontado
 * pra uma pasta sincronizada por fora (o loop do motor chama isto a cada 2min).
 *
 * Um arquivo por item, e não o `agents.json` inteiro: dois PCs criando agentes diferentes no
 * mesmo intervalo mexem em arquivos diferentes, e nenhum pisa no outro.
 *
 * Conciliação em 3 vias por item, com a mesma regra do drive-sync (`decidir`): a base é o MD5 do
 * arquivo do espelho na última vez em que os dois lados estavam iguais. Exclusão num lado apaga no
 * outro; criação/edição copia; editado dos dois lados, vale o `updatedAt` mais novo.
 *
 * O que é da máquina não viaja como está: hook de projeto vai com o slug do projeto (o caminho
 * muda de PC pra PC) e volta com o caminho daqui; agente cuja conta não existe aqui usa a primeira
 * conta pronta. Pra essa troca local não parecer edição (e subir pros outros PCs), o estado guarda
 * também o hash do item local como ficou — igual a ele, o item local conta como "não mudou".
 */

export { PASTA_BIBLIOTECA };

export type ResultadoBiblioteca = {
  exportados: number;
  importados: number;
  apagadosAqui: number;
  apagadosNoEspelho: number;
  erros: string[];
};

/** `base`: MD5 do arquivo do espelho; `local`: MD5 do item local cru, na última conciliação. */
type EstadoItem = { base: string; local: string };
type Estado = { root: string; itens: Record<string, EstadoItem> };

const md5 = (s: string | Buffer): string => createHash("md5").update(s).digest("hex");
const serializar = (obj: unknown): string => `${JSON.stringify(obj, null, 2)}\n`;
/** Id que vira nome de arquivo: nada de separador, `..` ou nome oculto. */
const ID_ARQUIVO_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/;

function lerEstado(home: string, root: string): Estado {
  try {
    const raw = JSON.parse(readFileSync(bibliotecaSyncStatePath(home), "utf8")) as Partial<Estado>;
    if (raw.root === root && raw.itens && typeof raw.itens === "object") return { root, itens: raw.itens };
  } catch {
    /* sem estado ou corrompido: recomeça do zero (nada é apagado sem base) */
  }
  return { root, itens: {} };
}

function gravarAtomico(path: string, conteudo: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, conteudo, "utf8");
  renameSync(tmp, path);
}

type Tipo<T extends { id: string }> = {
  pasta: string;
  /** O store local (`agents.json`…): ilegível, o tipo inteiro fica pra próxima rodada. */
  arquivo: (home: string) => string;
  ler: (home: string) => T[];
  gravar: (lista: T[], home: string) => void;
  /** Local → espelho. */
  portatil: (item: T, home: string) => unknown;
  /** Espelho → local; `undefined` = arquivo inválido (fica no espelho, não entra aqui). */
  local: (obj: unknown, id: string, home: string) => T | undefined;
};

function objeto(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const TIPO_AGENTE: Tipo<AgentDef> = {
  pasta: "agentes",
  arquivo: agentsPath,
  ler: agentes.readAll,
  gravar: agentes.writeAll,
  portatil: (a) => a,
  local: (v, id, home) => {
    const o = objeto(v);
    if (!o || o.id !== id || !AGENT_ID_RE.test(id) || typeof o.name !== "string") return undefined;
    const a = o as unknown as AgentDef;
    const contas = listProfiles(home);
    if (a.profileId && !contas.some((p) => p.id === a.profileId)) {
      const pronta = contas.find((p) => p.status === "ready");
      if (pronta) return { ...a, profileId: pronta.id };
    }
    return a;
  },
};

const TIPO_TIME: Tipo<TeamDef> = {
  pasta: "times",
  arquivo: teamsPath,
  ler: times.readAll,
  gravar: times.writeAll,
  portatil: (t) => t,
  local: (v, id) => {
    const o = objeto(v);
    if (!o || o.id !== id || !TEAM_ID_RE.test(id) || typeof o.name !== "string" || !Array.isArray(o.members)) return undefined;
    return o as unknown as TeamDef;
  },
};

type EscopoPortatil = { tipo: "global" } | { tipo: "projeto"; projectPath: string; projeto?: string };

const TIPO_HOOK: Tipo<RegraHook> = {
  pasta: "hooks",
  arquivo: hooksPath,
  ler: listarRegras,
  gravar: gravarRegras,
  portatil: (r, home) => {
    if (r.escopo.tipo !== "projeto") return r;
    const escopo: EscopoPortatil = { ...r.escopo, projeto: projectSlug(r.escopo.projectPath, home).slug };
    return { ...r, escopo };
  },
  local: (v, id, home) => {
    const o = objeto(v);
    const escopo = objeto(o?.escopo) as EscopoPortatil | undefined;
    if (!o || o.id !== id || typeof o.evento !== "string") return undefined;
    if (typeof o.agentId !== "string" && typeof o.teamId !== "string") return undefined;
    if (escopo?.tipo === "global") return { ...(o as unknown as RegraHook), escopo: { tipo: "global" } };
    if (escopo?.tipo !== "projeto" || typeof escopo.projectPath !== "string" || !escopo.projectPath.trim()) return undefined;
    // o mesmo projeto nesta máquina; sem ele, fica o caminho de lá — a regra só não casa com nada aqui
    const aqui = escopo.projeto ? projetosConhecidos(home).find((p) => projectSlug(p, home).slug === escopo.projeto) : undefined;
    return { ...(o as unknown as RegraHook), escopo: { tipo: "projeto", projectPath: aqui ?? escopo.projectPath } };
  },
};

type Contagem = Omit<ResultadoBiblioteca, "erros">;

/** Chaves do estado com este prefixo — base "cheia" de um tipo. */
function chavesDoTipo(estado: Estado, pasta: string): string[] {
  return Object.keys(estado.itens).filter((k) => k.startsWith(`${pasta}/`));
}

function conciliarJson<T extends { id: string; updatedAt?: string }>(
  home: string,
  tipo: Tipo<T>,
  raiz: string,
  estado: Estado,
  novo: Record<string, EstadoItem>,
  cont: Contagem,
  erros: string[],
): boolean {
  const dir = join(raiz, tipo.pasta);
  mkdirSync(dir, { recursive: true });
  // O `readAll` dos stores devolve [] pra arquivo corrompido — aqui isso viraria "apaguei tudo" e
  // sairia apagando nos outros PCs. Ilegível, não concilia este tipo (o erro sobe e a base fica).
  const store = tipo.arquivo(home);
  if (existsSync(store)) JSON.parse(readFileSync(store, "utf8"));
  const locais = new Map(tipo.ler(home).filter((i) => ID_ARQUIVO_RE.test(i.id)).map((i) => [i.id, i]));
  const espelho = new Map<string, { texto: string; md5: string; mtimeMs: number }>();
  for (const nome of readdirSync(dir)) {
    if (!nome.endsWith(".json")) continue;
    const id = nome.slice(0, -".json".length);
    if (!ID_ARQUIVO_RE.test(id)) continue;
    try {
      const texto = readFileSync(join(dir, nome), "utf8");
      espelho.set(id, { texto, md5: md5(texto), mtimeMs: statSync(join(dir, nome)).mtimeMs });
    } catch {
      /* sumiu no meio da leitura: a próxima rodada vê */
    }
  }
  const base = chavesDoTipo(estado, tipo.pasta);
  const ids = new Set([...locais.keys(), ...espelho.keys(), ...base.map((k) => k.slice(tipo.pasta.length + 1))]);

  let lista = [...locais.values()];
  let mudou = false;
  for (const id of [...ids].sort()) {
    const chave = `${tipo.pasta}/${id}`;
    const st = estado.itens[chave];
    const item = locais.get(id);
    const cru = item ? md5(JSON.stringify(item)) : undefined;
    const intacto = st !== undefined && cru === st.local;
    const texto = item && !intacto ? serializar(tipo.portatil(item, home)) : undefined;
    const hLocal = item ? (intacto ? st.base : md5(texto!)) : undefined;
    const e = espelho.get(id);
    let mtimeRemoto = e?.mtimeMs ?? 0;
    try {
      const u = e ? Date.parse(String((JSON.parse(e.texto) as { updatedAt?: unknown }).updatedAt ?? "")) : NaN;
      if (Number.isFinite(u)) mtimeRemoto = u;
    } catch {
      /* JSON inválido: `local` recusa mais abaixo */
    }
    const acao = decidir(st?.base, hLocal, e?.md5, {
      jsonl: false,
      mtimeLocal: Date.parse(item?.updatedAt ?? "") || 0,
      mtimeRemoto,
    });
    const arquivo = join(dir, `${id}.json`);
    try {
      if (acao === "nada") {
        if (item) novo[chave] = { base: hLocal!, local: cru! };
      } else if (acao === "subir") {
        const t = texto ?? serializar(tipo.portatil(item!, home));
        gravarAtomico(arquivo, t);
        novo[chave] = { base: md5(t), local: cru! };
        cont.exportados++;
      } else if (acao === "baixar") {
        const it = tipo.local(JSON.parse(e!.texto), id, home);
        if (!it) {
          erros.push(`${chave}: arquivo inválido no espelho`);
          if (st) novo[chave] = st;
          continue;
        }
        lista = [...lista.filter((x) => x.id !== id), it];
        novo[chave] = { base: e!.md5, local: md5(JSON.stringify(it)) };
        mudou = true;
        cont.importados++;
      } else if (acao === "apagar-local") {
        lista = lista.filter((x) => x.id !== id);
        mudou = true;
        cont.apagadosAqui++;
      } else if (acao === "apagar-remoto") {
        rmSync(arquivo, { force: true });
        cont.apagadosNoEspelho++;
      }
    } catch (err) {
      erros.push(`${chave}: ${(err as Error).message}`);
      if (st) novo[chave] = st;
    }
  }
  if (mudou) tipo.gravar(lista, home);
  return mudou;
}

/** MD5 do conteúdo de uma pasta inteira (caminho relativo + MD5 de cada arquivo) e o mtime mais novo. */
function hashPasta(dir: string): { md5: string; mtimeMs: number } {
  const linhas: string[] = [];
  let mtimeMs = 0;
  const andar = (d: string, prefixo: string): void => {
    for (const nome of readdirSync(d).sort()) {
      if (nome.endsWith(".tmp")) continue;
      const abs = join(d, nome);
      const st = statSync(abs);
      const rel = prefixo ? `${prefixo}/${nome}` : nome;
      if (st.isDirectory()) andar(abs, rel);
      else if (st.isFile()) {
        linhas.push(`${rel}\0${md5(readFileSync(abs))}`);
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      }
    }
  };
  andar(dir, "");
  return { md5: md5(linhas.join("\n")), mtimeMs };
}

function pastasDe(dir: string): Map<string, { md5: string; mtimeMs: number }> {
  const out = new Map<string, { md5: string; mtimeMs: number }>();
  if (!existsSync(dir)) return out;
  for (const nome of readdirSync(dir)) {
    if (!ID_ARQUIVO_RE.test(nome)) continue;
    const abs = join(dir, nome);
    try {
      if (statSync(abs).isDirectory()) out.set(nome, hashPasta(abs));
    } catch {
      /* sumiu no meio da leitura */
    }
  }
  return out;
}

function copiarPasta(de: string, para: string): void {
  rmSync(para, { recursive: true, force: true });
  cpSync(de, para, { recursive: true });
}

function conciliarSkills(home: string, raiz: string, estado: Estado, novo: Record<string, EstadoItem>, cont: Contagem, erros: string[]): void {
  const pasta = "skills";
  const dirLocal = globalSkillsDir(home);
  const dirEspelho = join(raiz, pasta);
  mkdirSync(dirLocal, { recursive: true });
  mkdirSync(dirEspelho, { recursive: true });
  const locais = pastasDe(dirLocal);
  const espelho = pastasDe(dirEspelho);
  const base = chavesDoTipo(estado, pasta);
  const nomes = new Set([...locais.keys(), ...espelho.keys(), ...base.map((k) => k.slice(pasta.length + 1))]);
  for (const nome of [...nomes].sort()) {
    const chave = `${pasta}/${nome}`;
    const st = estado.itens[chave];
    const l = locais.get(nome);
    const e = espelho.get(nome);
    const acao = decidir(st?.base, l?.md5, e?.md5, { jsonl: false, mtimeLocal: l?.mtimeMs ?? 0, mtimeRemoto: e?.mtimeMs ?? 0 });
    try {
      if (acao === "nada") {
        if (l) novo[chave] = { base: l.md5, local: l.md5 };
      } else if (acao === "subir") {
        copiarPasta(join(dirLocal, nome), join(dirEspelho, nome));
        novo[chave] = { base: l!.md5, local: l!.md5 };
        cont.exportados++;
      } else if (acao === "baixar") {
        copiarPasta(join(dirEspelho, nome), join(dirLocal, nome));
        novo[chave] = { base: e!.md5, local: e!.md5 };
        cont.importados++;
      } else if (acao === "apagar-local") {
        rmSync(join(dirLocal, nome), { recursive: true, force: true });
        cont.apagadosAqui++;
      } else if (acao === "apagar-remoto") {
        rmSync(join(dirEspelho, nome), { recursive: true, force: true });
        cont.apagadosNoEspelho++;
      }
    } catch (err) {
      erros.push(`${chave}: ${(err as Error).message}`);
      if (st) novo[chave] = st;
    }
  }
}

/**
 * Uma conciliação local ↔ espelho. Síncrona de ponta a ponta de propósito: sem `await` no meio,
 * nenhuma rota HTTP grava `agents.json` entre a leitura e a escrita daqui. Nunca lança.
 */
export function sincronizarBiblioteca(home: string): ResultadoBiblioteca {
  const res: ResultadoBiblioteca = { exportados: 0, importados: 0, apagadosAqui: 0, apagadosNoEspelho: 0, erros: [] };
  try {
    const raiz = join(projetosRoot(home), PASTA_BIBLIOTECA);
    const estado = lerEstado(home, raiz);
    // Espelho sumido (pasta do Drive desmontada, `_biblioteca` apagada à mão) não é "apagaram tudo
    // lá": recomeça sem base, e sem base a conciliação só junta os dois lados, nunca apaga.
    if (!existsSync(raiz)) estado.itens = {};
    mkdirSync(raiz, { recursive: true });
    const novo: Record<string, EstadoItem> = {};
    const passo = <T extends { id: string; updatedAt?: string }>(tipo: Tipo<T>): boolean => {
      try {
        return conciliarJson(home, tipo, raiz, estado, novo, res, res.erros);
      } catch (err) {
        res.erros.push(`${tipo.pasta}: ${(err as Error).message}`);
        for (const k of chavesDoTipo(estado, tipo.pasta)) novo[k] ??= estado.itens[k];
        return false;
      }
    };
    // agentes antes de times, times antes de hooks: quem é referenciado chega primeiro
    passo(TIPO_AGENTE);
    passo(TIPO_TIME);
    // hook novo/apagado vindo de outro PC precisa do script no `.git/hooks/` daqui
    if (passo(TIPO_HOOK)) {
      try {
        sincronizarHooksGlobal(home);
      } catch (err) {
        res.erros.push(`hooks do git: ${(err as Error).message}`);
      }
    }
    try {
      conciliarSkills(home, raiz, estado, novo, res, res.erros);
    } catch (err) {
      res.erros.push(`skills: ${(err as Error).message}`);
      for (const k of chavesDoTipo(estado, "skills")) novo[k] ??= estado.itens[k];
    }
    gravarAtomico(bibliotecaSyncStatePath(home), JSON.stringify({ root: raiz, itens: novo }));
  } catch (err) {
    res.erros.push((err as Error).message);
  }
  return res;
}
