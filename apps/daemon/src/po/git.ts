/**
 * Evidência do git pro PO: status, diff --stat e os commits desde o card aberto mais antigo.
 * Nunca conteúdo de arquivo. Sem git, fora de repositório ou com erro: string vazia.
 */
import { execFile } from "node:child_process";

const TETO_MS = 5_000;
const LINHAS_MAX = 30;
const LARGURA_MAX = 110;

export const PO_GIT_SECTION = "GIT DA PASTA (evidência; nunca conteúdo de arquivo):";

export type RodarGit = (cwd: string, args: string[]) => Promise<string | null>;

/** `git -C <cwd> --no-optional-locks …` — null quando falha. */
export const rodarGitPadrao: RodarGit = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "--no-optional-locks", ...args],
      { timeout: TETO_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });

function bloco(titulo: string, saida: string | null, vazio: string): string {
  const linhas = (saida ?? "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (!linhas.length) return `${titulo}\n${vazio}`;
  const corpo = linhas
    .slice(0, LINHAS_MAX)
    .map((l) => (l.length > LARGURA_MAX ? `${l.slice(0, LARGURA_MAX - 1)}…` : l));
  if (linhas.length > LINHAS_MAX) corpo.push(`(+${linhas.length - LINHAS_MAX} linhas)`);
  return `${titulo}\n${corpo.join("\n")}`;
}

/**
 * Bloco GIT do prompt, já com a quebra de linha na frente (pra colar no fim do digest).
 * `desde` = createdAt do card aberto mais antigo (sem ele, não lista commits).
 */
export async function evidenciaDoGit(cwd: string, desde?: string, rodar: RodarGit = rodarGitPadrao): Promise<string> {
  try {
    const dentro = await rodar(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (dentro?.trim() !== "true") return "";
    const [status, diffHead, log] = await Promise.all([
      rodar(cwd, ["status", "--porcelain"]),
      rodar(cwd, ["diff", "HEAD", "--stat"]),
      desde ? rodar(cwd, ["log", `--since=${desde}`, "--format=%h %s", "-n", "500"]) : Promise.resolve(""),
    ]);
    // Repositório sem commit nenhum: HEAD não existe — cai pro diff do índice.
    const diff = diffHead ?? (await rodar(cwd, ["diff", "--stat"]));
    return [
      "",
      "",
      PO_GIT_SECTION,
      bloco("git status --porcelain:", status, "(limpo: nada sem commit)"),
      bloco("git diff --stat:", diff, "(sem mudanças)"),
      bloco("commits desde o cartão:", log, "(nenhum)"),
    ].join("\n");
  } catch {
    return "";
  }
}
