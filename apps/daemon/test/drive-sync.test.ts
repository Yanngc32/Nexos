import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { decidir, sincronizarDrive } from "../src/drive-sync.ts";
import { disconnectGoogle, googleAccessToken, googleAccount, readGoogleStore, updateGoogleStore } from "../src/google-auth.ts";
import { cancelAllGoogleLogins, googleLoginStatus, startEscolherPasta, startGoogleLogin } from "../src/google-conectar.ts";
import { projetosRoot } from "../src/projeto-dir.ts";
import { addProfile } from "../src/profiles.ts";
import { appendEvent, importarConversas, listThreads, mesclarJsonl, readThread } from "../src/threads.ts";
import { threadPath } from "../src/home.ts";
import { tempHome } from "./helpers.ts";

/* ---------- Google falso: token + Drive v3 em memória ---------- */

type FakeFile = { id: string; name: string; mimeType: string; parents: string[]; data?: Buffer; trashed: boolean; modified: number; props?: Record<string, string> };

const ROOT = "ROOTFOLDER1234567";
let server: Server;
let files: Map<string, FakeFile>;
let nextId = 1;
let relogio = Date.parse("2026-01-01T00:00:00Z");
let tokensEmitidos = 0;
let ultimoAuthCode: { challenge?: string } = {};

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const meta = (f: FakeFile) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  ...(f.data ? { md5Checksum: md5(f.data) } : {}),
  modifiedTime: new Date(f.modified).toISOString(),
});

function lerCorpo(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const partes: Buffer[] = [];
    req.on("data", (c: Buffer) => partes.push(c));
    req.on("end", () => resolve(Buffer.concat(partes)));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function novoArquivo(name: string, parent: string, data?: Buffer, mimeType = "application/octet-stream"): FakeFile {
  const f: FakeFile = { id: `F${nextId++}`.padEnd(12, "x"), name, mimeType, parents: [parent], data, trashed: false, modified: (relogio += 1000) };
  files.set(f.id, f);
  return f;
}

async function tratar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const corpo = await lerCorpo(req);
  if (url.pathname === "/token") {
    const p = new URLSearchParams(corpo.toString("utf8"));
    if (p.get("grant_type") === "refresh_token") {
      if (p.get("refresh_token") !== "rt-fake") return json(res, 400, { error: "invalid_grant" });
      tokensEmitidos++;
      return json(res, 200, { access_token: "at-fake", expires_in: 3600 });
    }
    // PKCE: o verifier tem que bater com o challenge que foi pro navegador
    const esperado = ultimoAuthCode.challenge;
    const obtido = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
    if (!esperado || esperado !== obtido) return json(res, 400, { error: "invalid_grant", error_description: "pkce" });
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "eu@exemplo.com" })).toString("base64url")}.y`;
    return json(res, 200, { access_token: "at-fake", refresh_token: "rt-fake", expires_in: 3600, id_token: idToken });
  }
  if (req.headers.authorization !== "Bearer at-fake") return json(res, 401, { error: { message: "sem auth" } });

  const idNaRota = /\/files\/([^/?]+)/.exec(url.pathname)?.[1];
  if (req.method === "GET" && url.pathname === "/drive/files") {
    const q = url.searchParams.get("q") ?? "";
    const pai = /'([^']+)' in parents/.exec(q)?.[1];
    const marca = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q);
    // o Drive de verdade responde 404 pra `'<id inexistente>' in parents` — "root" é um alias que
    // sempre existe (Meu Drive), igual na API de verdade.
    if (pai && pai !== "root" && !files.has(pai)) return json(res, 404, { error: { message: `File not found: ${pai}` } });
    const lista = [...files.values()].filter(
      (f) => !f.trashed && (pai ? f.parents.includes(pai) : marca ? f.props?.[marca[1]!] === marca[2] : false),
    );
    return json(res, 200, { files: lista.sort((a, b) => a.modified - b.modified).map(meta) });
  }
  if (req.method === "GET" && idNaRota) {
    const f = files.get(idNaRota);
    if (!f) return json(res, 404, { error: { message: "não achei" } });
    if (url.searchParams.get("alt") === "media") return void res.writeHead(200).end(f.data);
    return json(res, 200, meta(f));
  }
  if (req.method === "POST" && url.pathname === "/drive/files") {
    const b = JSON.parse(corpo.toString("utf8")) as { name: string; mimeType: string; parents: string[] };
    return json(res, 200, meta(novoArquivo(b.name, b.parents[0]!, undefined, b.mimeType)));
  }
  if (req.method === "POST" && url.pathname === "/upload/files") {
    const boundary = /boundary=(.+)$/.exec(String(req.headers["content-type"]))?.[1] ?? "";
    const texto = corpo.toString("latin1");
    const partes = texto.split(`--${boundary}`).slice(1, -1);
    const [cabMeta, cabDados] = partes.map((p) => p.replace(/^\r\n/, "").replace(/\r\n$/, ""));
    const m = JSON.parse(cabMeta!.split("\r\n\r\n")[1]!) as { name: string; parents: string[] };
    const dadosLatin = cabDados!.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    return json(res, 200, meta(novoArquivo(m.name, m.parents[0]!, Buffer.from(dadosLatin, "latin1"))));
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/upload/files/") && idNaRota) {
    const f = files.get(idNaRota)!;
    f.data = corpo;
    f.modified = relogio += 1000;
    return json(res, 200, meta(f));
  }
  if (req.method === "PATCH" && url.pathname.startsWith("/drive/files/") && idNaRota) {
    const f = files.get(idNaRota)!;
    const b = JSON.parse(corpo.toString("utf8")) as { trashed?: boolean; appProperties?: Record<string, string | null> };
    if (b.trashed) f.trashed = true;
    for (const [k, v] of Object.entries(b.appProperties ?? {})) {
      f.props ??= {};
      if (v === null) delete f.props[k];
      else f.props[k] = v;
    }
    return json(res, 200, meta(f));
  }
  json(res, 404, { error: { message: `rota desconhecida ${req.method} ${url.pathname}` } });
}

beforeAll(async () => {
  process.env.NEXO_GOOGLE_CLIENT_ID = "cid";
  server = createServer((req, res) => void tratar(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NEXO_GOOGLE_TOKEN_URL = `${base}/token`;
  process.env.NEXO_GOOGLE_AUTH_URL = `${base}/auth`;
  process.env.NEXO_GOOGLE_API_URL = `${base}/drive`;
  process.env.NEXO_GOOGLE_UPLOAD_URL = `${base}/upload`;
});

afterAll(() => {
  server.close();
  for (const k of ["TOKEN", "AUTH", "API", "UPLOAD"]) delete process.env[`NEXO_GOOGLE_${k}_URL`];
  delete process.env.NEXO_GOOGLE_CLIENT_ID;
});

beforeEach(() => {
  files = new Map([[ROOT, { id: ROOT, name: "PastaEscolhida", mimeType: "application/vnd.google-apps.folder", parents: [], trashed: false, modified: 0 }]]);
  tokensEmitidos = 0;
  ultimoAuthCode = {};
});

afterEach(() => cancelAllGoogleLogins());

/** Máquina com conta conectada e pasta do Drive escolhida. */
function maquina(): string {
  const home = tempHome();
  updateGoogleStore(home, { refreshToken: "rt-fake", email: "eu@exemplo.com", folderId: ROOT, folderName: "Nexo" });
  return home;
}

function escrever(home: string, rel: string, texto: string, mtimeSec?: number): string {
  const abs = join(projetosRoot(home), ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  // pasta de projeto de verdade sempre tem `meta.json` (ver projectDir em projeto-dir.ts) — o
  // sync ignora pasta na raiz sem ele, então o fixture precisa criar o mesmo jeito.
  const projetoDir = join(projetosRoot(home), rel.split("/")[0]!);
  const metaPath = join(projetoDir, "meta.json");
  if (!existsSync(metaPath)) {
    mkdirSync(projetoDir, { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ projectPath: projetoDir, slug: rel.split("/")[0], origem: "manual" }), "utf8");
  }
  writeFileSync(abs, texto, "utf8");
  if (mtimeSec !== undefined) utimesSync(abs, mtimeSec, mtimeSec);
  return abs;
}

const ler = (home: string, rel: string) => readFileSync(join(projetosRoot(home), ...rel.split("/")), "utf8");
const existe = (home: string, rel: string) => existsSync(join(projetosRoot(home), ...rel.split("/")));

function remotos(): string[] {
  const caminho = (f: FakeFile): string => {
    const pai = files.get(f.parents[0] ?? "");
    return pai && pai.id !== ROOT ? `${caminho(pai)}/${f.name}` : f.name;
  };
  return [...files.values()]
    .filter((f) => f.id !== ROOT && !f.trashed && f.data)
    .map(caminho)
    .sort();
}

/* ---------- lógica pura ---------- */

describe("decidir", () => {
  const o = { jsonl: false, mtimeLocal: 1, mtimeRemoto: 2 };
  it.each([
    ["igual dos dois lados", "a", "a", "a", "nada"],
    ["arquivo novo só aqui", undefined, "a", undefined, "subir"],
    ["arquivo novo só lá", undefined, undefined, "a", "baixar"],
    ["só editei aqui", "a", "b", "a", "subir"],
    ["só editaram lá", "a", "a", "b", "baixar"],
    ["apaguei aqui, lá igual", "a", undefined, "a", "apagar-remoto"],
    ["apagaram lá, aqui igual", "a", "a", undefined, "apagar-local"],
    ["apaguei aqui, editaram lá: edição vence", "a", undefined, "b", "baixar"],
    ["editei aqui, apagaram lá: edição vence", "a", "b", undefined, "subir"],
    ["nunca sincronizado, os dois diferentes: mais novo (lá) vence", undefined, "a", "b", "baixar"],
    ["os dois editaram: mais novo (lá) vence", "a", "b", "c", "baixar"],
  ] as const)("%s", (_nome, base, local, remoto, esperado) => {
    expect(decidir(base, local, remoto, o)).toBe(esperado);
  });

  it("conflito com o local mais novo sobe", () => {
    expect(decidir("a", "b", "c", { jsonl: false, mtimeLocal: 9, mtimeRemoto: 2 })).toBe("subir");
  });

  it("conflito em conversa mescla em vez de escolher lado", () => {
    expect(decidir("a", "b", "c", { jsonl: true, mtimeLocal: 1, mtimeRemoto: 2 })).toBe("mesclar");
  });
});

describe("mesclarJsonl", () => {
  const ev = (ts: string, t: string) => JSON.stringify({ ts, type: "user", text: t });
  it("une sem repetir, em ordem de ts", () => {
    const a = `${ev("2026-01-01T00:00:01Z", "um")}\n${ev("2026-01-01T00:00:03Z", "três")}\n`;
    const b = `${ev("2026-01-01T00:00:01Z", "um")}\n${ev("2026-01-01T00:00:02Z", "dois")}\n`;
    const linhas = mesclarJsonl(a, b).trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
    expect(linhas).toEqual(["um", "dois", "três"]);
  });
  it("vazio com vazio dá vazio", () => expect(mesclarJsonl("", "\n")).toBe(""));
});

/* ---------- login + escolha da pasta (tudo no navegador) ---------- */

/** Faz o papel do Google: consente e segue o redirect até a página de escolha. */
async function logar(home: string) {
  const { loginId, url } = await startGoogleLogin(home);
  const u = new URL(url);
  ultimoAuthCode = { challenge: u.searchParams.get("code_challenge") ?? undefined };
  const redirect = u.searchParams.get("redirect_uri")!;
  const state = u.searchParams.get("state")!;
  const pagina = await fetch(`${redirect}?code=abc&state=${state}`);
  return { loginId, u, redirect, state, pagina, base: new URL(redirect).origin };
}

const escolher = (base: string, state: string, corpo: unknown) =>
  fetch(`${base}/escolher?state=${state}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });

describe("entrar com Google", () => {
  it("o client embutido no app já deixa o botão disponível, sem configurar nada", () => {
    delete process.env.NEXO_GOOGLE_CLIENT_ID;
    try {
      expect(googleAccount(tempHome()).disponivel).toBe(true);
    } finally {
      process.env.NEXO_GOOGLE_CLIENT_ID = "cid";
    }
  });

  it("o <script> embutido na página 'onde guardar?' é JS válido", async () => {
    // guarda contra escape de \ engolido pelo template literal do servidor (já aconteceu:
    // \/ virou / e formou um "//" que comentou o resto da linha)
    const home = tempHome();
    const { pagina } = await logar(home);
    const texto = await pagina.text();
    const m = texto.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error("script não encontrado no HTML");
    expect(() => new Function(m[1])).not.toThrow();
  });

  it("colar link de pasta do Drive extrai o id certo (idDaPastaNoLink)", async () => {
    const home = tempHome();
    const { pagina } = await logar(home);
    const texto = await pagina.text();
    const m = texto.match(/<script>([\s\S]*)<\/script>/)!;
    // roda o script de verdade (mesmo bug de escape de \/ já pegou aqui antes) e pega a função de volta
    const documentFake = { getElementById: () => ({ addEventListener() {}, style: {} }), querySelectorAll: () => [] };
    const idDaPastaNoLink = new Function("document", "fetch", `${m[1]}\nreturn idDaPastaNoLink;`)(documentFake, () => {});
    expect(idDaPastaNoLink("https://drive.google.com/drive/u/1/folders/1hnmxcBXvN7zndwc-up1_jlak_jXUpdUJ")).toBe(
      "1hnmxcBXvN7zndwc-up1_jlak_jXUpdUJ",
    );
    expect(idDaPastaNoLink("https://drive.google.com/drive/folders/ABC123?usp=sharing")).toBe("ABC123");
    expect(idDaPastaNoLink("https://drive.google.com/open?id=XYZ789")).toBe("XYZ789");
    expect(idDaPastaNoLink("https://exemplo.com/folders/ABC123")).toBe(null); // domínio errado
    expect(idDaPastaNoLink("não é um link")).toBe(null);
  });

  it("login pede o Drive completo com PKCE e cai direto na página 'onde guardar?'", async () => {
    const home = tempHome();
    const { loginId, u, pagina } = await logar(home);
    expect(u.searchParams.get("scope")).toContain("auth/drive");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(pagina.status).toBe(200);
    const texto = await pagina.text();
    expect(texto).toContain("Onde guardar seus projetos?");
    expect(texto).toContain("eu@exemplo.com");
    expect(texto).toContain("Criar a pasta");
    expect(texto).toContain("Escolher outra pasta"); // navegador de pastas próprio
    expect(texto).not.toContain("Continuar em"); // conta sem pasta ainda
    expect(texto).not.toContain("at-fake"); // token nunca vai pro navegador — /pastas roda no daemon
    expect(googleLoginStatus(loginId).state).toBe("choosing");
    expect(readGoogleStore(home).refreshToken).toBe("rt-fake");
  });

  it("'Criar a pasta Nexo' cria, marca e conclui", async () => {
    const home = tempHome();
    const { loginId, base, state } = await logar(home);
    const r = await escolher(base, state, { acao: "criar" });
    expect(r.status).toBe(200);
    const status = googleLoginStatus(loginId);
    expect(status).toMatchObject({ state: "done", email: "eu@exemplo.com", folder: { name: "Nexo" } });
    const pasta = files.get(status.folder!.id)!;
    expect(pasta.parents).toEqual(["root"]);
    expect(pasta.props).toEqual({ nexoRaiz: "1" });
    expect(readGoogleStore(home).folderId).toBe(pasta.id);
  });

  it("segundo PC da mesma conta vê 'Continuar em …' com a pasta do primeiro", async () => {
    const a = tempHome();
    const la = await logar(a);
    await escolher(la.base, la.state, { acao: "criar" });

    const b = tempHome();
    const lb = await logar(b);
    expect(await lb.pagina.text()).toContain("Continuar em “Nexo”");
    const idA = readGoogleStore(a).folderId!;
    await escolher(lb.base, lb.state, { acao: "existente", id: idA });
    expect(readGoogleStore(b).folderId).toBe(idA);
    expect([...files.values()].filter((f) => f.name === "Nexo")).toHaveLength(1);
  });

  it("pasta escolhida no seletor vira a raiz e tira a marca da anterior", async () => {
    const home = tempHome();
    const l = await logar(home);
    await escolher(l.base, l.state, { acao: "criar" });
    const antiga = readGoogleStore(home).folderId!;

    const outra = novoArquivo("Trabalho", "root", undefined, "application/vnd.google-apps.folder");
    const { loginId, url } = await startEscolherPasta(home);
    const u = new URL(url);
    const r = await escolher(u.origin, u.searchParams.get("state")!, { acao: "escolhida", id: outra.id });
    expect(r.status).toBe(200);
    expect(googleLoginStatus(loginId)).toMatchObject({ state: "done", folder: { id: outra.id, name: "Trabalho" } });
    expect(readGoogleStore(home).folderId).toBe(outra.id);
    expect(files.get(outra.id)!.props).toEqual({ nexoRaiz: "1" });
    expect(files.get(antiga)!.props).toEqual({});
  });

  it("/pastas lista só subpastas do parent pedido, pra montar o navegador", async () => {
    const home = tempHome();
    const l = await logar(home);
    const trabalho = novoArquivo("Trabalho", "root", undefined, "application/vnd.google-apps.folder");
    novoArquivo("nota.txt", "root", Buffer.from("x")); // arquivo solto na raiz não deve aparecer
    const filha = novoArquivo("Projetos", trabalho.id, undefined, "application/vnd.google-apps.folder");

    const raiz = await fetch(`${l.base}/pastas?state=${l.state}&parent=root`);
    expect((await raiz.json()).items).toEqual([{ id: trabalho.id, name: "Trabalho" }]);

    const dentro = await fetch(`${l.base}/pastas?state=${l.state}&parent=${trabalho.id}`);
    expect((await dentro.json()).items).toEqual([{ id: filha.id, name: "Projetos" }]);

    const r = await escolher(l.base, l.state, { acao: "escolhida", id: filha.id });
    expect(r.status).toBe(200);
    expect(googleLoginStatus(l.loginId)).toMatchObject({ folder: { id: filha.id, name: "Projetos" } });
  });

  it("escolher um arquivo (não pasta) é recusado", async () => {
    const home = tempHome();
    const l = await logar(home);
    const arq = novoArquivo("nota.txt", "root", Buffer.from("x"));
    const r = await escolher(l.base, l.state, { acao: "escolhida", id: arq.id });
    expect(r.status).toBe(400);
    expect(googleLoginStatus(l.loginId).state).toBe("choosing");
  });

  it("escolher a raiz do Meu Drive é recusado, com mensagem clara", async () => {
    const home = tempHome();
    const l = await logar(home);
    const r = await escolher(l.base, l.state, { acao: "escolhida", id: "root" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/raiz do Meu Drive/);
    expect(googleLoginStatus(l.loginId).state).toBe("choosing");
  });

  it("sem o state certo, nem callback nem escolha respondem", async () => {
    const home = tempHome();
    const { loginId, url } = await startGoogleLogin(home);
    const redirect = new URL(url).searchParams.get("redirect_uri")!;
    expect((await fetch(`${redirect}?code=x&state=errado`)).status).toBe(400);
    expect((await escolher(new URL(redirect).origin, "errado", { acao: "criar" })).status).toBe(400);
    expect(googleLoginStatus(loginId).state).toBe("waiting");
    expect([...files.values()].some((f) => f.name === "Nexo")).toBe(false);
  });

  it("escolha antes de terminar o login é recusada", async () => {
    const home = tempHome();
    const { url } = await startGoogleLogin(home);
    const u = new URL(url);
    const r = await escolher(new URL(u.searchParams.get("redirect_uri")!).origin, u.searchParams.get("state")!, { acao: "criar" });
    expect(r.status).toBe(409);
  });

  it("usuário negando no Google vira falha legível", async () => {
    const home = tempHome();
    const { loginId, url } = await startGoogleLogin(home);
    const u = new URL(url);
    await fetch(`${u.searchParams.get("redirect_uri")}?error=access_denied&state=${u.searchParams.get("state")}`);
    expect(googleLoginStatus(loginId)).toMatchObject({ state: "failed", message: expect.stringContaining("cancelou") });
  });

  it("trocar pasta sem estar conectado não abre nada", async () => {
    await expect(startEscolherPasta(tempHome())).rejects.toThrow(/não conectada/);
  });

  it("refresh token revogado desconecta a conta local", async () => {
    const home = tempHome();
    updateGoogleStore(home, { refreshToken: "revogado" });
    await expect(googleAccessToken(home)).rejects.toThrow(/revogado/);
    expect(googleAccount(home).connected).toBe(false);
  });

  it("guarda o access token em cache (um refresh só)", async () => {
    const home = maquina();
    await googleAccessToken(home);
    await googleAccessToken(home);
    expect(tokensEmitidos).toBe(1);
  });

  it("desconectar mantém a pasta lembrada", () => {
    const home = maquina();
    disconnectGoogle(home);
    expect(googleAccount(home)).toMatchObject({ connected: false, disponivel: true, folder: { id: ROOT } });
  });
});

/* ---------- sync ---------- */

describe("sync com o Drive", () => {
  it("sem conta, avisa em vez de rodar", async () => {
    const r = await sincronizarDrive(tempHome());
    expect(r.erros[0]).toMatch(/não conectada/);
  });

  it("sem pasta escolhida, cria a 'Nexo' na raiz do Drive (uma vez só) e sincroniza nela", async () => {
    const home = tempHome();
    updateGoogleStore(home, { refreshToken: "rt-fake" });
    escrever(home, "proj/memoria/M.md", "oi");
    const r = await sincronizarDrive(home);
    expect(r.erros).toEqual([]);
    const pastas = [...files.values()].filter((f) => f.name === "Nexo" && f.parents.includes("root"));
    expect(pastas).toHaveLength(1);
    expect(readGoogleStore(home).folderId).toBe(pastas[0]!.id);
    expect(remotos()).toEqual(["Nexo/proj/memoria/M.md"]);

    await sincronizarDrive(home);
    expect([...files.values()].filter((f) => f.name === "Nexo")).toHaveLength(1);
  });

  it("outro PC da mesma conta reaproveita a 'Nexo' que já existe", async () => {
    const a = tempHome();
    updateGoogleStore(a, { refreshToken: "rt-fake" });
    escrever(a, "proj/memoria/M.md", "do A");
    await sincronizarDrive(a);

    const b = tempHome();
    updateGoogleStore(b, { refreshToken: "rt-fake" });
    const r = await sincronizarDrive(b);
    expect(r.erros).toEqual([]);
    expect(ler(b, "proj/memoria/M.md")).toBe("do A");
    expect([...files.values()].filter((f) => f.name === "Nexo")).toHaveLength(1);
  });

  it("pasta apagada no Drive: esquece o id e a rodada seguinte recria", async () => {
    const home = tempHome();
    updateGoogleStore(home, { refreshToken: "rt-fake", folderId: "PASTAQUENAOEXISTE1", folderName: "Nexo" });
    const r = await sincronizarDrive(home);
    expect(r.erros[0]).toMatch(/não existe mais/);
    expect(readGoogleStore(home).folderId).toBeUndefined();
    escrever(home, "proj/memoria/M.md", "x");
    expect((await sincronizarDrive(home)).erros).toEqual([]);
    expect(remotos()).toEqual(["Nexo/proj/memoria/M.md"]);
  });

  it("sobe tudo (menos meta.json) e outra máquina baixa", async () => {
    const a = maquina();
    escrever(a, "proj/memoria/MEMORIA.md", "lembrar disso");
    escrever(a, "proj/tarefas/quadro.md", "quadro");
    escrever(a, "proj/meta.json", '{"projectPath":"C:/a"}');
    const ra = await sincronizarDrive(a);
    expect(ra.erros).toEqual([]);
    expect(ra.subiu).toBe(2);
    expect(remotos()).toEqual(["proj/memoria/MEMORIA.md", "proj/tarefas/quadro.md"]);

    const b = maquina();
    const rb = await sincronizarDrive(b);
    expect(rb.erros).toEqual([]);
    expect(rb.baixou).toBe(2);
    expect(ler(b, "proj/memoria/MEMORIA.md")).toBe("lembrar disso");
    expect(existe(b, "proj/meta.json")).toBe(false);
  });

  it("rodar de novo sem mudança não faz nada", async () => {
    const a = maquina();
    escrever(a, "proj/memoria/MEMORIA.md", "x");
    await sincronizarDrive(a);
    const r = await sincronizarDrive(a);
    expect(r).toMatchObject({ subiu: 0, baixou: 0, apagouLocal: 0, apagouRemoto: 0, mesclou: 0, erros: [] });
  });

  it("edição e exclusão viajam nos dois sentidos", async () => {
    const a = maquina();
    const b = maquina();
    escrever(a, "proj/memoria/M.md", "v1");
    escrever(a, "proj/memoria/N.md", "vai sumir");
    await sincronizarDrive(a);
    await sincronizarDrive(b);

    escrever(b, "proj/memoria/M.md", "v2 do B");
    rmLocal(b, "proj/memoria/N.md");
    const rb = await sincronizarDrive(b);
    expect(rb).toMatchObject({ subiu: 1, apagouRemoto: 1, erros: [] });

    const ra = await sincronizarDrive(a);
    expect(ra).toMatchObject({ baixou: 1, apagouLocal: 1, erros: [] });
    expect(ler(a, "proj/memoria/M.md")).toBe("v2 do B");
    expect(existe(a, "proj/memoria/N.md")).toBe(false);
  });

  it("conflito em arquivo comum: o mais recente vence", async () => {
    const a = maquina();
    const b = maquina();
    escrever(a, "proj/memoria/M.md", "base");
    await sincronizarDrive(a);
    await sincronizarDrive(b);

    escrever(a, "proj/memoria/M.md", "edição velha do A", 1_700_000_000); // mtime antigo
    escrever(b, "proj/memoria/M.md", "edição nova do B");
    await sincronizarDrive(b); // B sobe: Drive passa a ter o mtime "agora"
    const ra = await sincronizarDrive(a);
    expect(ra.erros).toEqual([]);
    expect(ler(a, "proj/memoria/M.md")).toBe("edição nova do B");
  });

  it("conflito em conversa (.jsonl) mescla as duas pontas", async () => {
    const ev = (ts: string, text: string) => `${JSON.stringify({ ts, type: "user", text })}\n`;
    const a = maquina();
    const b = maquina();
    escrever(a, "proj/conversas/t-1.jsonl", ev("2026-02-01T00:00:01Z", "início"));
    await sincronizarDrive(a);
    await sincronizarDrive(b);

    escrever(a, "proj/conversas/t-1.jsonl", ev("2026-02-01T00:00:01Z", "início") + ev("2026-02-01T00:00:02Z", "só no A"));
    escrever(b, "proj/conversas/t-1.jsonl", ev("2026-02-01T00:00:01Z", "início") + ev("2026-02-01T00:00:03Z", "só no B"));
    await sincronizarDrive(b);
    const ra = await sincronizarDrive(a);
    expect(ra).toMatchObject({ mesclou: 1, erros: [] });
    await sincronizarDrive(b); // B recebe a versão mesclada

    for (const home of [a, b]) {
      const textos = ler(home, "proj/conversas/t-1.jsonl").trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
      expect(textos).toEqual(["início", "só no A", "só no B"]);
    }
  });

  it("Drive esvaziado por acidente não apaga o que está aqui: sobe de novo", async () => {
    const a = maquina();
    escrever(a, "proj/memoria/M.md", "importante");
    await sincronizarDrive(a);
    for (const f of files.values()) if (f.id !== ROOT) f.trashed = true;

    const r = await sincronizarDrive(a);
    expect(r).toMatchObject({ apagouLocal: 0, subiu: 1, erros: [] });
    expect(ler(a, "proj/memoria/M.md")).toBe("importante");
    expect(remotos()).toEqual(["proj/memoria/M.md"]);
  });

  it("nome vindo do Drive que escaparia da raiz é ignorado", async () => {
    const a = maquina();
    novoArquivo("..", ROOT, Buffer.from("x"));
    novoArquivo("a\\b.md", ROOT, Buffer.from("x"));
    novoArquivo("c:evil.md", ROOT, Buffer.from("x"));
    const pasta = novoArquivo("proj", ROOT, undefined, "application/vnd.google-apps.folder");
    novoArquivo("bom.md", pasta.id, Buffer.from("ok"));

    const r = await sincronizarDrive(a);
    expect(r.erros).toEqual([]);
    expect(readdirSync(projetosRoot(a)).sort()).toEqual(["proj"]);
    expect(ler(a, "proj/bom.md")).toBe("ok");
  });

  it("Google Docs na pasta (sem md5) não entra no sync", async () => {
    const a = maquina();
    novoArquivo("planilha", ROOT, undefined, "application/vnd.google-apps.spreadsheet");
    const r = await sincronizarDrive(a);
    expect(r).toMatchObject({ baixou: 0, erros: [] });
  });

  it("uma rodada por vez: chamadas simultâneas dividem a mesma execução", async () => {
    const a = maquina();
    escrever(a, "proj/memoria/M.md", "x");
    const [r1, r2] = await Promise.all([sincronizarDrive(a), sincronizarDrive(a)]);
    expect(r1).toBe(r2);
    expect(remotos()).toEqual(["proj/memoria/M.md"]);
  });
});

function rmLocal(home: string, rel: string): void {
  rmSync(join(projetosRoot(home), ...rel.split("/")), { force: true });
}

/* ---------- conversas: espelho + importação ---------- */

describe("conversas no projeto", () => {
  function projetoLocal(home: string, nome: string): string {
    const pasta = join(mkdtempSync(join(tmpdir(), "nexo-proj-")), nome);
    mkdirSync(pasta, { recursive: true });
    saveConfig(home, { repos: [pasta] });
    addProfile({ id: "p1", engine: "stub" }, home);
    return pasta;
  }

  it("evento novo é espelhado em projetos/<slug>/conversas/", () => {
    const home = tempHome();
    const pasta = projetoLocal(home, "meu-app");
    appendEvent({ ts: "2026-03-01T00:00:00Z", type: "thread_meta", threadId: "t-1", projectPath: pasta, profileId: "p1" }, home);
    appendEvent({ ts: "2026-03-01T00:00:01Z", type: "user", threadId: "t-1", text: "oi" }, home);
    const espelho = ler(home, "meu-app/conversas/t-1.jsonl");
    expect(espelho).toBe(readFileSync(threadPath("t-1", home), "utf8"));
  });

  it("conversa que nasceu em outra máquina aparece aqui, reapontada pro projeto local", async () => {
    const home = maquina();
    const pasta = projetoLocal(home, "meu-app");
    const remota = [
      { ts: "2026-03-01T00:00:00Z", type: "thread_meta", threadId: "t-9", projectPath: "D:/outro/pc/meu-app", profileId: "perfil-do-outro-pc", worktreeDir: "D:/wt", branch: "x" },
      { ts: "2026-03-01T00:00:01Z", type: "user", threadId: "t-9", text: "feita no outro PC" },
    ];
    // a outra máquina sobe a conversa pelo Drive
    const pai = novoArquivo("meu-app", ROOT, undefined, "application/vnd.google-apps.folder");
    const conv = novoArquivo("conversas", pai.id, undefined, "application/vnd.google-apps.folder");
    novoArquivo("t-9.jsonl", conv.id, Buffer.from(`${remota.map((e) => JSON.stringify(e)).join("\n")}\n`));

    const r = await sincronizarDrive(home);
    expect(r.erros).toEqual([]);
    const lista = listThreads(pasta, home);
    expect(lista.map((t) => t.id)).toEqual(["t-9"]);
    expect(lista[0]).toMatchObject({ profileId: "p1", preview: "feita no outro PC" });
    expect(lista[0]?.worktreeDir).toBeUndefined();
  });

  it("linhas novas de uma conversa já existente são incorporadas sem duplicar", () => {
    const home = tempHome();
    const pasta = projetoLocal(home, "meu-app");
    appendEvent({ ts: "2026-03-01T00:00:00Z", type: "thread_meta", threadId: "t-2", projectPath: pasta, profileId: "p1" }, home);
    appendEvent({ ts: "2026-03-01T00:00:01Z", type: "user", threadId: "t-2", text: "aqui" }, home);
    const espelho = join(projetosRoot(home), "meu-app", "conversas", "t-2.jsonl");
    writeFileSync(espelho, `${readFileSync(espelho, "utf8")}${JSON.stringify({ ts: "2026-03-01T00:00:02Z", type: "user", threadId: "t-2", text: "lá" })}\n`);
    expect(importarConversas(home)).toBe(1);
    expect(readThread("t-2", home).map((e) => (e.type === "user" ? e.text : e.type))).toEqual(["thread_meta", "aqui", "lá"]);
    expect(importarConversas(home)).toBe(0); // idempotente
  });
});
