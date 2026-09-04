import { resolve } from "node:path";

/**
 * Diretório de trabalho do motor: a pasta do projeto, resolvida.
 *
 * Isto NÃO confina nada — o agente roda com a permissão do usuário e pode andar
 * pra fora daqui. O arquivo chamava `sandbox.ts`, nome que prometia um limite
 * que não existe. O confinamento de verdade está em outros dois lugares, cada um
 * no seu escopo: `boundPath` no main do Electron (árvore de arquivos e terminal
 * do app) e `assertInsideProject` em services.ts (cwd declarado no nexo.json).
 */
export function spawnCwd(projectPath: string): string {
  return resolve(projectPath);
}
