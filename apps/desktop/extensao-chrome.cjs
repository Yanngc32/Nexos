const { cpSync, existsSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Instalação da extensão do Chrome pelas Configurações.
 *
 * O Chrome não deixa app de fora instalar extensão (só política corporativa ou Web Store). O que
 * dá pra fazer: deixar a pasta pronta num lugar FIXO (`~/.nexos/chrome-extension`), copiar o
 * caminho e abrir `chrome://extensions` — a pessoa só clica em "Carregar sem compactação" e cola.
 *
 * Fixo de propósito: o atualizador troca a pasta de instalação do app a cada versão, e extensão
 * carregada de dentro dela sumiria do Chrome na primeira atualização. Aqui ela fica sempre no
 * mesmo caminho e é só re-copiada quando o app traz versão nova (o Chrome lê do disco ao reiniciar).
 */

/** Pasta da extensão que veio com o app: `resources/chrome-extension` empacotado, `dist` do build em dev. */
function origemDaExtensao({ isPackaged, resourcesPath, here }) {
  return isPackaged ? join(resourcesPath, "chrome-extension") : join(here, "..", "chrome-extension", "dist", "nexos-chrome");
}

function versaoDe(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/**
 * Copia `origem` → `destino` se não existe ou a versão é outra. `soSeJaInstalada`: não cria do nada
 * (é o caminho da subida do app — só atualiza quem já instalou).
 */
function prepararExtensao(origem, destino, { soSeJaInstalada = false } = {}) {
  const disponivel = versaoDe(origem);
  if (!disponivel) {
    throw new Error(`extensão não encontrada em ${origem} — em dev, rode "pnpm chrome" antes`);
  }
  const instalada = versaoDe(destino);
  if (soSeJaInstalada && !instalada) return { pasta: destino, versao: null, copiou: false };
  if (instalada === disponivel) return { pasta: destino, versao: instalada, copiou: false };
  // limpa antes: arquivo que saiu da versão nova não pode ficar pra trás
  if (existsSync(destino)) rmSync(destino, { recursive: true, force: true });
  cpSync(origem, destino, { recursive: true });
  return { pasta: destino, versao: disponivel, copiou: true };
}

/** `chrome.exe` nos lugares de sempre do Windows (por máquina e por usuário). `null` se não achar. */
function acharChrome(env = process.env, existe = existsSync) {
  const bases = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
  for (const b of bases) {
    const p = join(b, "Google", "Chrome", "Application", "chrome.exe");
    if (existe(p)) return p;
  }
  return null;
}

module.exports = { acharChrome, origemDaExtensao, prepararExtensao, versaoDe };
