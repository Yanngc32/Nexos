#!/usr/bin/env node
// Gera `dist/apk-deps-<versão>.zip`: a @bubblewrap/core (gerador de APK) com as dependências,
// num node_modules plano. Vai numa release PRÓPRIA do GitHub (`apk-deps-<versão>`), não no
// instalador — o daemon baixa na primeira vez que alguém gera o APK (ver src/apk-deps.ts).
//
// Só precisa rodar de novo quando a versão da bubblewrap mudar — aí suba APK_DEPS_VERSAO em
// src/apk-deps.ts e publique:
//   node scripts/build-apk-deps.mjs
//   gh release create apk-deps-<v> dist/apk-deps-<v>.zip --title "Dependências do gerador de APK <v>" --notes "..."
//
// Gera no Windows: a bubblewrap usa @resvg/resvg-js, que tem binário nativo por plataforma, e o
// Nexos é Windows.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const fonte = readFileSync(join(raiz, "src", "apk-deps.ts"), "utf8");
const versao = /APK_DEPS_VERSAO = "([^"]+)"/.exec(fonte)?.[1];
if (!versao) throw new Error("não achei APK_DEPS_VERSAO em src/apk-deps.ts");
const bw = JSON.parse(readFileSync(join(raiz, "node_modules", "@bubblewrap", "core", "package.json"), "utf8")).version;

const dir = mkdtempSync(join(tmpdir(), "nexos-apk-deps-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "nexos-apk-deps", private: true, dependencies: { "@bubblewrap/core": bw } }, null, 2));
console.log(`[apk-deps] instalando @bubblewrap/core@${bw} em ${dir}`);
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });

// tipos não rodam: fora do zip (~1.000 arquivos a menos)
const nm = join(dir, "node_modules");
for (const d of readdirSync(join(nm, "@types"), { withFileTypes: true })) rmSync(join(nm, "@types", d.name), { recursive: true, force: true });

// confere que carrega de verdade, do jeito que o daemon vai carregar
const req = createRequire(join(dir, "carregar.cjs"));
const carregada = req("@bubblewrap/core");
for (const k of ["TwaGenerator", "TwaManifest", "GradleWrapper", "AndroidSdkTools", "JdkHelper", "KeyTool", "DigitalAssetLinks", "Config"]) {
  if (typeof carregada[k] !== "function") throw new Error(`a bubblewrap instalada não tem ${k}`);
}
if (!req("@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools.js").BUILD_TOOLS_VERSION) throw new Error("sem BUILD_TOOLS_VERSION");

const req2 = createRequire(join(raiz, "package.json"));
const AdmZip = req2("adm-zip");
const zip = new AdmZip();
zip.addLocalFolder(nm, "node_modules");
const saida = join(raiz, "dist", `apk-deps-${versao}.zip`);
zip.writeZip(saida);
try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // o .node do resvg carregado na conferência acima fica preso até este processo sair
  console.log(`[apk-deps] (pasta temporária fica pra trás: ${dir})`);
}
console.log(`[apk-deps] ok: ${saida}`);
