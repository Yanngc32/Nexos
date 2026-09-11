import { existsSync, appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mecânica de instalação do lado do git — só isto: escrever/remover o bloco em
 * `.git/hooks/`. O despacho de verdade (o que `nexo hook fire` chamado pelo
 * script realmente faz) mora em `hooks.ts`; este arquivo não sabe nada disso.
 */

/** Nome do arquivo de hook do git pra cada evento que o Nexo dispara. */
export const GIT_HOOK_FILES: Record<string, string> = {
  "git.post-commit": "post-commit",
  "git.post-push": "post-push",
  "git.pre-push": "pre-push",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function marcador(event: string): { inicio: string; fim: string } {
  return { inicio: `# nexo-hook:BEGIN:${event}`, fim: `# nexo-hook:END:${event}` };
}

/**
 * Corpo do bloco pra este evento, entre sentinelas — é o que torna `install`
 * idempotente (checa se a sentinela já está lá) e `uninstall` seguro (remove
 * só entre as duas, nunca o resto de um hook que a pessoa já tinha).
 *
 * `pre-push` é o único que PRECISA propagar o exit code: é o único evento que
 * roda antes da ação existir, então é o único capaz de abortar. Os outros dois
 * já aconteceram — `|| true` garante que o daemon fora do ar nunca trava
 * `git commit`/`git push`.
 */
function blocoDoHook(event: string): string {
  const { inicio, fim } = marcador(event);
  if (event === "git.pre-push") {
    return [
      inicio,
      "while read local_ref local_sha remote_ref remote_sha; do",
      '  branch=$(echo "$remote_ref" | sed \'s#^refs/heads/##\')',
      '  nexo hook fire git.pre-push --branch "$branch"',
      "  status=$?",
      '  if [ "$status" -ne 0 ]; then exit "$status"; fi',
      "done",
      fim,
    ].join("\n");
  }
  return [inicio, `nexo hook fire ${event} >/dev/null 2>&1 || true`, fim].join("\n");
}

/**
 * Escreve (ou anexa a um hook já existente) o disparo deste evento em
 * `.git/hooks/<arquivo>`.
 *
 * @returns `true` se mudou o arquivo, `false` se a sentinela já estava lá.
 */
export function installGitHookScript(projectPath: string, event: string): boolean {
  const arquivo = GIT_HOOK_FILES[event];
  if (!arquivo) throw new Error(`evento sem hook de git conhecido: ${event}`);
  const path = join(projectPath, ".git", "hooks", arquivo);
  const bloco = blocoDoHook(event);
  const { inicio } = marcador(event);
  if (existsSync(path)) {
    const atual = readFileSync(path, "utf8");
    if (atual.includes(inicio)) return false;
    appendFileSync(path, `\n${bloco}\n`, "utf8");
  } else {
    writeFileSync(path, `#!/bin/sh\n${bloco}\n`, "utf8");
  }
  try {
    chmodSync(path, 0o755);
  } catch {
    // Windows sem suporte a chmod POSIX: o Git for Windows executa pelo shebang
    // mesmo assim, então a falta do +x aqui não impede o hook de rodar.
  }
  return true;
}

/**
 * Remove só o bloco deste evento (entre as sentinelas) — contraparte de
 * `installGitHookScript`, chamada quando nenhuma regra mais precisa dele
 * (ver `sincronizarHooksDoProjeto`). Nunca mexe no resto do arquivo.
 *
 * @returns `true` se mudou o arquivo, `false` se a sentinela não estava lá.
 */
export function uninstallGitHookScript(projectPath: string, event: string): boolean {
  const arquivo = GIT_HOOK_FILES[event];
  if (!arquivo) throw new Error(`evento sem hook de git conhecido: ${event}`);
  const path = join(projectPath, ".git", "hooks", arquivo);
  if (!existsSync(path)) return false;
  const atual = readFileSync(path, "utf8");
  const { inicio, fim } = marcador(event);
  const re = new RegExp(`\\n?${escapeRegExp(inicio)}[\\s\\S]*?${escapeRegExp(fim)}\\n?`);
  if (!re.test(atual)) return false;
  const restante = atual.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
  // Nada além do shebang sobrou: apaga o arquivo em vez de deixar um hook vazio no `.git/hooks`.
  if (restante.replace(/^#!.*\n?/, "").trim() === "") {
    writeFileSync(path, "", "utf8");
    return true;
  }
  writeFileSync(path, restante, "utf8");
  return true;
}
