import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACH_MAX_BYTES, ATTACH_MAX_PER_MESSAGE, IMAGE_MIMES, type Attachment } from "@nexo/shared";
import { attachmentsDir } from "./home.ts";
import { assertSlug } from "./ids.ts";

/** O que o cliente manda junto da mensagem: bytes em base64, sem caminho nenhum. */
export type IncomingImage = { name?: string; mime: string; data: string };

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Assinatura do formato: o mime que o cliente declara não decide nada sozinho. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 6).toString("latin1").startsWith("GIF8"),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** Nome do arquivo no disco: só o que a rota de download aceita servir. */
export const ATTACH_FILE_RE = /^img-[a-z0-9]+-[a-z0-9]+\.(?:png|jpg|gif|webp)$/;

function newFileName(ext: string): string {
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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

export function saveImages(threadId: string, images: IncomingImage[], home: string): Attachment[] {
  assertSlug(threadId);
  if (images.length > ATTACH_MAX_PER_MESSAGE) {
    throw new Error(`no máximo ${ATTACH_MAX_PER_MESSAGE} imagens por mensagem`);
  }
  const dir = attachmentsDir(threadId, home);
  mkdirSync(dir, { recursive: true });
  const out: Attachment[] = [];
  for (const image of images) {
    const mime = String(image.mime ?? "");
    if (!IMAGE_MIMES.includes(mime)) throw new Error(`formato não suportado: ${mime || "sem mime"}`);
    const buf = Buffer.from(String(image.data ?? ""), "base64");
    if (buf.length === 0) throw new Error("imagem vazia");
    if (buf.length > ATTACH_MAX_BYTES) {
      throw new Error(`imagem maior que ${Math.floor(ATTACH_MAX_BYTES / (1024 * 1024))} MB`);
    }
    if (!MAGIC[mime]?.(buf)) throw new Error(`o conteúdo não é ${mime}`);
    const ext = EXT[mime] as string;
    const file = newFileName(ext);
    const path = join(dir, file);
    writeFileSync(path, buf);
    out.push({ file, name: cleanName(image.name, `imagem.${ext}`), mime, bytes: buf.length, path });
  }
  return out;
}

export function readAttachment(threadId: string, file: string, home: string): { buf: Buffer; mime: string } {
  assertSlug(threadId);
  if (!ATTACH_FILE_RE.test(file)) throw new Error(`anexo inválido: ${file}`);
  const path = join(attachmentsDir(threadId, home), file);
  if (!existsSync(path)) throw new Error(`anexo não existe: ${file}`);
  const ext = file.split(".").pop() as string;
  const mime = Object.keys(EXT).find((m) => EXT[m] === ext) ?? "application/octet-stream";
  return { buf: readFileSync(path), mime };
}

export function removeThreadAttachments(threadId: string, home: string): void {
  assertSlug(threadId);
  rmSync(attachmentsDir(threadId, home), { recursive: true, force: true });
}

/**
 * O CLI recebe texto, não binário: o que vai no prompt é o caminho no disco,
 * e o próprio motor abre o arquivo com a ferramenta de leitura.
 */
export function promptWithAttachments(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((a) => `- ${a.path}`).join("\n");
  return `${text}\n\nImagens anexadas nesta mensagem (abra cada arquivo pra ver):\n${lines}`.trim();
}
