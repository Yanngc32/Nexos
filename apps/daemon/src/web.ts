import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serve a interface web (o app de celular) direto do daemon.
 *
 * Sem bundler e sem build, igual ao resto do projeto: os arquivos vão como
 * estão, e o navegador resolve os `import` por conta própria.
 *
 * **Sem autenticação, de propósito.** A página precisa carregar ANTES de existir
 * token — é nela que se digita o código de pareamento. O que ela pode fazer sem
 * token é nada: toda rota `/v1/*` continua exigindo o bearer, e a página sem
 * token só mostra a tela de pareamento.
 */

const aqui = dirname(fileURLToPath(import.meta.url));
/** `apps/daemon/src` → `apps` */
const apps = resolve(aqui, "../..");
const raizWeb = join(apps, "mobile");
const raizDesktop = join(apps, "desktop");

/**
 * Módulos do desktop que a interface web também usa.
 *
 * Lista branca em vez de servir a pasta inteira por dois motivos, e o segundo é
 * o que importa: (1) o desktop tem arquivo que não faz sentido no celular, e
 * (2) servir uma pasta por prefixo é como se serve o disco por acidente.
 *
 * Cópia não serve: dois arquivos iguais divergem. Então o compartilhado é
 * compartilhado de verdade, e esta lista é o registro explícito do que é.
 */
const COMUM = new Set([
  "api.js",
  "format.js",
  "markdown.js",
  "sse.js",
  "url.js",
  "run-view.js",
  "agent-trace.js",
  "widget-view.js",
  "thread-groups.js",
]);

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

export type Servido = { corpo: Buffer; tipo: string } | null;

/**
 * Resolve um caminho de `/app/...` num arquivo.
 *
 * `null` pra qualquer coisa que não seja arquivo servível — e é aqui que mora a
 * defesa contra travessia: o caminho é reconstruído a partir do NOME, e o
 * resultado é conferido contra a raiz. `..` no pedido não vira `..` no disco
 * porque nada do pedido é concatenado sem passar por essa conferência.
 */
export function servirWeb(caminho: string): Servido {
  const semQuery = caminho.split("?")[0] ?? "";
  // exige o prefixo em vez de só removê-lo quando aparece: função que serve
  // arquivo tem que recusar o que não é dela, não adivinhar
  if (semQuery !== "/app" && !semQuery.startsWith("/app/")) return null;
  const limpo = semQuery.slice("/app".length).replace(/^\//, "");
  const rel = limpo === "" ? "index.html" : decodeURIComponent(limpo);

  // o comum vem do desktop, e só o que está na lista branca
  const comum = rel.startsWith("comum/") ? rel.slice("comum/".length) : "";
  if (comum) {
    if (!COMUM.has(comum)) return null;
    return ler(join(raizDesktop, comum), raizDesktop);
  }
  return ler(join(raizWeb, rel), raizWeb);
}

function ler(alvo: string, raiz: string): Servido {
  const abs = resolve(alvo);
  // o arquivo tem que estar DENTRO da raiz: é o que fecha `..` e symlink
  if (abs !== resolve(raiz) && !abs.startsWith(resolve(raiz) + sepDe(abs))) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const tipo = TIPOS[extname(abs).toLowerCase()];
  if (!tipo) return null;
  return { corpo: readFileSync(abs), tipo };
}

/** Separador que o caminho absoluto está usando; no Windows é `\`. */
function sepDe(abs: string): string {
  return abs.includes("\\") ? "\\" : "/";
}
