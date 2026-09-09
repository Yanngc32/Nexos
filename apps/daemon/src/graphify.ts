import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { projectKey } from "./home.ts";
import type { Conjunto, Ferramenta } from "./mcp.ts";

/**
 * Ponte entre o turno e o grafo de conhecimento do projeto (skill `graphify`,
 * instalada à parte — ver docs/superpowers/specs/2026-09-09-memoria-projeto-design.md).
 *
 * O daemon não CONSTRÓI o grafo (isso é `graphify hook install` + o agente
 * memória rodando `graphify` depois de cada commit, ou a pessoa rodando
 * `/graphify` à mão) — só empresta a ferramenta MCP que já existe
 * (`/v1/mcp`) pra consultar o que já foi construído, em vez de o modelo sair
 * grepando o repositório inteiro de novo a cada run/agente.
 */

const execFileAsync = promisify(execFile);

/** Nomes como o CLI enxerga — entram no `--allowed-tools` do perfil `claude`. */
export const MCP_TOOLS_GRAPHIFY = ["mcp__nexo__nexo_grafo_perguntar", "mcp__nexo__nexo_grafo_explicar"];

/** Teto de tempo pro `graphify query`/`explain`: consulta é leitura de grafo já pronto, não deveria demorar. */
const TIMEOUT_MS = 30_000;

/** Só existe ferramenta quando o grafo já foi construído — nada a consultar sem isso. */
export function graphifyDisponivel(projectPath: string): boolean {
  return existsSync(join(projectPath, "graphify-out", "graph.json"));
}

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

/**
 * Raiz de todas as pastas compartilhadas de grafo (uma por projeto, por hash — mesmo esquema de
 * `memoria.ts`). Separado de `memoriaDir` de propósito: grafo é maior e regenerável, memória é
 * pequena e curada; o usuário pode querer sincronizar cada um numa pasta diferente.
 */
function graphRoot(home: string): string {
  const cfg = loadConfig(home);
  return cfg.graphDir || join(home, "grafo");
}

function graphHash(projectPath: string): string {
  return createHash("sha1").update(projectKey(projectPath)).digest("hex");
}

/** Pasta compartilhada de UM projeto — pode nem existir ainda (só é criada quando algo é escrito nela). */
function projectGraphDir(projectPath: string, home: string): string {
  return join(graphRoot(home), graphHash(projectPath));
}

function localGraphOutDir(projectPath: string): string {
  return join(projectPath, "graphify-out");
}

function mtimeOrZero(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Sincroniza `<projeto>/graphify-out/` (onde o `graphify` de verdade lê/escreve — CLI roda com
 * `cwd` no projeto, ver `rodarGraphify`) com a pasta compartilhada (`graphDir`). O mais recente
 * dos dois vence, cópia de arquivo por mtime — sem merge, porque é um artefato regenerável do
 * código, não um documento colaborativo (mesma lógica de "não é segredo grave" do design de
 * memória de projeto).
 *
 * Chamada ao abrir o projeto (`POST /v1/threads`, http.ts) — "ao abrir, busca na pasta
 * compartilhada" — e antes de checar/servir status do grafo. Sem `graphDir` configurado, no-op:
 * ninguém pediu pasta compartilhada nenhuma.
 */
export function sincronizarGrafoCompartilhado(projectPath: string, home: string): void {
  const cfg = loadConfig(home);
  if (!cfg.graphDir) return;
  const local = join(localGraphOutDir(projectPath), "graph.json");
  const compartilhado = join(projectGraphDir(projectPath, home), "graph.json");
  const tLocal = mtimeOrZero(local);
  const tCompartilhado = mtimeOrZero(compartilhado);
  if (!tLocal && !tCompartilhado) return;
  try {
    if (tCompartilhado > tLocal) {
      mkdirSync(localGraphOutDir(projectPath), { recursive: true });
      cpSync(projectGraphDir(projectPath, home), localGraphOutDir(projectPath), { recursive: true, force: true });
    } else if (tLocal > tCompartilhado) {
      mkdirSync(projectGraphDir(projectPath, home), { recursive: true });
      cpSync(localGraphOutDir(projectPath), projectGraphDir(projectPath, home), { recursive: true, force: true });
    }
  } catch (e) {
    console.error("sincronizar grafo compartilhado:", (e as Error).message || e);
  }
}

/**
 * Importa um grafo de fora (pasta escolhida à mão pelo usuário, via modal — ver
 * `POST /v1/graph/importar`, http.ts) pra dentro do projeto: cobre o caso de
 * `sincronizarGrafoCompartilhado` não achar nada em lugar nenhum. Aceita tanto a pasta que já É
 * um `graphify-out/` quanto uma pasta que CONTÉM um `graphify-out/`.
 */
export function importarGrafoManual(projectPath: string, origem: string, home: string): void {
  const candidato = existsSync(join(origem, "graph.json"))
    ? origem
    : existsSync(join(origem, "graphify-out", "graph.json"))
      ? join(origem, "graphify-out")
      : null;
  if (!candidato) throw badRequest("a pasta escolhida não tem graph.json (nem em graphify-out/)");
  mkdirSync(localGraphOutDir(projectPath), { recursive: true });
  cpSync(candidato, localGraphOutDir(projectPath), { recursive: true, force: true });
  // Compartilha de volta na hora, se a pasta compartilhada estiver configurada — sem isso o
  // próximo projeto/máquina não veria o que acabou de ser importado à mão.
  sincronizarGrafoCompartilhado(projectPath, home);
}

/** Status pra UI: se o grafo existe, se há pasta compartilhada configurada, e onde ele está. */
export function statusDoGrafo(
  projectPath: string,
  home: string,
): { disponivel: boolean; compartilhado: boolean; caminho: string; atualizadoEm?: string } {
  sincronizarGrafoCompartilhado(projectPath, home);
  const caminho = join(localGraphOutDir(projectPath), "graph.json");
  return {
    disponivel: graphifyDisponivel(projectPath),
    compartilhado: Boolean(loadConfig(home).graphDir),
    caminho,
    atualizadoEm: mtimeOrZero(caminho) ? new Date(mtimeOrZero(caminho)).toISOString() : undefined,
  };
}

/** Teto pra `update`/`tree`: são comandos locais (AST, sem LLM), mas repositório grande demora. */
const BUILD_TIMEOUT_MS = 300_000;

/**
 * Reconstrói o grafo por AST puro (`graphify update` — "no LLM needed", por isso é seguro num
 * botão da UI: não gasta quota de conta nenhuma, ao contrário de `graphify extract`, que é o que
 * o agente de memória decide rodar por conta própria).
 */
export async function atualizarGrafo(projectPath: string, home: string): Promise<{ ok: boolean; texto: string }> {
  try {
    const { stdout } = await execFileAsync("graphify", ["update", projectPath], {
      timeout: BUILD_TIMEOUT_MS,
      shell: process.platform === "win32",
    });
    sincronizarGrafoCompartilhado(projectPath, home);
    return { ok: true, texto: stdout.trim() || "grafo atualizado" };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return { ok: false, texto: (err.stderr || err.stdout || err.message || "falhou").trim() };
  }
}

/** Gera a árvore D3 navegável (`graphify tree`) — é o que a tela "Grafo" abre no navegador. */
/**
 * O grafo semântico de verdade — não `graphify tree` (que só desenha a árvore de PASTAS com
 * contagem por arquivo, sem comunidade nem relação nenhuma). `graph.html` já é gerado pelo
 * próprio `graphify` durante `extract`/`update` (clustering roda por padrão, sem `--no-cluster`),
 * então não precisa rodar CLI nenhum aqui — só apontar pro arquivo que já existe.
 */
export function caminhoDaArvoreDoGrafo(projectPath: string): { ok: boolean; arquivo: string; texto?: string } {
  const arquivo = join(localGraphOutDir(projectPath), "graph.html");
  if (existsSync(arquivo)) return { ok: true, arquivo };
  return {
    ok: false,
    arquivo: "",
    texto: "graph.html ainda não existe — construa o grafo primeiro (graphify extract, ou espera o hook rodar)",
  };
}

async function rodar(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: timeoutMs, shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Garante que o CLI `graphify` existe na máquina — best-effort, NUNCA lança. Chamada em dois
 * pontos: no boot do daemon (`cmdUp` em cli.ts, uma vez, em paralelo ao resto da subida, sem
 * esperar por ela) e quando uma regra de hook nova (`post-commit`/`post-push`) é criada pela API
 * (ver `saveRegra`, hooks.ts) — é o momento em que alguém provavelmente vai querer o agente
 * memória rodando `graphify` depois do commit. Falha de instalação (sem `uv` nem `pip` no PATH,
 * rede fora) só significa que as ferramentas do grafo ficam ausentes — nunca impede o daemon de
 * subir nem a regra de ser salva, então o log é a única forma de a pessoa saber que algo não pegou.
 */
export async function ensureGraphifyInstalled(): Promise<void> {
  if (await rodar("graphify", ["--version"], TIMEOUT_MS)) return;
  const INSTALL_TIMEOUT_MS = 120_000;
  if (await rodar("uv", ["tool", "install", "graphifyy"], INSTALL_TIMEOUT_MS)) {
    console.log("graphify: instalado via uv");
    return;
  }
  if (await rodar("pip", ["install", "graphifyy"], INSTALL_TIMEOUT_MS)) {
    console.log("graphify: instalado via pip");
    return;
  }
  console.log("graphify: não consegui instalar (uv e pip indisponíveis ou falharam) — instale à mão pra ligar o grafo");
}

async function rodarGraphify(projectPath: string, args: string[]): Promise<string> {
  try {
    // Mesma razão de `spawn-bin.ts`: `graphify` (instalado via pip/uv/pipx) pode
    // ser um shim que o Windows só resolve pela extensão em PATHEXT (.cmd/.bat)
    // — sem `shell`, `execFile` não tenta essas extensões e falha com ENOENT.
    const { stdout } = await execFileAsync("graphify", args, {
      cwd: projectPath,
      timeout: TIMEOUT_MS,
      shell: process.platform === "win32",
    });
    return stdout.trim() || "(sem resultado)";
  } catch (e) {
    // CLI ausente, timeout, ou erro do próprio graphify — tudo vira texto pro
    // modelo LER e decidir (ex.: cair pra grep se o grafo estiver quebrado),
    // não um erro de protocolo que mata o turno.
    const err = e as Error & { stdout?: string; stderr?: string };
    return (err.stderr || err.stdout || err.message || "graphify falhou").trim();
  }
}

/**
 * Ferramentas do grafo pra ESTE projeto. Vazio (não `undefined`) quando o
 * grafo ainda não existe — `Conjunto` já é reavaliado a cada `tools/list`
 * (ver mcp.ts), então some/aparece sozinho conforme o hook constrói o grafo.
 */
export function ferramentasDeGraphify(projectPath: string): Conjunto {
  return () => {
    if (!graphifyDisponivel(projectPath)) return [];
    const ferramentas: Ferramenta[] = [
      {
        name: "nexo_grafo_perguntar",
        description:
          "Busca livre no grafo de conhecimento deste projeto (graphify), a partir de uma pergunta em " +
          "linguagem natural. Prefira isto a sair lendo/grepando arquivo à toa. CUIDADO: se a pergunta " +
          "não citar um nome de símbolo/arquivo real, a busca pode partir de um nó sem relação com o " +
          "assunto e voltar lixo — confira se o resultado faz sentido antes de confiar nele. Se você já " +
          "suspeita do nome de uma classe/função/arquivo, use `nexo_grafo_explicar` em vez desta: é " +
          "preciso, não depende de a busca livre achar o nó certo.",
        inputSchema: {
          type: "object",
          properties: { pergunta: { type: "string", description: "a pergunta, em linguagem natural" } },
          required: ["pergunta"],
          additionalProperties: false,
        },
        executar: async (args) => {
          const pergunta = typeof args.pergunta === "string" ? args.pergunta.trim() : "";
          if (!pergunta) return { ok: false, texto: 'faltou "pergunta"' };
          return { ok: true, texto: await rodarGraphify(projectPath, ["query", pergunta]) };
        },
      },
      {
        name: "nexo_grafo_explicar",
        description: "Explicação em linguagem simples de UM nó do grafo (uma classe, função, arquivo, conceito).",
        inputSchema: {
          type: "object",
          properties: { no: { type: "string", description: "nome do nó — ex.: uma classe, arquivo ou função" } },
          required: ["no"],
          additionalProperties: false,
        },
        executar: async (args) => {
          const no = typeof args.no === "string" ? args.no.trim() : "";
          if (!no) return { ok: false, texto: 'faltou "no"' };
          return { ok: true, texto: await rodarGraphify(projectPath, ["explain", no]) };
        },
      },
    ];
    return ferramentas;
  };
}
