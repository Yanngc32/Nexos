/**
 * "Ir até" da linha de ferramenta do chat: decide se uma chamada do agente criou/alterou algo que
 * dá pra abrir (tarefa do Quadro, tela no Canvas, card ou plano na Tela de Planejamento) e qual é
 * o alvo, pelo input e pelo texto do `tool_result` (os textos vêm das ferramentas do daemon:
 * tarefas.ts, ds-print.ts, planejamento-ferramentas.ts, paineis.ts). Função pura, testa no node.
 */

const nomeCurto = (nome) => /(?:^|__|\.)(nexo_[a-z0-9]+(?:_[a-z0-9]+)*)$/.exec(String(nome || ""))?.[1] ?? "";
const texto = (v) => (typeof v === "string" ? v.trim() : "");

/** `{ tipo, ... }` do que a ferramenta criou/alterou; `null` se não tem o que abrir. */
export function alvoDaFerramenta(nome, input, resultado) {
  const n = nomeCurto(nome);
  const r = String(resultado ?? "");
  const inp = input && typeof input === "object" ? input : {};
  switch (n) {
    case "nexo_tarefa_salvar": {
      const id = /\btarefa (\S+) salva\b/.exec(r)?.[1] || texto(inp.id);
      return id ? { tipo: "tarefa", id } : null;
    }
    case "nexo_tarefa_checklist":
    case "nexo_tarefa_comentar":
    case "nexo_tarefa_commits": {
      const id = texto(inp.tarefaId);
      return id ? { tipo: "tarefa", id } : null;
    }
    case "nexo_mock_salvar":
    case "nexo_ds_card_salvar": {
      const m = /Card (?:criado|atualizado): (\S+) \(.*?\(id ([^)\s]+)\)/.exec(r);
      return m ? { tipo: "tela", sistema: m[2], card: m[1] } : null;
    }
    case "nexo_plano_card_criar":
    case "nexo_plano_ambiguidade_abrir": {
      const id = /— id `([^`]+)`/.exec(r)?.[1];
      return id ? { tipo: "plano-card", id } : null;
    }
    case "nexo_plano_card_atualizar":
    case "nexo_plano_ambiguidade_resolver": {
      const id = /(?:card|ambiguidade) `([^`]+)` (?:salvo|resolvida)/.exec(r)?.[1];
      return id ? { tipo: "plano-card", id } : null;
    }
    case "nexo_plano_iniciar":
      return /^(?:plano "|esta conversa já tinha aberto o plano)/.test(r.trim()) ? { tipo: "plano" } : null;
    default:
      return null;
  }
}

const ROTULOS = {
  tarefa: "Ir até a tarefa no Quadro",
  tela: "Ir até a tela no Canvas",
  "plano-card": "Ir até o card no plano",
  plano: "Ir até o plano",
};

/** Texto do `title`/`aria-label` do botão. */
export const rotuloDoAlvo = (alvo) => ROTULOS[alvo?.tipo] ?? "Ir até";
