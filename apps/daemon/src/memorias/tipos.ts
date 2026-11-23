/** Tipos públicos da memória do usuário (contrato do módulo `memorias`). */

export type OrigemMemoria = "agente" | "memorista" | "curador" | "migracao" | "usuario" | "externo";

export const ORIGENS_MEMORIA: readonly OrigemMemoria[] = ["agente", "memorista", "curador", "migracao", "usuario", "externo"];

export interface Memoria {
  relPath: string;
  /** "" na raiz. */
  pasta: string;
  titulo: string;
  gancho: string;
  tipo: string;
  corpo: string;
  revisao: number;
  status: "ativa" | "aposentada";
  origem: OrigemMemoria;
  criadaEm: string;
  atualizadaEm: string;
}

export interface PropostaMemoria {
  op: "create" | "update" | "retire";
  relPath: string;
  titulo?: string;
  gancho?: string;
  tipo?: string;
  corpo?: string;
  revisaoEsperada?: number;
  segredos?: { nome: string; valor: string }[];
  origem: OrigemMemoria;
}

export type ResultadoProposta =
  | { ok: true; memoria: Memoria; segredosGuardados: string[] }
  | { ok: false; motivo: string; revisaoAtual?: number };
