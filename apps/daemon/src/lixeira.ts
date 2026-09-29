import { LIXEIRA_DIAS } from "@nexos/shared";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { temPerguntaPendente } from "./perguntas.ts";
import { dropThread, turnoEmCurso } from "./session.ts";
import { daPessoa, marcarLixeira, todasAsConversas, type ThreadHead } from "./threads.ts";

const DIA_MS = 24 * 60 * 60_000;

/** A lixeira pra tela: da mais recente pra mais antiga, com quando some de vez. */
export function listarLixeira(home: string): (ThreadHead & { apagaEm: string })[] {
  return todasAsConversas(home)
    .filter((t) => t.lixeiraEm)
    .sort((a, b) => (a.lixeiraEm! < b.lixeiraEm! ? 1 : -1))
    .map((t) => ({ ...t, apagaEm: new Date(Date.parse(t.lixeiraEm!) + LIXEIRA_DIAS * DIA_MS).toISOString() }));
}

/** Conversa que a varredura não toca agora: trabalhando, esperando resposta ou aberta no app. */
function emUso(t: ThreadHead, abertaNoApp: string): boolean {
  return t.id === abertaNoApp || turnoEmCurso(t.id) || temPerguntaPendente(t.id);
}

/**
 * Conversa da pessoa parada há mais de `lixeiraAposDias` vai pra lixeira; na lixeira há mais de
 * `LIXEIRA_DIAS`, é apagada de vez (`dropThread`). Conversa que ganhou atividade depois de ir pra
 * lixeira (ex.: chegou mensagem pelo celular) volta sozinha. Passo de time e trabalho interno do
 * Nexos ficam de fora: pertencem a outra conversa ou tela.
 */
export async function varrerLixeira(home: string, agora = Date.now()): Promise<{ movidas: number; apagadas: number }> {
  const cfg = loadConfig(home);
  let movidas = 0;
  let apagadas = 0;
  for (const t of todasAsConversas(home)) {
    if (!daPessoa(t)) continue;
    if (t.lixeiraEm) {
      if (t.updatedAt > t.lixeiraEm) {
        marcarLixeira(t.id, false, "auto", home);
        continue;
      }
      if (agora - Date.parse(t.lixeiraEm) < LIXEIRA_DIAS * DIA_MS || emUso(t, cfg.lastThread)) continue;
      try {
        await dropThread(t.id, home);
        apagadas++;
      } catch (e) {
        log.aviso("lixeira", "não consegui apagar conversa da lixeira", { threadId: t.id, erro: (e as Error).message });
      }
      continue;
    }
    if (!cfg.lixeiraAposDias || emUso(t, cfg.lastThread)) continue;
    if (agora - Date.parse(t.updatedAt) < cfg.lixeiraAposDias * DIA_MS) continue;
    if (marcarLixeira(t.id, true, "auto", home)) movidas++;
  }
  if (movidas || apagadas) log.info("lixeira", `${movidas} conversa(s) pra lixeira, ${apagadas} apagada(s) de vez`);
  return { movidas, apagadas };
}
