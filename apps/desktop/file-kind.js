/**
 * Tipo de arquivo a partir do nome — é o que pinta o marcador da árvore.
 *
 * Aqui só se classifica. O glifo e a cor de cada tipo vivem no CSS, em
 * `[data-kind]`, pra dar pra mexer na paleta sem passar por JS — e pra não
 * existir tabela de cor em dois lugares. Tipo que não se reconhece volta como
 * `""`, e o CSS cai no default (marcador neutro em `var(--text)`), que é o
 * comportamento que a árvore já tinha.
 *
 * Módulo à parte porque é função pura: dá pra testar no node, sem DOM.
 */

/**
 * Nome inteiro, em minúsculas. Vem antes da extensão porque é justamente quem
 * não tem extensão (`Dockerfile`) ou cuja "extensão" é o nome todo
 * (`.gitignore`) que precisa disso.
 */
const POR_NOME = {
  dockerfile: "docker",
  makefile: "config",
  license: "doc",
  licence: "doc",
  copying: "doc",
  notice: "doc",
  ".gitignore": "config",
  ".gitattributes": "config",
  ".gitmodules": "config",
  ".dockerignore": "config",
  ".npmignore": "config",
  ".npmrc": "config",
  ".nvmrc": "config",
  ".editorconfig": "config",
  ".prettierrc": "config",
  ".eslintrc": "config",
  ".babelrc": "config",
  ".env": "config",
};

/** Extensão em minúsculas, sem o ponto. */
const POR_EXT = {
  md: "md",
  mdx: "md",
  markdown: "md",

  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",

  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",

  json: "json",
  jsonc: "json",
  json5: "json",

  yaml: "yaml",
  yml: "yaml",

  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "shell",
  psm1: "shell",
  psd1: "shell",
  bat: "shell",
  cmd: "shell",

  html: "html",
  htm: "html",
  xml: "html",

  css: "css",
  scss: "css",
  sass: "css",
  less: "css",

  py: "py",
  pyw: "py",
  pyi: "py",

  png: "img",
  jpg: "img",
  jpeg: "img",
  gif: "img",
  webp: "img",
  bmp: "img",
  ico: "img",
  avif: "img",
  tiff: "img",

  svg: "svg",

  lock: "config",
  toml: "config",
  ini: "config",
  cfg: "config",
  conf: "config",
  properties: "config",

  lnk: "link",
  url: "link",
  webloc: "link",

  txt: "texto",
  log: "texto",
  csv: "texto",
  tsv: "texto",

  zip: "arq",
  tar: "arq",
  gz: "arq",
  tgz: "arq",
  rar: "arq",
  "7z": "arq",
  xz: "arq",

  exe: "bin",
  dll: "bin",
  so: "bin",
  dylib: "bin",
  bin: "bin",
  node: "bin",
  wasm: "bin",
};

export function tipoDeArquivo(nome) {
  const n = String(nome || "")
    .trim()
    .toLowerCase();
  if (!n) return "";
  // hasOwn e não acesso direto: um arquivo chamado "constructor" acharia o
  // Object.prototype e voltaria função no lugar de tipo
  if (Object.hasOwn(POR_NOME, n)) return POR_NOME[n];
  // `.env.local`, `.env.production`: a extensão mente, o prefixo é que conta
  if (n.startsWith(".env.")) return "config";
  const ponto = n.lastIndexOf(".");
  // ponto na posição 0 é arquivo oculto sem extensão, não extensão
  if (ponto <= 0) return "";
  const ext = n.slice(ponto + 1);
  return Object.hasOwn(POR_EXT, ext) ? POR_EXT[ext] : "";
}
