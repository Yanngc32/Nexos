import { existsSync, appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nexoHome } from "./home.ts";

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
 * Caminho absoluto em forma segura pro `sh` do hook. Barra `/` mesmo no Windows: o
 * Git for Windows roda estes scripts num `sh`, onde `\` é escape — `C:\Users\...`
 * dentro de aspas é frágil, e `C:/Users/...` o Node e o próprio git aceitam igual.
 */
function shPath(p: string): string {
  return p.replace(/[\u005c]/g, "/");
}

/**
 * A CLI do Nexo resolvida por caminho absoluto, e não pelo `nexo` do PATH.
 *
 * O bin `nexo` só existe como bin de workspace (`apps/daemon/package.json`) — nunca é
 * instalado global. Um hook que chamasse só `nexo` falhava com `command not found` em
 * TODO commit, e o `|| true` (que existe pra daemon fora do ar não travar `git commit`)
 * engolia isso sem deixar rastro nenhum: o Nexo parecia estar ligado e nunca escrevia
 * memória. O daemon sabe onde a própria CLI está, então é ele quem grava o caminho.
 */
function nexoCliPath(): string {
  return shPath(fileURLToPath(new URL("../scripts/nexo.mjs", import.meta.url)));
}

/** Onde o hook reclama quando não acha jeito nenhum de chamar a CLI. Mesmo log do daemon. */
function nexoLogPath(): string {
  return shPath(join(nexoHome(), "daemon.log"));
}

/**
 * Corpo do bloco pra este evento, entre sentinelas — é o que torna `install`
 * idempotente (compara o bloco atual com o novo) e `uninstall` seguro (remove
 * só entre as duas, nunca o resto de um hook que a pessoa já tinha).
 *
 * Ordem de resolução, igual nos três eventos: caminho absoluto da CLI (com `node`
 * disponível), senão `nexo` do PATH, senão registra no log do daemon. O fallback pelo
 * PATH continua porque o caminho absoluto morre se a pasta do Nexo for movida, e aí
 * uma instalação global salva o hook.
 *
 * `pre-push` é o único que PRECISA propagar o exit code: é o único evento que
 * roda antes da ação existir, então é o único capaz de abortar. Os outros dois
 * já aconteceram — `|| true` garante que o daemon fora do ar nunca trava
 * `git commit`/`git push`.
 */
function blocoDoHook(event: string): string {
  const { inicio, fim } = marcador(event);
  const cli = `nexo_cli="${nexoCliPath()}"`;
  const log = nexoLogPath();
  const temCli = '[ -f "$nexo_cli" ] && command -v node >/dev/null 2>&1';
  const temPath = "command -v nexo >/dev/null 2>&1";
  const semNada = (extra: string): string =>
    `echo "nexo: ${event} não disparou — nem \\"$nexo_cli\\" nem 'nexo' no PATH${extra}" >> "${log}" 2>/dev/null || true`;
  if (event === "git.pre-push") {
    return [
      inicio,
      cli,
      "while read local_ref local_sha remote_ref remote_sha; do",
      '  branch=$(echo "$remote_ref" | sed \'s#^refs/heads/##\')',
      `  if ${temCli}; then`,
      '    node "$nexo_cli" hook fire git.pre-push --branch "$branch"',
      `  elif ${temPath}; then`,
      '    nexo hook fire git.pre-push --branch "$branch"',
      "  else",
      // Regra bloqueante que não consegue rodar não libera o push — só agora diz por quê,
      // em vez de barrar com o 127 opaco de "command not found" que sobrava antes.
      `    ${semNada("; push barrado")}`,
      "    exit 1",
      "  fi",
      "  status=$?",
      '  if [ "$status" -ne 0 ]; then exit "$status"; fi',
      "done",
      fim,
    ].join("\n");
  }
  return [
    inicio,
    cli,
    `if ${temCli}; then`,
    `  node "$nexo_cli" hook fire ${event} >/dev/null 2>&1 || true`,
    `elif ${temPath}; then`,
    `  nexo hook fire ${event} >/dev/null 2>&1 || true`,
    "else",
    `  ${semNada("")}`,
    "fi",
    fim,
  ].join("\n");
}

/** Regex do bloco deste evento, sentinelas inclusas — base de `uninstall` e da troca em `install`. */
function reDoBloco(event: string): RegExp {
  const { inicio, fim } = marcador(event);
  return new RegExp(`\\n?${escapeRegExp(inicio)}[\\s\\S]*?${escapeRegExp(fim)}\\n?`);
}

/**
 * Escreve (ou anexa a um hook já existente) o disparo deste evento em
 * `.git/hooks/<arquivo>`.
 *
 * @returns `true` se mudou o arquivo, `false` se o bloco já estava igual.
 */
export function installGitHookScript(projectPath: string, event: string): boolean {
  const arquivo = GIT_HOOK_FILES[event];
  if (!arquivo) throw new Error(`evento sem hook de git conhecido: ${event}`);
  const path = join(projectPath, ".git", "hooks", arquivo);
  const bloco = blocoDoHook(event);
  const { inicio } = marcador(event);
  const atual = existsSync(path) ? readFileSync(path, "utf8") : "";
  /*
   * Sentinela presente não quer mais dizer "nada a fazer": o corpo do bloco carrega o
   * caminho absoluto da CLI, que muda quando o Nexo é movido de pasta — e, sem esta
   * troca, um hook escrito por uma versão antiga ficaria com o `nexo` cru do PATH pra
   * sempre, sem nenhum caminho de atualização a não ser remover e recriar a regra.
   */
  if (atual.includes(inicio)) {
    if (atual.includes(bloco)) return false;
    writeFileSync(path, atual.replace(reDoBloco(event), `\n${bloco}\n`), "utf8");
    return true;
  }
  /*
   * Arquivo existe mas está vazio (ou só espaço): é o que `uninstallGitHookScript` deixa
   * pra trás quando remove o ÚLTIMO bloco (esvazia em vez de apagar o arquivo). Tratar isso
   * como "já tem conteúdo, então só anexa" perdia o shebang pra sempre — o hook virava um
   * script sem `#!/bin/sh` que o git tenta executar direto e falha com
   * "cannot spawn ...: No such file or directory" (visto de verdade neste repo).
   */
  if (atual.trim() === "") {
    writeFileSync(path, `#!/bin/sh\n${bloco}\n`, "utf8");
  } else {
    appendFileSync(path, `\n${bloco}\n`, "utf8");
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
  const re = reDoBloco(event);
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
