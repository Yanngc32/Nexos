const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

/**
 * `extraResources` (electron-builder.yml) copia `daemon-dist/**` mas SEMPRE descarta uma pasta
 * chamada exatamente `node_modules` na raiz de origem — é um filtro embutido do próprio
 * electron-builder (`util/filter.js: createFilter`, `if (relative === "node_modules") return
 * false`), sem flag nem `filter:` que desligue. Sem isto o app empacotado sobe sem
 * `tsx`/`esbuild`/`@nexos/shared`, e o motor nunca liga.
 *
 * Por isso o `node_modules` é copiado aqui, à mão, depois do pacote pronto — e só funciona
 * porque `deploy-daemon.mjs` gera esse `node_modules` "hoisted" (plano, sem NTFS junction
 * nenhuma): uma cópia comum já basta, sem precisar resolver link nenhum.
 */
module.exports = async function afterPack(context) {
  const src = join(__dirname, "..", "daemon-dist", "node_modules");
  const dest = join(context.appOutDir, "resources", "daemon", "node_modules");
  if (!existsSync(src)) {
    throw new Error(`afterPack: daemon-dist/node_modules não existe em ${src} — rode "pnpm run deploy:daemon" antes do build.`);
  }
  if (existsSync(dest)) return;
  cpSync(src, dest, { recursive: true });
};
