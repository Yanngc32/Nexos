import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Git: um jeito só de chamar, pro daemon inteiro.
 *
 * Antes disto cada módulo tinha o seu — `spawn` aqui em `worktree.ts`,
 * `execFileSync` em `tarefas-git.ts`, `projeto-dir.ts` e `repo-map-indice.ts`,
 * cada um com timeout, encoding e tratamento de erro diferentes. Enquanto era
 * só leitura pontual dava pra viver com isso; a partir do momento em que o
 * Nexo passa a CLONAR, TROCAR DE BRANCH e ATUALIZAR repositório da pessoa, a
 * divergência vira risco: é aqui que mora a decisão de nunca usar `--force`, de
 * sempre ter timeout, e de recusar operação que escreve com a árvore suja.
 *
 * Os três `execFileSync` legados seguem onde estão de propósito: são síncronos
 * por dependência de quem chama (`projectSlug` roda em caminho quente e
 * síncrono), e convertê-los é refatoração de outro escopo, sem ganho hoje.
 */

export type ResultadoGit = { ok: boolean; saida: string };

/** Teto de parede por comando. Git que não volta é defeito — melhor dizer isso que pendurar a requisição. */
const TIMEOUT_MS = 30_000;

/**
 * Roda git e devolve saída (stdout+stderr juntos, que é o que serve pra
 * mensagem de erro). NUNCA lança: quem chama decide o que fazer com `ok`.
 */
export function git(args: string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<ResultadoGit> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let saida = "";
    let terminou = false;
    const fim = (r: ResultadoGit) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(relogio);
      resolvePromise(r);
    };
    const relogio = setTimeout(() => {
      child.kill();
      fim({ ok: false, saida: `git ${args[0]} passou de ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (saida += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (saida += b.toString("utf8")));
    child.on("error", (e) => fim({ ok: false, saida: e.message }));
    child.on("close", (code) => fim({ ok: code === 0, saida: saida.trim() }));
  });
}

/** Erro que o cliente consegue corrigir — vira 4xx na rota, não 500. */
function pedidoRuim(msg: string): Error & { status: number } {
  return Object.assign(new Error(msg), { status: 400 });
}

export type RepoGithub = { owner: string; repo: string };

const NOME_GITHUB = /^[A-Za-z0-9._-]+$/;

/**
 * `owner`/`repo` de um remote **do github.com**, nos formatos que o git produz:
 * `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`.
 *
 * Valida o host de propósito. `projeto-dir.ts` tem um parser parecido, mas o
 * dele serve pra nomear pasta e aceita qualquer remote (GitLab inclusive);
 * aqui o host é o que decide se a URL que vamos montar existe — um remote do
 * GitLab virando link de github.com é erro mudo, levando a pessoa pra um
 * repositório de outra pessoa ou pra um 404.
 *
 * GitHub Enterprise (host próprio) fica de fora: não dá pra adivinhar o host,
 * e chutar github.com seria pior que dizer que não sei.
 */
export function githubDoRemote(url: string): RepoGithub | undefined {
  const bruto = (url || "").trim();
  if (!bruto) return undefined;
  // forma scp do git (`git@host:caminho`), que não é URL e o `new URL` não parseia
  const scp = /^[\w.+-]+@([\w.-]+):(.+)$/.exec(bruto);
  let host: string;
  let caminho: string;
  if (scp) {
    [, host, caminho] = scp;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(bruto);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    caminho = parsed.pathname;
  }
  if (host.toLowerCase() !== "github.com") return undefined;
  const partes = caminho
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (partes.length !== 2) return undefined;
  const [owner, repo] = partes;
  if (!NOME_GITHUB.test(owner) || !NOME_GITHUB.test(repo)) return undefined;
  return { owner, repo };
}

/**
 * Cada segmento escapado, as barras preservadas: branch tem barra o tempo todo
 * (`feat/x`) e o GitHub espera ela literal no caminho, mas `#`, `?` e espaço
 * num nome de branch quebrariam a URL se fossem crus.
 */
function caminhoDeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

export type AlvoDePr = RepoGithub & { branch: string; url: string };

/**
 * Link que abre o formulário de PR do GitHub já apontado pra branch atual.
 *
 * É a versão sem login: o `compare` do GitHub monta o PR com base no branch e
 * deixa título e corpo pra pessoa, e o navegador dela já está logado. Abrir o
 * PR pela API (título/base escolhidos aqui dentro) é o passo seguinte, e é ele
 * que vai precisar de token.
 *
 * Cada recusa aqui existe porque a alternativa é uma página do GitHub dizendo
 * algo que não ajuda ("There isn't anything to compare") sem a pessoa saber por
 * quê — e o caso comum, branch que ainda não foi pro remote, é exatamente esse.
 */
export async function alvoDePullRequest(projectPath: string): Promise<AlvoDePr> {
  const dir = resolve(projectPath || "");
  if (!projectPath || !existsSync(dir)) throw pedidoRuim("a pasta do projeto não existe");

  const dentro = await git(["rev-parse", "--is-inside-work-tree"], dir);
  if (!dentro.ok || dentro.saida.trim() !== "true") throw pedidoRuim("o projeto não é um repositório git");

  const remote = await git(["remote", "get-url", "origin"], dir);
  if (!remote.ok || !remote.saida.trim()) throw pedidoRuim("o repositório não tem um remote `origin`");
  const alvo = githubDoRemote(remote.saida);
  if (!alvo) throw pedidoRuim(`o remote \`origin\` não é um repositório do github.com (${remote.saida.trim()})`);

  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  const branch = head.ok ? head.saida.trim() : "";
  if (!branch) throw pedidoRuim("o repositório ainda não tem commit");
  if (branch === "HEAD") throw pedidoRuim("o HEAD está desanexado — entre numa branch pra abrir PR");

  // `origin/HEAD` só existe quando o clone (ou um `git remote set-head`) apontou a base;
  // quando não existe, seguimos sem o aviso em vez de chutar "main".
  const base = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
  if (base.ok && base.saida.trim() === `origin/${branch}`) {
    throw pedidoRuim(`\`${branch}\` é a branch base do repositório — crie uma branch com a sua mudança pra abrir PR`);
  }

  const noRemote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], dir);
  if (!noRemote.ok) {
    throw pedidoRuim(`a branch \`${branch}\` ainda não está no GitHub — dê push nela primeiro`);
  }

  return {
    ...alvo,
    branch,
    url: `https://github.com/${alvo.owner}/${alvo.repo}/compare/${caminhoDeBranch(branch)}?expand=1`,
  };
}
