import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { criarPastaNexo, NOME_PASTA_NEXO, usarPastaDrive } from "./drive-sync.ts";
import { acharRaizNexo, listSubfolders } from "./google-drive.ts";
import {
  authUrl,
  emailDoIdToken,
  googleClient,
  limparCacheToken,
  pkce,
  postToken,
  readGoogleStore,
  SCOPES,
  updateGoogleStore,
} from "./google-auth.ts";

/**
 * "Entrar com Google" de ponta a ponta, tudo no navegador da pessoa: consentimento do Google →
 * página "Onde guardar seus projetos?" (continuar na pasta que outro PC já usa, criar "Nexo" no
 * Meu Drive ou escolher outra no seletor do próprio Google) → "Pronto". O app só acompanha o estado.
 *
 * Servidor HTTP efêmero em `127.0.0.1:<porta livre>` (RFC 8252), PKCE S256, e o mesmo `state`
 * aleatório protege o callback E as rotas da página de escolha — nada ali responde sem ele.
 */
const SESSION_TTL = 15 * 60 * 1000;

export type ConectarEstado = "waiting" | "choosing" | "done" | "failed";
export type ConectarStatus = { state: ConectarEstado; email?: string; folder?: { id: string; name: string }; message?: string };

type Sessao = {
  id: string;
  home: string;
  segredo: string;
  server: Server;
  state: ConectarEstado;
  email?: string;
  folder?: { id: string; name: string };
  message?: string;
  ttl: NodeJS.Timeout;
};

type Rotas = (s: Sessao, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

const sessoes = new Map<string, Sessao>();

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function parar(id: string): void {
  const s = sessoes.get(id);
  if (!s) return;
  clearTimeout(s.ttl);
  sessoes.delete(id);
  s.server.close();
  s.server.closeAllConnections?.();
}

export function cancelGoogleLogin(loginId: string): void {
  parar(loginId);
}

/** Usado nos testes: não deixa servidor local órfão entre casos. */
export function cancelAllGoogleLogins(): void {
  for (const id of [...sessoes.keys()]) parar(id);
}

async function abrirServidor(home: string, estadoInicial: ConectarEstado, rotas: Rotas): Promise<Sessao> {
  cancelAllGoogleLogins();
  const sessao = { id: randomBytes(8).toString("hex"), home, segredo: randomBytes(16).toString("hex"), state: estadoInicial } as Sessao;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // `state` errado = outra origem tentando injetar código ou escolher pasta: ignora sem encerrar
    if (url.searchParams.get("state") !== sessao.segredo) {
      html(res, 400, pagina("Link inválido", "<p>Volte pro Nexo e tente de novo.</p>"));
      return;
    }
    rotas(sessao, req, res, url).catch((e: Error) => {
      if (!res.headersSent) html(res, 500, pagina("Não deu certo", `<p>${esc(e.message)}</p>`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  }).catch((e: Error) => {
    throw httpError(`não deu pra abrir a porta local do login: ${e.message}`, 500);
  });
  sessao.server = server;
  sessao.ttl = setTimeout(() => parar(sessao.id), SESSION_TTL);
  sessoes.set(sessao.id, sessao);
  return sessao;
}

const base = (s: Sessao) => `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;

function html(res: ServerResponse, status: number, corpo: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(corpo);
}

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(corpo));
}

/** Clique em "Entrar com Google": devolve a URL pra abrir no navegador. */
export async function startGoogleLogin(home: string): Promise<{ loginId: string; url: string }> {
  const client = googleClient();
  if (!client) throw httpError("login com Google indisponível nesta versão do Nexo", 400);
  const { verifier, challenge } = pkce();

  const sessao = await abrirServidor(home, "waiting", (s, req, res, url) =>
    url.pathname === "/callback" ? callback(s, res, url, client, verifier) : rotasEscolha(s, req, res, url),
  );

  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: `${base(sessao)}/callback`,
    response_type: "code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: sessao.segredo,
    access_type: "offline",
    // sem isso o Google só devolve refresh token na PRIMEIRA autorização da conta
    prompt: "consent",
  });
  return { loginId: sessao.id, url: `${authUrl()}?${params.toString()}` };
}

/** "Trocar pasta" com a conta já conectada: abre direto a página de escolha, sem novo login. */
export async function startEscolherPasta(home: string): Promise<{ loginId: string; url: string }> {
  const store = readGoogleStore(home);
  if (!store.refreshToken) throw httpError("conta Google não conectada", 400);
  const sessao = await abrirServidor(home, "choosing", (s, req, res, url) => rotasEscolha(s, req, res, url));
  if (store.email) sessao.email = store.email;
  return { loginId: sessao.id, url: `${base(sessao)}/escolher?state=${sessao.segredo}` };
}

async function callback(s: Sessao, res: ServerResponse, url: URL, client: { clientId: string; clientSecret: string }, verifier: string): Promise<void> {
  const erro = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (erro || !code) {
    s.state = "failed";
    s.message = erro === "access_denied" ? "você cancelou a autorização" : `o Google recusou o login (${erro ?? "sem código"})`;
    html(res, 200, pagina("Login cancelado", `<p>${esc(s.message)}. Pode fechar esta aba.</p>`));
    return;
  }
  try {
    const tok = await postToken({
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      code,
      code_verifier: verifier,
      redirect_uri: `${base(s)}/callback`,
      grant_type: "authorization_code",
    });
    if (!tok.refresh_token) throw new Error("o Google não devolveu acesso permanente — tente de novo");
    s.email = emailDoIdToken(tok.id_token);
    updateGoogleStore(s.home, { refreshToken: tok.refresh_token, email: s.email, connectedAt: new Date().toISOString() });
    limparCacheToken();
    s.state = "choosing";
  } catch (e) {
    s.state = "failed";
    s.message = (e as Error).message;
    html(res, 200, pagina("Não deu certo", `<p>${esc(s.message)}</p>`));
    return;
  }
  res.writeHead(302, { location: `/escolher?state=${s.segredo}` }).end();
}

async function rotasEscolha(s: Sessao, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (s.state !== "choosing" && s.state !== "done") {
    html(res, 409, pagina("Ainda não", "<p>Termine o login primeiro.</p>"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/escolher") {
    const existente = await acharRaizNexo(s.home);
    html(res, 200, paginaEscolha(s, existente && { id: existente.id, name: existente.name }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/pastas") {
    const pai = url.searchParams.get("parent") || "root";
    const items = await listSubfolders(s.home, pai);
    json(res, 200, { items });
    return;
  }
  if (req.method === "POST" && url.pathname === "/escolher") {
    const corpo = await lerJson(req);
    const id = typeof corpo.id === "string" ? corpo.id : "";
    let pasta: { id: string; name: string };
    if (corpo.acao === "criar") {
      pasta = await criarPastaNexo(s.home);
      updateGoogleStore(s.home, { folderId: pasta.id, folderName: pasta.name });
    } else if ((corpo.acao === "escolhida" || corpo.acao === "existente") && id) {
      pasta = await usarPastaDrive(s.home, id);
    } else {
      json(res, 400, { error: "escolha inválida" });
      return;
    }
    s.folder = pasta;
    s.state = "done";
    json(res, 200, { ok: true, folder: pasta });
    return;
  }
  res.writeHead(404).end();
}

function lerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let t = "";
    req.on("data", (c: Buffer) => {
      if (t.length < 10_000) t += c.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(t) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

export function googleLoginStatus(loginId: string): ConectarStatus {
  const s = sessoes.get(loginId);
  if (!s) throw httpError("sessão de login expirou — comece de novo", 400);
  const out: ConectarStatus = {
    state: s.state,
    ...(s.email ? { email: s.email } : {}),
    ...(s.folder ? { folder: s.folder } : {}),
    ...(s.message ? { message: s.message } : {}),
  };
  if (s.state === "failed") parar(loginId);
  // "done" segura o servidor uns segundos: a página ainda pode estar recebendo o "Pronto"
  if (s.state === "done") setTimeout(() => parar(loginId), 3000).unref();
  return out;
}

/* ---------- páginas ---------- */

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** Valor JS dentro de <script>: JSON sem `<` pra não fechar a tag. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const ESTILO = `
:root{color-scheme:light dark;--bg:#16151c;--card:#1f1e27;--tx:#ecebf2;--mut:#a4a2b3;--ac:#7c5cff;--bd:#2e2c3a}
@media (prefers-color-scheme:light){:root{--bg:#f5f4f9;--card:#fff;--tx:#1c1b22;--mut:#5f5d6e;--bd:#e3e1ec}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--tx);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(440px,92vw);background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:32px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 20px;color:var(--mut)}
.marca{font-weight:700;letter-spacing:.02em;color:var(--ac);margin-bottom:18px}
button{display:block;width:100%;padding:12px 16px;margin-top:10px;border-radius:10px;border:1px solid var(--bd);background:transparent;color:var(--tx);font:inherit;cursor:pointer;text-align:left}
button:hover{border-color:var(--ac)}
button.pri{background:var(--ac);border-color:var(--ac);color:#fff;font-weight:600}
button small{display:block;opacity:.75;font-weight:400}
button:disabled{opacity:.5;cursor:wait}
.erro{color:#ff6b6b;margin-top:14px}
.crumbs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}
.crumbs button{display:inline;width:auto;padding:4px 8px;margin:0;font-size:13px}
.crumbs button:last-child{color:var(--tx);font-weight:600;border-color:var(--ac)}
#lista{list-style:none;margin:0 0 16px;padding:0;max-height:260px;overflow:auto;border:1px solid var(--bd);border-radius:10px}
#lista li{padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--bd)}
#lista li:last-child{border-bottom:none}
#lista li:hover{background:var(--ac);color:#fff}
#lista .vazio{padding:14px;color:var(--mut);cursor:default}
#lista .vazio:hover{background:none;color:var(--mut)}`;

function pagina(titulo: string, corpo: string): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nexo — ${esc(titulo)}</title><style>${ESTILO}</style><body><div class="card"><div class="marca">Nexo</div><h1>${esc(titulo)}</h1>${corpo}</div>`;
}

function paginaEscolha(s: Sessao, existente: { id: string; name: string } | undefined): string {
  const botoes = [
    existente
      ? `<button class="pri" data-acao="existente" data-id="${esc(existente.id)}">Continuar em “${esc(existente.name)}”<small>A pasta que você já usa em outro computador</small></button>`
      : "",
    `<button class="${existente ? "" : "pri"}" data-acao="criar">Criar a pasta “${NOME_PASTA_NEXO}” no Meu Drive<small>Recomendado — o Nexo cuida de tudo</small></button>`,
    `<button data-acao="navegar">Escolher outra pasta…<small>Navegue até a pasta do seu Drive</small></button>`,
  ].join("");
  const quem = s.email ? `Conectado como <strong>${esc(s.email)}</strong>. ` : "";
  return pagina(
    "Onde guardar seus projetos?",
    `<p>${quem}Memória, tarefas e conversas ficam nessa pasta e aparecem iguais em todos os seus computadores.</p>
<div id="botoes">${botoes}</div>
<div id="navegador" style="display:none">
  <nav class="crumbs" id="crumbs"></nav>
  <ul id="lista"></ul>
  <button class="pri" id="usarAtual" type="button"></button>
  <button id="cancelarNav" type="button">Voltar</button>
</div>
<div id="erro" class="erro"></div>
<script>
const STATE=${js(s.segredo)};
let crumbs=[{id:"root",name:"Meu Drive"}];
const travar=(v)=>document.querySelectorAll("button").forEach(b=>b.disabled=v);
const erro=(m)=>{document.getElementById("erro").textContent=m;travar(false)};
async function escolher(corpo){
  travar(true);
  try{
    const r=await fetch("/escolher?state="+STATE,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(corpo)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)return erro(j.error||"Não deu certo. Tente de novo.");
    const card=document.querySelector(".card");
    card.innerHTML='<div class="marca">Nexo</div><h1>Pronto!</h1><p></p>';
    card.querySelector("p").textContent="Seus projetos vão ficar em “"+j.folder.name+"”. Pode fechar esta aba e voltar pro Nexo.";
  }catch(e){erro("Não deu certo: "+e.message)}
}
function abrirNavegador(){
  document.getElementById("botoes").style.display="none";
  document.getElementById("navegador").style.display="block";
  carregar();
}
function fecharNavegador(){
  document.getElementById("navegador").style.display="none";
  document.getElementById("botoes").style.display="block";
  erro("");
}
function renderCrumbs(){
  const nav=document.getElementById("crumbs");
  nav.innerHTML="";
  crumbs.forEach((c,i)=>{
    const b=document.createElement("button");
    b.type="button";b.textContent=c.name;
    b.addEventListener("click",()=>{crumbs=crumbs.slice(0,i+1);carregar()});
    nav.appendChild(b);
  });
}
async function carregar(){
  travar(true);
  const atual=crumbs[crumbs.length-1];
  renderCrumbs();
  document.getElementById("usarAtual").textContent="Usar “"+atual.name+"”";
  try{
    const r=await fetch("/pastas?state="+STATE+"&parent="+encodeURIComponent(atual.id));
    const j=await r.json().catch(()=>({items:[]}));
    const ul=document.getElementById("lista");
    ul.innerHTML="";
    const itens=j.items||[];
    if(itens.length===0){
      const li=document.createElement("li");
      li.className="vazio";li.textContent="Nenhuma subpasta aqui";
      ul.appendChild(li);
    }
    for(const it of itens){
      const li=document.createElement("li");
      li.textContent=it.name;
      li.addEventListener("click",()=>{crumbs.push({id:it.id,name:it.name});carregar()});
      ul.appendChild(li);
    }
    travar(false);
  }catch(e){erro("Não deu certo: "+e.message)}
}
document.getElementById("botoes").addEventListener("click",(e)=>{
  const b=e.target.closest("button");if(!b)return;
  if(b.dataset.acao==="navegar")return abrirNavegador();
  escolher({acao:b.dataset.acao,id:b.dataset.id});
});
document.getElementById("usarAtual").addEventListener("click",()=>{
  const atual=crumbs[crumbs.length-1];
  escolher({acao:"escolhida",id:atual.id});
});
document.getElementById("cancelarNav").addEventListener("click",fecharNavegador);
</script>`,
  );
}
