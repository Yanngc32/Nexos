import { fmtDuracao } from "./agent-trace.js";
import {
  aplicarEventoDeRun,
  duracaoDoPasso,
  larguraDosPassos,
  resumoDoRun,
  rotuloDoPasso,
  runFechado,
} from "./run-view.js";

/**
 * Tela cheia do time: editor de membros à esquerda, execução à direita.
 *
 * Diferente da bancada de um agente, aqui a tela não remonta a timeline a partir
 * do stream do motor — o daemon já entrega os passos prontos, com tempo medido
 * por ele. O stream serve pra atualizar sem poll; o `GET /v1/runs/:id` é a
 * verdade, e é dele que a tela parte ao abrir.
 *
 * Rodar exige o time salvo, pelo mesmo motivo da bancada: o daemon lê a
 * definição do disco. O botão vira "Salvar e rodar" quando há mudança pendente.
 */
export function createTeamStudio({
  req,
  api,
  headers,
  el,
  getProjectPath,
  isOk,
  getAgents,
  lerEventos,
  aoSalvar,
  aoFechar,
  fetchImpl = fetch,
  agora = () => Date.now(),
}) {
  /** id em edição; "" = criando. `null` = tela fechada. */
  let editando = null;
  let original = null;
  let membros = [];
  let run = null;
  let abort = null;
  let timer = 0;

  /* ---------- edição ---------- */

  function erro(msg) {
    const p = el("tm-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function ler() {
    return {
      name: el("tm-name").value,
      id: el("tm-id").value,
      description: el("tm-desc").value,
      members: membros.map((m) => ({ agentId: m.agentId, ...(m.papel ? { papel: m.papel } : {}) })),
    };
  }

  function sujo() {
    if (!original) return true;
    return JSON.stringify(ler()) !== JSON.stringify(original);
  }

  function aoMudar() {
    el("tm-dirty").classList.toggle("hidden", !sujo());
    el("btn-tm-run").textContent = sujo() ? "Salvar e rodar" : "Rodar";
    el("tm-head-name").textContent = el("tm-name").value || (editando ? editando : "novo");
  }

  /** Uma linha por membro: agente, papel e os controles de ordem. */
  function pintarMembros() {
    const ol = el("tm-members");
    const doc = ol.ownerDocument;
    ol.replaceChildren();
    const agentes = getAgents();

    membros.forEach((m, i) => {
      const li = doc.createElement("li");
      li.className = "tm-member";

      const n = doc.createElement("span");
      n.className = "tm-member-n";
      n.textContent = `${i + 1}`;

      const sel = doc.createElement("select");
      sel.className = "tm-member-agent";
      for (const a of agentes) {
        const o = doc.createElement("option");
        o.value = a.id;
        o.textContent = a.name;
        sel.append(o);
      }
      sel.value = m.agentId;
      sel.addEventListener("change", () => {
        m.agentId = sel.value;
        aoMudar();
      });

      const papel = doc.createElement("input");
      papel.type = "text";
      papel.className = "tm-member-papel";
      papel.maxLength = 200;
      papel.placeholder = "papel neste time (opcional)";
      papel.value = m.papel ?? "";
      papel.addEventListener("input", () => {
        m.papel = papel.value;
        aoMudar();
      });

      const acoes = doc.createElement("span");
      acoes.className = "tm-member-acts";
      for (const [rotulo, titulo, delta] of [
        ["↑", "Subir", -1],
        ["↓", "Descer", 1],
      ]) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "ghost";
        b.textContent = rotulo;
        b.title = titulo;
        b.disabled = delta < 0 ? i === 0 : i === membros.length - 1;
        b.addEventListener("click", () => mover(i, delta));
        acoes.append(b);
      }
      const rm = doc.createElement("button");
      rm.type = "button";
      rm.className = "ghost danger";
      rm.textContent = "✕";
      rm.title = "Tirar do time";
      rm.addEventListener("click", () => {
        membros.splice(i, 1);
        pintarMembros();
        aoMudar();
      });
      acoes.append(rm);

      li.append(n, sel, papel, acoes);
      ol.append(li);
    });

    const vazio = !agentes.length;
    el("btn-tm-add").disabled = vazio;
    el("btn-tm-add").title = vazio ? "Crie um agente antes" : "";
  }

  function mover(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= membros.length) return;
    // a ordem é a semântica do pipeline: mover é editar o time
    [membros[i], membros[j]] = [membros[j], membros[i]];
    pintarMembros();
    aoMudar();
  }

  function adicionar() {
    const primeiro = getAgents()[0];
    if (!primeiro) return erro("Crie um agente antes: painel de agentes → Novo agente.");
    membros.push({ agentId: primeiro.id, papel: "" });
    pintarMembros();
    aoMudar();
  }

  function slug(nome) {
    return String(nome || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  /** Abre a tela. `def` vazio = time novo. */
  function abrir(def) {
    editando = def ? def.id : "";
    el("tm-name").value = def?.name ?? "";
    el("tm-id").value = def?.id ?? "";
    el("tm-desc").value = def?.description ?? "";
    membros = (def?.members ?? []).map((m) => ({ agentId: m.agentId, papel: m.papel ?? "" }));
    if (!def && !membros.length) adicionar();
    el("tm-id").disabled = Boolean(def);
    el("btn-tm-del").classList.toggle("hidden", !def);
    original = def ? ler() : null;
    pintarMembros();
    erro("");
    limparRun();
    aoMudar();
  }

  async function salvar() {
    const v = ler();
    const id = editando || slug(v.id || v.name);
    if (!id) return erro("id inválido: use minúsculas, números, - e _"), false;
    if (!v.name.trim()) return erro("Nome obrigatório."), false;
    if (!v.members.length) return erro("O time precisa de pelo menos um membro."), false;
    const body = { ...v, id, name: v.name.trim(), description: v.description.trim() };
    try {
      if (editando) await req(`/v1/teams/${editando}`, { method: "PUT", body: JSON.stringify(body) });
      else await req("/v1/teams", { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      return erro(e.message || "Falhou ao salvar."), false;
    }
    editando = id;
    el("tm-id").value = id;
    el("tm-id").disabled = true;
    el("btn-tm-del").classList.remove("hidden");
    original = ler();
    erro("");
    aoMudar();
    await aoSalvar();
    return true;
  }

  async function excluir() {
    if (!editando) return;
    try {
      await req(`/v1/teams/${editando}`, { method: "DELETE" });
    } catch (e) {
      return erro(e.message || "Falhou ao excluir.");
    }
    await aoSalvar();
    fechar();
  }

  /* ---------- execução ---------- */

  const VAZIO = "Escreve o objetivo e roda: cada passo aparece aqui com o tempo e o custo dele.";

  function nota(msg) {
    el("tm-run-note").textContent = msg || "";
  }

  function limparRun() {
    pararRelogio();
    abort?.abort();
    abort = null;
    run = null;
    el("tm-steps").replaceChildren();
    el("tm-sum").textContent = "";
    el("tm-run-status").textContent = "";
    el("btn-tm-stop").classList.add("hidden");
    nota(VAZIO);
  }

  function pintarPassos() {
    const ol = el("tm-steps");
    const doc = ol.ownerDocument;
    ol.replaceChildren();
    if (!run) return;
    const t = agora();
    const larg = larguraDosPassos(run.steps, t);

    run.steps.forEach((s, i) => {
      const li = doc.createElement("li");
      li.className = "ag-step";
      li.dataset.tipo = s.status;

      const n = doc.createElement("span");
      n.className = "ag-step-n";
      n.textContent = `#${i + 1}`;

      const ico = doc.createElement("span");
      ico.className = "ag-step-ico";
      ico.textContent = { done: "✓", running: "▸", error: "✕", skipped: "–" }[s.status] ?? "·";

      const nome = doc.createElement("span");
      nome.className = "ag-step-name";
      nome.textContent = s.agentId;
      if (s.papel) nome.title = s.papel;

      const det = doc.createElement("span");
      det.className = "ag-step-det";
      det.textContent = s.error || s.papel || rotuloDoPasso(s);

      const barra = doc.createElement("span");
      barra.className = "ag-step-bar";
      const fill = doc.createElement("i");
      fill.style.width = `${larg[i]}%`;
      barra.append(fill);

      const ms = doc.createElement("span");
      ms.className = "ag-step-ms";
      ms.textContent = s.startedAt ? fmtDuracao(duracaoDoPasso(s, t)) : "";

      li.append(n, ico, nome, det, barra, ms);
      if (s.tokens) {
        const tk = doc.createElement("span");
        tk.className = "ag-step-tk";
        tk.textContent = `${s.tokens} tok`;
        li.append(tk);
      }
      ol.append(li);
    });
    ol.scrollTop = ol.scrollHeight;
  }

  function pintarResumo() {
    if (!run) return;
    const r = resumoDoRun(run, agora());
    const partes = [`${r.concluidos}/${r.total} passos`, fmtDuracao(r.ms)];
    if (r.tokens) partes.push(`${r.tokens} tok`);
    if (r.custoUsd) partes.push(`US$ ${r.custoUsd.toFixed(4)}`);
    el("tm-sum").textContent = partes.join(" · ");
    el("tm-run-status").textContent = run.status;
    el("tm-run-status").dataset.status = run.status;
    el("btn-tm-stop").classList.toggle("hidden", runFechado(run));
    if (run.error) nota(run.error);
  }

  function pintarRun() {
    pintarPassos();
    pintarResumo();
  }

  function comecarRelogio() {
    pararRelogio();
    timer = setInterval(pintarRun, 250);
  }

  function pararRelogio() {
    if (timer) clearInterval(timer);
    timer = 0;
  }

  async function rodar() {
    if (run && !runFechado(run)) return;
    if (!isOk()) return nota("O motor está desligado. Liga o motor pra rodar.");
    if (!getProjectPath()) return nota("Abre um projeto: o time roda na pasta dele.");
    if (sujo() || !editando) {
      if (!(await salvar())) return;
    }
    const goal = el("tm-goal").value.trim();
    if (!goal) return nota("Escreve o objetivo do time primeiro.");

    try {
      run = await req("/v1/runs", {
        method: "POST",
        body: JSON.stringify({ teamId: editando, projectPath: getProjectPath(), goal }),
      });
    } catch (e) {
      return nota(e.message || "Não deu pra criar a execução.");
    }
    nota("");
    ouvir();
    comecarRelogio();
    pintarRun();
    // O daemon começa a executar já no POST, então os primeiros eventos podem
    // ter acontecido antes de o stream estar ligado. Um GET logo depois fecha
    // essa janela: o stream é conveniência, o GET é a verdade.
    void recarregar();
  }

  function ouvir() {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    fetchImpl(api(`/v1/runs/${run.id}/events`), { headers: headers(), signal: ac.signal })
      .then((res) =>
        lerEventos(res, (ev) => {
          if (abort !== ac || !run) return;
          if (aplicarEventoDeRun(run, ev)) pintarRun();
          // no fim, relê em vez de confiar só no que passou pelo stream:
          // evento perdido no meio deixaria passo eternamente "na fila"
          if (ev.type === "run_end") void recarregar();
        }),
      )
      .catch((e) => {
        if (e.name === "AbortError" || abort !== ac) return;
        // stream caiu com o run vivo: cai no GET, que é a verdade
        void recarregar();
      });
  }

  /** Relê o run do daemon. O stream é conveniência; isto é a fonte. */
  async function recarregar() {
    if (!run) return;
    try {
      run = await req(`/v1/runs/${run.id}`);
    } catch {
      return;
    }
    pintarRun();
    if (runFechado(run)) encerrar();
  }

  function encerrar() {
    pararRelogio();
    abort?.abort();
    abort = null;
    pintarRun();
  }

  async function parar() {
    if (!run) return;
    try {
      await req(`/v1/runs/${run.id}/abort`, { method: "POST" });
    } catch {
      /* o recarregar abaixo mostra o estado real */
    }
    await recarregar();
  }

  function fechar() {
    encerrar();
    editando = null;
    aoFechar();
  }

  /** Liga os controles. Chamado uma vez, no boot. */
  function ligar() {
    for (const id of ["tm-name", "tm-id", "tm-desc"]) {
      el(id).addEventListener("input", aoMudar);
    }
    el("btn-tm-add").addEventListener("click", adicionar);
    el("btn-tm-save").addEventListener("click", () => void salvar());
    el("btn-tm-del").addEventListener("click", () => void excluir());
    el("btn-close-team").addEventListener("click", fechar);
    el("btn-tm-stop").addEventListener("click", () => void parar());
    el("tm-ask").addEventListener("submit", (e) => {
      e.preventDefault();
      void rodar();
    });
    el("tm-goal").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void rodar();
      }
    });
  }

  return { abrir, fechar, ligar, salvar, rodar, parar, editandoId: () => editando, runAtual: () => run };
}
