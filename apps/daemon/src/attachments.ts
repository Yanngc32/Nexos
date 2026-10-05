import { createHmac, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ATTACH_MAX_BYTES,
  ATTACH_MAX_PER_MESSAGE,
  ENTREGA_MAX_BYTES,
  IMAGE_MIMES,
  type Attachment,
  type ElementoDoPreview,
} from "@nexos/shared";
import { attachmentsDir } from "./home.ts";

/**
 * O que o cliente manda junto da mensagem: bytes em base64, sem caminho nenhum. Começou só com
 * imagem (daí o campo `images` no corpo da mensagem); hoje é qualquer arquivo.
 */
export type IncomingFile = { name?: string; mime?: string; data: string };
export type IncomingImage = IncomingFile;

/**
 * Mime pela extensão, decidido AQUI: o que o cliente declara não entra no disco nem no
 * cabeçalho de resposta. Fora da tabela vira `application/octet-stream` (só download).
 */
const MIME_POR_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "text/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Código e config: abrem como texto puro no preview. */
const EXT_DE_TEXTO = new Set(
  "ts tsx js jsx mjs cjs css scss less py rb php go rs java kt c h cpp hpp cs sh bash ps1 bat cmd sql toml ini cfg conf env gitignore".split(" "),
);

export function mimeDoArquivo(ext: string): string {
  const e = ext.toLowerCase();
  return MIME_POR_EXT[e] ?? (EXT_DE_TEXTO.has(e) ? "text/plain" : "application/octet-stream");
}

/** Extensão do nome, em minúsculas e só se for curta e simples — vira parte do nome no disco. */
export function extensao(nome: string): string {
  return /\.([a-z0-9]{1,10})$/i.exec(nome)?.[1]?.toLowerCase() ?? "";
}

/** Assinatura do formato: o mime que o cliente declara não decide nada sozinho. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 6).toString("latin1").startsWith("GIF8"),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

const EXT_DE_IMAGEM: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * Nome do arquivo no disco: só o que a rota de download aceita servir. `img-` = imagem conferida
 * pela assinatura; `arq-` = qualquer outro arquivo (anexado ou entregue pelo agente).
 */
export const ATTACH_FILE_RE = /^(?:img|arq)-[a-z0-9]+-[a-z0-9]+\.[a-z0-9]{1,10}$/;

function newFileName(prefixo: "img" | "arq", ext: string): string {
  return `${prefixo}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

/** Rótulo de UI: sem caminho, sem controle, com teto. Nunca vira nome de arquivo. */
function cleanName(raw: string | undefined, fallback: string): string {
  const name = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()
    ?.trim();
  return name ? name.slice(0, 120) : fallback;
}

const mb = (n: number) => `${Math.floor(n / (1024 * 1024))} MB`;

export function saveAttachments(threadId: string, files: IncomingFile[], home: string): Attachment[] {
  if (files.length > ATTACH_MAX_PER_MESSAGE) {
    throw new Error(`no máximo ${ATTACH_MAX_PER_MESSAGE} arquivos por mensagem`);
  }
  const dir = attachmentsDir(threadId, home);
  mkdirSync(dir, { recursive: true });
  const out: Attachment[] = [];
  for (const f of files) {
    const declarado = String(f.mime ?? "");
    const nome = cleanName(f.name, "");
    const buf = Buffer.from(String(f.data ?? ""), "base64");
    if (buf.length === 0) throw new Error(`${nome || "arquivo"} está vazio`);
    if (buf.length > ATTACH_MAX_BYTES) throw new Error(`${nome || "arquivo"} passa de ${mb(ATTACH_MAX_BYTES)}`);
    // imagem colada (sem nome) vem só com o mime; o resto o nome diz o que é
    const ext = extensao(nome) || EXT_DE_IMAGEM[declarado] || "bin";
    const mime = IMAGE_MIMES.includes(declarado) ? declarado : mimeDoArquivo(ext);
    const imagem = IMAGE_MIMES.includes(mime);
    if (imagem && !MAGIC[mime]?.(buf)) throw new Error(`o conteúdo de ${nome || "imagem"} não é ${mime}`);
    const file = newFileName(imagem ? "img" : "arq", imagem ? (EXT_DE_IMAGEM[mime] as string) : ext);
    const path = join(dir, file);
    writeFileSync(path, buf);
    out.push({ file, name: nome || (imagem ? `imagem.${EXT_DE_IMAGEM[mime]}` : `arquivo.${ext}`), mime, bytes: buf.length, path });
  }
  return out;
}

/**
 * `nexo_arquivo_entregar`: copia o arquivo pros anexos da conversa. Cópia e não referência — o
 * agente pode apagar o temporário depois, e a rota de download só serve o que está ali dentro.
 */
export function entregarArquivo(threadId: string, origem: string, home: string, nome?: string): Attachment {
  let info;
  try {
    info = statSync(origem);
  } catch {
    throw new Error(`arquivo não existe: ${origem}`);
  }
  if (!info.isFile()) throw new Error(`não é um arquivo: ${origem}`);
  if (info.size === 0) throw new Error(`arquivo vazio: ${origem}`);
  if (info.size > ENTREGA_MAX_BYTES) throw new Error(`arquivo passa de ${mb(ENTREGA_MAX_BYTES)}: ${origem}`);
  const extDaOrigem = extensao(basename(origem));
  let rotulo = cleanName(nome, "") || cleanName(basename(origem), "arquivo");
  if (!extensao(rotulo) && extDaOrigem) rotulo = `${rotulo}.${extDaOrigem}`;
  const ext = extensao(rotulo) || extDaOrigem || "bin";
  const dir = attachmentsDir(threadId, home);
  mkdirSync(dir, { recursive: true });
  const file = newFileName("arq", ext);
  const path = join(dir, file);
  copyFileSync(origem, path);
  return { file, name: rotulo, mime: mimeDoArquivo(ext), bytes: info.size, path };
}

export function readAttachment(threadId: string, file: string, home: string): { buf: Buffer; mime: string } {
  if (!ATTACH_FILE_RE.test(file)) throw new Error(`anexo inválido: ${file}`);
  const path = join(attachmentsDir(threadId, home), file);
  if (!existsSync(path)) throw new Error(`anexo não existe: ${file}`);
  return { buf: readFileSync(path), mime: mimeDoArquivo(extensao(file)) };
}

/**
 * Link do anexo pra fora do app (painel Browser, navegador do celular): quem abre não manda o
 * bearer, então a chave vai na URL — HMAC do token sobre `thread/arquivo`. Vale só pra aquele
 * arquivo e cai junto quando o token é trocado.
 */
export function chaveDoAnexo(token: string, threadId: string, file: string): string {
  return createHmac("sha256", token).update(`${threadId}/${file}`).digest("hex").slice(0, 32);
}

export function chaveConfere(token: string, threadId: string, file: string, chave: string): boolean {
  const certa = Buffer.from(chaveDoAnexo(token, threadId, file));
  const veio = Buffer.from(String(chave));
  return certa.length === veio.length && timingSafeEqual(certa, veio);
}

/** Página e SVG rodam script: no link aberto eles vão numa origem opaca, sem ver o motor. */
const MIME_ATIVO = new Set(["text/html", "image/svg+xml"]);
const MIME_TEXTO = /^(text\/|application\/(json|yaml)$)/;
const MIME_INLINE = /^(image\/|video\/|audio\/|application\/pdf$)/;

/**
 * Cabeçalhos do link aberto: o que o navegador mostra sozinho (imagem, PDF, mídia, texto) vai
 * inline; página/SVG vão com CSP `sandbox` (sem `allow-same-origin`); o resto só baixa.
 * `baixar` força o download com o nome original.
 */
export function cabecalhosDoLink(mime: string, nome: string, baixar: boolean): Record<string, string> {
  const ativo = MIME_ATIVO.has(mime);
  const tipo = ativo ? mime : MIME_TEXTO.test(mime) ? "text/plain; charset=utf-8" : MIME_INLINE.test(mime) ? mime : "application/octet-stream";
  const ascii = nome.replace(/[^\w.\- ]/g, "_") || "arquivo";
  const inline = !baixar && (ativo || tipo !== "application/octet-stream");
  return {
    "content-type": tipo,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    ...(ativo ? { "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals" } : {}),
  };
}

export function removeThreadAttachments(threadId: string, home: string): void {
  rmSync(attachmentsDir(threadId, home), { recursive: true, force: true });
}

/**
 * O CLI recebe texto, não binário: o que vai no prompt é o caminho no disco,
 * e o próprio motor abre o arquivo com a ferramenta de leitura.
 */
export function promptWithAttachments(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((a) => `- ${a.name}: ${a.path}`).join("\n");
  return `${text}\n\nArquivos anexados nesta mensagem (abra cada um pra ver):\n${lines}`.trim();
}

const MAX_ELEMENTOS = 20;

/** Elementos do picker vindos do app, com o tamanho de cada campo limitado. */
export function lerElementos(bruto: unknown): ElementoDoPreview[] {
  if (!Array.isArray(bruto)) return [];
  return bruto
    .slice(0, MAX_ELEMENTOS)
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      rotulo: String(e.rotulo ?? "").slice(0, 40),
      seletor: String(e.seletor ?? "").slice(0, 300),
      ...(typeof e.texto === "string" && e.texto.trim() ? { texto: e.texto.trim().slice(0, 200) } : {}),
      html: String(e.html ?? "").slice(0, 4000),
    }))
    .filter((e) => e.seletor || e.html);
}

/** O que o motor recebe: o pedido + o detalhe de cada elemento (o chat mostra só os chips). */
export function textoComElementos(text: string, elementos: ElementoDoPreview[] | undefined): string {
  if (!elementos?.length) return text;
  const linhas = elementos.map((e, i) => {
    const rotulo = e.texto ? `${e.seletor} — "${e.texto}"` : e.seletor;
    return `${i + 1}. [${e.rotulo || `elemento${i + 1}`}] ${rotulo}\n   ${e.html}`;
  });
  return `${text.trim() || "(sem pedido escrito)"}\n\nElementos do preview apontados nesta mensagem:\n${linhas.join("\n")}`;
}
