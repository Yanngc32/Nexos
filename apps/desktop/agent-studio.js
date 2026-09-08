import { TEMPLATES, aplicarTemplate, lacunas, templatePorId } from "./agent-templates.js";
import { createTrace, fmtDuracao, larguras } from "./agent-trace.js";

/**
 * Tela cheia de criação e edição de agente, com bancada de teste ao lado.
 *
 * A bancada roda o agente COMO ELE ESTÁ SALVO: o motor lê a definição do disco
 * quando sobe, então testar um rascunho exigiria uma rota nova no daemon. Em vez
 * de fingir, o botão passa a dizer "Salvar e testar" quando há mudança pendente
 * — o que você vê rodando é sempre o que está gravado.
 *
 * A conversa de teste é descartável: nasce ao testar e é apagada ao limpar ou
 * fechar a tela, pra não encher a lista de conversas do projeto.
 */
export function createAgentStudio({
  req,
  api,
  headers,
  el,
  getProjectPath,
  isOk,
  getProfiles,
  lerEventos,
  aoSalvar,
  aoFechar,
  renderMd,
  fetchImpl = fetch,
  agora = () => Date.now(),
}) {
  /** id em edição; "" = criando. `null` = tela fechada. */
  let editando = null;
  let original = vazio();
  let templateAtivo = "blank";
  let aba = "steps";

  const trace = createTrace({ agora });
  let threadTeste = "";
  let abort = null;
  let rodando = false;
  let resposta = "";
  let timer = 0;

  function vazio() {
    return {
      name: "",
      id: "",
      color: "#4d9cd6",
      description: "",
      profileId: "",
      model: "",
      effort: "",
      permissionMode: "",
      instructions: "",
    };
  }

  const CAMPOS = {
    name: "ag-name",
    id: "ag-id",
    color: "ag-color",
    description: "ag-desc",
    profileId: "ag-profile",
    model: "ag-model",
    effort: "ag-effort",
    permissionMode: "ag-mode",
    instructions: "ag-instructions",
  };

  function ler() {
    const out = {};
    for (const [campo, id] of Object.entries(CAMPOS)) out[campo] = el(id).value;
    return out;
  }

  function escrever(v) {
    for (const [campo, id] of Object.entries(CAMPOS)) {
      if (v[campo] !== undefined) el(id).value = v[campo];
    }
  }

  /** Mudou em relação ao que está salvo? É o que decide o rótulo do botão de teste. */
  function sujo() {
    const atual = ler();
    return Object.keys(CAMPOS).some((c) => String(atual[c] ?? "") !== String(original[c] ?? ""));
  }

  /* ---------- modelos de criação ---------- */

  function pintarTemplates() {
    const box = el("ag-tpls");
    const doc = box.ownerDocument;
    box.replaceChildren();
    for (const t of TEMPLATES) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "ag-tpl";
      b.dataset.on = t.id === templateAtivo ? "1" : "0";
      b.dataset.id = t.id;
      const nome = doc.createElement("strong");
      nome.textContent = t.nome;
      const resumo = doc.createElement("span");
      resumo.textContent = t.resumo;
      b.append(nome, resumo);
      b.addEventListener("click", () => usarTemplate(t.id));
      box.append(b);
    }
    const nota = el("ag-tpl-nota");
    nota.textContent = templatePorId(templateAtivo)?.nota || "";
    nota.classList.toggle("hidden", !nota.textContent);
  }

  function usarTemplate(id) {
    templateAtivo = id;
    escrever(aplicarTemplate(id, ler()));
    pintarTemplates();
    aoMudar();
  }

  /* ---------- edição ---------- */

  function erro(msg) {
    const p = el("ag-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function aoMudar() {
    const v = ler();
    el("ag-count").textContent = `${v.instructions.length} / 8000`;
    const faltando = lacunas(v.instructions);
    const g = el("ag-gaps");
    g.textContent = faltando.length ? `Falta preencher: ${faltando.join(", ")}` : "";
    g.classList.toggle("hidden", !faltando.length);
    el("ag-dirty").classList.toggle("hidden", !sujo());
    el("btn-ag-run").textContent = sujo() ? "Salvar e testar" : "Testar";
    el("ag-head-name").textContent = v.name || (editando ? editando : "novo");
  }

  function fillProfiles(escolhido) {
    const sel = el("ag-profile");
    const doc = sel.ownerDocument;
    sel.replaceChildren();
    for (const p of getProfiles()) {
      const o = doc.createElement("option");
      o.value = p.id;
      o.textContent = `${p.id} · ${p.engine}`;
      sel.append(o);
    }
    if (escolhido) sel.value = escolhido;
  }

  /** Abre a tela. `def` vazio = agente novo. */
  function abrir(def) {
    editando = def ? def.id : "";
    const v = { ...vazio(), ...(def || {}) };
    fillProfiles(v.profileId || getProfiles()[0]?.id || "");
    escrever(v);
    if (!def) el("ag-profile").value = getProfiles()[0]?.id || "";
    original = def ? { ...v, profileId: el("ag-profile").value } : { ...vazio(), profileId: "" };
    el("ag-id").disabled = Boolean(def);
    el("btn-ag-del").classList.toggle("hidden", !def);
    el("ag-tpl-sec").classList.toggle("hidden", Boolean(def));
    templateAtivo = "blank";
    pintarTemplates();
    erro("");
    limparBancada();
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

  async function salvar() {
    const v = ler();
    const id = editando || slug(v.id || v.name);
    if (!id) return erro("id inválido: use minúsculas, números, - e _"), false;
    if (!v.name.trim()) return erro("Nome obrigatório."), false;
    if (!v.profileId) return erro("Crie uma conta antes: Configurações → Nova conta."), false;
    const body = { ...v, id, name: v.name.trim(), description: v.description.trim(), model: v.model.trim() };
    try {
      if (editando) await req(`/v1/agents/defs/${editando}`, { method: "PUT", body: JSON.stringify(body) });
      else await req("/v1/agents/defs", { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      return erro(e.message || "Falhou ao salvar."), false;
    }
    editando = id;
    original = { ...v, id };
    el("ag-id").disabled = true;
    el("btn-ag-del").classList.toggle("hidden", false);
    erro("");
    aoMudar();
    await aoSalvar();
    return true;
  }

  async function excluir() {
    if (!editando) return;
    try {
      await req(`/v1/agents/defs/${editando}`, { method: "DELETE" });
    } catch (e) {
      return erro(e.message || "Falhou ao excluir.");
    }
    await aoSalvar();
    await fechar();
  }

  /* ---------- bancada ---------- */

  const VAZIO = "Escreve uma mensagem e testa: cada etapa aparece aqui com o tempo que levou.";

  function nota(msg) {
    el("ag-bench-note").textContent = msg || "";
  }

  function limparBancada() {
    pararRelogio();
    abort?.abort();
    abort = null;
    rodando = false;
    resposta = "";
    trace.iniciar();
    void descartarThread();
    el("ag-steps").replaceChildren();
    el("ag-chat").replaceChildren();
    el("ag-sum").textContent = "";
    nota(VAZIO);
    pintarBotoes();
  }

  async function descartarThread() {
    const id = threadTeste;
    threadTeste = "";
    if (!id) return;
    // conversa de teste não fica no histórico do projeto
    try {
      await req(`/v1/threads/${id}`, { method: "DELETE" });
    } catch {
      /* já pode ter sumido; não é erro pra mostrar */
    }
  }

  function pintarBotoes() {
    el("btn-ag-run").classList.toggle("hidden", rodando);
    el("btn-ag-stop").classList.toggle("hidden", !rodando);
  }

  function trocarAba(qual) {
    aba = qual;
    el("ag-tab-steps").dataset.on = qual === "steps" ? "1" : "0";
    el("ag-tab-chat").dataset.on = qual === "chat" ? "1" : "0";
    el("ag-steps").classList.toggle("hidden", qual !== "steps");
    el("ag-chat").classList.toggle("hidden", qual !== "chat");
  }

  const ICONE = { envio: "→", thinking: "◇", text: "▢", tool: "⚙", falha: "✕" };

  function pintarEtapas() {
    const passos = trace.lista();
    const larg = larguras(passos);
    const ol = el("ag-steps");
    const doc = ol.ownerDocument;
    ol.replaceChildren();
    passos.forEach((p, i) => {
      const li = doc.createElement("li");
      li.className = "ag-step";
      li.dataset.tipo = p.tipo;
      if (p.aberta) li.dataset.aberta = "1";

      const n = doc.createElement("span");
      n.className = "ag-step-n";
      n.textContent = `#${i + 1}`;

      const ico = doc.createElement("span");
      ico.className = "ag-step-ico";
      ico.textContent = ICONE[p.tipo] || "·";

      const nome = doc.createElement("span");
      nome.className = "ag-step-name";
      nome.textContent = p.rotulo;
      if (p.detalhe) nome.title = p.detalhe;

      const det = doc.createElement("span");
      det.className = "ag-step-det";
      det.textContent = p.detalhe || (p.chars ? `${p.chars} car.` : "");

      const barra = doc.createElement("span");
      barra.className = "ag-step-bar";
      const fill = doc.createElement("i");
      fill.style.width = `${larg[i]}%`;
      barra.append(fill);

      const ms = doc.createElement("span");
      ms.className = "ag-step-ms";
      ms.textContent = fmtDuracao(p.ms);

      li.append(n, ico, nome, det, barra, ms);
      if (p.tokens) {
        const tk = doc.createElement("span");
        tk.className = "ag-step-tk";
        tk.textContent = `${p.tokens} tok`;
        // o motor reporta por requisição, não por etapa: não vender precisão falsa
        if (p.aproximado) tk.title = "aproximado: o motor reporta uso por requisição, não por etapa";
        if (p.aproximado) tk.textContent += "~";
        li.append(tk);
      }
      ol.append(li);
    });
    ol.scrollTop = ol.scrollHeight;
  }

  function pintarResumo() {
    const r = trace.resumo();
    const partes = [fmtDuracao(r.ms)];
    if (r.ferramentas) partes.push(`${r.ferramentas} ferr.`);
    const tok = r.input + r.output;
    if (tok) partes.push(`${tok} tok`);
    if (r.contextTokens) partes.push(`ctx ${r.contextTokens}`);
    if (r.custoUsd) partes.push(`US$ ${r.custoUsd.toFixed(4)}`);
    if (r.model) partes.push(r.model);
    el("ag-sum").textContent = partes.join(" · ");
  }

  function pintarBancada() {
    pintarEtapas();
    pintarResumo();
  }

  function comecarRelogio() {
    pararRelogio();
    // etapa aberta e duração do turno crescem sozinhas; 4/s chega e não pesa
    timer = setInterval(pintarBancada, 250);
  }

  function pararRelogio() {
    if (timer) clearInterval(timer);
    timer = 0;
  }

  async function testar() {
    if (rodando) return;
    if (!isOk()) return nota("O motor está desligado. Liga o motor pra testar.");
    if (!getProjectPath()) return nota("Abre um projeto: o agente roda na pasta dele.");
    if (sujo() || !editando) {
      if (!(await salvar())) return;
    }
    const texto = el("ag-prompt").value.trim();
    if (!texto) return nota("Escreve a mensagem de teste primeiro.");

    if (!threadTeste) {
      try {
        const t = await req("/v1/threads", {
          method: "POST",
          body: JSON.stringify({ projectPath: getProjectPath(), agentId: editando }),
        });
        threadTeste = t.id;
      } catch (e) {
        return nota(e.message || "Não deu pra criar a conversa de teste.");
      }
    }

    rodando = true;
    resposta = "";
    el("ag-prompt").value = "";
    trace.iniciar(texto);
    nota("Conversa de teste — não fica no histórico do projeto.");
    pintarBotoes();
    pintarBancada();
    comecarRelogio();
    ouvir();

    try {
      await req(`/v1/threads/${threadTeste}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: texto }),
      });
    } catch (e) {
      nota(e.message || "Falhou ao enviar.");
      encerrar();
    }
  }

  function encerrar() {
    rodando = false;
    pararRelogio();
    abort?.abort();
    abort = null;
    pintarBotoes();
    pintarBancada();
  }

  function ouvir() {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    fetchImpl(api(`/v1/threads/${threadTeste}/events`), { headers: headers(), signal: ac.signal })
      .then((res) =>
        lerEventos(res, (ev) => {
          if (abort !== ac) return;
          // a timeline vem primeiro: um erro ao desenhar a resposta não pode
          // levar embora a medição do turno, que é o ponto da bancada
          if (trace.aplicar(ev)) pintarBancada();
          if (ev.type === "text") {
            resposta += ev.text ?? "";
            try {
              renderMd(el("ag-chat"), resposta);
            } catch (err) {
              el("ag-chat").textContent = resposta;
            }
          }
          if (["done", "quota", "auth", "error"].includes(ev.type)) encerrar();
        }),
      )
      .catch((e) => {
        if (e.name === "AbortError" || abort !== ac) return;
        nota(e.message || "Stream caiu.");
        encerrar();
      });
  }

  async function parar() {
    if (!threadTeste) return encerrar();
    try {
      await req(`/v1/threads/${threadTeste}/abort`, { method: "POST" });
    } catch {
      /* o encerrar abaixo já limpa a tela */
    }
    encerrar();
  }

  async function fechar() {
    encerrar();
    await descartarThread();
    editando = null;
    aoFechar();
  }

  /** Liga os controles da tela. Chamado uma vez, no boot. */
  function ligar() {
    for (const id of Object.values(CAMPOS)) {
      el(id).addEventListener("input", aoMudar);
      el(id).addEventListener("change", aoMudar);
    }
    el("btn-ag-save").addEventListener("click", () => void salvar());
    el("btn-ag-del").addEventListener("click", () => void excluir());
    el("btn-close-agent").addEventListener("click", () => void fechar());
    el("btn-ag-clear").addEventListener("click", limparBancada);
    el("btn-ag-stop").addEventListener("click", () => void parar());
    el("ag-tab-steps").addEventListener("click", () => trocarAba("steps"));
    el("ag-tab-chat").addEventListener("click", () => trocarAba("chat"));
    el("ag-ask").addEventListener("submit", (e) => {
      e.preventDefault();
      void testar();
    });
    el("ag-prompt").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void testar();
      }
    });
  }

  return { abrir, fechar, ligar, salvar, testar, parar, limparBancada, usarTemplate, editandoId: () => editando };
}
