/**
 * Máquina de estado do modo seleção (inspector), pura — sem DOM, sem Electron. O host liga
 * na UI (aria-pressed, faixa de status) e no transporte (envio via `inspector-host.js`);
 * este módulo só decide qual é o estado seguinte dado o estado atual e um evento.
 *
 * `state.inspector.on` deixava a UI mentir: o botão acendia no clique, não na confirmação
 * do preload. Aqui o botão só pode ficar "pressionado" na fase LIGADO, que só é alcançada
 * depois do handshake (`PRONTO`) — ver EVENTOS.PRONTO abaixo.
 */

export const FASE = Object.freeze({
  DESLIGADO: "desligado",
  ARMANDO: "armando",
  LIGADO: "ligado",
  ERRO: "erro",
});

export const EVENTOS = Object.freeze({
  LIGAR: "ligar",
  DESLIGAR: "desligar",
  PRONTO: "pronto",
  TIMEOUT: "timeout",
  RECARREGOU: "recarregou",
  SELECIONADO: "selecionado",
  REMOVER: "remover",
});

export function estadoInicial() {
  return { fase: FASE.DESLIGADO, selecionados: [] };
}

/**
 * Reducer puro: (estado, evento) -> novo estado. Eventos fora de fase (ex: PRONTO sem
 * estar ARMANDO, SELECIONADO fora de LIGADO) são ignorados — devolve o mesmo estado.
 */
export function transicionar(estado, evento) {
  switch (evento.tipo) {
    case EVENTOS.LIGAR:
      if (estado.fase === FASE.DESLIGADO || estado.fase === FASE.ERRO) {
        return { fase: FASE.ARMANDO, selecionados: [] };
      }
      return estado;

    case EVENTOS.PRONTO:
      if (estado.fase === FASE.ARMANDO) return { ...estado, fase: FASE.LIGADO };
      return estado;

    case EVENTOS.TIMEOUT:
      if (estado.fase === FASE.ARMANDO) return { ...estado, fase: FASE.ERRO };
      return estado;

    // Reload/navegação do preview enquanto o modo tava ligado (ou ainda armando):
    // o preload morreu e nasceu de novo, precisa reconfirmar o handshake. As marcações
    // antigas apontavam pra elementos de um documento que não existe mais.
    case EVENTOS.RECARREGOU:
      if (estado.fase === FASE.LIGADO || estado.fase === FASE.ARMANDO) {
        return { fase: FASE.ARMANDO, selecionados: [] };
      }
      return estado;

    case EVENTOS.DESLIGAR:
      return estadoInicial();

    case EVENTOS.SELECIONADO:
      if (estado.fase !== FASE.LIGADO) return estado;
      return { ...estado, selecionados: [...estado.selecionados, evento.dado] };

    case EVENTOS.REMOVER:
      if (estado.fase !== FASE.LIGADO) return estado;
      if (evento.indice < 0 || evento.indice >= estado.selecionados.length) return estado;
      return { ...estado, selecionados: estado.selecionados.filter((_, i) => i !== evento.indice) };

    default:
      return estado;
  }
}

/** Único critério pro botão ficar `aria-pressed="true"`: handshake confirmado. */
export function botaoPressionado(estado) {
  return estado.fase === FASE.LIGADO;
}
