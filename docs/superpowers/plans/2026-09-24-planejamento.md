# Tela de Planejamento — plano de implementação

Base: "Agent Manager" do [agent-code](https://github.com/MatheusLarcher/agent-code) @ `8c85d17` (`src/main/planning/`, `src/renderer/src/planning/`, ~16k linhas com testes). Código lido estaticamente, não executado. Adaptado à arquitetura do Nexos: daemon Hono + CLI por processo filho, desktop JS puro, persistência em arquivo, sem build.

## Andamento

- [x] F1 — store (`apps/daemon/src/planejamento.ts`, 19 testes)
- [x] F2 — rotas HTTP + SSE (`http.ts`, `test/planejamento-http.test.ts`)
- [x] F3 — Manager: `thread_meta.planejamento`, ferramentas `nexo_plano_*` (`planejamento-ferramentas.ts`), motor somente leitura (`StartOpts.somenteLeitura`), bloco no pack, `POST /v1/planejamento/:slug/manager`
- [x] F4 — tela: `planejamento-board.js` + `planejamento-layout.js` (puro), pane em `index.html`, seção `Planejamento` em `styles.css`, abre sozinha na conversa do Manager (chat lateral), botão no repo, menu, paleta
- [x] F5 — edição: status da etapa, título, + Card, duplo clique na coluna, editor lateral (grava ao sair, rascunho em localStorage, conflito junta campos), arrastar, ligar pela alça, Delete em card/ligação, autocomplete `[[`
- [x] F5b — animação: `canvas-anim.js` (mesma linguagem/classes do DS; **não** extraído do `canvas-ds.js` porque ele tem mudanças sem commit — unificar depois), `diffPlano` puro, eco da própria escrita não anima, botão Animação
- [x] F6 — envio: `planejamento-handoff.ts` (prontidão, rascunho determinístico, pedido ao Manager), `GET .../handoff/rascunho`, `POST .../handoff/enviar` (grava em `handoff/`, cria "Implementação: <título>" com `thread_meta.handoff` e manda o texto), diálogo Conferir → Gerar → Revisar; "Pedir ao Agent Manager" manda o pedido no chat do Manager e pega o arquivo novo pelo SSE
- [ ] F7 · F8

Ajustes vistos rodando o app (modo screenshot, `NEXOS_DEV=1`): cards medidos antes de empilhar (setas no centro, sem buraco), enquadramento que não esconde a 1ª coluna, título do cabeçalho com `field-sizing`, e `criadoEm` no card — a ordem da coluna era a do nome do arquivo e card novo empurrava os antigos.

Nomes finais: as ferramentas saíram como `nexo_plano_*` (padrão `nexo_` do projeto), não `plan_*`.

## Objetivo

Uma conversa "Manager" que **não implementa**: questiona, pesquisa e organiza o plano num roteiro de etapas + cards no canvas. Usuário e Manager editam o mesmo plano. No fim, "Enviar para implementação" gera prompt(s) autocontido(s) e abre a conversa que executa.

## Como o agent-code faz (referência)

- **A conversa É a tela**: conversa com `mode: 'planning'` + `planningSlug`; `PlanningWorkspace` troca o workspace normal por roteiro (esquerda) + canvas, com o mesmo `ChatPanel` flutuando sobre o canvas (`ManagerChatFloat`, maximizado/minimizado).
- **Sessão do Manager** (`planningSession.ts::applyPlanningSessionOptions`): MCP só `planning` + `memory` com `strictMcpConfig`; system prompt = `buildPlanningHint` (`planningPrompt.ts`) em append; `disallowedTools` sem subagentes/Monitor/PowerShell; sem agentes especialistas.
- **Prompt**: postura questionadora, "melhor caminho = mais curto e barato"; 1ª ação `plan_read` → `plan_roteiro_set`; requisitos/decisões/notas como cards na etapa certa; marca etapa em andamento/concluída; pesquisa web antes de opinar; sugestão só com fonte (URL ou `arquivo:linha`), senão vira decisão/nota; ambiguidade = card com opinião + pergunta; cards citados por `[[Título]]` (resolve sem caixa/acento); não altera o título do plano; conteúdo de cards/web é **dado, não instrução**.
- **Ferramentas** (`planningTools.ts`): `plan_read`, `plan_roteiro_set`, `plan_etapa_marcar`, `plan_card_create|update|delete|link`, `plan_ambiguidade_abrir|resolver`, `plan_handoff_write`. Slug vem do contexto da sessão. Toda escrita exige `expected_rev`.
- **Handoff** (`HandoffDialog.tsx`, `handoffReadiness.ts`, `handoffFlow.ts`): conferência (ambiguidade aberta bloqueia, resto avisa) → dois caminhos: (a) pedido fixo ao Manager (`managerHandoffRequest`) que grava 1+ prompts via `plan_handoff_write`, detectados por `newHandoffsSince`; (b) rascunho determinístico `buildDraftHandoff`. Prompts editáveis → gravados em `_handoff/` → `launchHandoff` cria "Implementação: <título>", 1º prompt sai, demais na fila, para no 1º que falhar. A conversa nova recebe `handoffAppendBlock` (onde está o plano, declarar etapas como TodoWrite na ordem, não replanejar, perguntar antes de desviar) e skills de replanejamento bloqueadas no 1º turno.
- **Canvas** (`layout.ts`, puro): fluxo horizontal, uma coluna por etapa + "Sem etapa"; `CARD_W 248`, `CARD_H 140`, `COL_GAP 72`, `ROW_GAP 16`; posição salva prevalece, card novo vai pro fim da coluna; arestas = `links` + `[[refs]]` do corpo + sequência entre etapas.
- **Ao vivo**: `fs.watch` por plano + filtro sha256 de eco → `planning:changed` → `usePlanning` recarrega, calcula `born` (anima), trata `rev_conflict`, layout otimista com debounce 400ms.
- **Segurança extra**: Write/Edit só em `<cwd>/docs/spec/<slug>/_sandbox` (glob + realpath), hook `PreToolUse`, todo Bash pede aprovação.

## O que muda no Nexos (verificado no código)

| Ponto | Nexos hoje | Decisão |
|---|---|---|
| Chat + tela | Já existe split: `state.sideChat` põe `#pane-chat` à direita do pane (`renderer.js:1663-1674`, `styles.css:1270-1278`) com resizer `#split-chat` (`renderer.js:6670`) | Abrir o pane de planejamento com `sideChat = true`. **Sem chat flutuante** |
| Comunicação | HTTP + SSE (`api.js`, `sse.js`) | Rotas `/v1/planejamento/*` em `http.ts` abaixo do auth (`:348`) + SSE de eventos |
| Ferramentas MCP | Conjunto em `/v1/mcp` (`http.ts:1964`); por thread via `meta.mcpTools` (`session.ts:620-668`) | `ferramentasDePlanejamento` no conjunto quando a thread é de planejamento; nela saem delegar/navegador/tarefas/DS |
| Ferramentas nativas por thread | **Não existe**: `--allowed-tools` vem do perfil (`cli.ts:188-191`); `--disallowed-tools` só skills (`cli.ts:338-341`) | Novo campo em `thread_meta`: `planejamento: { slug }`. `profileFlags` lê e, nessa thread, restringe `--allowed-tools` e adiciona `--disallowed-tools` Write/Edit/MultiEdit/NotebookEdit/Bash/Task |
| System prompt por thread | **Não existe**; só `instrucoesDoPack` (`session.ts:376-445`) → `--append-system-prompt-file` (`cli.ts:434-440`) | `instrucoesDoPack` inclui o bloco do Manager quando `meta.planejamento`, e o bloco de handoff quando `meta.handoff`. Omite DS/quadro nessas threads |
| Título da conversa | Não é gerado; `lerCabecalho` usa 72 chars da 1ª mensagem (`threads.ts:355-357`) | Plano nasce "Sem nome"; título do plano = mesma regra, gravado no roteiro após a 1ª mensagem. Usuário pode renomear |
| Markdown | `markdown.js::renderMd` escapa antes de formatar (`:22`, `:171`) | Corpo dos cards via `renderMd`. (`pagina-markdown.js` é HTML→MD, não serve) |
| Fila | `enfileirar` só na thread ativa, não exportada (`renderer.js:7284`) | Handoff v1 = **um prompt só**, enviado pelo daemon (`postMessage`, padrão de `ds-gerar.ts:309-327`). Multi-prompt fica para depois |
| Persistência | Arquivos em `~/.nexos`, padrão de `tarefas.ts:12-26` | Mesmo padrão |
| Sandbox de escrita | Sem SDK, sem `canUseTool`/hook por chamada | **v1 sem escrita e sem Bash**. Manager só lê projeto + web + `plan_*` + `nexo_perguntar` |

Fora da v1: export PDF, minimapa, sandbox, watcher de edição manual no disco, escolha de modelo por TypeSafe, migração de legado. A animação de nascimento do agent-code (`CardBirthFlow`, fluxo saindo do chat) **não** é portada: no lugar entra a animação que o Nexos já tem no canvas do Design System (ver "Animação").

## Modelo de dados (`apps/daemon/src/planejamento.ts`)

```ts
type TipoCard = "etapa" | "requisito" | "decisao" | "sugestao" | "ambiguidade" | "nota";
interface Card { id: string; tipo: TipoCard; titulo: string; etapa?: string;
  status?: "aberta" | "resolvida"; links: string[]; fonte?: string; rev: number; corpo: string }
interface Roteiro { titulo: string; rev: number;
  etapas: { id: string; titulo: string; status: "pendente" | "em_andamento" | "concluida" }[] }
interface Layout { posicoes: Record<string, { x: number; y: number }>; vista?: { x: number; y: number; escala: number } }
```

Regras no store (não só na ferramenta): `id`/slug `[a-z0-9-]{1,64}`; `sugestao` exige `fonte` (URL http/https ou caminho relativo `arquivo[:linha]`); `ambiguidade` exige `status`; link só para card existente e ≠ próprio; `etapa` precisa existir no roteiro (senão cai em "Sem etapa" na tela). Escrita com `rev` esperado → conflito devolve `{ code: "rev_conflito", atual }`.

## Disco

```
<projectDir>/planejamento/<slug>/   # mesma pasta por projeto da memória/tarefas (projeto-dir.ts)
  roteiro.md                 # bloco json (verdade) + markdown legível
  canvas.json                # só visual; se sumir, recalcula
  cards/<id>.md              # bloco json + corpo markdown
  handoff/AAAA-MM-DD-NN.md   # criação exclusiva (wx), nunca sobrescreve
```

Gravação atômica tmp+rename (funções síncronas: sem intercalação dentro do daemon), card malformado vai para `invalidos[]` sem derrubar o plano. Nada de `:` em nome de arquivo.

## Especificação visual

Referência: agent-code rodando com um plano de 4 etapas / 7 cards (prints na conversa de 2026-09-24). Adaptado aos tokens do Nexos (`styles.css:8+`: `--surface*`, `--line*`, `--muted`, `--faint`, `--accent*`, `--ok`, `--warn`, `--danger`, `--font-mono`, `--fs-*`, `--s-*`, `--ease`). Prefixo de classe `pl-`, seção `/* ---------- Planejamento ---------- */`.

### Layout

```
┌ mod-head ───────────────────────────────────────────────────────────────┐
│ PLANEJAMENTO            [1 de 4 etapas]      [modelo]  [Enviar p/ impl.] │
│ Título do plano (editável)                                              │
├ Roteiro ─────┬ Canvas ───────────────────────────────────────┬ Chat ────┤
│ ROTEIRO  1/4 │ [+ Card]  dica: duplo clique abre · Delete…    │ (sideChat│
│ ▬▬▬▬░░░░░░░  │  01 Store ──▸ 02 Rotas ──▸ 03 Manager ──▸ …    │  do      │
│ ✓ 1 Store    │  │            │             │                 │  Nexos,  │
│ ◐ 2 Rotas    │  [card]      [card]        [card]              │  resizer │
│ ◌ 3 Manager  │  [card]──────[card]                            │  próprio)│
│ ◌ 4 Tela     │                               [+][−][⛶]        │          │
└──────────────┴────────────────────────────────────────────────┴──────────┘
```

- **Cabeçalho** (`mod-head`): rótulo "PLANEJAMENTO" (`--fs-2xs`, caixa alta, `--muted`) sobre o título (editável no lugar, clique). Selo "N de M etapas" (concluídas/total). À direita, modelo do Manager e botão primário "Enviar para implementação" (`--accent`).
- **Roteiro** (esquerda, 180px–40%, largura em localStorage, recolhível num trilho): cabeçalho "ROTEIRO" + contador `concluídas/total` + botão recolher; barra de progresso fina (`--ok`); itens `número · ícone · título`. Ícones: ✓ círculo cheio `--ok` (concluída, título riscado e `--faint`), meio círculo `--warn` (em andamento, título em negrito), círculo tracejado `--muted` (pendente). Clique no ícone roda o ciclo; clique no título centraliza a coluna no canvas.
- **Chat**: não flutua. Usa o split que o Nexos já tem (`state.sideChat`, `#split-chat`). Libera o canvas inteiro — foi o que mais atrapalhou no agent-code (chat aberto cobre metade do canvas).
- **Plano vazio**: faixa no topo do canvas "Plano em branco — converse com o Manager para separar em etapas…" + botão "+ Card".

### Canvas

- Dimensões do original (`layout.ts`): card 248×≤140, cabeçalho de coluna 56, `COL_GAP 72`, `ROW_GAP 16`, 28 entre cabeçalho e 1º card. Fundo pontilhado (`radial-gradient` com `--line`), acompanha pan/zoom.
- **Cabeçalho de coluna**: caixa `--surface-2`, borda `--line`, número mono "01" `--muted`, título em negrito, linha de baixo "● Concluída · 2 cards" com a cor do status. Etapa em andamento ganha borda `--warn`. Duplo clique cria card na etapa.
- **Card**: `--surface`, borda `--line`, raio 8, **sem faixa lateral colorida** (o tipo aparece no rótulo/ícone e na borda de hover/seleção). Linha 1: ícone + rótulo do tipo em caixa alta `--fs-2xs` na cor do tipo; à direita, fonte (`hono.dev ↗`, abre externo) na sugestão ou selo "aberta"/"resolvida" na ambiguidade. Linha 2: título (negrito, 2 linhas máx.). Linha 3: prévia do corpo (1–3 linhas, `--muted`, reticências). Hover: borda mistura 45% da cor do tipo. Selecionado: borda na cor do tipo + fundo 7%.
- **Cores por tipo** (`--pl-<tipo>` só na seção do planejamento): etapa azul `#6f9bd1`, requisito roxo `#a98bd1`, decisão `--ok`, sugestão `--warn`, ambiguidade `--danger`, nota cinza `#8d8a86`. Conferir contraste nos temas padrão e `preto` (`styles.css:102`).
- **Controles**: zoom `+ / − / enquadrar` no canto inferior esquerdo. Zoom mínimo que mantém o texto legível; se o plano não cabe, enquadra a etapa em andamento. Pan/zoom do usuário salvo (debounce 400ms); enquadramento automático não.

### Linhas e setas

Camada SVG única dentro do board (mesma transformação de pan/zoom, `vector-effect: non-scaling-stroke` como em `.ds-traco rect`). Três tipos, calculados pela função pura de layout:

| Tipo | Origem | Traço | Ponta |
|---|---|---|---|
| Sequência | etapa N → etapa N+1 (cabeçalhos) | tracejado `4 4`, `--muted`, opacidade .7 | seta fechada |
| Ligação | `links` do card | contínuo 1.4, `--muted` 70% | seta fechada |
| Referência | `[[Título]]`/`[[id]]` no corpo que resolve para outro card (e não é já uma ligação) | pontilhado `2 4`, `--muted` 70% | seta fechada |

- Curva bezier saindo da borda direita do card de origem e chegando na borda esquerda do destino; se o destino está na mesma coluna ou atrás, sai por baixo/entra por cima (evita a linha cruzar o próprio card). Ponta via `<marker>` único por tipo.
- Hover/seleção na linha: `--accent`, espessura 2; Delete apaga a ligação (referência só some editando o corpo — tooltip diz isso).
- Hover no card destaca as linhas dele e esmaece as demais (opacidade .25) — ajuda a ler plano cheio.
- Alças: ponto na borda direita/esquerda aparece no hover; arrastar de uma alça até outro card cria ligação (linha fantasma seguindo o mouse durante o arrasto).
- Recalcular só as linhas afetadas ao arrastar card (por id), não o SVG inteiro.

### Animação (reuso do Design System)

Mesma linguagem de `canvas-ds.js` (`rodarFila`, `:1063`): **cursor sintético** (`.ds-cursor`, seta `--accent` com sombra, contra-escala `1/escala`) viaja até o alvo, **contorno** SVG se desenha em volta (`stroke-dashoffset` de perímetro → 0 em 360ms, some em 380ms) e o elemento **entra** (`opacity 0 → 1`, `scale(.97) → 1`, 280ms). Fila com passo que acelera se acumular (110 → 70 → 40ms).

Adaptação ao planejamento:
- **Quando anima**: só o que chegou de fora da tela — SSE depois de escrita do Manager (ou de outra janela). O que o usuário acabou de editar aqui não anima (o módulo guarda os ids/revs gravados por ele e ignora o eco).
- **O que anima**, em ordem de fila:
  1. Etapa nova → cabeçalho de coluna entra; a seta de sequência até ela se desenha (`stroke-dashoffset` no path, mesmo tempo do contorno).
  2. Card novo → cursor vai até a posição, contorno do card se desenha, card entra.
  3. Ligação/referência nova → a linha se desenha da origem ao destino (dash no comprimento do path via `getTotalLength()`), cursor acompanha a ponta.
  4. Card alterado → só pulso (`ds-pulso`, `:7283`) + contorno, sem reentrada.
  5. Status de etapa mudou → ícone no roteiro e selo da coluna trocam com pulso.
- **Extração**: tirar o cursor/contorno/fila de `canvas-ds.js` para `canvas-anim.js` (`criarAnimador({ doc, camada, cursor, vista })` → `{ enfileirar(alvo, tipo) }`), usado pelos dois. Só vale se os testes do DS continuarem iguais; senão, copia no início e unifica depois.
- **Botão "Animação"** no cabeçalho, igual ao do DS (`#ds-anim`, `aria-pressed`, localStorage `nexo.pl.animacao`). `prefers-reduced-motion`: sem cursor, só aparece.
- Plano aberto pela primeira vez ou recarregado: sem animação (mesmo critério do DS, `recarregar({ animar: false })`).

### Editor de card

Painel lateral direito dentro do pane (empurra o canvas; não cobre o chat). Cabeçalho "Editar card" + id em mono + ✕. Campos: Título; Tipo (grade 3×2 de botões com ícone, ativo com borda/fundo na cor do tipo); Etapa (select, inclui "Sem etapa"); Fonte (só sugestão, valida URL/`arquivo:linha` ao sair); Situação (segmentado Aberta/Resolvida, só ambiguidade); Conteúdo com abas Escrever/Prévia (`renderMd`). Rodapé: "Apagar" (texto `--danger`, confirma), "Grava sozinho ao sair do card", "Fechar".

### Enviar para implementação (modal)

Modal fora do work, como `#processos-modal`. Cabeçalho "PLANEJAMENTO · <TÍTULO>" + "Enviar para implementação". Stepper 1 Conferir · 2 Gerar · 3 Revisar.
1. **Conferir**: caixa "BLOQUEIA O ENVIO" (borda `--danger`) com ambiguidades abertas + checkbox "Enviar mesmo assim — vão como pendentes de confirmação"; caixa "AVISOS" (borda `--warn`). Botões: Cancelar · Usar rascunho automático · Pedir ao Agent Manager (desabilitados enquanto houver bloqueio sem o checkbox).
2. **Gerar**: estado de espera quando pede ao Manager (some quando o arquivo aparece via SSE).
3. **Revisar**: textarea mono com o markdown; Voltar · Enviar para implementação.

Formato do rascunho (validado no agent-code, portar quase igual): `# Implementação: <título>` → onde está o plano → Objetivo → Etapas na ordem (com cards e caminho de cada arquivo) → Cards fora das etapas → Requisitos → Decisões (com o porquê) → Sugestões (com fonte) → Ambiguidades abertas/resolvidas → Notas → Como trabalhar (declarar etapas como TodoWrite, não replanejar, perguntar antes de desviar).

## Fases

### F1 — Store no daemon
- `planejamento.ts`: `listarPlanos`, `criarPlano` (slug `plano-AAAAMMDD-HHMM`, "Sem nome"), `abrirPlano`, `salvarCard`, `apagarCard` (limpa links de quem aponta), `salvarRoteiro`, `salvarLayout`, `escreverHandoff`, `refsDoCorpo` (`[[Título]]`/`[[id]]`).
- Emissor de eventos em memória por plano.
- `test/planejamento.test.ts` (`tempHome()`): validações, conflito de rev, card inválido isolado, CRLF, apagar limpa links, resolução de `[[ref]]` sem caixa/acento.

### F2 — Rotas HTTP
- `GET/POST /v1/planejamento?projectPath=`, `GET /v1/planejamento/:slug`, `PUT/DELETE .../cards/:id`, `PUT .../roteiro`, `PUT .../layout`, `GET/POST .../handoff`, `GET /v1/planejamento/events` (SSE).
- `POST /v1/planejamento` cria plano **e** a thread do Manager (`createThread` + `meta.planejamento`), devolve `{ slug, threadId }`.
- Padrão das rotas de tarefas (`http.ts:1515-1745`). Casos em `http.test.ts`; `route-guard.test.ts` verde.

### F3 — Manager
- `packages/shared`: `thread_meta.planejamento?: { slug }` e `thread_meta.handoff?: { slug }`; `CreateThreadInput` idem.
- `ferramentasDePlanejamento(projectPath, slug, home)`: `plan_ler`, `plan_roteiro_definir`, `plan_etapa_marcar`, `plan_card_criar|atualizar|apagar|ligar`, `plan_ambiguidade_abrir|resolver`, `plan_handoff_escrever`. Slug vem da thread. Respostas pt-BR; conflito devolve versão atual. Cada escrita emite evento.
- `http.ts` `/v1/mcp`: na thread de planejamento, conjunto = planejamento + `nexo_perguntar` (+ autoria/resumo só se fizer sentido — decidir na implementação).
- `cli.ts::profileFlags`: restrição de ferramentas nativas para `meta.planejamento` (tabela acima). Teste com fixture conferindo os argv.
- `session.ts::instrucoesDoPack`: bloco do Manager (tradução direta de `buildPlanningHint`, sem as partes de sandbox/Bash) e bloco de handoff. Atenção ao `--resume` (`cli.ts:443+`): confirmar que o bloco chega na retomada.
- Testes: ferramenta recusa etapa inexistente, sugestão sem fonte, link para si; argv da thread de planejamento sem Write/Bash.

### F4 — Tela (leitura + ao vivo)
- `index.html`: `<section class="pane" id="pane-planejamento">` com `mod-head` (título editável, botão "Enviar para implementação"), roteiro à esquerda (redimensionável, largura em localStorage) e canvas.
- Registro: `work-session.js` (`KIND_UNICO`/`KIND_TAB`/`NOMES`), `renderer.js` (`MODULES`, `ICO_PATHS`, `WORK_PANES`, `aoMostrarPainel`, instanciação ~`:5424`, boot ~`:8586`). Ao abrir: `state.sideChat = true` e troca para a thread do Manager.
- `planejamento-board.js`: factory `createPlanejamentoBoard({ req, el, getProjectPath, aoAbrirConversa, confirmar, avisar })` → `{ ligar, abrir }`. DOM por `createElement`/`textContent`; corpo por `renderMd`.
- `planejamento-layout.js` (puro, port de `layout.ts`): colunas, posições, arestas link/ref/sequência.
- Canvas: cards com cor/ícone por tipo (tokens `--pl-<tipo>`, seção própria em `styles.css`, prefixo `pl-`), arestas em SVG. Pan/zoom: reusar `zoomEm` de `canvas-ds.js:141` (extrair para `canvas-vista.js` só se não mexer no comportamento do DS).
- SSE → recarrega o plano.
- Entrada: ícone no repo da sidebar + item na Paleta → `POST /v1/planejamento` → abre aba. Lista de planos do projeto para reabrir (reabrir volta à mesma thread).
- Testes (happy-dom, `req` falso): `planejamento-layout.test.js` (port dos casos de `layout.test.ts`) e `planejamento-board.test.js`.

### F5 — Edição pelo usuário
- Clique no status da etapa roda o ciclo (reaplica 1× em conflito).
- Arrastar card salva posição (debounce 400ms); pan/zoom do usuário salvo, enquadramento automático não.
- Duplo clique no card → editor lateral (título, tipo, etapa, fonte, status, corpo com prévia). Sem botão salvar: rascunho em localStorage, grava ao perder foco/fechar; conflito → merge campo a campo.
- Duplo clique na coluna cria card; arrastar entre alças liga; Delete apaga (confirmar).
- Autocomplete `[[` no editor.
- Linhas: hover destaca/esmaece, alças com linha fantasma no arrasto, Delete na ligação (ver "Linhas e setas").

### F5b — Animação
- Extrair `canvas-anim.js` de `canvas-ds.js` (cursor + contorno + fila) sem mudar o comportamento do DS; `test/canvas-ds.test.js` continua verde.
- Diferença entre leituras (`diffPlano(anterior, atual)`, pura): etapas, cards, ligações e referências novos; cards alterados; status mudados. Ignora o que foi gravado por esta janela.
- Fila na ordem da seção "Animação"; linha se desenhando por `getTotalLength()`; botão "Animação" + `prefers-reduced-motion`.
- Testes: `diffPlano` (happy-dom não mede layout — o desenho em si é conferido rodando o app).

### F6 — Enviar para implementação
- Conferência (`prontidaoHandoff`, pura): ambiguidade aberta bloqueia (com "enviar mesmo assim"); roteiro vazio, etapa sem card/não concluída, card inválido → aviso.
- Dois caminhos, como no original: "Rascunho automático" (`montarHandoff`, determinístico, testado) e "Pedir ao Manager" (manda o pedido fixo na thread do Manager e espera o arquivo novo em `handoff/` via SSE).
- Texto editável; versão final gravada em `handoff/` antes do envio.
- Envio pelo daemon: `POST .../handoff/enviar` cria thread "Implementação: <título>" com `meta.handoff` e faz `postMessage`. Desktop só abre a conversa (`aoAbrirConversa`).
- Opcional: criar tarefas no Quadro (marco = título do plano, uma por etapa, dependência na anterior) — `tarefas.ts` já tem marcos e dependências.

### F7 — Integração: Quadro de tarefas e Design System

Objetivo: o plano não é uma ilha. Um card pode apontar pra uma tela do DS, pra uma tarefa do Quadro ou pra um arquivo; o envio vira tarefas no Quadro; e dá pra navegar nos dois sentidos.

**Referências unificadas** — mesma sintaxe `[[…]]` que já liga cards do plano, com prefixo:

| Sintaxe | Aponta pra | Na tela |
|---|---|---|
| `[[Título]]` / `[[id]]` | card do plano | seta no canvas (já existe) |
| `[[ds:<id>]]` | card/tela do Design System (`design-system.ts`) | chip com miniatura (mesmo iframe sandbox do `canvas-ds.js`); clique abre a aba DS focada no card |
| `[[tarefa:<id>]]` | tarefa do Quadro (`tarefas.ts`) | chip com coluna e prioridade; clique abre o Quadro com a tarefa aberta |
| `[[arquivo:src/a.ts:12]]` | arquivo do projeto | chip; clique abre no editor |

- `planejamento.ts`: `extrairRefs` separa por prefixo; `abrirPlano` devolve `refsExternas` por card, já resolvidas contra o DS ativo e o Quadro (`existe`, título, status) — ref que sumiu aparece riscada, não quebra nada.
- Autocomplete `[[` no editor e no chat lista os três: cards do plano, telas do DS, tarefas.
- Manager ganha leitura desses mundos: `nexo_tarefa_listar` (só leitura) e listar/ver telas do DS (reusar `ferramentaDePrintDoDs`, que devolve a imagem da tela — o Manager planeja olhando a tela de verdade). Continua sem escrever neles.
- Handoff inclui as referências resolvidas (id + caminho do arquivo do card DS / id da tarefa), pra implementação usar o componente certo.

**Envio → Quadro** (opção no passo 3, ligada por padrão quando `modulos.quadroTarefas`):
- Um **marco** com o título do plano; uma **tarefa por etapa** (título da etapa, descrição = requisitos/decisões da etapa + link do plano, checklist = requisitos), `dependeDe` a tarefa da etapa anterior, `threadId` = conversa de implementação.
- Grava o vínculo nos dois lados: `etapa.tarefaId` no roteiro e `Tarefa.origem = { plano, etapa }` (campo novo, opcional, em `tarefas.ts`).
- Bloco de handoff lista os ids das tarefas: a conversa de implementação move os cards dela no Quadro (regra do quadro que já existe no pack).

**Dois status, sem briga de fonte da verdade**: o status da etapa no roteiro é de **especificação** (planejando → especificada); depois do envio, a execução vem do Quadro e aparece como selo só leitura na etapa e no cabeçalho da coluna ("Quadro: Fazendo"). Nada sincroniza escrevendo de um lado pro outro.

**Navegação**:
- Quadro: tarefa com `origem` mostra chip "Plano: <título> · <etapa>" → abre a Tela de Planejamento centrada na etapa.
- DS: card do DS mostra "usado em N planos" (busca reversa pelas refs) → lista e abre.
- Quadro → "Planejar esta tarefa": cria plano com a tarefa como primeiro card (`[[tarefa:id]]`) e abre o Manager. (Depois da v1.)

Testes: resolução de refs (existe/sumiu/prefixo inválido), criação de tarefas com dependências e vínculo, chips no board (happy-dom).

### F8 — Docs
- `CHANGELOG.md`; `DOC_TEC.md` seções "API HTTP" (`:299`) e "Telas" (`:328`).

## Riscos

- **`settings.json` do usuário**: regras `allow` podem ou não vencer `--disallowed-tools`. Validar no CLI em F3; é por isso que o agent-code tem hook `PreToolUse`.
- **`--resume` ignora `--append-system-prompt-file`**: o bloco do Manager precisa chegar pelo mecanismo de stdin que já existe.
- **Edição manual no disco** não aparece ao vivo na v1.
- `renderer.js` sem teste: lógica no módulo, só ligação no renderer.

## Ordem

F1+F2 → F3 (Manager usável só pelo chat) → F4 → F5 → F5b → F6 → F7 (integração) → F8 (docs). Toda fase de tela (F4–F6) fecha também com o app rodando e print comparado com a "Especificação visual". Cada fase fecha com `pnpm check` verde.
