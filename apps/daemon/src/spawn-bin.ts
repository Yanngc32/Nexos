import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function isNodeScript(bin: string): boolean {
  const base = bin.split(/[\\/]/).pop() ?? bin;
  return /\.(mjs|cjs|js|ts)$/i.test(base);
}

/**
 * O `.js` real que um shim `.cmd`/`.bat` do npm invoca, lido do PRÓPRIO arquivo.
 *
 * **Por que isto existe.** O `.cmd` que o `npm install -g` gera no Windows (o
 * template `cmd-shim`, universal no ecossistema) termina numa linha como:
 *
 *     endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 *
 * Repare o `&`/`||` no PRÓPRIO corpo do shim, ANTES de `%*`. Isso significa que
 * todo argumento passado a esse `.cmd` atravessa DOIS parses de cmd.exe: o do
 * `/c` que o invoca, e o do PRÓPRIO `.cmd` executando essa linha. Um argumento
 * com `&` (a URL do MCP que o daemon passa ao `codex` sempre tem — query string
 * com `projectPath` e `threadId`) sobrevive ao primeiro parse mesmo escapado
 * (testado com a técnica do `cross-spawn`, que é a referência do ecossistema) e
 * quebra no segundo — não existe escape de argv que resolva os dois parses ao
 * mesmo tempo. Era isso que fazia o motor codex morrer (`exit 1`) em TODA
 * mensagem no Windows, sempre, sem relação com login ou instalação.
 *
 * A saída é não passar pelo `.cmd` NENHUMA vez: resolver o `.js` que ele invoca
 * e chamar `node` direto nele — mesmo caminho que os fixtures de teste (`.mjs`)
 * já usavam sem problema, porque nunca tocam cmd.exe.
 */
export function resolveShimEntry(cmdPath: string): string | undefined {
  let conteudo: string;
  try {
    conteudo = readFileSync(cmdPath, "utf8");
  } catch {
    return undefined;
  }
  // Pode haver mais de um `%dp0%\...\algo.js"` na linha (o próprio %_prog% às vezes
  // também é um .js do node embutido) — o que importa é o ÚLTIMO, que é o entrypoint
  // real do pacote (medido contra o codex.cmd de verdade, ver doc acima).
  const matches = [...conteudo.matchAll(/"%dp0%\\([^"]+\.[cm]?js)"/gi)];
  const ultimo = matches.at(-1)?.[1];
  if (!ultimo) return undefined;
  const alvo = join(dirname(cmdPath), ultimo);
  return existsSync(alvo) ? alvo : undefined;
}

/** `where <bin>` lista todo hit do PATH; o shim executável é o `.cmd`/`.bat`, não o script POSIX homônimo. */
function findCmdShim(bin: string): string | undefined {
  let r: import("node:child_process").SpawnSyncReturns<string>;
  try {
    r = spawnSync("where", [bin], { encoding: "utf8" });
  } catch {
    return undefined;
  }
  if (r.status !== 0 || !r.stdout) return undefined;
  return r.stdout
    .split(/\r?\n/)
    .map((l: string) => l.trim())
    .find((l: string) => /\.(cmd|bat)$/i.test(l));
}

// Por nome de bin: `where` + leitura de arquivo custam um processo e uma stat por turno sem isso.
const entryCache = new Map<string, string | null>();

/** Caminho direto pro `.js` real, quando `bin` resolve pra um shim `.cmd`/`.bat` do npm no Windows. */
function windowsDirectEntry(bin: string): string | undefined {
  if (process.platform !== "win32" || isNodeScript(bin)) return undefined;
  const cached = entryCache.get(bin);
  if (cached !== undefined) return cached ?? undefined;
  const shim = findCmdShim(bin);
  const entry = (shim && resolveShimEntry(shim)) || null;
  entryCache.set(bin, entry);
  return entry ?? undefined;
}

export function spawnBin(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (isNodeScript(bin)) {
    return spawn(process.execPath, [bin, ...args], { ...opts, shell: false });
  }
  const entry = windowsDirectEntry(bin);
  if (entry) {
    return spawn(process.execPath, [entry, ...args], { ...opts, shell: false, windowsHide: true });
  }
  /*
   * Sem shim `.cmd`/`.bat` conhecido (bin já é `.exe`, ou instalação fora do npm):
   * melhor esforço, igual a antes. Só funciona com segurança se o argv não tiver
   * metacaractere de cmd.exe — o caminho de cima é o que garante isso pros
   * motores de CLI, que é onde o argv carrega conteúdo dinâmico (URL do MCP etc.).
   */
  return spawn(bin, args, {
    ...opts,
    shell: opts.shell ?? (process.platform === "win32"),
    windowsHide: true,
  });
}
