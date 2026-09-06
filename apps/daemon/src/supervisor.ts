import type { AgentDef } from "@nexo/shared";

/**
 * Protocolo de decisão do supervisor.
 *
 * O supervisor é um membro como outro qualquer: ele recebe um pedido e responde
 * texto. A diferença é que a resposta dele não é trabalho — é uma ORDEM, e o
 * daemon é quem a executa. Por isso o formato precisa ser fechado: texto livre
 * viraria adivinhação sobre quem chamar.
 *
 * Isto NÃO é MCP. O supervisor não age no meio do turno dele; ele decide, o
 * turno fecha, o daemon chama o membro e volta com o resultado no turno
 * seguinte — na MESMA conversa, então o supervisor mantém o contexto do que já
 * mandou fazer. O custo dessa escolha é um turno por decisão; o ganho é rodar
 * em qualquer motor, inclusive nos que não falam MCP (`api`, `stub`), sem
 * processo novo nem credencial saindo do daemon.
 */

export type Decisao =
  | { acao: "chamar"; membro: string; pedido: string }
  | { acao: "encerrar"; resumo: string };

/** O que o supervisor pode chamar. `id` é o que ele escreve na resposta. */
export type Disponivel = { id: string; nome: string; papel?: string };

export function listarDisponiveis(defs: Array<AgentDef | undefined>, papeis: Array<string | undefined>): Disponivel[] {
  const out: Disponivel[] = [];
  defs.forEach((def, i) => {
    if (!def) return;
    const papel = papeis[i];
    out.push({ id: def.id, nome: def.name, ...(papel ? { papel } : {}) });
  });
  return out;
}

const FORMATO =
  "# Como responder\n" +
  "Responda SÓ com um objeto JSON, sem texto em volta e sem cerca de código.\n" +
  'Para pôr um membro pra trabalhar: {"acao":"chamar","membro":"<id da lista>","pedido":"<o que ele deve fazer>"}\n' +
  'Quando o objetivo estiver cumprido: {"acao":"encerrar","resumo":"<o resultado do time>"}\n' +
  "Você NÃO executa o trabalho: quem lê arquivo, escreve código e roda comando são os membros. " +
  "Chame um de cada vez e use o resultado dele pra decidir o próximo.";

/** Primeiro pedido: objetivo, quem existe e o formato. Só este repete o objetivo. */
export function pedidoInicial(goal: string, papel: string | undefined, membros: Disponivel[], restam: number): string {
  const lista = membros.map((m) => `- ${m.id} — ${m.nome}${m.papel ? `: ${m.papel}` : ""}`).join("\n");
  return [
    `# Objetivo do time\n${goal}`,
    `# Seu papel\n${papel || "supervisor: você decide quem do time trabalha, e com que pedido."}`,
    `# Membros que você pode chamar\n${lista}`,
    FORMATO,
    `Restam ${restam} chamadas.`,
  ].join("\n\n");
}

/**
 * Turnos seguintes. NÃO repete o objetivo nem a lista: é a mesma conversa, o
 * motor ainda tem tudo isso no contexto, e repetir pagaria o objetivo inteiro
 * de novo a cada decisão.
 */
export function pedidoDeVolta(agentId: string, saida: string, arquivo: string, restam: number, corte: number): string {
  const cortado = saida.length > corte;
  return [
    `# Resultado de ${agentId}\n${saida.slice(0, corte)}` +
      (cortado ? `\n\n[cortado — o texto inteiro está em ${arquivo}]` : ""),
    `Arquivo com a saída completa: ${arquivo}`,
    `Restam ${restam} chamadas. Responda no mesmo formato JSON.`,
  ].join("\n\n");
}

/** Um passo falhou. O supervisor decide o que fazer — não é o daemon que decide por ele. */
export function pedidoDeFalha(agentId: string, motivo: string, restam: number): string {
  return (
    `# ${agentId} falhou\n${motivo}\n\n` +
    `Decida: chamar outro membro, tentar de novo com outro pedido, ou encerrar dizendo o que ficou de fora.\n\n` +
    `Restam ${restam} chamadas. Responda no mesmo formato JSON.`
  );
}

export function pedidoDeCorrecao(erro: string): string {
  return (
    `A resposta anterior não deu pra usar: ${erro}\n\n` +
    "Responda AGORA só com o objeto JSON, sem nenhuma outra palavra.\n" +
    '{"acao":"chamar","membro":"...","pedido":"..."} ou {"acao":"encerrar","resumo":"..."}'
  );
}

/**
 * Acha o objeto JSON na resposta. Modelo põe cerca de código, texto antes e
 * "claro, aqui está" depois — recusar tudo isso queimaria um turno de correção
 * por bobagem de formatação. O que NÃO se afrouxa é o conteúdo: id de membro
 * fora da lista é recusado, porque adivinhar quem ele quis dizer é pior que
 * perguntar.
 */
export function lerDecisao(texto: string, membros: Disponivel[]): { ok: true; d: Decisao } | { ok: false; erro: string } {
  const bruto = acharObjeto(texto ?? "");
  if (!bruto) return { ok: false, erro: "não veio objeto JSON nenhum" };
  let obj: unknown;
  try {
    obj = JSON.parse(bruto);
  } catch {
    return { ok: false, erro: "o JSON não é válido" };
  }
  const o = obj as { acao?: unknown; membro?: unknown; pedido?: unknown; resumo?: unknown };
  if (o.acao === "encerrar") {
    const resumo = typeof o.resumo === "string" ? o.resumo.trim() : "";
    return { ok: true, d: { acao: "encerrar", resumo: resumo || "o supervisor encerrou sem resumo" } };
  }
  if (o.acao !== "chamar") return { ok: false, erro: `"acao" precisa ser "chamar" ou "encerrar"` };
  const membro = typeof o.membro === "string" ? o.membro.trim() : "";
  if (!membros.some((m) => m.id === membro)) {
    return { ok: false, erro: `"${membro}" não está no time — escolha entre: ${membros.map((m) => m.id).join(", ")}` };
  }
  const pedido = typeof o.pedido === "string" ? o.pedido.trim() : "";
  if (!pedido) return { ok: false, erro: `"pedido" vazio: diga o que ${membro} deve fazer` };
  return { ok: true, d: { acao: "chamar", membro, pedido } };
}

/**
 * Último objeto `{...}` balanceado do texto. Último, e não primeiro, porque o
 * modelo às vezes mostra um exemplo antes de dar a resposta de verdade.
 *
 * Conta chaves varrendo pra frente, respeitando string e escape: regex não
 * serve porque `pedido` costuma trazer `{`, `}` e aspas escapadas dentro.
 */
function acharObjeto(texto: string): string | null {
  let inicio = -1;
  let nivel = 0;
  let emString = false;
  let escapado = false;
  let achado: string | null = null;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (emString) {
      if (escapado) escapado = false;
      else if (c === "\\") escapado = true;
      else if (c === '"') emString = false;
      continue;
    }
    if (c === '"') emString = true;
    else if (c === "{") {
      if (nivel === 0) inicio = i;
      nivel++;
    } else if (c === "}" && nivel > 0 && --nivel === 0) {
      achado = texto.slice(inicio, i + 1);
    }
  }
  return achado;
}
