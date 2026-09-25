/**
 * Tela de abertura: o que mostrar enquanto o motor sobe, em vez da janela vazia com "Ligando…"
 * no rodapé. Mock aprovado no DS "Mocks" (card `tela-de-abertura-loading`): 1 · ligando (passos),
 * 2 · demorando (mais de `DEMORA_MS`), 3 · motor travado. Puro: o renderer pinta e liga os botões.
 */

/** A partir daqui a subida deixa de ser normal e a tela oferece saída. */
export const DEMORA_MS = 25_000;

/** Mesmo prazo do vigia do main (destravar.cjs): sem agente vivo, reinicia sozinho aos 15 s. */
export const DESTRAVA_SOZINHO_MS = 15_000;

const MAGO = { ligando: "work", demorando: "idle", travado: "off", erro: "off" };

/** Linha útil de um stack de erro do Node (mesma regra do banner). */
export function linhaDoErro(msg) {
  const linhas = String(msg || "").trim().split(/\r?\n/).filter(Boolean);
  const linha = [...linhas].reverse().find((l) => /error/i.test(l) && !/^\s*at\s/.test(l)) || linhas.at(-1) || "";
  return linha.trim().slice(0, 200);
}

/**
 * `passos`: `{ motor, dados, conversa }` já concluídos; `comConversa` diz se há conversa pra
 * reabrir (sem ela o 3º passo nem aparece). Devolve `null` quando tudo terminou (tela sai).
 */
export function faseDaAbertura({ info = {}, passos = {}, comConversa = false, desde, agora = Date.now() }) {
  const lista = [
    { id: "motor", rotulo: "Motor ligado" },
    { id: "dados", rotulo: "Contas e projetos" },
    ...(comConversa ? [{ id: "conversa", rotulo: "Última conversa" }] : []),
  ];
  if (lista.every((p) => passos[p.id])) return null;

  const segundos = Math.max(0, Math.round((agora - desde) / 1000));
  let achouAtual = false;
  const marcar = (erro) =>
    lista.map((p) => {
      if (passos[p.id]) return { ...p, estado: "feito" };
      if (achouAtual) return { ...p, estado: "espera" };
      achouAtual = true;
      return { ...p, estado: erro ? "erro" : "agora" };
    });

  if (!info.ok && info.estado === "sem_resposta") {
    const t = info.travado || {};
    const acoes = [];
    let aviso;
    if (t.destravando) aviso = "Reiniciando o motor…";
    else if (t.recusado) {
      aviso = `Não confirmei que ${t.pid ? `o PID ${t.pid}` : "o processo na porta"} é o motor do Nexos (${t.motivo || "sem motivo"}).`;
      if (t.pid) acoes.push({ id: "forcar", rotulo: `Matar PID ${t.pid} e reiniciar`, pri: true });
    } else if (t.agentes) {
      aviso = "Tem agente trabalhando: reiniciar perde o turno em curso.";
      acoes.push({ id: "destravar", rotulo: "Reiniciar agora", pri: true });
    } else {
      const falta = t.desde ? Math.ceil((t.desde + DESTRAVA_SOZINHO_MS - agora) / 1000) : 0;
      aviso = falta > 0 ? `Reiniciando sozinho em ${falta} s` : "Reiniciando sozinho…";
      acoes.push({ id: "destravar", rotulo: "Reiniciar agora", pri: true });
    }
    acoes.push({ id: "log", rotulo: "Ver log" });
    return {
      fase: "travado",
      mago: MAGO.travado,
      status: "Motor travado",
      passos: marcar(true).map((p) => (p.id === "motor" ? { ...p, rotulo: "Motor não responde" } : p)),
      aviso,
      avisoEstado: !t.agentes && !t.recusado,
      nota: t.agentes ? "" : "Nenhum agente trabalhando agora.",
      acoes,
    };
  }

  if (!info.ok && !info.starting && info.erro) {
    return {
      fase: "erro",
      mago: MAGO.erro,
      status: "O motor não ligou",
      passos: marcar(true),
      meta: linhaDoErro(info.erro),
      acoes: [
        { id: "tentar", rotulo: "Tentar de novo", pri: true },
        { id: "log", rotulo: "Ver log" },
        { id: "entrar", rotulo: "Entrar assim mesmo", link: true },
      ],
    };
  }

  if (agora - desde >= DEMORA_MS) {
    return {
      fase: "demorando",
      mago: MAGO.demorando,
      status: passos.motor ? "Está demorando pra abrir" : "O motor está demorando pra ligar",
      meta: `há ${segundos} s`,
      aviso: "Pode ser a primeira subida depois de atualizar, ou o antivírus conferindo os arquivos.",
      acoes: [
        { id: "tentar", rotulo: "Tentar de novo", pri: true },
        { id: "log", rotulo: "Ver log" },
        { id: "entrar", rotulo: "Entrar assim mesmo", link: true },
      ],
    };
  }

  return {
    fase: "ligando",
    mago: MAGO.ligando,
    status: passos.motor ? "Abrindo sua área de trabalho…" : "Ligando o motor…",
    passos: marcar(false),
    acoes: [],
  };
}
