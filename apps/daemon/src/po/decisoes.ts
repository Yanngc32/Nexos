/**
 * Diário de decisões do PO: uma linha JSON por rodada em `<home>/po-decisions.log`. Passou de
 * 2 MB, o atual vira `.1` (o `.1` antigo some). Best-effort: falha de disco nunca chega no chat.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FasePO } from "./veredito.ts";

export const ARQUIVO_DECISOES_PO = "po-decisions.log";
const TETO_BYTES = 2 * 1024 * 1024;

export type DecisaoPO = {
  conversationId: string;
  phase: FasePO;
  /** ok | sem-mudanca | erro | pulado:<motivo> | segurar */
  outcome: string;
  /** Perfil/modelo que rodou (ou "-"). */
  route: string;
  durationMs: number;
  cards: string[];
  detalhe?: string;
};

export function registrarDecisaoPO(home: string, d: DecisaoPO, tetoBytes = TETO_BYTES): void {
  try {
    mkdirSync(home, { recursive: true });
    const arquivo = join(home, ARQUIVO_DECISOES_PO);
    if (existsSync(arquivo) && statSync(arquivo).size >= tetoBytes) {
      const velho = `${arquivo}.1`;
      rmSync(velho, { force: true });
      renameSync(arquivo, velho);
    }
    appendFileSync(arquivo, `${JSON.stringify({ at: new Date().toISOString(), ...d })}\n`, "utf8");
  } catch {
    // diário é só trilha
  }
}
