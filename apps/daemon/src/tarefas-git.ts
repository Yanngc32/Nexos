import { execFileSync } from "node:child_process";

/**
 * Vínculo automático entre tarefa e código: busca commits cuja MENSAGEM menciona o id da
 * tarefa (`tk-...`) — convenção livre (quem quiser que o Nexos ache o commit inclui o id na
 * mensagem), não força nada. Sem campo persistido: sempre computado na hora, nunca fica
 * desatualizado. Ver docs/superpowers/specs/2026-09-12-tarefas-avancado-design.md.
 */

export type CommitRelacionado = { hash: string; mensagem: string; data: string };

const SEP = "\x1f"; // não aparece em mensagem de commit normal — separador seguro pro parse
const LIMITE = 20;

/**
 * `git log --all --grep=<id>` — best-effort, nunca lança: sem `.git`, sem `git` no PATH, ou
 * nenhum commit mencionando o id, devolve lista vazia (mesmo padrão de `listarArquivos` em
 * `repo-map-indice.ts`).
 */
export function commitsRelacionados(projectPath: string, tarefaId: string): CommitRelacionado[] {
  try {
    const out = execFileSync(
      "git",
      ["log", "--all", "--fixed-strings", `--grep=${tarefaId}`, "-n", String(LIMITE), `--format=%H${SEP}%s${SEP}%aI`],
      { cwd: projectPath, encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((linha) => {
        const [hash, mensagem, data] = linha.split(SEP);
        return { hash: hash ?? "", mensagem: mensagem ?? "", data: data ?? "" };
      })
      .filter((c) => c.hash);
  } catch {
    return [];
  }
}
