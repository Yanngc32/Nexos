# Nexo — novas visualizações de tarefas (design)

Data: 2026-09-12
Status: aprovado pelo usuário, aguardando plano de implementação

Terceiro de 4 specs da iniciativa "gestão de memória/tarefas entre dispositivos +
reformulação da página de tarefas/projeto". Ordem: A (storage, implementado) → B (modelo
avançado, implementado) → **C (este spec)** → D (ferramenta de LLM).

## Problema

O quadro de tarefas só tem uma visualização (Kanban). Não dá pra ver tudo num relance filtrado
por campo (tabela), planejar por data (calendário) e entender o roadmap por marco
(timeline) sem abrir tarefa por tarefa.

## Objetivo

Três visualizações novas — tabela/lista filtrável, calendário por prazo, timeline por marco —
selecionáveis por abas no topo do painel de Tarefas, ao lado do Kanban existente. Mesmo
`quadro`/`tarefas` já carregados por `tarefas-board.js`; só muda como são desenhados.

## Fora de escopo

- **D** (ferramenta de LLM) — spec próprio depois deste.
- **Edição de tarefa dentro da tabela/calendário/timeline** — clicar numa linha/chip/barra abre
  o MESMO modal de edição do Kanban (nenhum formulário novo). Sem edição inline na tabela.
- **Drag-and-drop nas visualizações novas** — mover tarefa entre colunas por arrastar continua
  exclusivo do Kanban.
- **Views separadas com filtro persistido entre sessões** — filtro da tabela reseta ao trocar de
  aba/fechar o painel (estado só em memória, mesmo padrão do filtro por marco do Kanban hoje).
- **Zoom/pan na timeline** — período fixo (do marco mais cedo ao mais tarde, com folga); sem
  controle de zoom nesta v1.

## Modelo de dados: `Marco` ganha início

```ts
type Marco = { id: string; nome: string; inicio?: string; prazo?: string };
```

`inicio` é opcional (mesmo formato `AAAA-MM-DD` de `prazo`, mesma validação `limparData`).
Marco só com `prazo` (todos os marcos já existentes) continua válido — timeline desenha um
PONTO em vez de uma barra quando não há `inicio`. `salvarMarco` ganha uma checagem a mais:
`inicio` (quando os dois estão presentes) não pode ser depois de `prazo` — 400 "início não
pode ser depois do prazo".

## Seletor de visualização

Abas na toolbar do painel de Tarefas (`apps/desktop`, `pane-tarefas`): **Kanban** (default) |
**Lista** | **Calendário** | **Timeline**. Estado `modo` em `tarefas-board.js`, guardado só em
memória (volta pro Kanban toda vez que o painel reabre). Cada modo tem seu próprio contêiner
(`tk-board`, `tk-lista`, `tk-calendario`, `tk-timeline`); trocar de aba mostra um e esconde os
outros três — nenhum reflow de HTML pesado, só toggle de `hidden` + (re)render do modo ativo.

## Lista/tabela

Colunas: Título, Coluna, Tipo, Prioridade, Marco, Prazo, Etiquetas. Uma linha por tarefa;
clique abre o modal de edição (mesmo `abrirModal`).

Filtros (barra acima da tabela, todos combinados em E lógico):

- **Coluna** — select, "todas" por padrão.
- **Tipo** — select (`TIPOS_TAREFA` + "todos").
- **Prioridade** — select (`PRIORIDADES` + "todas").
- **Etiqueta** — select (etiquetas do quadro + "todas").
- **Busca de texto** — input livre, casa contra `título` OU `descrição` (case-insensitive,
  substring — mesmo critério simples de busca, sem fuzzy/ranking).

Filtro é função pura nova (`filtrarTabela(tarefas, filtros)`), testável sem DOM — mesmo
padrão de `filtrarPorMarco`/`ordenarPorOrdem` já existentes em `tarefas-board.js`.

## Calendário

Mês corrente por padrão, com "◀ mês anterior" / "mês seguinte ▶". Grade de semanas
(domingo–sábado); cada dia mostra as tarefas cujo `prazo` cai naquele dia, como chip
pequeno (título truncado, cor de fundo por prioridade se houver — reaproveita
`ROTULO_PRIORIDADE`). Tarefa sem `prazo` não aparece nesta view (não tem onde plotar). Clique
no chip abre o modal.

Função pura nova `tarefasPorDia(tarefas, ano, mes)` → `Map<string, Tarefa[]>` (chave
`AAAA-MM-DD`), testável sem DOM.

## Timeline (marcos)

Eixo horizontal cobrindo do `inicio` (ou `prazo`, se não houver início) do marco mais cedo até
o `prazo` do marco mais tarde, com um pouco de folga nas pontas (padding proporcional, não
fixo em dias — mesma ideia de "auto-fit" de um gráfico simples). Marcos sem NENHUMA data
(nem início, nem prazo) não entram na timeline — não tem onde plotar (aparecem só nos outros
modos/no painel de marcos).

Cada marco vira uma linha:

- **Com `inicio` e `prazo`**: barra proporcional ao intervalo.
- **Só `prazo`** (caso mais comum hoje, marco antigo): marcador de ponto único.
- Clique expande/recolhe a lista de tarefas daquele marco embaixo da barra (reaproveita
  `filtrarPorMarco`, já existente).

Renderização em HTML/CSS puro (barras via `<div>` com `left`/`width` em porcentagem
calculada a partir das datas) — sem biblioteca de gráfico nova, é a mesma filosofia de
"sem framework" do resto do `apps/desktop`.

Função pura nova `escalaDaTimeline(marcos)` → `{ inicio: Date, fim: Date }` (intervalo total
com folga) e `posicaoNaTimeline(marco, escala)` → `{ left: number, width: number }` (0–100),
ambas testáveis sem DOM.

## UI (edição de marco)

Painel de Marcos (`tk-marcos-painel`, já existe) ganha um segundo campo de data
("Início", opcional) ao lado do "Prazo" já existente.

## Testes

- `apps/daemon/test/tarefas.test.ts`: `salvarMarco` aceita `inicio` opcional; recusa `inicio`
  depois de `prazo`; aceita marco só com `prazo` (retrocompatível) e só com `inicio`.
- `apps/desktop/test/tarefas-board.test.js`: `filtrarTabela` — cada filtro isolado e
  combinado; busca de texto casa título OU descrição, case-insensitive; sem filtro nenhum
  devolve tudo.
- `apps/desktop/test/tarefas-board.test.js`: `tarefasPorDia` — agrupa por data corretamente;
  tarefa sem prazo não entra em nenhum dia; dois meses diferentes não se misturam.
- `apps/desktop/test/tarefas-board.test.js`: `escalaDaTimeline`/`posicaoNaTimeline` — marco só
  com prazo vira ponto (width 0 ou marcador); marco com início+prazo vira barra proporcional;
  marco sem nenhuma data é ignorado no cálculo da escala.
- `apps/desktop/test/tarefas-board.test.js` (com DOM, `happy-dom`): trocar de aba mostra o
  contêiner certo e esconde os outros três; clique numa linha da tabela/num chip do
  calendário/numa barra da timeline abre o modal com os dados certos.
