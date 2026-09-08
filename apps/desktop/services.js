import { lerEventos } from "./sse.js";

/**
 * Painel de serviços locais do projeto (o que o `nexo.json` declara).
 *
 * O módulo é dono do estado dos serviços — lista, erro, confiança, log aberto e
 * o resultado da sonda por porta. Isso morava no `state` global do renderer,
 * mas ninguém de fora escrevia nele: só o painel.
 *
 * As três saídas pra UI entram como callback (`abrirNoBrowser`, `aoErro`)
 * porque o painel não deve saber o que é aba de browser nem log de chat — e
 * porque, sem isso, importar o renderer de volta faria ciclo.
 */
export function createServicesPanel({
  req,
  api,
  headers,
  getProjectPath,
  isOk,
  el,
  abrirNoBrowser,
  aoErro,
  fetchImpl = fetch,
}) {
  let list = [];
  let error = "";
  let trusted = false;
  let logId = "";
  /** Geração do stream: um abort velho não pode religar por cima do novo. */
  let abort = null;
  /** Resultado da sonda por serviço: processo de pé ainda não quer dizer que atende. */
  let portes = {};

  function svcDotState(s) {
    if (!s.url) return s.proc === "running" ? "up" : s.proc === "off" ? "" : "down";
    if (s.proc !== "running") return "down";
    // rodando: quem manda na bolinha é a porta responder ou não
    return portes[s.id] === "up" ? "up" : "waiting";
  }

  function paint() {
    const strip = el("svc-strip");
    // Some sem projeto ou com motor desligado (aí a lista não é confiável: o "vazio"
    // seria mentira). Antes eu escondia toda seção vazia "pra não poluir", e o efeito
    // foi ninguém descobrir que serviços existem — agora o vazio aparece.
    strip.classList.toggle("hidden", !getProjectPath() || !isOk());
    el("svc-empty").classList.toggle("hidden", Boolean(list.length || error));
    el("svc-error").textContent = error;
    el("svc-error").classList.toggle("hidden", !error);
    // só oferece confiar quando existe autostart declarado esperando liberação
    const querAutostart = list.some((s) => s.autostart);
    el("btn-svc-trust").classList.toggle("hidden", trusted || !querAutostart);

    const ul = el("svc-list");
    const doc = ul.ownerDocument;
    ul.replaceChildren();
    for (const s of list) {
      const li = doc.createElement("li");
      const dot = doc.createElement("span");
      dot.className = "svc-dot";
      dot.dataset.state = svcDotState(s);
      dot.title = s.proc === "exited" ? `saiu com código ${s.exitCode}` : s.proc;

      const nome = doc.createElement("span");
      nome.className = "svc-name";
      nome.textContent = s.name;
      nome.title = `${s.cmd} (${s.cwd})`;
      nome.addEventListener("click", () => void abrirLog(s.id, s.name));

      const porta = doc.createElement("span");
      porta.className = "svc-port";
      porta.textContent = s.portNumber ? String(s.portNumber) : "";

      const acao = doc.createElement("button");
      acao.type = "button";
      acao.className = "ghost svc-act";
      const vivo = s.proc === "running";
      acao.textContent = vivo ? "■" : "▶";
      acao.title = vivo ? "Parar" : "Rodar";
      acao.addEventListener("click", () => void acionar(s.id, vivo ? "stop" : "start"));

      li.append(dot, nome, porta, acao);
      if (s.url) {
        const abrir = doc.createElement("button");
        abrir.type = "button";
        abrir.className = "ghost svc-act";
        abrir.textContent = "↗";
        abrir.title = `Abrir ${s.url} no Browser`;
        abrir.addEventListener("click", () => abrirNoBrowser(s.url));
        li.append(abrir);
      }
      ul.append(li);
    }
  }

  function rota() {
    return `/v1/services?projectPath=${encodeURIComponent(getProjectPath())}`;
  }

  async function load() {
    if (!getProjectPath() || !isOk()) {
      list = [];
      paint();
      return;
    }
    try {
      const rel = await req(rota());
      list = rel.services || [];
      error = rel.error || "";
      trusted = Boolean(rel.trusted);
    } catch (e) {
      // Nada de engolir: daemon antigo (sem a rota) parecia "projeto sem serviço".
      list = [];
      error = /404|not found/i.test(e.message || "")
        ? "Motor antigo, sem suporte a serviços. Desliga e liga o motor pra recarregar."
        : e.message || "não consegui ler os serviços";
    }
    paint();
    void probe();
    void autostart();
  }

  /**
   * Sobe o que o nexo.json marcou como autostart. O daemon ignora em projeto não
   * confiável, então chamar sempre é seguro; só vale a pena se há algo parado.
   */
  async function autostart() {
    if (!trusted) return;
    if (!list.some((s) => s.autostart && s.proc !== "running")) return;
    try {
      await req("/v1/services/autostart", {
        method: "POST",
        body: JSON.stringify({ projectPath: getProjectPath() }),
      });
    } catch {
      return;
    }
    const rel = await req(rota());
    list = rel.services || [];
    paint();
    void probe();
  }

  /** Sonda a porta de cada serviço vivo: processo de pé ainda não quer dizer que atende. */
  async function probe() {
    for (const s of list) {
      if (!s.url || s.proc !== "running") continue;
      try {
        const r = await req(`/v1/probe?url=${encodeURIComponent(s.url)}`);
        portes[s.id] = r.ok ? "up" : "down";
      } catch {
        portes[s.id] = "down";
      }
    }
    paint();
  }

  async function acionar(id, acao) {
    try {
      await req(`/v1/services/${encodeURIComponent(id)}/${acao}`, {
        method: "POST",
        body: JSON.stringify({ projectPath: getProjectPath() }),
      });
    } catch (e) {
      aoErro(e.message || `não deu pra ${acao} ${id}`);
    }
    if (acao === "stop") delete portes[id];
    await load();
  }

  async function confiar() {
    try {
      await req("/v1/services/trust", {
        method: "POST",
        body: JSON.stringify({ projectPath: getProjectPath() }),
      });
    } catch (e) {
      aoErro(e.message || "não deu pra confiar no projeto");
      return;
    }
    await load();
  }

  async function abrirLog(id, nome) {
    logId = id;
    el("svc-log-title").textContent = nome;
    el("svc-log").classList.remove("hidden");
    try {
      const r = await req(
        `/v1/services/${encodeURIComponent(id)}/logs?projectPath=${encodeURIComponent(getProjectPath())}`,
      );
      el("svc-log-body").textContent = r.log || "(sem saída ainda)";
    } catch {
      el("svc-log-body").textContent = "(não consegui ler o log)";
    }
    const box = el("svc-log-body");
    box.scrollTop = box.scrollHeight;
  }

  function fecharLog() {
    logId = "";
    el("svc-log").classList.add("hidden");
  }

  function aplicarStatus(ev) {
    list = list.map((s) => (s.id === ev.service.id ? ev.service : s));
    if (ev.service.proc !== "running") delete portes[ev.service.id];
    paint();
    if (ev.service.proc === "running") void probe();
  }

  function aplicarLog(ev) {
    if (ev.id !== logId) return;
    const box = el("svc-log-body");
    const colado = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
    box.textContent += ev.chunk;
    if (colado) box.scrollTop = box.scrollHeight;
  }

  /** SSE dos serviços: status muda sozinho quando um processo cai. */
  function listen() {
    abort?.abort();
    if (!getProjectPath() || !isOk()) return;
    const ac = new AbortController();
    abort = ac;
    fetchImpl(api(`/v1/services/events?projectPath=${encodeURIComponent(getProjectPath())}`), {
      headers: headers(),
      signal: ac.signal,
    })
      .then(async (res) => {
        await lerEventos(res, (ev) => {
          if (ev.type === "status") aplicarStatus(ev);
          if (ev.type === "log") aplicarLog(ev);
        });
        religar();
      })
      .catch(() => {
        religar();
      });

    function religar() {
      // mesmo defeito do SSE do chat: fim limpo do stream (daemon reiniciando)
      // não pode deixar o status congelado até alguém recarregar a tela
      if (abort !== ac || !getProjectPath()) return;
      setTimeout(() => {
        if (abort !== ac || !getProjectPath() || !isOk()) return;
        void load();
        listen();
      }, 1500);
    }
  }

  /** Troca de projeto: a sonda da pasta antiga não diz nada sobre a nova. */
  function limparPortas() {
    portes = {};
  }

  return {
    paint,
    load,
    listen,
    acionar,
    confiar,
    fecharLog,
    limparPortas,
    servicos: () => list,
  };
}
