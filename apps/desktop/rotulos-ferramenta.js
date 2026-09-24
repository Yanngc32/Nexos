/**
 * Rótulo legível pras ferramentas do próprio Nexos na linha de ferramenta do chat: no lugar de
 * `mcp__nexo__nexo_navegador_ler`, "Navegando · lendo a página". O nome cru continua no hover.
 * Função pura, testa no node.
 */

const GRUPOS = [
  {
    prefixo: "nexo_navegador_",
    grupo: "Navegando",
    ico: "◎",
    acoes: {
      abrir: "abrindo a página",
      ler: "lendo a página",
      markdown: "lendo o conteúdo",
      screenshot: "tirando print",
      clicar: "clicando",
      digitar: "digitando",
    },
  },
  {
    prefixo: "nexo_windows_",
    grupo: "No Windows",
    ico: "▣",
    acoes: {
      abrir_app: "abrindo app",
      listar_apps: "listando apps",
      listar_janelas: "listando janelas",
      ativar_janela: "trazendo a janela pra frente",
      estado: "lendo a tela",
      clicar: "clicando",
      clicar_elemento: "clicando",
      acao_secundaria: "clique com o botão direito",
      arrastar: "arrastando",
      digitar: "digitando",
      definir_valor: "preenchendo campo",
      tecla: "apertando tecla",
      rolar: "rolando",
    },
  },
  {
    prefixo: "nexo_tarefa_",
    grupo: "Quadro de tarefas",
    ico: "☰",
    acoes: { listar: "lendo o quadro", salvar: "atualizando card", checklist: "checklist", comentar: "comentando", commits: "ligando commits" },
  },
];

const AVULSAS = {
  nexo_mapa_simbolos: { grupo: "Mapeando símbolos", ico: "⌗" },
  nexo_repomap_resumo_salvar: { grupo: "Atualizando o mapa do repositório", ico: "⌗" },
  nexo_delegar: { grupo: "Delegando", ico: "↗" },
  nexo_chamar: { grupo: "Chamando agente", ico: "↗" },
  nexo_contexto: { grupo: "Lendo contexto", ico: "◌" },
  nexo_membros: { grupo: "Listando membros do time", ico: "◌" },
  nexo_skill_instalar: { grupo: "Instalando skill", ico: "✚" },
  nexo_agente_salvar: { grupo: "Salvando agente", ico: "✚" },
  nexo_time_salvar: { grupo: "Salvando time", ico: "✚" },
  nexo_hook_listar: { grupo: "Listando hooks", ico: "◌" },
  nexo_hook_salvar: { grupo: "Salvando hook", ico: "✚" },
  nexo_veredito: { grupo: "Registrando veredito", ico: "✓" },
};

/** `{ texto, ico }` pra ferramenta do Nexos; `null` pro resto (Bash, Read… seguem com o nome). */
export function rotuloDaFerramenta(nome) {
  const curto = String(nome || "").replace(/^mcp__nexo__/, "");
  if (!curto.startsWith("nexo_")) return null;
  const avulsa = AVULSAS[curto];
  if (avulsa) return { texto: avulsa.grupo, ico: avulsa.ico };
  const g = GRUPOS.find((x) => curto.startsWith(x.prefixo));
  if (!g) return null;
  const acao = g.acoes[curto.slice(g.prefixo.length)];
  return { texto: acao ? `${g.grupo} · ${acao}` : `${g.grupo}…`, ico: g.ico };
}
