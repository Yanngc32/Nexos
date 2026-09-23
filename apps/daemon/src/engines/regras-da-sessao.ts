/**
 * Regras do Nexos que uma sessão do `claude` já conhece × as de agora.
 *
 * As regras vão como system prompt na CRIAÇÃO da sessão (ver `CliEngine.send`), e um
 * `--append-system-prompt` num `--resume` é ignorado pelo CLI. Então o que muda no meio da
 * conversa — design system criado, memória atualizada, agente trocado — só chega se for junto da
 * próxima mensagem. Aqui sai SÓ o que mudou, pra não reenviar tudo (repo map e memória são grandes).
 *
 * Os blocos são os `# Título` do topo de cada seção de `instrucoesDoPack` (session.ts).
 */

/** Título → conteúdo. Título repetido (markdown da memória com `# ` dentro) junta no mesmo bloco. */
export function blocosDeRegras(texto: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const bloco of texto.split(/\n\n(?=# )/)) {
    const t = bloco.trim();
    if (!t) continue;
    const titulo = t.split("\n", 1)[0]!;
    out.set(titulo, out.has(titulo) ? `${out.get(titulo)}\n\n${t}` : t);
  }
  return out;
}

/**
 * O que mandar junto da mensagem pra sessão ficar em dia: blocos novos ou alterados, e o aviso dos
 * que saíram. `sabido = null` = sessão sem registro (criada antes disto): manda tudo, uma vez.
 * Vazio = nada mudou.
 */
export function atualizacaoDasRegras(sabido: string | null, atual: string): string {
  if (sabido === atual) return "";
  const antes = blocosDeRegras(sabido ?? "");
  const agora = blocosDeRegras(atual);
  const mudaram = [...agora].filter(([t, c]) => antes.get(t) !== c).map(([, c]) => c);
  const sairam = sabido === null ? [] : [...antes.keys()].filter((t) => !agora.has(t));
  if (!mudaram.length && !sairam.length) return "";
  const partes = [
    sabido === null
      ? "[Nexos: estas são as regras atuais desta conversa — valem a partir de agora, no lugar das que vieram antes.]"
      : "[Nexos: regras desta conversa atualizadas — valem a partir de agora.]",
    ...mudaram,
    ...(sairam.length ? [`Não valem mais: ${sairam.map((t) => t.replace(/^#\s*/, "")).join(", ")}.`] : []),
  ];
  return `${partes.join("\n\n")}\n\n---\n\n`;
}
