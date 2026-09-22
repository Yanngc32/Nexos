import { randomBytes } from "node:crypto";
import { googleAccessToken } from "./google-auth.ts";

/** Cliente fino da API v3 do Drive (só fetch). URLs sobrescrevíveis por env pros testes. */
function apiUrl(): string {
  return process.env.NEXO_GOOGLE_API_URL ?? "https://www.googleapis.com/drive/v3";
}
function uploadUrl(): string {
  return process.env.NEXO_GOOGLE_UPLOAD_URL ?? "https://www.googleapis.com/upload/drive/v3";
}

export const MIME_PASTA = "application/vnd.google-apps.folder";

export type DriveItem = {
  id: string;
  name: string;
  mimeType: string;
  /** Só existe pra arquivo binário/texto de verdade (não pra pasta nem Google Docs). */
  md5Checksum?: string;
  modifiedTime?: string;
};

function httpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const ESPERA_MS = [500, 1500];

async function driveFetch(home: string, url: string, init: RequestInit = {}): Promise<Response> {
  let forcar = false;
  for (let tentativa = 0; ; tentativa++) {
    const token = await googleAccessToken(home, forcar);
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
    if (res.ok) return res;
    if (res.status === 401 && !forcar) {
      forcar = true;
      continue;
    }
    const retentavel = res.status === 429 || res.status >= 500;
    if (retentavel && tentativa < ESPERA_MS.length) {
      await new Promise((r) => setTimeout(r, ESPERA_MS[tentativa]));
      continue;
    }
    const corpo = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw httpError(corpo.error?.message || `Drive respondeu ${res.status}`, res.status === 404 ? 404 : res.status === 403 ? 403 : 502);
  }
}

const COMUM = "supportsAllDrives=true";
const CAMPOS = "id,name,mimeType,md5Checksum,modifiedTime";

/** Metadados de uma pasta; recusa arquivo que não é pasta. */
export async function getFolder(home: string, id: string): Promise<DriveItem> {
  const res = await driveFetch(home, `${apiUrl()}/files/${encodeURIComponent(id)}?fields=${CAMPOS}&${COMUM}`);
  const item = (await res.json()) as DriveItem;
  if (item.mimeType !== MIME_PASTA) throw httpError("o item escolhido não é uma pasta", 400);
  return item;
}

/**
 * Marca (em `appProperties`, invisível pra pessoa) da pasta onde o Nexo guarda os projetos. É por
 * ela que outro PC da mesma conta acha a pasta sozinho — inclusive uma que foi escolhida no seletor
 * e tem qualquer nome.
 */
const MARCA = "nexoRaiz";

/** Pasta marcada como raiz do Nexo nesta conta (a mais antiga, se por acaso houver mais de uma). */
export async function acharRaizNexo(home: string): Promise<DriveItem | undefined> {
  const q = encodeURIComponent(`appProperties has { key='${MARCA}' and value='1' } and mimeType = '${MIME_PASTA}' and trashed = false`);
  const res = await driveFetch(home, `${apiUrl()}/files?q=${q}&orderBy=createdTime&pageSize=10&fields=files(${CAMPOS})&includeItemsFromAllDrives=true&${COMUM}`);
  return ((await res.json()) as { files?: DriveItem[] }).files?.[0];
}

/** Marca `id` como a raiz do Nexo e desmarca qualquer outra — só uma vale por conta. */
export async function marcarRaizNexo(home: string, id: string): Promise<void> {
  const q = encodeURIComponent(`appProperties has { key='${MARCA}' and value='1' } and trashed = false`);
  const res = await driveFetch(home, `${apiUrl()}/files?q=${q}&pageSize=100&fields=files(id)&includeItemsFromAllDrives=true&${COMUM}`);
  for (const f of ((await res.json()) as { files?: { id: string }[] }).files ?? []) {
    if (f.id !== id) await patchAppProperties(home, f.id, { [MARCA]: null });
  }
  await patchAppProperties(home, id, { [MARCA]: "1" });
}

async function patchAppProperties(home: string, id: string, props: Record<string, string | null>): Promise<void> {
  await driveFetch(home, `${apiUrl()}/files/${encodeURIComponent(id)}?${COMUM}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appProperties: props }),
  });
}

export async function listChildren(home: string, folderId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const res = await driveFetch(
      home,
      `${apiUrl()}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${CAMPOS})&includeItemsFromAllDrives=true&${COMUM}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    );
    const body = (await res.json()) as { files?: DriveItem[]; nextPageToken?: string };
    out.push(...(body.files ?? []));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** Subpastas diretas de `parentId` (ordem alfabética) — usadas no navegador de pastas da escolha. */
export async function listSubfolders(home: string, parentId: string): Promise<{ id: string; name: string }[]> {
  const q = encodeURIComponent(`'${parentId}' in parents and mimeType = '${MIME_PASTA}' and trashed = false`);
  const res = await driveFetch(home, `${apiUrl()}/files?q=${q}&pageSize=1000&orderBy=name&fields=files(id,name,mimeType)&includeItemsFromAllDrives=true&${COMUM}`);
  const files = ((await res.json()) as { files?: { id: string; name: string; mimeType: string }[] }).files ?? [];
  // o filtro de mimeType já vai na query, mas confere de novo aqui: mais barato que confiar cego no `q`
  return files.filter((f) => f.mimeType === MIME_PASTA).map(({ id, name }) => ({ id, name }));
}

export async function downloadFile(home: string, id: string): Promise<Buffer> {
  const res = await driveFetch(home, `${apiUrl()}/files/${encodeURIComponent(id)}?alt=media&${COMUM}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function createFolder(home: string, parentId: string, name: string): Promise<DriveItem> {
  const res = await driveFetch(home, `${apiUrl()}/files?fields=${CAMPOS}&${COMUM}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: MIME_PASTA, parents: [parentId] }),
  });
  return (await res.json()) as DriveItem;
}

export async function createFile(home: string, parentId: string, name: string, data: Buffer): Promise<DriveItem> {
  const boundary = `nexo${randomBytes(12).toString("hex")}`;
  const meta = JSON.stringify({ name, parents: [parentId] });
  const corpo = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await driveFetch(home, `${uploadUrl()}/files?uploadType=multipart&fields=${CAMPOS}&${COMUM}`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(corpo),
  });
  return (await res.json()) as DriveItem;
}

export async function updateFile(home: string, id: string, data: Buffer): Promise<DriveItem> {
  const res = await driveFetch(home, `${uploadUrl()}/files/${encodeURIComponent(id)}?uploadType=media&fields=${CAMPOS}&${COMUM}`, {
    method: "PATCH",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(data),
  });
  return (await res.json()) as DriveItem;
}

/** Lixeira (recuperável por 30 dias), nunca exclusão definitiva. */
export async function trashFile(home: string, id: string): Promise<void> {
  await driveFetch(home, `${apiUrl()}/files/${encodeURIComponent(id)}?${COMUM}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}
