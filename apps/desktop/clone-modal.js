/**
 * Modal de clonar repositório: cola o link (ou escolhe da lista, se GitHub
 * estiver conectado), escolhe a pasta, acompanha o progresso.
 *
 * O progresso chega por SSE (`POST /v1/git/clone`) e não por resposta simples
 * porque clone de repositório grande leva minutos — e tela parada por minutos é
 * indistinguível de travada. O `ok`/`erro` vem como ÚLTIMO EVENTO, não como
 * status HTTP: quando o stream abriu, o 200 já foi embora.
 *
 * Dependências por parâmetro (mesmo motivo de `dialogo.js` e `automacao-modal.js`):
 * é o que torna isto testável fora do Electron, que é onde `window.nexo` existe.
 * `req` é opcional: sem ele (como nos testes) o seletor de "meus repositórios"
 * fica escondido e só sobra o link colado à mão — comportamento de antes.
 */
export function createCloneModal({ el, api, headers, req, lerEventos, pickFolder, aoClonar, fetchImpl = fetch }) {
  /** Cancela o stream em andamento; `null` quando não há clone rodando. */
  let cancelar = null;

  function erro(msg) {
    const p = el("cl-err");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function progresso(msg) {
    const p = el("cl-progresso");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  /** Enquanto clona, o botão vira estado: sem isso dá pra disparar dois clones na mesma pasta. */
  function rodando(sim) {
    el("btn-cl-clonar").disabled = sim;
    el("btn-cl-clonar").textContent = sim ? "Clonando…" : "Clonar";
    el("cl-url").disabled = sim;
    el("btn-cl-pasta").disabled = sim;
  }

  async function escolherPasta() {
    const pasta = await pickFolder();
    if (!pasta) return;
    el("cl-pasta").value = pasta;
    erro("");
  }

  /*
   * Lista customizada em vez de <select> nativo: no Electron/Chromium, rolar a
   * bolinha do mouse com o popup nativo aberto fecha ele sozinho (rola a página
   * por baixo). Um <div> comum com overflow-y não tem esse problema — só fecha
   * em clique fora ou ao escolher um item.
   */
  function fecharDropdown(id) {
    el(id)?.classList.add("hidden");
  }

  function montarDropdown(listaId, itens, aoEscolher) {
    const lista = el(listaId);
    if (!lista) return;
    lista.innerHTML = "";
    for (const item of itens) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dropdown-item";
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        fecharDropdown(listaId);
        aoEscolher(item.value);
      });
      lista.appendChild(btn);
    }
  }

  function toggleDropdown(listaId) {
    const lista = el(listaId);
    if (!lista) return;
    const abrir = lista.classList.contains("hidden");
    fecharDropdown("cl-repo-list");
    fecharDropdown("cl-branch-list");
    if (abrir) lista.classList.remove("hidden");
  }

  /** repos.fullName → { cloneUrl, defaultBranch, private } — pro clique do dropdown achar os dados do item. */
  let reposPorNome = new Map();

  function preencherBranches(fullName, padrao) {
    const gatilho = el("cl-branch-trigger");
    const campo = el("cl-branch-field");
    if (!gatilho || !campo) return;
    gatilho.textContent = padrao || "…";
    montarDropdown("cl-branch-list", padrao ? [{ label: padrao, value: padrao }] : [], (branch) => {
      gatilho.textContent = branch;
    });
    campo.classList.remove("hidden");
    if (!req) return;
    req(`/v1/github/branches?repo=${encodeURIComponent(fullName)}`)
      .then((branches) => {
        if (gatilho.dataset.repo !== fullName) return; // trocou de repo enquanto isso carregava
        montarDropdown(
          "cl-branch-list",
          branches.map((b) => ({ label: b, value: b })),
          (branch) => {
            gatilho.textContent = branch;
          },
        );
      })
      .catch(() => {
        // fica só com a branch padrão que já tínhamos
      });
  }

  /** Repositório escolhido na lista (não link colado à mão): preenche a URL e busca as branches. */
  function selecionarRepo(fullName) {
    const branchCampo = el("cl-branch-field");
    const repoGatilho = el("cl-repo-trigger");
    const branchGatilho = el("cl-branch-trigger");
    if (!fullName) {
      if (repoGatilho) repoGatilho.textContent = "— colar link manualmente —";
      branchCampo?.classList.add("hidden");
      el("cl-url").value = "";
      el("cl-url").readOnly = false;
      return;
    }
    const repo = reposPorNome.get(fullName);
    if (!repo) return;
    if (repoGatilho) repoGatilho.textContent = repo.private ? `${fullName} (privado)` : fullName;
    el("cl-url").value = repo.cloneUrl;
    el("cl-url").readOnly = true;
    if (branchGatilho) branchGatilho.dataset.repo = fullName;
    preencherBranches(fullName, repo.defaultBranch);
  }

  /** Lista "meus repositórios" só quando o GitHub do Nexo está conectado (Configurações → GitHub). */
  async function carregarRepos() {
    const bloco = el("cl-github");
    if (!req || !bloco) return;
    try {
      const conta = await req("/v1/github");
      if (!conta.connected) {
        bloco.classList.add("hidden");
        return;
      }
      const repos = await req("/v1/github/repos");
      reposPorNome = new Map(repos.map((r) => [r.fullName, r]));
      montarDropdown(
        "cl-repo-list",
        [
          { label: "— colar link manualmente —", value: "" },
          ...repos.map((r) => ({ label: r.private ? `${r.fullName} (privado)` : r.fullName, value: r.fullName })),
        ],
        selecionarRepo,
      );
      bloco.classList.remove("hidden");
    } catch {
      bloco.classList.add("hidden");
    }
  }

  async function clonar() {
    const url = el("cl-url").value.trim();
    const destinoPai = el("cl-pasta").value.trim();
    if (!url) return erro("Cole o link do repositório.");
    if (!destinoPai) return erro("Escolha a pasta onde o repositório vai ficar.");
    const branchCampo = el("cl-branch-field");
    const branch = branchCampo && !branchCampo.classList.contains("hidden") ? el("cl-branch-trigger")?.textContent || "" : "";

    erro("");
    progresso("Começando…");
    rodando(true);
    const ac = new AbortController();
    cancelar = () => ac.abort();
    let destino = "";
    try {
      const res = await fetchImpl(api("/v1/git/clone"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ url, destinoPai, ...(branch ? { branch } : {}) }),
        signal: ac.signal,
      });
      await lerEventos(res, (ev) => {
        if (ev.type === "progresso") progresso(ev.linha);
        if (ev.type === "erro") erro(ev.message);
        if (ev.type === "ok") destino = ev.dir;
      });
    } catch (e) {
      // abortar é a pessoa fechando o modal, não falha que ela precise ler
      if (!ac.signal.aborted) erro(e.message || "O clone falhou.");
    } finally {
      cancelar = null;
      rodando(false);
      progresso("");
    }

    if (!destino) return false;
    await aoClonar(destino);
    fechar();
    return true;
  }

  function abrir() {
    el("cl-url").value = "";
    el("cl-url").readOnly = false;
    el("cl-pasta").value = "";
    erro("");
    progresso("");
    rodando(false);
    if (el("cl-repo-trigger")) el("cl-repo-trigger").textContent = "— colar link manualmente —";
    fecharDropdown("cl-repo-list");
    fecharDropdown("cl-branch-list");
    el("cl-branch-field")?.classList.add("hidden");
    el("clone-modal").classList.remove("hidden");
    void carregarRepos();
  }

  function fechar() {
    // o clone segue no daemon se já começou; o que se corta aqui é só o stream
    cancelar?.();
    fecharDropdown("cl-repo-list");
    fecharDropdown("cl-branch-list");
    el("clone-modal").classList.add("hidden");
  }

  function ligar() {
    el("btn-cl-pasta").addEventListener("click", () => void escolherPasta());
    el("btn-cl-clonar").addEventListener("click", () => void clonar());
    el("btn-cl-fechar").addEventListener("click", fechar);
    el("cl-repo-trigger")?.addEventListener("click", () => toggleDropdown("cl-repo-list"));
    el("cl-branch-trigger")?.addEventListener("click", () => toggleDropdown("cl-branch-list"));
    document.addEventListener("click", (e) => {
      if (!el("cl-repo-dd")?.contains(e.target)) fecharDropdown("cl-repo-list");
      if (!el("cl-branch-dd")?.contains(e.target)) fecharDropdown("cl-branch-list");
    });
    el("clone-modal").addEventListener("click", (e) => {
      if (e.target.id === "clone-modal") fechar();
    });
  }

  return { abrir, fechar, ligar, clonar };
}
