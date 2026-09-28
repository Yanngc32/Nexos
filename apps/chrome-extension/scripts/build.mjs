/**
 * Monta a extensão em `dist/nexos-chrome/` (pasta pra "Carregar sem compactação") e
 * `dist/nexos-chrome-<versão>.zip`.
 *
 * O `pagina-bundle.js` junta o que já existe no desktop — leitor de página do painel Browser
 * (`navegador-selector.cjs`), markdown (`pagina-markdown.js`), Readability e Turndown — pra
 * extensão ler a página igual ao painel, sem cópia do código. Tudo embrulhado num `if` que só
 * roda uma vez por documento: o service worker reinjeta o arquivo a cada comando.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(raiz, "src");
const desktop = join(raiz, "..", "desktop");
const saida = join(raiz, "dist", "nexos-chrome");

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));

function pacote(nome) {
  return realpathSync(join(desktop, "node_modules", nome));
}

/** Arquivo CommonJS/UMD → valor exportado, num escopo próprio (sem `const` vazando entre arquivos). */
function comoModulo(codigo, global) {
  return `(function(){var module={exports:{}};var exports=module.exports;var define=undefined;\n${codigo}\n;globalThis.${global}=module.exports;})();`;
}

function montarBundle() {
  const seletor = readFileSync(join(desktop, "navegador-selector.cjs"), "utf8");
  const md = readFileSync(join(desktop, "pagina-markdown.js"), "utf8").replace(/^export /gm, "");
  const readability = readFileSync(join(pacote("@mozilla/readability"), "Readability.js"), "utf8");
  const turndown = readFileSync(join(pacote("turndown"), "lib", "turndown.browser.umd.js"), "utf8");
  const pagina = readFileSync(join(src, "pagina.js"), "utf8");
  return [
    `/* Nexos ${manifest.version} — gerado por scripts/build.mjs, não editar. */`,
    "if (!globalThis.__nexo) {",
    comoModulo(seletor, "__sel"),
    comoModulo(readability, "Readability"),
    comoModulo(turndown, "TurndownService"),
    `(function(){\n${md}\n;globalThis.__md={coletarDaPagina,paginaParaMarkdown};})();`,
    `(function(){\n${pagina}\n})();`,
    "}",
    "",
  ].join("\n");
}

function copiarPasta(de, para, pular) {
  mkdirSync(para, { recursive: true });
  for (const nome of readdirSync(de)) {
    if (pular.has(nome)) continue;
    const a = join(de, nome);
    const b = join(para, nome);
    if (statSync(a).isDirectory()) copiarPasta(a, b, new Set());
    else copyFileSync(a, b);
  }
}

function listar(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listar(p) : [p];
  });
}

/** Zip mínimo (deflate), sem dependência: o suficiente pro Chrome e pro Explorer abrirem. */
function zipar(arquivos, base) {
  const locais = [];
  const centrais = [];
  let offset = 0;
  for (const arq of arquivos) {
    const nome = Buffer.from(relative(base, arq).split("\\").join("/"));
    const dado = readFileSync(arq);
    const comp = deflateRawSync(dado, { level: 9 });
    const crc = crc32(dado);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nome em UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); // hora/data zeradas: zip reproduzível
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(dado.length, 22);
    local.writeUInt16LE(nome.length, 26);
    locais.push(local, nome, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(dado.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(offset, 42);
    centrais.push(central, nome);
    offset += 30 + nome.length + comp.length;
  }
  const tamCentral = centrais.reduce((s, b) => s + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamCentral, 12);
  fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, ...centrais, fim]);
}

rmSync(join(raiz, "dist"), { recursive: true, force: true });
copiarPasta(src, saida, new Set(["pagina.js"]));
writeFileSync(join(saida, "pagina-bundle.js"), montarBundle());

const arquivos = listar(saida).sort();
const zip = join(raiz, "dist", `nexos-chrome-${manifest.version}.zip`);
writeFileSync(zip, zipar(arquivos, saida));
console.log(`pasta: ${saida}`);
console.log(`zip:   ${zip} (${arquivos.length} arquivos)`);
