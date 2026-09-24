/**
 * Modal com os processos soltos que o Nexos pôs de pé — serviços de qualquer projeto e órfãos
 * (motor que ficou pendurado, serviço de uma subida anterior). Agente trabalhando fica de fora:
 * o daemon já não lista (ver `processos.ts`).
 *
 * Aberto, atualiza sozinho a cada `intervaloMs`; fechado, não pergunta nada ao daemon. Matar vai
 * pela `chave` da lista — o daemon recusa PID que ele mesmo não listou.
 *
 * Dependências por parâmetro (mesmo motivo de `clone-modal.js`): testável fora do Electron.
 */
export function createProcessosModal({ el, req, aoErro, confirmar = async () => true, intervaloMs = 3000, agora = () => Date.now() }) {
  let timer = null;
  let lista = [];
  let carregando = false;

  function tempo(ms) {
    const s = Math.max(0, Math.round((agora() - ms) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}min`;
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, "0")}`;
  }

  function pasta(p) {
    return (p || "").split(/[\\/]/).filter(Boolean).at(-1) || p || "";
  }

  function paint() {
    const ul = el("proc-list");
    const doc = ul.ownerDocument;
    ul.replaceChildren();
    el("proc-empty").classList.toggle("hidden", lista.length > 0);
    for (const p of lista) {
      const li = doc.createElement("li");
      li.className = "proc-item";
      li.dataset.tipo = p.tipo;

      const topo = doc.createElement("div");
      topo.className = "proc-topo";
      const nome = doc.createElement("span");
      nome.className = "proc-nome";
      nome.textContent = p.tipo === "servico" ? p.nome : `${p.nome || "processo"} · órfão`;
      const meta = doc.createElement("span");
      meta.className = "proc-meta";
      meta.textContent = [
        p.projectPath ? pasta(p.projectPath) : "",
        p.porta ? `:${p.porta}` : "",
        `PID ${p.pid}`,
        p.desde ? tempo(p.desde) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const matar = doc.createElement("button");
      matar.type = "button";
      matar.className = "ghost proc-matar";
      matar.textContent = p.tipo === "servico" ? "Parar" : "Matar";
      matar.addEventListener("click", () => void acabar(p));
      topo.append(nome, meta, matar);

      const cmd = doc.createElement("div");
      cmd.className = "proc-cmd";
      cmd.textContent = p.comando;
      cmd.title = p.comando;
      li.append(topo, cmd);
      if (p.motivo) {
        const motivo = doc.createElement("div");
        motivo.className = "proc-motivo";
        motivo.textContent = p.motivo;
        li.append(motivo);
      }
      ul.append(li);
    }
  }

  async function carregar() {
    if (carregando) return;
    carregando = true;
    try {
      const r = await req("/v1/processos");
      lista = r.processos || [];
      el("proc-err").classList.add("hidden");
    } catch (e) {
      el("proc-err").textContent = e.message || "não consegui listar os processos";
      el("proc-err").classList.remove("hidden");
    } finally {
      carregando = false;
    }
    paint();
  }

  async function acabar(p) {
    if (p.tipo === "orfao" && !(await confirmar(`Matar ${p.nome || "o processo"} (PID ${p.pid})?`))) return;
    try {
      await req("/v1/processos/matar", { method: "POST", body: JSON.stringify({ chave: p.chave }) });
    } catch (e) {
      aoErro(e.message || `não deu pra matar o PID ${p.pid}`);
    }
    await carregar();
  }

  function abrir() {
    el("processos-modal").classList.remove("hidden");
    void carregar();
    clearInterval(timer);
    timer = setInterval(() => void carregar(), intervaloMs);
  }

  function fechar() {
    el("processos-modal").classList.add("hidden");
    clearInterval(timer);
    timer = null;
  }

  return { abrir, fechar, carregar, aberto: () => timer !== null };
}
