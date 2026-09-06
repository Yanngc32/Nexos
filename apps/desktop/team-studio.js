import { fmtDuracao } from "./agent-trace.js";
import {
  aplicarEventoDeRun,
  duracaoDoPasso,
  larguraDosPassos,
  podeRetomar,
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
      topology: el("tm-topology").value,
      members: membros.map((m) => ({ agentId: m.agentId, ...(m.papel ? { papel: m.papel } : {}) })),
    };
  }

  function sujo() {
    if (!original) return true;
    return JSON.stringify(ler()) !== JSON.stringify(original);
  }

  /**
   * O que acontece em paralelo depende de o projeto ser git ou não, e a tela não
   * sabe qual é na hora de montar o time — então diz os dois casos. Quem escolhe
   * os membros é quem precisa saber onde eles vão escrever.
   */
  const AVISO_FANIN =
    "Em paralelo, cada membro trabalha numa árvore própria do repositório, num branch " +
    "`nexo/<run>/<n>-<agente>` — ninguém sobrescreve ninguém, e o trabalho fica nos branches " +
    "pra você revisar. Se o projeto não for um repositório git, todos escrevem na mesma pasta " +
    "ao mesmo tempo e vão se atropelar.";

  /**
   * O supervisor gasta um turno por decisão e escolhe quantas rodadas quer — o
   * custo não sai da contagem de membros, como nas outras duas. Quem monta o
   * time precisa saber disso antes de rodar, não depois da fatura.
   */
  const AVISO_SUPERVISOR =
    "O PRIMEIRO da lista não trabalha: ele decide, a cada rodada, qual dos outros chamar. " +
    "Cada decisão é um turno dele, então o time gasta mais que o número de membros — e quantas " +
    "rodadas vão acontecer é ele que escolhe. Use o teto de passos pra fechar a conta.";

  const AVISOS = { fanin: AVISO_FANIN, supervisor: AVISO_SUPERVISOR };

  /** O que a ORDEM da lista significa muda com a topologia — dizer só uma seria mentira nas outras duas. */
  const ORDEM = {
    pipeline: "Roda um por vez, de cima pra baixo: a saída de cada um vira a entrada do próximo.",
    fanin: "Todos menos o último rodam ao mesmo tempo; o ÚLTIMO recebe a saída de todos pra juntar.",
    supervisor: "O PRIMEIRO decide e não trabalha. A ordem dos outros não importa: quem escolhe é ele.",
  };

  function aoMudar() {
    const topologia = el("tm-topology").value;
    const aviso = AVISOS[topologia] ?? "";
    el("tm-ordem").textContent = ORDEM[topologia] ?? "";
    el("tm-aviso").textContent = aviso;
    el("tm-aviso").classList.toggle("hidden", !aviso);
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

      const chefia = i === 0 && el("tm-topology").value === "supervisor";
      const n = doc.createElement("span");
      n.className = "tm-member-n";
      // a posição 1 muda de significado no supervisor: dizer só "1" esconderia
      // que esse membro não vai trabalhar
      n.textContent = chefia ? "sup" : `${i + 1}`;
      if (chefia) n.title = "Decide quem trabalha; não executa";

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
    el("tm-topology").value = def?.topology ?? "pipeline";
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
    if (v.topology === "supervisor" && v.members.length < 2) {
      return erro("O supervisor não trabalha, chama: o time precisa de mais alguém além dele."), false;
    }
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
    el("btn-tm-resume").classList.add("hidden");
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
      n.textContent = s.supervisor ? "sup" : `#${i + 1}`;

      const ico = doc.createElement("span");
      ico.className = "ag-step-ico";
      ico.textContent = s.supervisor ? "⌘" : ({ done: "✓", running: "▸", error: "✕", skipped: "–" }[s.status] ?? "·");

      const nome = doc.createElement("span");
      nome.className = "ag-step-name";
      nome.textContent = s.agentId;
      if (s.papel) nome.title = s.papel;

      const det = doc.createElement("span");
      det.className = "ag-step-det";
      // o supervisor fica aberto o run inteiro: "rodando" não diria nada. O que
      // conta nele é quantas decisões já custaram.
      const decidiu = s.decisoes ? `${s.decisoes} decisõe${s.decisoes > 1 ? "s" : ""}` : "decidindo";
      det.textContent = s.error || (s.supervisor ? decidiu : s.papel || rotuloDoPasso(s));

      const barra = doc.createElement("span");
      barra.className = "ag-step-bar";
      const fill = doc.createElement("i");
      fill.style.width = `${larg[i]}%`;
      barra.append(fill);

      const ms = doc.createElement("span");
      ms.className = "ag-step-ms";
      ms.textContent = s.startedAt ? fmtDuracao(duracaoDoPasso(s, t)) : "";

      li.append(n, ico, nome, det, barra, ms);
      if (s.branch) {
        const br = doc.createElement("span");
        br.className = "ag-step-tk tm-step-branch";
        br.textContent = "⑂";
        // o branch é onde o trabalho ficou: sem isso o isolamento seria invisível
        br.title = `Trabalhou no branch ${s.branch}`;
        li.append(br);
      }
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
    // retomar só faz sentido no que parou no meio: run concluído não tem o que continuar
    el("btn-tm-resume").classList.toggle("hidden", !podeRetomar(run));
    if (run.error) nota(run.error);
    else if (run.isolationOff) nota(`Sem árvores separadas: ${run.isolationOff}. Os membros dividiram a pasta.`);
    else if (run.isolated) nota("Cada membro paralelo trabalhou no branch dele — o ⑂ mostra qual.");
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

  /**
   * Retoma de onde parou, sem refazer o que já ficou pronto.
   *
   * O teto de passos NÃO é reenviado de propósito: se foi ele que parou o run,
   * mandar o mesmo pararia na mesma linha sem gastar nada e pareceria defeito.
   * Quem clica aqui está decidindo deixar o time continuar.
   */
  async function retomar() {
    if (!run || !podeRetomar(run)) return;
    if (!isOk()) return nota("O motor está desligado. Liga o motor pra retomar.");
    try {
      run = await req(`/v1/runs/${run.id}/resume`, { method: "POST", body: "{}" });
    } catch (e) {
      return nota(e.message || "Não deu pra retomar.");
    }
    nota("");
    ouvir();
    comecarRelogio();
    pintarRun();
    void recarregar();
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
    el("tm-topology").addEventListener("change", aoMudar);
    el("btn-tm-add").addEventListener("click", adicionar);
    el("btn-tm-save").addEventListener("click", () => void salvar());
    el("btn-tm-del").addEventListener("click", () => void excluir());
    el("btn-close-team").addEventListener("click", fechar);
    el("btn-tm-stop").addEventListener("click", () => void parar());
    el("btn-tm-resume").addEventListener("click", () => void retomar());
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

  return { abrir, fechar, ligar, salvar, rodar, parar, retomar, editandoId: () => editando, runAtual: () => run };
}
