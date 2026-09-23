import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { projectKey } from "./home.ts";
import { projectDir, projectDirSemCriar } from "./projeto-dir.ts";

/**
 * Logo/ícone do projeto pra barra lateral do app (no lugar do ícone de pasta).
 *
 * O lugar mostra 16–20px, então ícone QUADRADO ganha de logo horizontal: favicon/icon/
 * apple-touch-icon vêm antes de "logo". SVG ganha de bitmap (escala sem borrar). Só olha pastas
 * onde ícone costuma morar e até pouca profundidade — é chamado pra cada projeto da lista.
 */

const EXT = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);
const PULAR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", "vendor", "target", ".venv", "venv", "__pycache__", ".turbo", ".cache"]);
const MAX_BYTES = 512 * 1024;
const PROFUNDIDADE = 4;
const MAX_ENTRADAS = 4000;
const TTL_MS = 5 * 60_000;

export type LogoDoProjeto = { caminho: string; mime: string };

/** Pontuação do nome: quanto maior, melhor pro espaço pequeno e quadrado da barra. */
function pontoDoNome(nome: string, rel: string): number {
  const base = nome.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  if (/^apple-touch-icon/.test(base)) return 60;
  if (/^(favicon|icon)(-\d+(x\d+)?)?$/.test(base)) return 55;
  if (/^(logo|logomarca|marca|brand)[-_]?(icon|icone|ícone|mark|simbolo|símbolo|square|quadrado)/.test(base)) return 50;
  if (/^(logo|logomarca|marca|brand)$/.test(base)) return 40;
  // ícone de app desktop/mobile (Electron `icons/app.png`, `build/icon.png`, `brand/icon-x.png`)
  if (/^(app|app-icon|appicon)(-\d+(x\d+)?)?$/.test(base) && /(^|\/)(icons?|build|resources|brand|assets)(\/|$)/.test(rel)) return 45;
  if (/^icon[-_][a-z0-9-]+$/.test(base) && /(^|\/)(icons?|brand|branding|assets|resources)(\/|$)/.test(rel)) return 30;
  if (/(^|[-_.])(logo|brand|marca)([-_.]|$)/.test(base)) return 25;
  return 0;
}

function pontoDaExt(ext: string): number {
  return ext === ".svg" ? 8 : ext === ".png" ? 6 : ext === ".webp" ? 5 : ext === ".ico" ? 3 : 1;
}

/** Pasta que costuma ter o ícone do app pesa mais que uma pasta qualquer. */
function pontoDaPasta(rel: string): number {
  if (/^(public|static|assets|app|src\/app|src\/assets|resources|images|img|brand|branding)(\/|$)/.test(rel)) return 6;
  return rel ? 0 : 4; // raiz do projeto
}

export function acharLogo(projectPath: string): LogoDoProjeto | null {
  let melhor: { caminho: string; ext: string; ponto: number } | null = null;
  let vistos = 0;
  const andar = (dir: string, rel: string, nivel: number): void => {
    if (nivel > PROFUNDIDADE || vistos > MAX_ENTRADAS) return;
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      vistos += 1;
      if (e.isDirectory()) {
        if (!PULAR.has(e.name) && !e.name.startsWith(".")) andar(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, nivel + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extname(e.name).toLowerCase();
      if (!EXT.has(ext)) continue;
      const pn = pontoDoNome(e.name, rel);
      if (!pn) continue;
      const caminho = join(dir, e.name);
      try {
        const tam = statSync(caminho).size;
        if (!tam || tam > MAX_BYTES) continue;
      } catch {
        continue;
      }
      const ponto = pn + pontoDaExt(ext) + pontoDaPasta(rel) - nivel;
      if (!melhor || ponto > melhor.ponto) melhor = { caminho, ext, ponto };
    }
  };
  andar(projectPath, "", 0);
  if (!melhor) return null;
  const achado = melhor as { caminho: string; ext: string };
  return { caminho: achado.caminho, mime: EXT.get(achado.ext)! };
}

const cache = new Map<string, { em: number; logo: LogoDoProjeto | null }>();

/*
 * Ícone escolhido à mão (menu do projeto → "Escolher ícone…"), pra quando o automático pega o
 * arquivo errado. Fica COPIADO na pasta do projeto no Nexos (não aponta pro original): vai junto
 * no sync entre máquinas e não quebra se o arquivo do repo mudar de lugar.
 */
const MANUAL = "icone-manual";

function logoManual(projectPath: string, home: string): LogoDoProjeto | null {
  const dir = projectDirSemCriar(projectPath, home);
  for (const [ext, mime] of EXT) {
    const caminho = join(dir, `${MANUAL}${ext}`);
    if (existsSync(caminho)) return { caminho, mime };
  }
  return null;
}

function apagarManual(dir: string): void {
  for (const ext of EXT.keys()) rmSync(join(dir, `${MANUAL}${ext}`), { force: true });
}

export function definirLogoManual(projectPath: string, home: string, nome: string, base64: string): LogoDoProjeto {
  const ext = extname(nome).toLowerCase();
  const mime = EXT.get(ext);
  if (!mime) throw Object.assign(new Error("formato não suportado (svg, png, ico, webp, jpg)"), { status: 400 });
  const corpo = Buffer.from(base64, "base64");
  if (!corpo.length) throw Object.assign(new Error("arquivo vazio"), { status: 400 });
  if (corpo.length > MAX_BYTES) throw Object.assign(new Error("imagem grande demais (máx. 512 KB)"), { status: 400 });
  const dir = projectDir(projectPath, home);
  apagarManual(dir);
  const caminho = join(dir, `${MANUAL}${ext}`);
  writeFileSync(caminho, corpo);
  return { caminho, mime };
}

export function limparLogoManual(projectPath: string, home: string): void {
  apagarManual(projectDirSemCriar(projectPath, home));
}

/** Manual primeiro; o automático tem cache curto (a barra pede o logo de cada projeto a cada repintura). */
export function logoDoProjeto(projectPath: string, home: string): (LogoDoProjeto & { manual?: boolean }) | null {
  const manual = logoManual(projectPath, home);
  if (manual) return { ...manual, manual: true };
  const chave = projectKey(projectPath);
  const c = cache.get(chave);
  if (c && Date.now() - c.em < TTL_MS) return c.logo;
  const logo = acharLogo(projectPath);
  cache.set(chave, { em: Date.now(), logo });
  return logo;
}
