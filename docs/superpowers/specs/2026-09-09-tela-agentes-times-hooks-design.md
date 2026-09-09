# Nexo — tela única de Agentes/Times/Hooks (design)

Data: 2026-09-09
Status: aprovado pelo usuário, aguardando plano de implementação

## Problema

Hoje o botão "Agentes" (`#btn-agents`, `index.html`) abre um popover pequeno (`#agents-dock`) com
4 abas — Rodando, Times, Meus agentes, Hooks (`ABAS_AGENTES`, `renderer.js`). Cada aba lista os
itens da categoria; clicar num item (ou "+ Novo") **fecha o popover** e abre uma **tela cheia
separada** — `agent-studio.js` → `#pane-agent`, `team-studio.js` → `#pane-team`, `hooks-studio.js`
→ `#pane-hooks` — cada uma com seu próprio header, botão fechar e formulário.

Duas camadas de UI (popover → tela cheia) pra uma ação só ("editar/criar isto") é o atrito
principal — não a navegação entre categorias, nem a falta de visão de conjunto.

## Objetivo

Clicar "Agentes" abre direto uma **tela cheia única** com abas no topo — Agentes | Times | Hooks
— e trocar de aba é instantâneo (mesmo pane, só troca o conteúdo). Criar/editar acontece na
MESMA tela, sem popover, sem trocar de pane.

## Fora de escopo

- **Lógica de editar/salvar/validar** de agente, time e hook — `agent-studio.js`,
  `team-studio.js`, `hooks-studio.js` continuam donos disso (`ler`/`escrever`/`sujo`/`salvar`).
  O que muda é só a casca em volta (onde cada um é montado, quem tem header/botão fechar).
- **Backend** — nenhum endpoint novo, nenhuma mudança em `apps/daemon`. É reorganização de
  `apps/desktop` só.
- **"Rodando"** (agentes em execução agora) sai da tela nova — é execução ao vivo (efêmera),
  diferente de configurar definição (estático). Continua no popover pequeno de hoje, só que com
  UMA aba em vez de 4 (ver seção própria).
- **Bancada do agente / execução do time** — o painel largo ao lado do formulário
  (`#ag-bench`/`#tm-run`) continua existindo, só é realocado pra dentro da aba em vez de ser a
  tela inteira. Nenhuma mudança na lógica de rodar/streamar.

## Layout da tela nova

```
┌───────────────────────────────────────────────┐
│  Agentes  │  Times  │  Hooks              [✕]  │  ← topbar de abas
├───────────┬─────────────────────┬─────────────┤
│ · rev     │  Formulário do       │  Bancada /   │
│ · escritor│  item selecionado    │  Execução    │
│           │  (mesmo editor de     │  (só Agente  │
│ + Novo    │  hoje)                │  e Time)     │
└───────────┴─────────────────────┴───────────────┘
```

- **Topbar**: 3 abas + botão fechar único (substitui os 3 "✕ Fechar" individuais de hoje).
  Trocar de aba não fecha/abre pane — só troca qual editor está montado/visível.
- **Lista da aba ativa**: mesma lista que já existe (`paintAgentDefs`/`paintTeams`/
  `paintHookRules`), só que dentro da coluna esquerda da aba em vez de dentro do popover.
  "+ Novo" no rodapé da lista, como hoje.
- **Coluna do meio (formulário)**: `agent-studio.js`/`team-studio.js`/`hooks-studio.js` mantidos,
  só sem a seção de header própria (nome do item + dirty + salvar/excluir sobem pro topbar da
  tela, ou ficam como uma barrinha fina no topo da coluna do meio — a decidir no plano, é
  detalhe de implementação, não de arquitetura).
- **Coluna da direita (bancada/execução)**: só existe quando a aba ativa é Agentes ou Times E um
  item está selecionado. Hooks nunca tem essa coluna (não roda inline).
- **Sem seleção**: coluna do meio mostra um vazio ("Selecione um item à esquerda, ou crie um
  novo").

## Popover "Rodando"

`#agents-dock` continua existindo, mas só com a lista de agentes rodando agora
(`#agents-pane-run`, `paintAgents`) — os `data-on`/abas de Times, Meus agentes e Hooks saem
daqui. Ganha um botão/link no rodapé: **"Agentes, Times e Hooks →"**, que fecha o popover e abre
a tela nova (`state.view = "agentes"`).

O badge de contagem no botão "Agentes" (`#agents-badge`) continua contando execuções em voo, sem
mudança.

## Estado e navegação

- Novo valor de `state.view`: `"agentes"` — mesmo mecanismo de `applyWorkLayout()` que já existe
  pra `"file"`/`"terminal"`/`"canvas"`/`"graph"`/`"agent"`/`"team"`/`"hooks"`. Os panes antigos
  `#pane-agent`, `#pane-team`, `#pane-hooks` são **substituídos** por um `#pane-agentes` só (os tr
  ês editores passam a viver dentro dele, montados/desmontados por visibilidade — não por
  navegação de `state.view`).
- Estado local da tela (não em `state` global, só desta tela): qual aba está ativa
  (`agentes`/`times`/`hooks`) e qual item está selecionado em cada uma — persiste ao trocar de
  aba e voltar (não reseta seleção à toa), mas não precisa sobreviver a fechar a tela.
- `abrirEstudio`/`abrirTime`/`abrirHook` (`renderer.js`) — hoje cada um seta `state.view` pro pane
  antigo e chama `.abrir(def)` do studio correspondente. Passam a: setar `state.view = "agentes"`,
  ativar a aba certa, e chamar `.abrir(def)` do studio certo — chamados tanto pelo clique na lista
  quanto pelo "+ Novo" de cada aba.

## Migração dos três studios

Cada um perde a seção `<header class="mod-head">...</header>` com botão fechar próprio (o fechar
agora é um só, no topbar da tela). O resto do markup (`#ag-edit`/`#ag-bench`,
`#tm-edit`/`#tm-run`, `#hk-edit`) muda de pai (`<section class="pane" id="pane-X">` → dentro do
conteúdo da aba correspondente em `#pane-agentes`), mas os ids internos dos campos não mudam —
`ler()`/`el()` continuam funcionando sem tocar a lógica de JS desses três arquivos, só o HTML ao
redor.

## Testes

- Desktop não tem harness de e2e/DOM pra essas telas hoje (nem `agent-studio.js` nem
  `team-studio.js` têm teste dedicado — só módulos de lógica pura como `run-view.js` têm). Este
  refactor segue o mesmo padrão: sem teste de UI novo, `node --check` nos arquivos editados e
  verificação manual (rodar o app) antes de considerar pronto.
- `npx vitest run` (apps/desktop) não deve regredir — nenhum dos módulos testados hoje
  (`run-view.js`, `agent-trace.js`, etc.) muda de comportamento, só a casca ao redor deles no
  `renderer.js`/`index.html`.
