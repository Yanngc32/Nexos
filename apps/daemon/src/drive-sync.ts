import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { driveSyncStatePath } from "./home.ts";
import { googleAccount, readGoogleStore, updateGoogleStore } from "./google-auth.ts";
import {
  acharRaizNexo,
  createFile,
  createFolder,
  downloadFile,
  getFolder,
  listChildren,
  marcarRaizNexo,
  MIME_PASTA,
  trashFile,
  updateFile,
} from "./google-drive.ts";
import { PASTA_BIBLIOTECA, sincronizarBiblioteca } from "./biblioteca.ts";
import { projetosRoot, trazerPastaManualProDrive } from "./projeto-dir.ts";
import { decidir } from "./sync-decisao.ts";
import { importarConversas, mesclarJsonl } from "./threads.ts";

/**
 * Sync de DUAS MÃOS entre `projetosRoot` (memória, tarefas, repo-map, conversas de cada projeto)
 * e uma pasta do Drive escolhida pela pessoa, pela API — sem Drive Desktop. A estrutura é a mesma
 * dos dois lados: `<pasta do Drive>/<slug-do-projeto>/{memoria,tarefas,repo-map,conversas}/…`.
 *
 * Como saber quem mudou: o estado local (`drive-sync.json`, por máquina) guarda o MD5 de cada
 * arquivo na última vez em que os dois lados estavam iguais. Comparando local e remoto com essa
 * base, dá pra separar "só eu mudei", "só o outro mudou", "apagaram" e "os dois mudaram".
 * Conflito: conversa (`.jsonl`, só cresce) é mesclada linha a linha; o resto vale o mais recente.
 *
 * `meta.json` de cada projeto NÃO sincroniza: ele guarda o caminho da pasta NESTA máquina.
 * `_biblioteca/` (agentes, times, hooks, skills) viaja junto, conciliada antes e depois de cada
 * rodada por `sincronizarBiblioteca` (biblioteca.ts).
 */

export { decidir, type Acao } from "./sync-decisao.ts";

type BaseEntry = { md5: string; size: number; mtimeMs: number };
type Estado = { folderId: string; root: string; files: Record<string, BaseEntry> };

export type ResultadoSync = {
  subiu: number;
  baixou: number;
  apagouLocal: number;
  apagouRemoto: number;
  mesclou: number;
  erros: string[];
  iniciouEm: string;
  duracaoMs: number;
};

export type StatusDrive = {
  connected: boolean;
  folder?: { id: string; name: string };
  running: boolean;
  last?: ResultadoSync;
};

const md5 = (buf: Buffer | string): string => createHash("md5").update(buf).digest("hex");

function lerEstado(home: string): Estado | undefined {
  try {
    const raw = JSON.parse(readFileSync(driveSyncStatePath(home), "utf8")) as Partial<Estado>;
    if (typeof raw.folderId !== "string" || typeof raw.root !== "string" || !raw.files || typeof raw.files !== "object") return undefined;
    return { folderId: raw.folderId, root: raw.root, files: raw.files };
  } catch {
    return undefined;
  }
}

function gravarEstado(home: string, e: Estado): void {
  const path = driveSyncStatePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(e), "utf8");
  renameSync(tmp, path);
}

/** Nome de arquivo/pasta vindo do Drive: recusa o que escaparia da raiz ao virar caminho local. */
function nomeSeguro(nome: string): boolean {
  return nome !== "" && nome !== "." && nome !== ".." && !/[\\/:*?"<>|\0]/.test(nome) && !nome.startsWith(".");
}

type Local = { md5: string; size: number; mtimeMs: number };

function varrerLocal(root: string, base: Record<string, BaseEntry>): Map<string, Local> {
  const out = new Map<string, Local>();
  const andar = (dir: string, prefixo: string): void => {
    let nomes: string[];
    try {
      nomes = readdirSync(dir);
    } catch {
      return;
    }
    for (const nome of nomes) {
      if (nome.startsWith(".") || nome.endsWith(".tmp")) continue;
      const abs = join(dir, nome);
      const rel = prefixo ? `${prefixo}/${nome}` : nome;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // raiz de `projetosRoot` pode ter outras pastas além das nossas (cache de outra
        // ferramenta, layout antigo, o que for) — só desce em pasta de projeto de verdade
        // (tem `meta.json`), pra não varrer/subir lixo que não é nosso.
        // `_biblioteca` é o espelho de agentes/times/hooks/skills (biblioteca.ts), não um projeto.
        if (prefixo === "" && nome !== PASTA_BIBLIOTECA && !existsSync(join(abs, "meta.json"))) continue;
        andar(abs, rel);
      } else if (st.isFile()) {
        if (rel.split("/").length === 2 && nome === "meta.json") continue;
        const anterior = base[rel];
        // mesmo tamanho e mtime da última sync: não relê o arquivo (repo-map pode ser grande)
        const hash = anterior && anterior.size === st.size && anterior.mtimeMs === st.mtimeMs ? anterior.md5 : md5(readFileSync(abs));
        out.set(rel, { md5: hash, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  andar(root, "");
  return out;
}

type Remoto = { id: string; md5: string; mtimeMs: number };

async function varrerRemoto(home: string, rootId: string): Promise<{ arquivos: Map<string, Remoto>; pastas: Map<string, string> }> {
  const arquivos = new Map<string, Remoto>();
  const pastas = new Map<string, string>([["", rootId]]);
  const fila: { id: string; rel: string }[] = [{ id: rootId, rel: "" }];
  while (fila.length) {
    const { id, rel } = fila.shift()!;
    for (const item of await listChildren(home, id)) {
      if (!nomeSeguro(item.name)) continue;
      const caminho = rel ? `${rel}/${item.name}` : item.name;
      if (item.mimeType === MIME_PASTA) {
        if (pastas.has(caminho)) continue;
        pastas.set(caminho, item.id);
        fila.push({ id: item.id, rel: caminho });
      } else if (item.md5Checksum && !arquivos.has(caminho)) {
        // sem md5 = Google Docs/Sheets/atalho: não é arquivo nosso
        arquivos.set(caminho, { id: item.id, md5: item.md5Checksum, mtimeMs: Date.parse(item.modifiedTime ?? "") || 0 });
      }
    }
  }
  return { arquivos, pastas };
}

let emAndamento: Promise<ResultadoSync> | undefined;
let ultimo: ResultadoSync | undefined;

export function driveStatus(home: string): StatusDrive {
  const acc = googleAccount(home);
  return {
    connected: acc.connected,
    ...(acc.folder ? { folder: acc.folder } : {}),
    running: emAndamento !== undefined,
    ...(ultimo ? { last: ultimo } : {}),
  };
}

export const NOME_PASTA_NEXO = "Nexos";

/**
 * Pasta de destino quando esta máquina ainda não tem nenhuma: a que outro PC da mesma conta já
 * usa (marcada, ver `marcarRaizNexo`), senão cria "Nexos" no Meu Drive. Grava o id pra próxima rodada.
 */
export async function garantirPastaNexo(home: string): Promise<{ id: string; name: string }> {
  const existente = await acharRaizNexo(home);
  const pasta = existente ?? (await criarPastaNexo(home));
  updateGoogleStore(home, { folderId: pasta.id, folderName: pasta.name });
  return { id: pasta.id, name: pasta.name };
}

export async function criarPastaNexo(home: string): Promise<{ id: string; name: string }> {
  const pasta = await createFolder(home, "root", NOME_PASTA_NEXO);
  await marcarRaizNexo(home, pasta.id);
  return pasta;
}

/** Usa `id` como pasta dos projetos (escolhida no seletor do Google) e avisa os outros PCs. */
export async function usarPastaDrive(home: string, id: string): Promise<{ id: string; name: string }> {
  // a raiz do Meu Drive não aceita appProperties customizado (marcarRaizNexo falharia) — e sincronizar
  // o Drive inteiro da pessoa seria um escopo bem diferente do pretendido aqui.
  if (id === "root") {
    throw Object.assign(new Error("não dá pra usar a raiz do Meu Drive — crie ou escolha uma subpasta"), { status: 400 });
  }
  const pasta = await getFolder(home, id);
  await marcarRaizNexo(home, pasta.id);
  updateGoogleStore(home, { folderId: pasta.id, folderName: pasta.name });
  return { id: pasta.id, name: pasta.name };
}

export function removerPastaDrive(home: string): void {
  updateGoogleStore(home, { folderId: undefined, folderName: undefined });
}

/** Uma rodada de sync (single-flight: chamada durante outra devolve a mesma promessa). */
export function sincronizarDrive(home: string): Promise<ResultadoSync> {
  if (emAndamento) return emAndamento;
  emAndamento = rodar(home).finally(() => {
    emAndamento = undefined;
  });
  return emAndamento;
}

async function rodar(home: string): Promise<ResultadoSync> {
  const inicio = Date.now();
  const res: ResultadoSync = { subiu: 0, baixou: 0, apagouLocal: 0, apagouRemoto: 0, mesclou: 0, erros: [], iniciouEm: new Date(inicio).toISOString(), duracaoMs: 0 };
  try {
    const store = readGoogleStore(home);
    if (!store.refreshToken) throw Object.assign(new Error("conta Google não conectada"), { status: 400 });
    const folderId = store.folderId ?? (await garantirPastaNexo(home)).id;
    const rootLocal = projetosRoot(home);
    mkdirSync(rootLocal, { recursive: true });
    // o que ficou na pasta manual antiga (gravado fora do sync pela API) vem pra cá e sobe nesta rodada
    trazerPastaManualProDrive(home, rootLocal);
    // antes: o que mudou aqui (agente, time, hook, skill) já vai no espelho que sobe nesta rodada
    anotarBiblioteca(res, sincronizarBiblioteca(home));

    // outra pasta do Drive ou outra raiz local: a base antiga não vale mais (recomeça do zero, sem apagar nada)
    let estado = lerEstado(home);
    if (!estado || estado.folderId !== folderId || estado.root !== rootLocal) {
      estado = { folderId, root: rootLocal, files: {} };
    }

    const local = varrerLocal(rootLocal, estado.files);
    let varredura;
    try {
      varredura = await varrerRemoto(home, folderId);
    } catch (e) {
      // pasta apagada (ou tirada do alcance) no Drive: esquece, a próxima rodada acha/cria outra
      if ((e as { status?: number }).status === 404) {
        removerPastaDrive(home);
        throw new Error("a pasta do Drive não existe mais — o Nexos vai criar outra na próxima sincronização");
      }
      throw e;
    }
    const { arquivos: remoto, pastas } = varredura;

    // Um lado vazio com base cheia é quase sempre acidente (pasta apagada/movida), não intenção:
    // trata como "nunca sincronizado" em vez de propagar a exclusão em massa pro outro lado.
    const temBase = Object.keys(estado.files).length > 0;
    const ignorarBase = temBase && (local.size === 0 || remoto.size === 0);

    const garantirPasta = async (rel: string): Promise<string> => {
      const existente = pastas.get(rel);
      if (existente) return existente;
      const i = rel.lastIndexOf("/");
      const paiId = await garantirPasta(i === -1 ? "" : rel.slice(0, i));
      const nova = await createFolder(home, paiId, i === -1 ? rel : rel.slice(i + 1));
      pastas.set(rel, nova.id);
      return nova.id;
    };

    const caminhos = new Set([...local.keys(), ...remoto.keys(), ...Object.keys(estado.files)]);
    const novaBase: Record<string, BaseEntry> = {};
    const gravar = (rel: string, buf: Buffer, st: { size: number; mtimeMs: number }): void => {
      novaBase[rel] = { md5: md5(buf), size: st.size, mtimeMs: st.mtimeMs };
    };
    const manter = (rel: string): void => {
      const b = estado.files[rel];
      if (b) novaBase[rel] = b;
    };

    for (const rel of [...caminhos].sort()) {
      const l = local.get(rel);
      const r = remoto.get(rel);
      const b = ignorarBase ? undefined : estado.files[rel];
      const abs = join(rootLocal, ...rel.split("/"));
      const acao = decidir(b?.md5, l?.md5, r?.md5, { jsonl: rel.endsWith(".jsonl"), mtimeLocal: l?.mtimeMs ?? 0, mtimeRemoto: r?.mtimeMs ?? 0 });
      try {
        if (acao === "nada") {
          if (l) novaBase[rel] = { md5: l.md5, size: l.size, mtimeMs: l.mtimeMs };
        } else if (acao === "subir") {
          const st = statSync(abs); // antes de ler: se mudar no meio, o próximo ciclo enxerga
          const buf = readFileSync(abs);
          if (r) await updateFile(home, r.id, buf);
          else {
            const i = rel.lastIndexOf("/");
            await createFile(home, await garantirPasta(i === -1 ? "" : rel.slice(0, i)), rel.slice(i + 1), buf);
          }
          gravar(rel, buf, st);
          res.subiu++;
        } else if (acao === "baixar") {
          const buf = await downloadFile(home, r!.id);
          // mudou localmente durante o download: não pisa, o próximo ciclo resolve como conflito
          if (l && existsSync(abs) && md5(readFileSync(abs)) !== l.md5) {
            manter(rel);
            continue;
          }
          escreverAtomico(abs, buf);
          gravar(rel, buf, statSync(abs));
          res.baixou++;
        } else if (acao === "mesclar") {
          const doRemoto = (await downloadFile(home, r!.id)).toString("utf8");
          // sem `await` entre ler o local e gravar: nenhum append do daemon cabe no meio
          const doLocal = existsSync(abs) ? readFileSync(abs, "utf8") : "";
          const junto = mesclarJsonl(doLocal, doRemoto);
          if (junto !== doLocal) escreverAtomico(abs, Buffer.from(junto, "utf8"));
          const buf = Buffer.from(junto, "utf8");
          if (md5(buf) !== r!.md5) await updateFile(home, r!.id, buf);
          gravar(rel, buf, statSync(abs));
          res.mesclou++;
        } else if (acao === "apagar-local") {
          if (l && existsSync(abs) && md5(readFileSync(abs)) !== l.md5) {
            manter(rel);
            continue;
          }
          rmSync(abs, { force: true });
          res.apagouLocal++;
        } else if (acao === "apagar-remoto") {
          await trashFile(home, r!.id);
          res.apagouRemoto++;
        }
      } catch (e) {
        res.erros.push(`${rel}: ${(e as Error).message}`);
        manter(rel);
      }
    }

    estado.files = novaBase;
    gravarEstado(home, estado);
    try {
      importarConversas(home);
    } catch (e) {
      res.erros.push(`importar conversas: ${(e as Error).message}`);
    }
    // depois: o que desceu do Drive pro espelho vira agente/time/hook/skill desta máquina
    anotarBiblioteca(res, sincronizarBiblioteca(home));
  } catch (e) {
    res.erros.push((e as Error).message);
  }
  res.duracaoMs = Date.now() - inicio;
  ultimo = res;
  return res;
}

function anotarBiblioteca(res: ResultadoSync, b: { erros: string[] }): void {
  for (const e of b.erros) res.erros.push(`biblioteca: ${e}`);
}

function escreverAtomico(abs: string, buf: Buffer): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, abs);
}
