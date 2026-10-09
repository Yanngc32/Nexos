/**
 * Torre de magia — FALAS em balão (camada pura), como os "quips" do escritório do agent-code.
 *
 * Um balão por mago, no máximo 7 na torre (os de maior prioridade); cada situação tem 4+ frases
 * sorteadas sem repetir antes de as outras saírem; cortadas em 72 caracteres. Fixas enquanto o
 * estado valer: pergunta, erro, sem mana, apagão. O primeiro retrato não fala (os eventos já
 * garantem). Sem emoji: ícone é pixel/SVG, não texto.
 */

export const MAX_NA_TELA = 7;
export const CORTE = 72;
export const PRIORIDADE = { pergunta: 70, erro: 60, mana: 55, pedido: 50, quadro: 45, resultado: 40, aviso: 30, festa: 15, ocio: 10 };
export const TTL = { pedido: 7_000, resultado: 9_000, quadro: 4_000, aviso: 6_000, festa: 4_000, ocio: 6_500 };
export const OCIO_MIN_MS = 40_000;
export const OCIO_MAX_MS = 120_000;
export const OCIO_CHANCE = 0.6;

export const FRASES = {
  pedido: ["Opa, pedido novo — bora!", "Deixa comigo.", "Já vou nisso.", "Mãos à obra!", "Pode deixar, já estou vendo."],
  resultado: ["Pronto!", "Feito — dá uma olhada.", "Terminei por aqui.", "Entreguei.", "Fechado, próximo!"],
  erro: ["Deu ruim… preciso de ajuda.", "Tropecei num erro.", "Isso não devia acontecer.", "Travei num erro aqui."],
  pergunta: ["Preciso de você: {texto}", "Uma pergunta: {texto}", "Me diz: {texto}", "Decide pra mim: {texto}"],
  mana: ["Sem mana até {hora}.", "Cristal seco. Volta às {hora}.", "Esperando a mana voltar ({hora})."],
  travou: ["Sem sinal há {tempo}…", "Será que travei? {tempo} parado.", "Nada acontece há {tempo}."],
  delegou: ["Mandei um explorador: {texto}", "Explorador, vai lá: {texto}", "Delegado: {texto}"],
  voltou: ["O explorador voltou: missão cumprida.", "Voltou com o pergaminho cheio.", "Explorador de volta, tudo certo."],
  voltouMal: ["O explorador voltou de mãos vazias.", "Não deu: o explorador tropeçou.", "Voltou ferido, sem resposta."],
  comecou: ["Comecei: {texto}", "Peguei a tarefa: {texto}", "Em andamento: {texto}"],
  concluiu: ["Concluí: {texto}", "Fechei a tarefa: {texto}", "Carimbado: {texto}"],
  criou: ["Nova tarefa: {texto}", "Anotei no mural: {texto}", "Preguei no mural: {texto}"],
  anotou: ["Anotei em: {texto}", "Atualizei: {texto}", "Mexi em: {texto}"],
  apagao: ["Acabou a mana! Festa até {hora}", "Cadê o cristal reserva?", "Alguém tem uma tocha?", "Sem mana, sem trabalho — dança!"],
  voltaMana: ["Voltou a mana! Todo mundo pra mesa.", "Luz de volta. Ao trabalho!", "Mana no cristal — bora."],
  ocio: [
    "Nada pra fazer… vou olhar as estrelas.",
    "E se eu reescrevesse tudo em Rust?",
    "Alguém viu meu grimório?",
    "O chá de mana esfriou de novo.",
    "Será que o Quadro mudou?",
    "Hora de um cochilo?",
    "Esse caldeirão precisa de uma limpeza.",
  ],
};

export function falasNovo() {
  return {
    /** chave → `{ texto, prioridade, ate, fixa, categoria }`. */
    porMago: new Map(),
    /** categoria → índices já usados nesta rodada. */
    usadas: new Map(),
    /** chave → quando pode falar de ócio de novo. */
    proximoOcio: new Map(),
  };
}

function cortar(t) {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > CORTE ? `${s.slice(0, CORTE - 1).trimEnd()}…` : s;
}

/** Sorteia uma frase da categoria sem repetir antes de todas saírem. */
export function frase(f, categoria, dados = {}, sorteio = Math.random) {
  const lista = FRASES[categoria] ?? [];
  if (!lista.length) return "";
  let usadas = f.usadas.get(categoria);
  if (!usadas || usadas.size >= lista.length) {
    usadas = new Set();
    f.usadas.set(categoria, usadas);
  }
  const livres = lista.map((_, i) => i).filter((i) => !usadas.has(i));
  const i = livres[Math.floor(sorteio() * livres.length)];
  usadas.add(i);
  return cortar(lista[i].replace(/\{(\w+)\}/g, (_, k) => String(dados[k] ?? "")));
}

function dizer(f, chave, categoria, texto, prioridade, agora, ttl, fixa = false) {
  const atual = f.porMago.get(chave);
  if (atual && atual.ate > agora && atual.prioridade > prioridade) return false;
  f.porMago.set(chave, { texto, prioridade, ate: fixa ? Infinity : agora + ttl, fixa, categoria });
  return true;
}

const TIPO_DO_MURAL = { criou: "criou", moveu: "comecou", concluiu: "concluiu", editou: "anotou", checklist: "anotou", comentou: "anotou" };

/**
 * Eventos → falas. Aceita os da camada 4 (`pedido`, `terminou`, `erro`, `delegou`, `voltou`,
 * `travou`) e os do mural (`{ tipo: "mural", chave, mudanca: "criou"|"moveu"|"concluiu"|..., titulo }`),
 * do apagão (`{ tipo: "apagao", chave, hora }` / `{ tipo: "volta-mana", chave }`).
 */
export function aplicarEventosNasFalas(f, eventos, agora, sorteio = Math.random) {
  for (const ev of eventos ?? []) {
    const c = ev.chave;
    if (!c) continue;
    switch (ev.tipo) {
      case "pedido":
        dizer(f, c, "pedido", frase(f, "pedido", {}, sorteio), PRIORIDADE.pedido, agora, TTL.pedido);
        break;
      case "terminou":
        dizer(f, c, "resultado", frase(f, "resultado", {}, sorteio), PRIORIDADE.resultado, agora, TTL.resultado);
        break;
      case "delegou":
        dizer(f, c, "aviso", frase(f, "delegou", { texto: cortar(ev.descricao ?? "") || "explorar" }, sorteio), PRIORIDADE.aviso, agora, TTL.aviso);
        break;
      case "voltou":
        dizer(f, c, "resultado", frase(f, ev.ok === false ? "voltouMal" : "voltou", {}, sorteio), PRIORIDADE.resultado, agora, TTL.resultado);
        break;
      case "travou":
        dizer(f, c, "aviso", frase(f, "travou", { tempo: ev.tempo ?? "2 min" }, sorteio), PRIORIDADE.aviso, agora, TTL.aviso);
        break;
      case "mural": {
        const cat = TIPO_DO_MURAL[ev.mudanca] ?? "anotou";
        dizer(f, c, "quadro", frase(f, cat, { texto: ev.titulo ?? "" }, sorteio), PRIORIDADE.quadro, agora, TTL.quadro);
        break;
      }
      case "volta-mana":
        dizer(f, c, "festa", frase(f, "voltaMana", {}, sorteio), PRIORIDADE.festa, agora, TTL.festa);
        break;
      default:
        break;
    }
  }
}

/**
 * Avança: renova as fixas pelo estado (pergunta, erro, sem mana, apagão), sorteia ócio e devolve
 * os balões a pintar (no máximo 7, maior prioridade primeiro).
 * @param magos personagens do Salão (modelo) — `estado`, `pergunta`, `resetHora`, `travado`
 * @param opts `{ apagao: bool, apagaoHora }`
 */
export function avancarFalas(f, magos, agora, sorteio = Math.random, opts = {}) {
  const vivos = new Set(magos.map((m) => m.chave));
  for (const chave of [...f.porMago.keys()]) if (!vivos.has(chave)) f.porMago.delete(chave);

  for (const m of magos) {
    const atual = f.porMago.get(m.chave);
    // fixas pelo estado: entram quando o estado começa, saem quando acaba
    if (m.estado === "esperando") {
      if (atual?.categoria !== "pergunta") dizer(f, m.chave, "pergunta", frase(f, "pergunta", { texto: m.pergunta?.texto ?? "" }, sorteio), PRIORIDADE.pergunta, agora, 0, true);
    } else if (m.estado === "erro") {
      if (atual?.categoria !== "erro") dizer(f, m.chave, "erro", frase(f, "erro", {}, sorteio), PRIORIDADE.erro, agora, 0, true);
    } else if (opts.apagao) {
      if (atual?.categoria !== "apagao") dizer(f, m.chave, "apagao", frase(f, "apagao", { hora: opts.apagaoHora ?? "mais tarde" }, sorteio), PRIORIDADE.mana, agora, 0, true);
    } else if (m.estado === "sem-mana") {
      if (atual?.categoria !== "mana") dizer(f, m.chave, "mana", frase(f, "mana", { hora: m.resetHora ?? "mais tarde" }, sorteio), PRIORIDADE.mana, agora, 0, true);
    } else if (atual?.fixa) {
      f.porMago.delete(m.chave);
    }
    // ócio: 40–120 s, 60% de chance
    if (m.estado === "ocioso" || m.estado === "terminou") {
      const quando = f.proximoOcio.get(m.chave);
      if (quando === undefined) f.proximoOcio.set(m.chave, agora + OCIO_MIN_MS + Math.floor(sorteio() * (OCIO_MAX_MS - OCIO_MIN_MS)));
      else if (quando <= agora) {
        f.proximoOcio.set(m.chave, agora + OCIO_MIN_MS + Math.floor(sorteio() * (OCIO_MAX_MS - OCIO_MIN_MS)));
        if (sorteio() < OCIO_CHANCE) dizer(f, m.chave, "ocio", frase(f, "ocio", {}, sorteio), PRIORIDADE.ocio, agora, TTL.ocio);
      }
    } else f.proximoOcio.delete(m.chave);
  }

  for (const [chave, fala] of [...f.porMago]) if (fala.ate <= agora) f.porMago.delete(chave);
  return [...f.porMago.entries()]
    .map(([chave, fala]) => ({ chave, texto: fala.texto, prioridade: fala.prioridade, categoria: fala.categoria }))
    .sort((a, b) => b.prioridade - a.prioridade || a.chave.localeCompare(b.chave))
    .slice(0, MAX_NA_TELA);
}

export function esvaziarFalas(f) {
  f.porMago.clear();
}
