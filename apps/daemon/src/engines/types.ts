import type { EngineEvent, EngineOverrides, PartesDoPack, StartOpts } from "@nexos/shared";

export type EngineHandler = (ev: EngineEvent) => void;

export type EngineMcp = Pick<StartOpts, "mcpConfig" | "mcpTools" | "mcpHttp">;

export interface Engine {
  start(opts: StartOpts, onEvent: EngineHandler): Promise<void>;
  /**
   * Refaz o contexto que vai no próximo `send`. Necessário porque nenhum motor de
   * `--print`/`exec` (nem a chamada de API) guarda a conversa entre invocações —
   * cada `send` sobe um processo (ou request) novo. Sem reempurrar o pack a cada
   * turno, o motor só veria o retrato de quando o engine subiu, e "esqueceria" a
   * própria resposta anterior e o que rodou de ferramenta desde então.
   *
   * Exceção: o CLI `claude` com `--resume` (ver `updateResume`) — aí o pack NÃO
   * vai no stdin, senão a conversa duplica e a quota explode de novo.
   */
  updatePack(pack: string, partes?: PartesDoPack): void;
  /**
   * Refaz quais ferramentas MCP o próximo `send` oferece — mesma razão do `updatePack`:
   * sem isso, mudar `delegacaoModo`/`allowedTools` só valeria depois de um engine NOVO
   * (troca de conta, `/clear` ou reiniciar o motor), porque `mcpConfig`/`mcpTools`/`mcpHttp`
   * só eram lidos uma vez, em `start`.
   */
  updateMcp(mcp: EngineMcp): void;
  /**
   * Sessão do CLI `claude` pra o próximo `send` ir com `--resume` e SEM o pack
   * do histórico. Sem isso cada turno nasce processo novo, reenvia a conversa
   * inteira no stdin e paga cache-create de novo — bem mais quota que o Claude
   * Code interativo, que reusa a mesma sessão. `undefined` volta ao pack.
   * Nos outros motores é no-op: `codex exec` / API não têm `--resume`.
   */
  updateResume(sessionId?: string): void;
  /**
   * Override do TURNO, aplicado por cima do perfil e do agente. Existe pro
   * modelo "Automático": o modelo é escolhido a cada mensagem, pela complexidade
   * dela (`escolherModelo` em typesafe.ts), e o motor relê perfil/agente a cada
   * `send` — sem um canal por turno, essa escolha não teria onde entrar.
   * `{}` limpa. Nos motores que não montam argv (stub) é no-op.
   */
  updateOverrides(over: EngineOverrides): void;
  send(text: string): Promise<void>;
  /**
   * Mensagem nova no MEIO do turno em voo: o motor lê entre uma ferramenta e outra, sem esperar o
   * turno acabar. `false` = este motor não tem canal pra isso agora (não suporta, ou o turno já
   * fechou) e quem chamou deve cair na fila. Só o CLI `claude` (stdin em `stream-json`) suporta.
   */
  inject?(text: string): boolean;
  /**
   * Quando o motor deu sinal de vida pela última vez e quantas tarefas em background (Bash
   * `run_in_background`, Monitor) ele tem de pé. Base do teto por INATIVIDADE do turno: turno
   * longo que segue produzindo, ou esperando tarefa em background, não é motor travado.
   * Motor sem isso cai no teto fixo desde o início do turno.
   */
  ocupacao?(): { ultimaAtividade: number; tarefasEmBackground: number };
  abort(): Promise<void>;
}
