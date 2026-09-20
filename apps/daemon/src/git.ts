import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * Ambiente de todo git daqui: **nunca perguntar nada**.
 *
 * Um daemon não tem terminal pra responder. Sem isto, um `fetch` de repositório
 * privado sem credencial fica esperando usuário e senha que ninguém vai digitar
 * — a requisição pendura até o timeout e a pessoa não descobre que o problema
 * era credencial. Com isto o git falha na hora, dizendo que não conseguiu
 * autenticar, que é uma mensagem acionável.
 *
 * `BatchMode=yes` faz o mesmo pelo lado do SSH (chave com passphrase não
 * carregada no agente falha em vez de abrir prompt). O agente de chaves segue
 * funcionando normalmente — é só o prompt interativo que morre.
 */
function ambienteSemPrompt(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

/**
 * Roda git e devolve saída (stdout+stderr juntos, que é o que serve pra
 * mensagem de erro). NUNCA lança: quem chama decide o que fazer com `ok`.
 */
export function git(args: string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<ResultadoGit> {
  return gitStream(args, cwd, undefined, timeoutMs);
}

/**
 * Igual ao `git`, mas entrega cada linha de progresso enquanto acontece — é o
 * que faz um clone de minutos mostrar andamento em vez de uma tela parada.
 *
 * Quebra por `\r` além de `\n` de propósito: o progresso do git ("Receiving
 * objects: 47%") reescreve a MESMA linha com carriage return, então quem
 * separasse só por `\n` receberia tudo de uma vez, no fim, quando não serve
 * mais pra nada.
 */
export function gitStream(
  args: string[],
  cwd: string,
  onLinha?: (linha: string) => void,
  timeoutMs = TIMEOUT_MS,
): Promise<ResultadoGit> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: ambienteSemPrompt(),
    });
    let saida = "";
    let pendente = "";
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
    const receber = (b: Buffer) => {
      const texto = b.toString("utf8");
      saida += texto;
      if (!onLinha) return;
      pendente += texto;
      const linhas = pendente.split(/[\r\n]/);
      pendente = linhas.pop() ?? "";
      for (const linha of linhas) {
        const limpa = linha.trim();
        if (limpa) onLinha(limpa);
      }
    };
    child.stdout.on("data", receber);
    child.stderr.on("data", receber);
    child.on("error", (e) => fim({ ok: false, saida: e.message }));
    child.on("close", (code) => {
      if (onLinha && pendente.trim()) onLinha(pendente.trim());
      fim({ ok: code === 0, saida: saida.trim() });
    });
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

const NOME_PASTA = /^[A-Za-z0-9._-]+$/;

export type UrlDeClone = { url: string; nome: string };

/**
 * Valida a URL de clone e tira dela o nome da pasta.
 *
 * **É a parte com risco de verdade deste arquivo.** Duas armadilhas conhecidas
 * do `git clone`, as duas com URL que parece inofensiva:
 *
 * 1. `ext::sh -c "<comando>"` é um transporte legítimo do git que EXECUTA o
 *    comando. Clonar uma URL dessas é rodar código arbitrário na máquina da
 *    pessoa. Por isso a lista de esquemas é branca, não preta: transporte novo
 *    que aparecer entra recusado por padrão.
 * 2. URL começando com `-` vira FLAG pro git (`--upload-pack=...`). O `--` na
 *    chamada já separa, e a recusa aqui é o segundo cinto.
 *
 * `git://` fica de fora junto: não tem autenticação nem integridade, e quem
 * ainda o usa consegue a mesma coisa por https.
 */
export function validarUrlDeClone(bruta: string): UrlDeClone {
  const url = (bruta || "").trim();
  if (!url) throw pedidoRuim("faltou o link do repositório");
  if (url.startsWith("-")) throw pedidoRuim("link inválido: não pode começar com `-`");

  let caminho: string;
  const scp = /^[\w.+-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp) {
    caminho = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw pedidoRuim(`não entendi o link: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
      throw pedidoRuim(`link ${parsed.protocol.replace(":", "")} não é aceito — use https:// ou ssh (git@host:dono/repo)`);
    }
    caminho = parsed.pathname;
  }

  const nome = caminho
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean)
    .at(-1);
  if (!nome || !NOME_PASTA.test(nome)) throw pedidoRuim(`não consegui tirar um nome de pasta do link: ${url}`);
  return { url, nome };
}

/**
 * Clona pra dentro de `destinoPai`, numa pasta com o nome do repositório.
 *
 * Usa a credencial de git que já existe na máquina (chave SSH, credential
 * helper) — é o mesmo `git clone` que a pessoa rodaria no terminal, então repo
 * privado funciona sem o Nexo guardar token nenhum.
 *
 * Nunca escreve por cima: pasta que já existe com conteúdo é recusa, não
 * merge. Clone longo é a regra, não a exceção — daí o teto de 30 min e o
 * `--progress` chegando em `onProgresso`.
 */
export async function clonar(
  urlBruta: string,
  destinoPai: string,
  onProgresso?: (linha: string) => void,
): Promise<{ dir: string }> {
  const { url, nome } = validarUrlDeClone(urlBruta);
  const pai = resolve(destinoPai || "");
  if (!destinoPai || !existsSync(pai)) throw pedidoRuim("a pasta de destino não existe");
  const dir = join(pai, nome);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw pedidoRuim(`já existe uma pasta \`${nome}\` com conteúdo em ${pai}`);
  }

  // `--` separa a URL dos argumentos: sem ele, link começando com `-` vira flag do git
  const r = await gitStream(["clone", "--progress", "--", url, dir], pai, onProgresso, 30 * 60_000);
  if (!r.ok) throw pedidoRuim(r.saida || "git clone falhou");
  return { dir };
}

export type EstadoRepo = {
  /** Vazio quando o HEAD está desanexado. */
  branch: string;
  limpo: boolean;
  upstream?: string;
  /** Commits que o upstream tem e este branch não (e vice-versa), pelo que o último fetch trouxe. */
  atras: number;
  adiante: number;
  github?: RepoGithub;
};

async function repoValido(projectPath: string): Promise<string> {
  const dir = resolve(projectPath || "");
  if (!projectPath || !existsSync(dir)) throw pedidoRuim("a pasta do projeto não existe");
  const dentro = await git(["rev-parse", "--is-inside-work-tree"], dir);
  if (!dentro.ok || dentro.saida.trim() !== "true") throw pedidoRuim("o projeto não é um repositório git");
  return dir;
}

/**
 * O que a barra de repositório mostra: branch, se há mudança não commitada, e
 * a distância pro upstream. `atras`/`adiante` valem pelo que o último fetch
 * trouxe — quem quer número fresco chama `atualizar`, que busca antes.
 */
export async function estadoDoRepo(projectPath: string): Promise<EstadoRepo> {
  const dir = await repoValido(projectPath);
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  const branch = head.ok && head.saida.trim() !== "HEAD" ? head.saida.trim() : "";
  const sujo = await git(["status", "--porcelain"], dir);
  const remote = await git(["remote", "get-url", "origin"], dir);

  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], dir);
  const upstream = up.ok ? up.saida.trim() : undefined;
  let atras = 0;
  let adiante = 0;
  if (upstream) {
    const contagem = await git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], dir);
    if (contagem.ok) {
      const [a, b] = contagem.saida.trim().split(/\s+/).map(Number);
      atras = Number.isFinite(a) ? a : 0;
      adiante = Number.isFinite(b) ? b : 0;
    }
  }
  return {
    branch,
    limpo: sujo.ok && sujo.saida.length === 0,
    upstream,
    atras,
    adiante,
    github: remote.ok ? githubDoRemote(remote.saida) : undefined,
  };
}

/** Branches locais, na ordem de uso mais recente — quem acabou de trabalhar numa quer ela por perto. */
export async function listarBranches(projectPath: string): Promise<{ atual: string; locais: string[] }> {
  const dir = await repoValido(projectPath);
  const r = await git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], dir);
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  return {
    atual: head.ok && head.saida.trim() !== "HEAD" ? head.saida.trim() : "",
    locais: r.ok ? r.saida.split("\n").map((l) => l.trim()).filter(Boolean) : [],
  };
}

/**
 * Troca de branch — recusando com a árvore suja.
 *
 * O git até deixa trocar carregando mudança não commitada, mas aí ela "segue"
 * pra outra branch e some da que a pessoa achava estar editando. É confuso na
 * melhor das hipóteses e perde trabalho na pior, então quem decide isso é ela,
 * no terminal, de propósito.
 */
export async function trocarBranch(projectPath: string, branch: string): Promise<{ branch: string }> {
  const dir = await repoValido(projectPath);
  const alvo = (branch || "").trim();
  if (!alvo) throw pedidoRuim("faltou a branch");
  /*
   * NUNCA `checkout -- <alvo>`: depois do `--` o git lê o argumento como
   * CAMINHO, e `checkout -- foo` restaura o arquivo foo do índice, jogando
   * fora a edição dele. É o oposto do que esta função existe pra fazer.
   * Contra nome de branch começando com `-` (que viraria flag), a defesa é
   * recusar aqui.
   */
  if (alvo.startsWith("-")) throw pedidoRuim("nome de branch inválido");
  const sujo = await git(["status", "--porcelain"], dir);
  if (sujo.ok && sujo.saida.length > 0) {
    throw pedidoRuim("há mudança não commitada — comite ou guarde (`git stash`) antes de trocar de branch");
  }
  const r = await git(["checkout", alvo], dir);
  if (!r.ok) throw pedidoRuim(r.saida || `não consegui entrar em \`${alvo}\``);
  return { branch: alvo };
}

export type Atualizacao = { branch: string; trazidos: number; jaEstavaEmDia: boolean };

/**
 * Busca do remote e avança a branch — **só fast-forward**.
 *
 * É a diferença entre isto e um pull de verdade: não faz merge, não faz
 * rebase, não resolve conflito. Se as duas pontas andaram, para e manda a
 * pessoa pro terminal, com o número de commits de cada lado. Merge automático
 * num repositório de outra pessoa é exatamente o tipo de coisa que, quando dá
 * errado, ninguém consegue desfazer sem saber git — e quem clicou num botão
 * "atualizar" não pediu por isso.
 */
export async function atualizar(projectPath: string): Promise<Atualizacao> {
  const dir = await repoValido(projectPath);
  const antes = await estadoDoRepo(projectPath);
  if (!antes.branch) throw pedidoRuim("o HEAD está desanexado — entre numa branch pra atualizar");
  if (!antes.limpo) {
    throw pedidoRuim("há mudança não commitada — comite ou guarde (`git stash`) antes de atualizar");
  }

  const fetch = await git(["fetch", "--prune", "origin"], dir, 5 * 60_000);
  if (!fetch.ok) throw pedidoRuim(fetch.saida || "git fetch falhou");

  const depois = await estadoDoRepo(projectPath);
  if (!depois.upstream) {
    throw pedidoRuim(`a branch \`${depois.branch}\` não acompanha nenhuma branch do remote`);
  }
  if (depois.atras === 0) return { branch: depois.branch, trazidos: 0, jaEstavaEmDia: true };
  if (depois.adiante > 0) {
    throw pedidoRuim(
      `as duas pontas andaram: ${depois.adiante} commit(s) seu(s) e ${depois.atras} do remote. ` +
        "Resolva no terminal (merge ou rebase) — aqui só avanço quando dá sem juntar nada.",
    );
  }

  const ff = await git(["merge", "--ff-only", depois.upstream], dir, 2 * 60_000);
  if (!ff.ok) throw pedidoRuim(ff.saida || "não deu pra avançar sem merge");
  return { branch: depois.branch, trazidos: depois.atras, jaEstavaEmDia: false };
}
