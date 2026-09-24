import type { Card, Plano } from "./planejamento.ts";

/**
 * "Enviar para implementação": a conferência do plano antes do envio, o rascunho automático do
 * prompt (determinístico: mesmo plano → mesmo texto) e o pedido fixo quando quem escreve é o
 * Agent Manager. Puro — as rotas (http.ts) só chamam. Base: `handoffReadiness.ts`/`handoffFlow.ts`
 * do agent-code; o formato do rascunho é o que vimos funcionando lá.
 */

export type Pendencia = { tipo: "ambiguidade-aberta" | "roteiro-vazio" | "etapa-sem-card" | "etapa-nao-concluida" | "card-invalido"; texto: string; ref?: string };
export type Prontidao = { bloqueios: Pendencia[]; avisos: Pendencia[] };

const ROTULO: Record<Card["tipo"], string> = {
  requisito: "Requisito",
  decisao: "Decisão",
  sugestao: "Sugestão",
  ambiguidade: "Ambiguidade",
  nota: "Nota",
  etapa: "Etapa",
};
const ORDEM: Record<Card["tipo"], number> = { requisito: 0, decisao: 1, sugestao: 2, ambiguidade: 3, nota: 4, etapa: 5 };
const STATUS: Record<string, string> = { pendente: "pendente", em_andamento: "em andamento", concluida: "concluída" };

export function ambiguidadeAberta(c: Card): boolean {
  return c.tipo === "ambiguidade" && c.status !== "resolvida";
}

/** Bloqueio: ambiguidade aberta (a implementação teria de adivinhar). O resto só avisa. */
export function prontidao(p: Plano): Prontidao {
  const bloqueios: Pendencia[] = p.cards
    .filter(ambiguidadeAberta)
    .map((c) => ({ tipo: "ambiguidade-aberta" as const, ref: c.id, texto: `Ambiguidade aberta: "${c.titulo}"` }));
  const avisos: Pendencia[] = [];
  const etapas = p.roteiro.etapas;
  if (!etapas.length) avisos.push({ tipo: "roteiro-vazio", texto: "O roteiro não tem etapas: a implementação não terá uma ordem a seguir." });
  for (const e of etapas) {
    if (!p.cards.some((c) => c.etapa === e.id)) avisos.push({ tipo: "etapa-sem-card", ref: e.id, texto: `A etapa "${e.titulo}" não tem nenhum card.` });
  }
  for (const e of etapas) {
    if (e.status !== "concluida") avisos.push({ tipo: "etapa-nao-concluida", ref: e.id, texto: `A etapa "${e.titulo}" ainda está ${STATUS[e.status]}.` });
  }
  for (const i of p.invalidos) avisos.push({ tipo: "card-invalido", ref: i.arquivo, texto: `O card ${i.arquivo} não pôde ser lido e fica de fora.` });
  return { bloqueios, avisos };
}

const porTipo = (a: Card, b: Card) => ORDEM[a.tipo] - ORDEM[b.tipo] || a.titulo.localeCompare(b.titulo);
const arquivo = (c: Card) => `cards/${c.id}.md`;

/** O prompt da conversa de implementação, montado só do plano (sem gastar turno do Manager). */
export function montarHandoff(p: Plano): string {
  const r = p.roteiro;
  const etapaIds = new Set(r.etapas.map((e) => e.id));
  const secao = (titulo: string, cards: Card[], corpo: (c: Card) => string[]) =>
    cards.length ? ["", `## ${titulo}`, ...cards.flatMap((c) => ["", `### ${c.titulo} (\`${arquivo(c)}\`)`, ...corpo(c)])] : [];
  const texto = (c: Card) => (c.corpo.trim() ? ["", c.corpo.trim()] : []);

  const linhas = [
    `# Implementação: ${r.titulo}`,
    "",
    `Esta conversa implementa o planejamento **${r.titulo}**, feito com a pessoa na Tela de Planejamento. O plano detalhado está em \`${p.dir}\`: \`roteiro.md\` (as etapas, na ordem) e \`cards/\` (um arquivo por card).`,
    "",
    "## Objetivo",
    "",
    `${r.titulo}. Entregar as ${r.etapas.length} etapas do roteiro, na ordem, respeitando os requisitos e as decisões abaixo.`,
    "",
    "## Etapas, na ordem",
    "",
  ];
  r.etapas.forEach((e, i) => {
    linhas.push(`${i + 1}. **${e.titulo}** (\`${e.id}\`) — ${STATUS[e.status]}`);
    for (const c of p.cards.filter((c) => c.etapa === e.id).sort(porTipo)) linhas.push(`   - ${ROTULO[c.tipo]}: ${c.titulo} (\`${arquivo(c)}\`)`);
  });
  if (!r.etapas.length) linhas.push("_O roteiro está vazio._");
  const fora = p.cards.filter((c) => !c.etapa || !etapaIds.has(c.etapa)).sort(porTipo);
  if (fora.length) linhas.push("", "## Cards fora das etapas", "", ...fora.map((c) => `- ${ROTULO[c.tipo]}: ${c.titulo} (\`${arquivo(c)}\`)`));

  const de = (t: Card["tipo"]) => p.cards.filter((c) => c.tipo === t).sort(porTipo);
  linhas.push(...secao("Requisitos", de("requisito"), texto));
  linhas.push(...secao("Decisões (com o porquê)", de("decisao"), texto));
  linhas.push(...secao("Sugestões (com fonte)", de("sugestao"), (c) => [...(c.fonte ? ["", `Fonte: ${c.fonte}`] : []), ...texto(c)]));
  const abertas = de("ambiguidade").filter(ambiguidadeAberta);
  const resolvidas = de("ambiguidade").filter((c) => !ambiguidadeAberta(c));
  linhas.push(...secao("Ambiguidades resolvidas", resolvidas, texto));
  if (abertas.length) {
    linhas.push("", "## Ambiguidades ainda abertas", "");
    linhas.push(...abertas.map((c) => `- **${c.titulo}** (\`${arquivo(c)}\`) — sem decisão: confirme com a pessoa antes de implementar o que depende dela.`));
  }
  linhas.push(...secao("Notas", de("nota"), texto));
  linhas.push(
    "",
    "## Como trabalhar",
    "",
    "- Antes de começar, declare as etapas acima como o seu plano (TodoWrite), na mesma ordem, e siga-as sem replanejar.",
    `- Consulte \`${p.dir}\` (roteiro e cards) sempre que precisar de detalhe: os cards são a fonte das decisões.`,
    "- Se o código real contradisser o plano, diga à pessoa o que encontrou e pergunte antes de desviar dele.",
  );
  return `${linhas.join("\n")}\n`;
}

/**
 * Pedido que vai pra conversa do Manager quando a pessoa escolhe "Pedir ao Agent Manager": ele
 * grava o prompt com `nexo_plano_handoff` e a tela pega o arquivo novo pelo SSE.
 */
export function pedidoAoManager(p: Plano, abertas = 0): string {
  const linhas = [
    "Gere agora o handoff deste planejamento para a conversa de implementação.",
    "",
    "Grave com `nexo_plano_handoff` UM prompt autocontido. Ele precisa trazer: o objetivo; as etapas do roteiro na ordem, com os cards de cada uma; os requisitos; as decisões com o porquê; as sugestões com a fonte; as ambiguidades resolvidas; riscos e critérios de aceite; e a instrução de declarar as etapas como plano (TodoWrite) e consultar " +
      `\`${p.dir}\` sem replanejar. A conversa de implementação só verá esse texto e os cards.`,
    "",
    "Não implemente nada e não altere cards nem o roteiro agora: só grave o prompt e, no fim, diga que gravou.",
  ];
  if (abertas > 0) {
    linhas.push(
      "",
      `Atenção: ${abertas === 1 ? "uma ambiguidade continua aberta" : `${abertas} ambiguidades continuam abertas`} e a pessoa decidiu enviar mesmo assim. Diga qual leitura seguir (a sua recomendação) e marque-a como pendente de confirmação.`,
    );
  }
  return linhas.join("\n");
}
