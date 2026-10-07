/**
 * Seção "Aprendizados" da Memória do Projeto: a pessoa aprova, edita ou rejeita o que o Nexos
 * percebeu nas correções dela (daemon: `instintos.ts`; na tela só se diz "aprendizado").
 *
 * Em cima, helpers puros (rótulos, filtros, contagens) testados sem DOM. Embaixo, a fábrica que
 * desenha a seção. Texto que veio de conversa (trecho da fala, título) é dado não confiável:
 * entra sempre por `textContent`, nunca por `innerHTML`.
 */

export const ABAS = [
  { id: "revisar", rotulo: "Pra revisar" },
  { id: "aprovados", rotulo: "Aprovados" },
  { id: "rejeitados", rotulo: "Rejeitados" },
];

export const GATILHO_MAX = 120;
export const ACAO_MAX = 280;
const TRECHO_MAX = 140;
const TOAST_MS = 6000;
const SAIDA_MS = 120;

const ROTULO_DO_SINAL = {
  parar: "Parar turno",
  inject: "Correção no meio do turno",
  mock_reprovado: "Mock reprovado",
  mensagem_seguinte: "Mensagem seguinte",
};
/** Rótulo curto de cada sinal dentro da lista de evidências. */
const ROTULO_CURTO = { parar: "parar turno", inject: "inject", mock_reprovado: "mock reprovado", mensagem_seguinte: "mensagem seguinte" };
/** Do mais forte pro mais fraco: o eyebrow do cartão mostra o primeiro que aparece nas evidências. */
const FORTE = ["mock_reprovado", "parar", "inject", "mensagem_seguinte"];

/** Espelho de `fraseDoGatilho` (instintos.ts): o gatilho vem sem o "Quando". */
export function fraseDoGatilho(gatilho) {
  const g = String(gatilho ?? "").trim().replace(/[:.]+$/, "");
  if (/^(quando|ao|antes|depois|sempre|se|em|no|na|durante)\b/i.test(g)) return g.charAt(0).toUpperCase() + g.slice(1);
  return `Quando ${g}`;
}

export function rotuloDoSinal(tipo) {
  return ROTULO_DO_SINAL[tipo] ?? "Correção";
}

/** Tipo do sinal mais forte entre as evidências (ou undefined, sem evidência). */
export function sinalMaisForte(evidencia) {
  const tipos = new Set((evidencia ?? []).map((e) => e.tipo));
  return FORTE.find((t) => tipos.has(t));
}

export function eyebrowDoCartao(i) {
  const tipo = sinalMaisForte(i.evidencia);
  return `${tipo ? rotuloDoSinal(tipo) : "Correção"} · ${i.escopo === "projeto" || !i.escopo ? "projeto" : i.escopo}`;
}

/** "0,30" — duas casas, vírgula. */
export function fmtConfianca(n) {
  return (Number(n) || 0).toFixed(2).replace(".", ",");
}

/** "05/10" no fuso da pessoa; vazio se a data não vale. */
export function fmtDataCurta(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function cortar(texto, max = TRECHO_MAX) {
  const t = String(texto ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Conversas distintas que deram evidência e a data mais recente. */
export function resumoDasEvidencias(evidencia) {
  const lista = evidencia ?? [];
  const conversas = new Set(lista.map((e) => e.threadId)).size;
  const ultimo = lista.map((e) => e.data).filter(Boolean).sort().at(-1);
  return { conversas, ultimo: ultimo ? fmtDataCurta(ultimo) : "" };
}

export function abaDoInstinto(i) {
  if (i.status === "candidato") return "revisar";
  if (i.status === "rejeitado") return "rejeitados";
  return "aprovados";
}

/** Instintos da aba, mais confiáveis primeiro (empate: o mais novo). */
export function filtrarPorAba(instintos, aba) {
  return (instintos ?? [])
    .filter((i) => abaDoInstinto(i) === aba)
    .sort((a, b) => b.confianca - a.confianca || String(b.atualizadoEm).localeCompare(String(a.atualizadoEm)));
}

export function contagens(instintos) {
  const c = { revisar: 0, aprovados: 0, rejeitados: 0 };
  for (const i of instintos ?? []) c[abaDoInstinto(i)]++;
  return c;
}

/** Abre em "Pra revisar" se houver pendente; senão "Aprovados". */
export function abaInicial(instintos) {
  return contagens(instintos).revisar > 0 ? "revisar" : "aprovados";
}

/** Candidatos pra revisar (0 com o aprendizado desligado: o contador some). */
export function pendentesDe(dados) {
  if (!dados || dados.ligado === false) return 0;
  return contagens(dados.instintos).revisar;
}

export function textoDoStatus(dados) {
  if (!dados) return "";
  if (dados.ligado === false) return "desligado";
  const n = pendentesDe(dados);
  return n > 0 ? `${n} pra revisar` : "nada pendente";
}

export function rotuloDoContador(n) {
  return n === 1 ? "1 aprendizado pra revisar" : `${n} aprendizados pra revisar`;
}

export function textoDoRodape(contexto) {
  if (!contexto) return "";
  return `No contexto agora: ${contexto.itens} de ${contexto.maxItens} · ${contexto.chars} de ${contexto.maxChars} caracteres`;
}

export function tituloDaProposta(p) {
  if (p.atualizar) return `Atualizar a skill /${p.skill}`;
  return `Juntar ${p.gatilhos.length} aprendizados sobre ${p.area} numa skill`;
}

export function textoAnalisando(n) {
  return n === 1 ? "analisando 1 conversa…" : `analisando ${n} conversas…`;
}

/* ---------------------------------------------------------------------------
 * DOM
 * ------------------------------------------------------------------------- */

const SVG_SETA_BAIXO = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" focusable="false"><path d="M3 4.5l3 3 3-3"/></svg>';
const SVG_SETA_LADO = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" focusable="false"><path d="M4.5 3l3 3-3 3"/></svg>';
const SVG_ALERTA = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true" focusable="false"><circle cx="6" cy="6" r="4.5"/><path d="M6 4v2.5M6 8.3v.1"/></svg>';

function no(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

function botao(texto, classe, onClick) {
  const b = no("button", classe, texto);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `req`: cliente do daemon. `el`: `$`. `getProjectPath`: projeto aberto. `visivel`: a Memória do
 * Projeto está na tela (só então a seção reconsulta sozinha enquanto o Nexos analisa).
 * `aoPendentes(path, n)`: o contador da barra lateral e da aba acompanham. `aoAbrirConversa(id)` e
 * `aoAbrirSkills()` reusam a navegação do app.
 */
export function createAprendizados({ req, el, getProjectPath, visivel = () => true, aoPendentes = () => {}, aoAbrirConversa = () => {}, aoAbrirSkills = () => {} }) {
  const st = {
    path: "",
    dados: null,
    carregando: false,
    erro: "",
    aba: "revisar",
    abaEscolhida: false,
    editando: null,
    expandidos: new Set(),
    erroDoCartao: null, // { id, texto }
    erroDaProposta: null, // { area, texto }
    ocupado: new Set(),
    toast: null, // { texto, desfazer? }
    timerToast: 0,
    timerPoll: 0,
  };

  const qs = () => `projectPath=${encodeURIComponent(st.path)}`;

  /* ---------- dados ---------- */

  async function carregar({ silencioso = false } = {}) {
    const path = getProjectPath();
    if (!path) return;
    if (path !== st.path) {
      Object.assign(st, { path, dados: null, erro: "", abaEscolhida: false, editando: null, erroDoCartao: null, erroDaProposta: null, toast: null });
      st.expandidos.clear();
    }
    clearTimeout(st.timerPoll);
    if (!st.dados && !silencioso) {
      st.carregando = true;
      desenhar();
    }
    try {
      const dados = await req(`/v1/aprendizados?${qs()}`);
      if (path !== st.path) return;
      st.dados = dados;
      st.erro = "";
      if (!st.abaEscolhida) {
        st.aba = abaInicial(dados.instintos);
        st.abaEscolhida = true;
      }
      aoPendentes(path, pendentesDe(dados));
    } catch (e) {
      if (path !== st.path) return;
      // erro com dados na tela: mantém o que já tinha e mostra o aviso
      st.erro = e.message || "erro desconhecido";
    }
    st.carregando = false;
    desenhar();
    if (st.dados?.analisando > 0) st.timerPoll = setTimeout(() => visivel() && void carregar({ silencioso: true }), 8000);
  }

  /** Troca um instinto devolvido pelo motor dentro dos dados da tela (antes de reconsultar). */
  function aplicarLocal(novo) {
    if (!st.dados || !novo) return;
    st.dados.instintos = st.dados.instintos.map((i) => (i.id === novo.id ? { ...i, ...novo } : i));
  }

  /* ---------- toast ---------- */

  function mostrarToast(texto, desfazer) {
    clearTimeout(st.timerToast);
    st.toast = { texto, desfazer };
    st.timerToast = setTimeout(() => {
      st.toast = null;
      desenharToast();
    }, desfazer ? TOAST_MS : 4000);
    desenharToast();
  }

  function desenharToast() {
    const alvo = el("aprend-toast");
    if (!alvo) return;
    alvo.replaceChildren();
    alvo.classList.toggle("hidden", !st.toast);
    if (!st.toast) return;
    alvo.append(no("span", "", st.toast.texto));
    if (st.toast.desfazer) alvo.append(botao("Desfazer", "aprend-toast-lk", st.toast.desfazer));
  }

  /* ---------- ações ---------- */

  /** Id do cartão que fica no lugar do que sai (foco): o próximo da aba, senão o anterior. */
  function vizinhoDe(id) {
    const ids = filtrarPorAba(st.dados.instintos, st.aba).map((i) => i.id);
    const k = ids.indexOf(id);
    return ids[k + 1] ?? ids[k - 1] ?? null;
  }

  function focarDepois(idProximo) {
    const alvo = idProximo ? el("aprend-lista")?.querySelector(`[data-id="${CSS.escape(idProximo)}"]`) : el("aprend-h");
    alvo?.focus?.();
  }

  async function sairComFade(id) {
    const art = el("aprend-lista")?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (art) {
      art.classList.add("saindo");
      await dormir(SAIDA_MS);
    }
  }

  function conflito(e) {
    if (e.status !== 409) return false;
    if (e.data?.atual) aplicarLocal(e.data.atual);
    st.editando = null;
    mostrarToast("Mudou em outro aparelho — recarreguei.");
    void carregar({ silencioso: true });
    return true;
  }

  async function agir(i, acao) {
    if (st.ocupado.has(i.id)) return;
    st.ocupado.add(i.id);
    st.erroDoCartao = null;
    const proximo = vizinhoDe(i.id);
    const statusAnterior = i.status;
    try {
      const novo = await req(`/v1/aprendizados/${encodeURIComponent(i.id)}/acao?${qs()}`, {
        method: "POST",
        body: JSON.stringify({ acao, expected: i.atualizadoEm }),
      });
      await sairComFade(i.id);
      aplicarLocal(novo);
      if (acao === "aprovar") mostrarToast("Aprovado — entra nas próximas conversas.");
      else if (acao === "rejeitar") {
        mostrarToast("Rejeitado.", () => void desfazerRejeicao(novo, statusAnterior));
      }
      desenhar();
      focarDepois(proximo);
      void carregar({ silencioso: true });
    } catch (e) {
      if (!conflito(e)) {
        st.erroDoCartao = { id: i.id, texto: e.message || "Não gravou." };
        desenhar();
      }
    } finally {
      st.ocupado.delete(i.id);
    }
  }

  async function desfazerRejeicao(i, statusAnterior) {
    clearTimeout(st.timerToast);
    st.toast = null;
    desenharToast();
    try {
      const novo = await req(`/v1/aprendizados/${encodeURIComponent(i.id)}/acao?${qs()}`, {
        method: "POST",
        body: JSON.stringify({ acao: "desfazer-rejeicao", expected: i.atualizadoEm, statusAnterior }),
      });
      aplicarLocal(novo);
      desenhar();
      void carregar({ silencioso: true });
    } catch (e) {
      if (!conflito(e)) mostrarToast(`Não deu pra desfazer: ${e.message || "erro"}`);
    }
  }

  async function salvarEdicao(i, gatilho, acao, aprovar) {
    if (st.ocupado.has(i.id)) return;
    st.ocupado.add(i.id);
    st.erroDoCartao = null;
    desenhar();
    try {
      const novo = await req(`/v1/aprendizados/${encodeURIComponent(i.id)}?${qs()}`, {
        method: "PUT",
        body: JSON.stringify({ gatilho, acao, aprovar, expected: i.atualizadoEm }),
      });
      st.editando = null;
      aplicarLocal(novo);
      if (aprovar) mostrarToast("Aprovado — entra nas próximas conversas.");
      desenhar();
      void carregar({ silencioso: true });
    } catch (e) {
      // edição fica aberta, com o texto que a pessoa digitou (a próxima pintura relê dos campos)
      if (!conflito(e)) st.erroDoCartao = { id: i.id, texto: e.message || "Não gravou.", rascunho: { gatilho, acao } };
      desenhar();
    } finally {
      st.ocupado.delete(i.id);
    }
  }

  async function criarSkill(p) {
    const chave = `skill:${p.area}`;
    if (st.ocupado.has(chave)) return;
    st.ocupado.add(chave);
    st.erroDaProposta = null;
    desenhar();
    try {
      const r = await req(`/v1/aprendizados/propostas/${encodeURIComponent(p.area)}/skill?${qs()}`, { method: "POST" });
      mostrarToast(`Skill /${r.skill} ${p.atualizar ? "atualizada" : "criada"} — vale nas próximas conversas.`);
      await carregar({ silencioso: true });
    } catch (e) {
      st.erroDaProposta = { area: p.area, texto: e.message || "Não deu pra criar a skill." };
      desenhar();
    } finally {
      st.ocupado.delete(chave);
    }
  }

  async function adiar(p) {
    try {
      await req(`/v1/aprendizados/propostas/${encodeURIComponent(p.area)}/adiar?${qs()}`, { method: "POST" });
      st.dados.propostas = st.dados.propostas.filter((x) => x.area !== p.area);
      desenhar();
    } catch (e) {
      st.erroDaProposta = { area: p.area, texto: e.message || "Não gravou." };
      desenhar();
    }
  }

  async function alternarChave(ligado) {
    try {
      await req(`/v1/aprendizados/config?${qs()}`, { method: "PUT", body: JSON.stringify({ ligado }) });
      if (st.dados) st.dados.ligado = ligado;
      aoPendentes(st.path, pendentesDe(st.dados));
      desenhar();
    } catch (e) {
      st.erro = e.message || "Não gravou.";
      desenhar();
    }
  }

  /* ---------- desenho ---------- */

  function cartaoDeProposta(p) {
    const art = no("article", "aprend-card aprend-prop");
    const titulo = tituloDaProposta(p);
    art.setAttribute("aria-label", titulo);
    art.append(no("div", "aprend-eyebrow", `Proposta de skill · ${p.area}`), no("div", "aprend-tit", titulo));
    const ul = no("ul", "aprend-gat");
    for (const g of p.gatilhos) ul.append(no("li", "", fraseDoGatilho(g)));
    art.append(ul);
    if (st.erroDaProposta?.area === p.area) art.append(no("p", "ag-err", st.erroDaProposta.texto));
    const ocupado = st.ocupado.has(`skill:${p.area}`);
    const acoes = no("div", "aprend-acoes");
    const principal = botao(st.erroDaProposta?.area === p.area ? "Tentar de novo" : p.atualizar ? "Atualizar skill" : "Criar skill", "primary", () => void criarSkill(p));
    principal.disabled = ocupado;
    acoes.append(principal, botao("Agora não", "ghost", () => void adiar(p)));
    art.append(acoes);
    return art;
  }

  function evidencias(i) {
    const ul = no("ul", "aprend-ev");
    for (const e of i.evidencia) {
      const li = no("li");
      const b = botao("", "aprend-ev-btn", () => aoAbrirConversa(e.threadId));
      b.title = "Abrir a conversa";
      b.append(no("b", "", `“${e.titulo || "Conversa"}”`));
      const data = fmtDataCurta(e.data);
      b.append(document.createTextNode(` · ${data ? `${data} · ` : ""}${ROTULO_CURTO[e.tipo] ?? "correção"}`));
      if (e.trecho) {
        b.append(document.createTextNode(" — "), no("q", "", cortar(e.trecho)));
      }
      li.append(b);
      ul.append(li);
    }
    return ul;
  }

  function formDeEdicao(i, art) {
    const rascunho = st.erroDoCartao?.id === i.id ? st.erroDoCartao.rascunho : null;
    const campo = (rotulo, max, valor, multilinha) => {
      const wrap = no("div", "aprend-campo");
      const lab = no("label");
      const cont = no("span", "aprend-cont", `${valor.length}/${max}`);
      lab.append(document.createTextNode(rotulo), cont);
      const campoEl = multilinha ? no("textarea") : no("input");
      if (!multilinha) campoEl.type = "text";
      else campoEl.rows = 3;
      campoEl.value = valor;
      campoEl.maxLength = max;
      campoEl.setAttribute("aria-label", rotulo.replace("…", ""));
      campoEl.addEventListener("input", () => {
        cont.textContent = `${campoEl.value.length}/${max}`;
      });
      wrap.append(lab, campoEl);
      return { wrap, campoEl };
    };
    art.dataset.editando = "1";
    const g = campo("Quando…", GATILHO_MAX, rascunho?.gatilho ?? i.gatilho, false);
    const a = campo("Fazer…", ACAO_MAX, rascunho?.acao ?? i.acao, true);
    art.append(g.wrap, a.wrap);
    if (st.erroDoCartao?.id === i.id) art.append(no("p", "ag-err", st.erroDoCartao.texto));
    const candidato = i.status === "candidato";
    const cancelar = () => {
      st.editando = null;
      st.erroDoCartao = null;
      desenhar();
      el("aprend-lista")?.querySelector(`[data-id="${CSS.escape(i.id)}"]`)?.focus?.();
    };
    const salvar = botao(candidato ? "Salvar e aprovar" : "Salvar", "primary", () => void salvarEdicao(i, g.campoEl.value, a.campoEl.value, candidato));
    salvar.disabled = st.ocupado.has(i.id);
    art.append(no("div", "aprend-acoes"));
    art.lastChild.append(salvar, botao("Cancelar", "ghost", cancelar));
    art.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        cancelar();
      }
    });
    queueMicrotask(() => g.campoEl.focus?.());
  }

  function cartao(i) {
    const titulo = fraseDoGatilho(i.gatilho);
    const art = no("article", "aprend-card");
    art.dataset.id = i.id;
    art.tabIndex = -1;
    art.setAttribute("aria-label", titulo);
    art.append(no("div", "aprend-eyebrow", eyebrowDoCartao(i)));

    if (st.editando === i.id) {
      formDeEdicao(i, art);
      return art;
    }

    art.append(no("div", "aprend-tit", titulo), no("div", "aprend-corpo", i.acao));

    const meta = no("div", "aprend-meta");
    if (i.status === "incorporado") {
      const pl = botao(`na skill /${i.skill}`, "aprend-pill aprend-pill-ativo", aoAbrirSkills);
      pl.title = "Abrir Configurações › Skills";
      meta.append(pl);
    } else {
      if (i.status === "aprovado" && i.noContexto === false) {
        const pl = no("span", "aprend-pill aprend-pill-teto");
        pl.innerHTML = SVG_ALERTA;
        pl.append("fora do contexto (teto)");
        meta.append(pl);
      }
      const conf = no("span", "aprend-conf", `Confiança ${fmtConfianca(i.confianca)}`);
      const barra = no("span", "aprend-barra");
      barra.setAttribute("aria-hidden", "true");
      const preenchido = no("i");
      preenchido.style.width = `${Math.round(Math.min(1, Math.max(0, i.confianca)) * 100)}%`;
      barra.append(preenchido);
      conf.append(barra);
      meta.append(conf);
      const r = resumoDasEvidencias(i.evidencia);
      if (r.conversas) {
        meta.append(no("span", "aprend-sep", "·"), no("span", "", `visto em ${r.conversas} ${r.conversas === 1 ? "conversa" : "conversas"}${r.ultimo ? ` · último ${r.ultimo}` : ""}`));
      }
    }
    art.append(meta);

    if (i.evidencia?.length) {
      const aberto = st.expandidos.has(i.id);
      const disc = no("button", "aprend-disc");
      disc.type = "button";
      disc.setAttribute("aria-expanded", aberto ? "true" : "false");
      disc.innerHTML = aberto ? SVG_SETA_BAIXO : SVG_SETA_LADO;
      disc.append(`De onde veio (${i.evidencia.length})`);
      disc.addEventListener("click", () => {
        if (aberto) st.expandidos.delete(i.id);
        else st.expandidos.add(i.id);
        desenhar();
        el("aprend-lista")?.querySelector(`[data-id="${CSS.escape(i.id)}"] .aprend-disc`)?.focus?.();
      });
      art.append(disc);
      if (aberto) art.append(evidencias(i));
    }

    if (st.erroDoCartao?.id === i.id) art.append(no("p", "ag-err", st.erroDoCartao.texto));

    const acoes = no("div", "aprend-acoes");
    const ocupado = st.ocupado.has(i.id);
    const editar = botao("Editar", "ghost", () => {
      st.editando = i.id;
      st.erroDoCartao = null;
      desenhar();
    });
    if (i.status === "candidato") {
      const ok = botao("Aprovar", "primary", () => void agir(i, "aprovar"));
      ok.disabled = ocupado;
      acoes.append(ok, editar, botao("Rejeitar", "ghost", () => void agir(i, "rejeitar")));
    } else if (i.status === "aprovado") {
      acoes.append(editar, botao("Remover", "ghost", () => void agir(i, "rejeitar")));
    } else if (i.status === "rejeitado") {
      acoes.append(botao("Reconsiderar", "ghost", () => void agir(i, "reconsiderar")));
    }
    if (acoes.children.length) art.append(acoes);
    return art;
  }

  function esqueleto() {
    const wrap = no("div", "aprend-card aprend-esq");
    wrap.setAttribute("aria-hidden", "true");
    for (const w of ["30%", "60%", "85%"]) {
      const barra = no("i");
      barra.style.width = w;
      wrap.append(barra);
    }
    return wrap;
  }

  function vazio(titulo, texto) {
    const v = no("div", "aprend-vazio");
    v.append(no("h3", "", titulo));
    if (texto) v.append(no("p", "", texto));
    return v;
  }

  function desenhar() {
    const sec = el("aprend-sec");
    if (!sec) return;
    const dados = st.dados;
    const pend = pendentesDe(dados);

    const contador = el("aprend-contador");
    contador.textContent = String(pend);
    contador.classList.toggle("hidden", pend === 0);
    contador.setAttribute("aria-label", rotuloDoContador(pend));

    const status = el("aprend-status");
    status.replaceChildren();
    if (st.carregando && !dados) status.textContent = "carregando…";
    else if (dados?.analisando > 0) {
      status.append(no("span", "aprend-spin"), textoAnalisando(dados.analisando));
    } else status.textContent = textoDoStatus(dados);
    status.dataset.on = dados && dados.ligado !== false && pend > 0 ? "1" : "0";

    const chave = el("aprend-ligado");
    chave.checked = dados ? dados.ligado !== false : true;
    chave.disabled = !dados;

    const erro = el("aprend-erro");
    erro.classList.toggle("hidden", !st.erro);
    el("aprend-erro-msg").textContent = st.erro ? `Não deu pra ler os aprendizados: ${st.erro}.`.replace(/\.\.$/, ".") : "";

    const abas = el("aprend-abas");
    const lista = el("aprend-lista");
    // edição aberta: o cartão é reaproveitado (repintar jogaria fora o que a pessoa digitou)
    const emEdicao = st.editando ? lista.querySelector('[data-editando="1"]') : null;
    abas.replaceChildren();
    lista.replaceChildren();
    el("aprend-rodape").textContent = "";

    if (!dados) {
      abas.classList.add("hidden");
      if (st.carregando) lista.append(esqueleto(), esqueleto());
      return;
    }

    const c = contagens(dados.instintos);
    abas.classList.toggle("hidden", dados.instintos.length === 0);
    for (const aba of ABAS) {
      const b = no("button", "aprend-tab");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", st.aba === aba.id ? "true" : "false");
      b.tabIndex = st.aba === aba.id ? 0 : -1;
      b.dataset.aba = aba.id;
      b.append(`${aba.rotulo} `, no("span", "n", `(${c[aba.id]})`));
      b.addEventListener("click", () => {
        st.aba = aba.id;
        st.abaEscolhida = true;
        st.editando = null;
        desenhar();
      });
      abas.append(b);
    }

    if (!dados.instintos.length) {
      lista.append(vazio("Nada aprendido ainda", "Quando você parar um turno, corrigir o agente no meio do caminho ou reprovar um mock, o Nexos anota o padrão aqui pra você revisar."));
      return;
    }

    for (const p of dados.propostas ?? []) lista.append(cartaoDeProposta(p));
    const doAba = filtrarPorAba(dados.instintos, st.aba);
    for (const i of doAba) {
      const reaproveita = emEdicao && emEdicao.dataset.id === i.id && st.editando === i.id && st.erroDoCartao?.id !== i.id;
      lista.append(reaproveita ? emEdicao : cartao(i));
    }
    if (!doAba.length) {
      lista.append(
        st.aba === "revisar" && c.aprovados > 0
          ? vazio("Tudo revisado.")
          : vazio(st.aba === "revisar" ? "Nada pra revisar" : st.aba === "aprovados" ? "Nenhum aprovado ainda" : "Nenhum rejeitado"),
      );
    }
    el("aprend-rodape").textContent = textoDoRodape(dados.contexto);
  }

  /* ---------- ligações ---------- */

  function ligar() {
    el("aprend-ligado").addEventListener("change", (ev) => void alternarChave(ev.target.checked));
    el("btn-aprend-tentar").addEventListener("click", () => void carregar());
    el("aprend-abas").addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      const ids = ABAS.map((a) => a.id);
      const k = ids.indexOf(st.aba) + (ev.key === "ArrowRight" ? 1 : -1);
      st.aba = ids[(k + ids.length) % ids.length];
      st.abaEscolhida = true;
      desenhar();
      el("aprend-abas").querySelector(`[data-aba="${st.aba}"]`)?.focus();
    });
  }
  ligar();

  return {
    carregar,
    /** Pra teste e pra tela: estado atual. */
    estado: () => st,
  };
}
