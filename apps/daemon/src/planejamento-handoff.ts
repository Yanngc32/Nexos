import type { Card, Plano } from "./planejamento.ts";

/**
 * "Enviar para implementação": a conferência do plano antes do envio, o rascunho automático do
 * prompt (determinístico: mesmo plano → mesmo texto) e o pedido fixo quando quem escreve é o
 * Agent Manager. Puro — as rotas (http.ts) só chamam. Base: `handoffReadiness.ts`/`handoffFlow.ts`
 * do agent-code.
 *
 * O prompt é só o MAPA do plano (resumo, estrutura e o id): a conversa de implementação tem as
 * ferramentas `nexo_plano_*` e lê o conteúdo completo de lá. Copiar os cards pro prompt deixava o
 * texto enorme e congelado — o que a pessoa mudasse no plano depois do envio não chegava.
 */

export type Pendencia = {
  tipo: "ambiguidade-aberta" | "roteiro-vazio" | "etapa-sem-card" | "etapa-nao-concluida" | "card-invalido" | "tela-sem-spec";
  texto: string;
  ref?: string;
};
export type Prontidao = { bloqueios: Pendencia[]; avisos: Pendencia[] };

const ROTULO: Record<Card["tipo"], string> = {
  requisito: "Requisito",
  decisao: "Decisão",
  sugestao: "Sugestão",
  ambiguidade: "Ambiguidade",
  tela: "Tela",
  nota: "Nota",
  etapa: "Etapa",
};
const ORDEM: Record<Card["tipo"], number> = { tela: 0, requisito: 1, decisao: 2, sugestao: 3, ambiguidade: 4, nota: 5, etapa: 6 };
const STATUS: Record<string, string> = { pendente: "pendente", em_andamento: "em andamento", concluida: "concluída" };

/** Card de tela com spec e ainda sem o mock anexado (tela do DS). */
export function telaSemMock(c: Card): boolean {
  return c.tipo === "tela" && !c.anexos.some((a) => a.tipo === "ds");
}

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
  for (const c of p.cards) {
    if (c.tipo === "tela" && c.corpo.trim().length < 40) {
      avisos.push({ tipo: "tela-sem-spec", ref: c.id, texto: `A tela "${c.titulo}" está sem spec: o mock vai sair no chute.` });
    }
  }
  for (const i of p.invalidos) avisos.push({ tipo: "card-invalido", ref: i.arquivo, texto: `O card ${i.arquivo} não pôde ser lido e fica de fora.` });
  return { bloqueios, avisos };
}

const porTipo = (a: Card, b: Card) => ORDEM[a.tipo] - ORDEM[b.tipo] || a.titulo.localeCompare(b.titulo);

const PLURAL: Record<Card["tipo"], string> = {
  tela: "telas",
  requisito: "requisitos",
  decisao: "decisões",
  sugestao: "sugestões",
  ambiguidade: "ambiguidades",
  nota: "notas",
  etapa: "etapas",
};

/** "2 telas, 1 requisito, 3 decisões" — na ordem de `ORDEM`. */
function contagem(cards: Card[]): string {
  const n: Partial<Record<Card["tipo"], number>> = {};
  for (const c of cards) n[c.tipo] = (n[c.tipo] ?? 0) + 1;
  return (Object.keys(ORDEM) as Card["tipo"][])
    .filter((t) => n[t])
    .map((t) => `${n[t]} ${n[t] === 1 ? ROTULO[t].toLowerCase() : PLURAL[t]}`)
    .join(", ");
}

/** Instruções fixas de como a conversa de implementação usa o plano (vão no fim do prompt). */
export function comoTrabalhar(slug: string): string[] {
  return [
    "## Como trabalhar",
    "",
    `- Este texto é só o mapa. O conteúdo completo (requisitos, decisões com o porquê, specs de tela, ambiguidades) está no plano \`${slug}\`: leia com \`nexo_plano_ler\` ANTES de começar e releia sempre que precisar de detalhe — o plano é a fonte da verdade, não este texto.`,
    "- Declare as etapas como o seu plano (TodoWrite), na ordem, e siga sem replanejar. Se o código contradisser o plano, diga o que encontrou e pergunte antes de desviar.",
    "- Mantenha o plano em dia: `nexo_plano_implementacao` (em_andamento ao começar a etapa, feita ao terminar e verificar) e `feito: true` em cada requisito pronto (`nexo_plano_card_atualizar`).",
    '- Cards de **Tela** trazem a spec completa da tela. Antes de codar a tela, gere o mock no Canvas com `nexo_mock_salvar` (painel de mocks do DS oficial: cria na 1ª vez, depois só acrescenta a tela) seguindo a spec e os tokens, confira com `nexo_ds_print`, e anexe o mock ao card (`nexo_plano_card_atualizar` com `anexos` + `{ tipo: "ds", sistema, card }`, mantendo os anexos que já estavam).',
    '- A pessoa aprova ou reprova o design no card. Só codifique a tela depois de "DESIGN APROVADO" (`nexo_plano_ler`); enquanto aguarda, siga com outras etapas — a decisão chega aqui como mensagem. Reprovado: refaça o mock seguindo o motivo, no mesmo card do DS (mesmo id), e ele volta a aguardar.',
  ];
}

/** O prompt da conversa de implementação, montado só do plano (sem gastar turno do Manager). */
export function montarHandoff(p: Plano): string {
  const r = p.roteiro;
  const etapaIds = new Set(r.etapas.map((e) => e.id));
  const abertas = p.cards.filter(ambiguidadeAberta);
  const telas = p.cards.filter((c) => c.tipo === "tela");
  const linhas = [
    `# Implementação: ${r.titulo}`,
    "",
    `Plano \`${p.slug}\`, feito com a pessoa na Tela de Planejamento.`,
    "",
    "## Resumo",
    "",
    `${r.etapas.length} ${r.etapas.length === 1 ? "etapa" : "etapas"}${p.cards.length ? ` e ${contagem(p.cards)}` : ""}.` +
      (telas.length ? ` ${telas.filter(telaSemMock).length} de ${telas.length} tela(s) ainda sem mock.` : ""),
    "",
    "## Estrutura",
    "",
  ];
  const linhaCard = (c: Card) =>
    `${ROTULO[c.tipo]}: ${c.titulo} (\`${c.id}\`)${c.tipo === "tela" ? (telaSemMock(c) ? " — mock pendente" : " — mock anexado") : ""}${ambiguidadeAberta(c) ? " — ABERTA" : ""}`;
  r.etapas.forEach((e, i) => {
    linhas.push(`${i + 1}. **${e.titulo}** (\`${e.id}\`)`);
    for (const c of p.cards.filter((c) => c.etapa === e.id).sort(porTipo)) linhas.push(`   - ${linhaCard(c)}`);
  });
  if (!r.etapas.length) linhas.push("_O roteiro está vazio._");
  const fora = p.cards.filter((c) => !c.etapa || !etapaIds.has(c.etapa)).sort(porTipo);
  if (fora.length) linhas.push("", "Fora das etapas:", ...fora.map((c) => `- ${linhaCard(c)}`));
  if (abertas.length) {
    linhas.push(
      "",
      "## Atenção",
      "",
      ...abertas.map((c) => `- Ambiguidade **${c.titulo}** (\`${c.id}\`) sem decisão: confirme com a pessoa antes de implementar o que depende dela.`),
    );
  }
  linhas.push("", ...comoTrabalhar(p.slug));
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
    `Grave com \`nexo_plano_handoff\` UM prompt CURTO — é o mapa, não o plano. A conversa de implementação tem as ferramentas do plano e lê o conteúdo completo dele sozinha (plano \`${p.slug}\`). O prompt traz: o objetivo em 2 a 5 frases; a estrutura (etapas na ordem, cada uma com os títulos e ids dos cards); riscos e critérios de aceite, se houver. NÃO copie o corpo dos cards.`,
    "",
    "Termine o prompt exatamente com esta seção:",
    "",
    ...comoTrabalhar(p.slug),
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
