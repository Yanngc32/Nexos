#!/usr/bin/env node
// Compila o daemon (src/index.ts + @nexos/shared + dependências JS) num arquivo só:
// dist/nexos.mjs. É o que vai no instalador — sem TypeScript-fonte, sem tsx/esbuild em runtime e
// sem as centenas de arquivos de cada dependência, que era o que deixava a atualização lenta.
//
// Fica FORA do bundle (continua em node_modules) o que carrega arquivo do disco pelo caminho do
// próprio pacote: web-tree-sitter (o .wasm dele) e tree-sitter-wasms (as gramáticas). A
// @bubblewrap/core (gerador de APK) nem vai no instalador: é baixada sob demanda (src/apk-deps.ts).
//
// `dist/` fica na MESMA profundidade de `src/` de propósito: os caminhos relativos do código
// (`../scripts/nexo.mjs`, raiz dos apps) continuam valendo.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(raiz, "src", "index.ts")],
  outfile: join(raiz, "dist", "nexos.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@bubblewrap/core", "@bubblewrap/core/*", "web-tree-sitter", "tree-sitter-wasms"],
  // dependência CommonJS dentro de bundle ESM chama `require("fs")`: sem isto, "Dynamic require
  // of fs is not supported" na primeira linha
  banner: { js: 'import { createRequire as __nexosCreateRequire } from "node:module"; const require = __nexosCreateRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "info",
});
