/**
 * Torre de magia — o CONVÍVIO entre os magos do Salão (camada pura, sorteio injetado).
 *
 * Fica ACIMA do cérebro na ordem de prioridade: só mago LIVRE (ocioso, terminou e já comemorou,
 * sem pergunta, com mana) entra em interação, e qualquer mudança de estado interrompe na hora.
 * Mago com tarefa ativa ou esperando você nunca sai da mesa — no máximo olha ou levanta a cabeça.
 *
 * Interações (pedido da pessoa, as cinco):
 * - conversar: dois vizinhos livres trocam balõezinhos (~4 s);
 * - espiar: livre anda até a mesa do vizinho que trabalha, olha por cima, volta;
 * - comemorar junto: vizinhos de quem terminou pulam (livres) ou levantam a cabeça (ocupados);
 * - apontar pro "?": todo mundo olha pra quem espera você; livres apontam, de novo a cada 15 s;
 * - cumprimentar: quem chega/volta acena; os livres acenam de volta.
 * Primeiro retrato e volta de aba oculta não disparam nada (os eventos já cuidam disso).
 */

export const CONVERSA_MS = 4_000;
export const ESPIA_IDA_MS = 800;
export const ESPIA_OLHA_MS = 3_000;
export const COMEMORA_MS = 1_200;
export const APONTA_MS = 1_200;
export const APONTA_REPETE_MS = 15_000;
export const ACENO_MS = 1_500;
export const OLHA_ESTRELA_MS = 2_000;
/** Intervalo entre sorteios de um mago livre: 20–40 s. */
export const SORTEIO_MIN_MS = 20_000;
export const SORTEIO_MAX_MS = 40_000;
export const MESAS_POR_FILEIRA = 4;

const LIVRE = new Set(["ocioso", "terminou", "erro"]);
const OCUPADO = new Set(["trabalhando", "pensando", "segundo-plano"]);

export function convivioNovo() {
  return {
    /** chave → interação ativa `{ tipo, alvo, desde, ate, papel }`. */
    ativas: new Map(),
    /** chave → quando pode sortear de novo. */
    proximoSorteio: new Map(),
    /** chave de quem espera você → último "apontar" disparado. */
    apontadoEm: new Map(),
  };
}

/** Mago pode entrar numa interação agora? */
export function livre(m) {
  return LIVRE.has(m.estado) && !m.comemorando;
}

/** Vizinhos de mesa: ao lado na mesma fileira e o da mesma coluna na outra fileira. */
export function vizinhos(mesas, chave) {
  const i = mesas.get(chave);
  if (i === undefined) return [];
  const out = [];
  const fileira = Math.floor(i / MESAS_POR_FILEIRA);
  for (const [outra, j] of mesas) {
    if (outra === chave) continue;
    const mesmaFileira = Math.floor(j / MESAS_POR_FILEIRA) === fileira;
    if ((mesmaFileira && Math.abs(j - i) === 1) || (!mesmaFileira && j % MESAS_POR_FILEIRA === i % MESAS_POR_FILEIRA)) out.push(outra);
  }
  return out;
}

function comecar(c, chave, tipo, alvo, agora, ms, papel = "") {
  c.ativas.set(chave, { tipo, alvo, desde: agora, ate: agora + ms, papel });
}

function proximo(c, chave, agora, sorteio) {
  c.proximoSorteio.set(chave, agora + SORTEIO_MIN_MS + Math.floor(sorteio() * (SORTEIO_MAX_MS - SORTEIO_MIN_MS)));
}

/**
 * Avança o convívio. `magos` = personagens do Salão (modelo), `mesas` = Map chave → índice
 * (lugares), `eventos` = os da camada 4 neste tique.
 * @returns Map chave → `{ tipo, alvo, fase, progresso, pose, espelho }` só pra quem está interagindo
 */
export function avancarConvivio(c, { magos, mesas, eventos = [], agora, sorteio = Math.random, reduzido = false }) {
  const porChave = new Map(magos.map((m) => [m.chave, m]));

  // 1. interrompe quem mudou de estado ou saiu; encerra o que venceu
  for (const [chave, a] of [...c.ativas]) {
    const m = porChave.get(chave);
    const alvoSumiu = a.alvo && !porChave.has(a.alvo);
    const precisaLivre = a.tipo !== "olhando" && a.tipo !== "levanta-cabeca" && a.tipo !== "olhando-estrela" && a.tipo !== "cumprimento";
    if (!m || a.ate <= agora || alvoSumiu || (precisaLivre && !livre(m))) {
      c.ativas.delete(chave);
      // conversa é a dois: o par também para
      if (a.tipo === "conversando" && c.ativas.get(a.alvo)?.alvo === chave) c.ativas.delete(a.alvo);
    }
  }

  const esperando = magos.filter((m) => m.estado === "esperando").map((m) => m.chave);
  for (const k of [...c.apontadoEm.keys()]) if (!esperando.includes(k)) c.apontadoEm.delete(k);

  // 2. eventos
  const perguntasNovas = new Set();
  for (const ev of eventos) {
    if (ev.tipo === "terminou") {
      for (const v of vizinhos(mesas, ev.chave)) {
        const m = porChave.get(v);
        if (!m || c.ativas.has(v)) continue;
        if (livre(m)) comecar(c, v, "comemorando-junto", ev.chave, agora, COMEMORA_MS);
        else if (OCUPADO.has(m.estado)) comecar(c, v, "levanta-cabeca", ev.chave, agora, 800);
      }
    }
    if (ev.tipo === "pergunta") perguntasNovas.add(ev.chave); // força o apontar agora
    if (ev.tipo === "estrela") {
      // estrela acendeu: quem está livre olha pra cima; quem trabalha só levanta a cabeça
      for (const m of magos) {
        if (c.ativas.has(m.chave) || m.estado === "esperando") continue;
        comecar(c, m.chave, "olhando-estrela", "", agora, OLHA_ESTRELA_MS);
      }
    }
    if (ev.tipo === "entrou" || ev.tipo === "voltou") {
      const quem = ev.chave;
      const m = porChave.get(quem);
      if (m && livre(m) && !c.ativas.has(quem)) comecar(c, quem, "acenando", "", agora, ACENO_MS);
      for (const outro of magos) {
        if (outro.chave === quem || c.ativas.has(outro.chave) || !livre(outro)) continue;
        comecar(c, outro.chave, "acenando", quem, agora, ACENO_MS);
      }
    }
  }

  // 3. apontar pro "?" (na pergunta nova e a cada 15 s enquanto durar). Quem já esperava quando a
  //    aba abriu (ou voltou de oculta) só começa a contar: o primeiro retrato não gera reação.
  for (const alvo of esperando) {
    const ultimo = c.apontadoEm.get(alvo);
    if (!perguntasNovas.has(alvo)) {
      if (ultimo === undefined) {
        c.apontadoEm.set(alvo, agora);
        continue;
      }
      if (agora - ultimo < APONTA_REPETE_MS) continue;
    }
    c.apontadoEm.set(alvo, agora);
    for (const m of magos) {
      if (m.chave === alvo || c.ativas.has(m.chave)) continue;
      if (livre(m)) comecar(c, m.chave, "apontando", alvo, agora, APONTA_MS);
      else if (OCUPADO.has(m.estado)) comecar(c, m.chave, "olhando", alvo, agora, APONTA_MS);
    }
  }

  // 4. sorteio: conversar ou espiar (só livres, sem interação, na vez deles)
  for (const m of magos) {
    if (!livre(m) || c.ativas.has(m.chave)) continue;
    const quando = c.proximoSorteio.get(m.chave);
    if (quando === undefined) {
      proximo(c, m.chave, agora, sorteio);
      continue;
    }
    if (quando > agora) continue;
    proximo(c, m.chave, agora, sorteio);
    const viz = vizinhos(mesas, m.chave).map((k) => porChave.get(k)).filter(Boolean);
    const livres = viz.filter((v) => livre(v) && !c.ativas.has(v.chave));
    const ocupados = viz.filter((v) => OCUPADO.has(v.estado));
    if (livres.length && sorteio() < 0.6) {
      const par = livres[Math.floor(sorteio() * livres.length)];
      comecar(c, m.chave, "conversando", par.chave, agora, CONVERSA_MS, "fala");
      comecar(c, par.chave, "conversando", m.chave, agora, CONVERSA_MS, "ouve");
      proximo(c, par.chave, agora, sorteio);
    } else if (ocupados.length && !reduzido) {
      const alvo = ocupados[Math.floor(sorteio() * ocupados.length)];
      comecar(c, m.chave, "espiando", alvo.chave, agora, ESPIA_IDA_MS * 2 + ESPIA_OLHA_MS);
    }
  }

  // 5. saída pra pintura
  const out = new Map();
  for (const [chave, a] of c.ativas) {
    const i = mesas.get(chave);
    const j = a.alvo ? mesas.get(a.alvo) : undefined;
    const espelho = j !== undefined && i !== undefined ? j % MESAS_POR_FILEIRA < i % MESAS_POR_FILEIRA : false;
    const t = agora - a.desde;
    let fase = "";
    let progresso = 0;
    let pose = a.tipo;
    if (a.tipo === "espiando") {
      if (reduzido) {
        fase = "olhando";
        pose = "olhando";
      } else if (t < ESPIA_IDA_MS) {
        fase = "indo";
        progresso = t / ESPIA_IDA_MS;
        pose = "andando";
      } else if (t < ESPIA_IDA_MS + ESPIA_OLHA_MS) {
        fase = "olhando";
        progresso = 1;
      } else {
        fase = "voltando";
        progresso = 1 - (t - ESPIA_IDA_MS - ESPIA_OLHA_MS) / ESPIA_IDA_MS;
        pose = "andando";
      }
    } else if (a.tipo === "olhando-estrela") {
      pose = porChave.get(chave) && livre(porChave.get(chave)) ? "olhando-cima" : "levanta-cabeca";
    } else if (a.tipo === "cumprimento") {
      pose = "acenando";
    } else if (a.tipo === "conversando") {
      // os dois alternam: quem fala agora ganha o balão
      const vez = Math.floor(t / 1_200) % 2 === 0;
      pose = (a.papel === "fala") === vez ? "conversando" : "ouvindo";
    }
    out.set(chave, { tipo: a.tipo, alvo: a.alvo, fase, progresso, pose, espelho: a.tipo === "espiando" && fase === "voltando" ? !espelho : espelho });
  }
  return out;
}

/** A pessoa clicou no mago: ele acena (1,5 s). */
export function cumprimentar(c, chave, agora) {
  const a = c.ativas.get(chave);
  if (a && a.tipo !== "olhando" && a.tipo !== "levanta-cabeca") return false;
  comecar(c, chave, "cumprimento", "", agora, ACENO_MS);
  return true;
}
