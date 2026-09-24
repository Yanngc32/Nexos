const { createHash } = require("node:crypto");
const { createReadStream, statSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");

/**
 * Gera o `nexos-portatil.json` que o app lê pra atualizar por troca de pasta (ver atualizador.cjs):
 * nome do zip portátil, sha512 (base64, como o latest.yml) e tamanho. O latest.yml do
 * electron-updater só descreve o instalador, e o zip precisa de conferência própria.
 *
 * O caminho devolvido entra na publicação junto dos artefatos (contrato do `afterAllArtifactBuild`).
 */
module.exports = async function afterAllArtifactBuild(result) {
  const zip = result.artifactPaths.find((p) => p.toLowerCase().endsWith(".zip"));
  if (!zip) throw new Error("afterAllArtifactBuild: build sem o zip portátil — confira `win.target` no electron-builder.yml");
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    createReadStream(zip).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
  });
  const info = {
    version: result.configuration?.extraMetadata?.version ?? require("../package.json").version,
    arquivo: basename(zip),
    sha512: hash.digest("base64"),
    tamanho: statSync(zip).size,
  };
  const saida = join(dirname(zip), "nexos-portatil.json");
  writeFileSync(saida, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return [saida];
};
