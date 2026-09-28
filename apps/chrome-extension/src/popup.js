/** Popup: só pinta o estado do service worker e manda as ações pra ele. */

const $ = (id) => document.getElementById(id);
const pedir = (msg) => chrome.runtime.sendMessage(msg);

const VISOES = ["v-parear", "v-sem-motor", "v-pausado", "v-conectado"];

function mostrar(id) {
  for (const v of VISOES) $(v).classList.toggle("hidden", v !== id);
}

function hora(ms) {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function estadoTopo(e) {
  if (e.status === "sem-par") return ["○ Não pareado", ""];
  if (e.status === "token-invalido") return ["✕ Pareamento recusado", "perigo"];
  if (e.pausado) return ["❚❚ Pausado", "atencao"];
  if (e.status === "conectado") return ["● Conectado", "ok"];
  if (e.status === "conectando") return ["… Conectando", ""];
  return ["✕ Sem motor", "perigo"];
}

function pintarAbas(abas) {
  const box = $("abas");
  box.replaceChildren();
  $("abas-n").textContent = String(abas.length);
  if (!abas.length) {
    const p = document.createElement("p");
    p.className = "pp-vazio";
    p.textContent = "Nenhuma aba ainda. O grupo aparece quando o agente abrir a primeira.";
    box.append(p);
    return;
  }
  for (const a of abas) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pp-aba";
    b.title = "Ir pra esta aba";
    const fav = document.createElement(a.favicon ? "img" : "div");
    fav.className = "pp-fav";
    if (a.favicon) {
      fav.src = a.favicon;
      fav.alt = "";
    }
    const t = document.createElement("div");
    t.className = "t";
    const n = document.createElement("div");
    n.className = "n";
    n.textContent = a.titulo || "(sem título)";
    const u = document.createElement("div");
    u.className = "u";
    u.textContent = a.url.replace(/^https?:\/\//, "");
    t.append(n, u);
    b.append(fav, t);
    if (a.ativa) {
      const tag = document.createElement("span");
      tag.className = "pp-tag";
      tag.textContent = "ativa";
      b.append(tag);
    }
    b.addEventListener("click", () => void pedir({ tipo: "focar-aba", id: a.id }));
    box.append(b);
  }
}

function pintarLog(log) {
  const box = $("log");
  box.replaceChildren();
  if (!log.length) {
    const p = document.createElement("p");
    p.className = "pp-vazio";
    p.textContent = "Nada ainda.";
    box.append(p);
    return;
  }
  for (const l of log.slice(0, 5)) {
    const d = document.createElement("div");
    const h = document.createElement("span");
    h.className = "h";
    h.textContent = hora(l.hora);
    d.append(h, `${l.ok ? "" : "✕ "}${l.texto}`);
    if (!l.ok) {
      d.className = "falhou";
      d.title = l.detalhe;
    }
    box.append(d);
  }
}

async function pintar() {
  const e = await pedir({ tipo: "estado" });
  if (!e) return;
  const [txt, cls] = estadoTopo(e);
  $("est").textContent = txt;
  $("est").className = `pp-est ${cls}`;
  $("rodape").classList.toggle("hidden", e.status === "sem-par" || e.status === "token-invalido");
  $("rod-base").textContent = `Motor ${e.base.replace(/^https?:\/\//, "")} · v${e.versao}`;

  if (e.status === "sem-par" || e.status === "token-invalido") {
    mostrar("v-parear");
    if (!$("base").value) $("base").value = e.base;
    const aviso = $("parear-aviso");
    aviso.classList.toggle("hidden", e.status !== "token-invalido");
    aviso.textContent = e.status === "token-invalido" ? e.ultimoErro : "";
    return;
  }
  if (e.pausado) return mostrar("v-pausado");
  if (e.status !== "conectado") {
    mostrar("v-sem-motor");
    $("sem-motor-meta").textContent = e.ultimaTentativa
      ? `última tentativa ${new Date(e.ultimaTentativa).toLocaleTimeString("pt-BR")} · ${e.base.replace(/^https?:\/\//, "")}`
      : "";
    return;
  }
  mostrar("v-conectado");
  $("agente-tit").textContent = e.agindo ? "▶ Agente mexendo agora" : "Esperando o agente";
  $("agente-sub").textContent = e.agindo ? "Tudo que ele faz aparece nas abas do grupo" : "Nada acontece fora do grupo Nexos";
  pintarAbas(e.abas);
  pintarLog(e.log);
}

$("f-parear").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("btn-parear");
  btn.disabled = true;
  btn.textContent = "Pareando…";
  const r = await pedir({ tipo: "parear", base: $("base").value, codigo: $("codigo").value });
  btn.disabled = false;
  btn.textContent = "Parear";
  if (!r?.ok) {
    $("parear-aviso").textContent = r?.erro || "não deu pra parear";
    $("parear-aviso").classList.remove("hidden");
    return;
  }
  $("codigo").value = "";
  void pintar();
});

$("btn-tentar").addEventListener("click", () => void pedir({ tipo: "tentar" }).then(pintar));
$("btn-pausar").addEventListener("click", () => void pedir({ tipo: "pausar" }).then(pintar));
$("btn-retomar").addEventListener("click", () => void pedir({ tipo: "retomar" }).then(pintar));
$("btn-desparear").addEventListener("click", () => void pedir({ tipo: "desparear" }).then(pintar));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.tipo === "mudou") void pintar();
});

void pintar();
