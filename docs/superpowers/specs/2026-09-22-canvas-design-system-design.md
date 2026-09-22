# Nexos — Canvas de Design System (design)

Data: 2026-09-22
Status: rascunho, aguardando aprovação do usuário

## Problema

O front que os agentes geram sai inconsistente: cada tela inventa hex, espaçamento, raio e tipografia. Não existe no Nexos um lugar pra definir a linguagem visual do projeto nem um jeito de os agentes seguirem essa linguagem.

Referência de produto: Claude Design (Anthropic Labs), que tem chat + canvas, DS extraído de código, screenshots e arquivos de marca, comentário inline, controles gerados pelo Claude, verificação contra o DS antes de mostrar e sync com o código nos dois sentidos. Referência de animação: Google Stitch, em que o desenho se forma aos poucos acompanhado de um cursor.

## Objetivo

1. Nova view **Canvas**: um board estruturado (seções e cards em grid, com pan e zoom) onde o usuário cria, vê e ajusta o design system (DS) do projeto.
2. O DS completo é gerado por agente a partir do codebase, de uma URL/screenshot de referência, do logo ou de um brief.
3. **Streaming real:** o card vai se desenhando enquanto o HTML chega, com um cursor sintético indo até cada elemento novo.
4. O agente edita o DS **livremente**, conforme o pedido do usuário no chat, com as ferramentas nativas do motor. O Nexos não cria ferramenta de edição.
5. Cada card tem **Edit** (tokens), **Controles** (sliders que o agente declara) e **Feedback** (comentário ancorado num elemento).
6. **Verificação antes de mostrar:** um card fora das regras volta pro agente corrigir antes de ser dado como pronto.
7. **Sync com o código** nos dois sentidos: ressincronizar o DS a partir do código e checar a conformidade do código com o DS.
8. Os agentes consomem o DS no trabalho de front. É daí que vem o ganho de qualidade.

## Fora do escopo (v1)

- Canvas livre estilo Figma e edição direta (arrastar/redimensionar/alinhar elemento).
- Componentes no stack real (React/Vue). O DS é HTML + CSS vars, e o agente traduz pro stack na hora de implementar.
- Biblioteca global de DS compartilhada entre projetos.
- Handoff bundle. No Nexos o agente já trabalha no próprio repo, então não há o que empacotar.
- Export pra PPTX/PDF/ferramentas de terceiros.

## Storage

O DS mora **dentro do projeto, na pasta que o usuário escolhe** ao criar (o padrão sugerido é `design-system/`). O caminho fica salvo na config do projeto no daemon. Um projeto pode ter mais de um DS (ex.: painel interno e portal do cliente); nesse caso, um deles é o "ativo".

```
<pasta-escolhida>/
  tokens.json        # W3C DTCG: color, typography, spacing, radius, shadow, motion, breakpoint
  DESIGN.md          # regras de uso (o "Uso da cor" etc.) — o que o agente lê
  cards/<id>.html    # 1 card por arquivo; só var(--token), nunca hex literal
  meta.json          # ordem das seções, fonte de geração, versões, avisos de lint
```

Os **arquivos são a fonte da verdade**. Qualquer um pode alterá-los: o agente (via Write/Edit/shell), o próprio Canvas (Edit/Controles) ou o usuário num editor. O Canvas só reflete o que está em disco. Tudo é versionado pelo git do projeto, sem banco novo.

### Seções padrão (o agente pode omitir ou adicionar)

| Seção | Cards |
|---|---|
| Fundamentos | Superfícies, Marca & semântica, Tipografia, Espaçamento, Raio & sombra, Motion |
| Core | Logo, Botões, Pills/status, Avatares, Barras, Ícones |
| Layout | Casca (sidebar, topbar), Cards, KPIs, Grid responsivo |
| Dados & formulários | Datatable, Campos + validação, Selects, Alertas |
| Navegação | Tabs, Breadcrumb, Paginação, Menu |
| Feedback & overlays | Toast, Modal, Drawer, Empty state, Loading/skeleton |
| Gráficos | Paleta de dados, Barras/linha, Legendas |
| Telas-exemplo | 2–3 telas completas compostas só com o DS |

## Por que não criar ferramentas de edição

Capacidade de cada motor hoje:

| Motor | Edita arquivo nativamente | Cliente MCP |
|---|---|---|
| `claude` | sim (Write/Edit) | sim |
| `codex` | sim (shell) | sim |
| `api` | não, só devolve texto | não (`engines/api.ts:41`) |

Ferramentas MCP de DS duplicariam o que `claude`/`codex` já fazem, gerariam superfície pra manter e não funcionariam no `api`. Duas coisas cobrem todos os motores sem ferramenta nova: observar o disco (§2) e um protocolo de texto na resposta (§3).

## Arquitetura

### 1. Daemon — `apps/daemon/src/design-system.ts`

- Leitura e escrita em disco: `lerDs`, `salvarTokens`, `salvarCard`. O caminho vem da config do projeto e é validado pra ficar DENTRO do projeto (sem `..`, sem symlink pra fora; mesma regra de `projeto-dir.ts`).
- `tokensParaCss(tokens)`: gera o `:root { --... }`, a única fonte das variáveis. Temas claro e escuro saem de `$extensions` do DTCG.
- Rotas HTTP em `server.ts`: `GET/PUT /projects/:id/ds`, `PUT /projects/:id/ds/cards/:card`, `POST /projects/:id/ds/generate`, `POST /projects/:id/ds/cards/:card/feedback`, `POST /projects/:id/ds/resync`, `POST /projects/:id/ds/conformidade`.

### 2. Observador + lint — `ds-watch.ts`

- `fs.watch` recursivo na pasta do DS ativo, com debounce de ~150 ms por arquivo. Hoje não existe observador no daemon: é código novo.
- A cada mudança, roda o **lint** do arquivo e publica no bus `ds:changed {arquivo, lint}`.
- Regras do lint:
  - cor literal (`#hex`, `rgb(`, `hsl(`, `oklch(`…) em qualquer lugar do card — card não define paleta, quem define é o `tokens.json` (cor nomeada tipo `white` não é acusada: falso positivo demais);
  - `<script>` (exceto o bloco JSON de controles, §5);
  - `src`/`href`/`url()` externos fora da allowlist de fontes;
  - `tokens.json` inválido (DTCG) ou referência a token inexistente (`var(--x)` sem `--x`).
- O resultado vai pra `meta.json` e aparece como badge no card.

### 3. Geração e streaming real — `ds-stream.ts`

**Protocolo.** Pra gerar ou reescrever um card inteiro, o agente escreve o card na resposta, delimitado assim:

```
<ds-card id="core-botoes" titulo="Botões" secao="core">
  ...html...
</ds-card>
```

É o único caminho com streaming real e o que faz o motor `api` funcionar. O daemon consome os eventos `text` do motor, detecta os delimitadores e publica `ds:chunk {card, html}` e `ds:card-done {card}`. No fechamento, grava `cards/<id>.html`, o que passa pelo observador/lint normalmente. Um card incompleto (turno abortado) não é gravado.

**Edição livre** (o usuário pede no chat, o agente usa Edit num trecho): não passa pelo protocolo. O observador detecta a mudança e o Canvas anima só a diferença (§4).

**Por motor (medido no código atual):**

- `claude`: já roda com `--include-partial-messages`. Hoje `text_delta` é descartado em `parse-claude.ts:248` pra não duplicar o texto do `assistant`. É preciso um modo opt-in que emita os deltas **só** em turnos de DS, sem mudar o chat.
- `codex`: `exec --json` só emite item completo (`parse-codex.ts`), então **não há streaming real**. Fallback de replay: o card chega inteiro e é montado com a mesma animação.
- `api`: verificar na implementação se usa streaming. Se não usar, também cai no replay.

**Pipeline de geração:**

1. **Coleta de contexto** (sem LLM): scan do codebase (CSS vars, `tailwind.config`/`@theme`, fontes, hex mais usados), screenshot da URL de referência (webview que já existe), logo e brief.
2. **Agente "Diretor"**: escreve `tokens.json` + `DESIGN.md`. Nesse ponto o Canvas já renderiza os Fundamentos.
3. **Fan-out de cards**: um time (`teams.ts`, modo paralelo) com um agente por seção, cada um recebendo tokens + DESIGN.md + a lista de cards da seção.
4. O prompt de sistema exige: HTML sem JS, só `var(--token)`, conteúdo em pt-BR e o logo real do projeto quando houver (nunca inventado).
5. Antes da geração, o Canvas mostra uma estimativa de custo (nº de agentes e cards) e permite gerar seção por seção.

### 4. Verificação antes de mostrar

- **Em turnos que o Nexos inicia** (gerar, Feedback, ressincronizar): quando um card fecha com erro de lint, o daemon manda automaticamente, no mesmo thread, uma mensagem de correção com os erros e o trecho. São no máximo 2 tentativas. Enquanto isso, o card fica em "corrigindo" e só é dado como pronto sem erro. Se esgotar as tentativas, fica com o badge de erro e o botão "pedir correção".
- **Em edições livres pelo chat**: não há reenvio automático (o turno é do usuário). O badge aparece no card e os avisos pendentes entram no pack do próximo turno do projeto.
- v1 é só lint determinístico. Revisão visual por screenshot fica como evolução, fora da v1.

### 5. Canvas — `apps/desktop/canvas-ds.js`

- É uma nova `data-view="canvas"` em `#work`. Pan (arrastar ou espaço+arrastar), zoom (ctrl+scroll, "ajustar à tela") e navegação lateral pelas seções.
- Cada card é um `<iframe sandbox>` **sem** `allow-scripts`, com o `:root` dos tokens injetado.
- Header do card: título, subtítulo, **Feedback**, **Controles** (se houver) e **Edit**.
- **Streaming**: o host escreve os chunks com `doc.open()` + `doc.write(chunk)`. O parser HTML do Chromium é incremental, então o HTML parcial renderiza correto sem parser próprio. Um `MutationObserver` enfileira cada elemento novo.
- **Fila de animação** (~60–120 ms por elemento):
  1. o cursor sintético (reaproveitar o `navegador-cursor.cjs`) desliza até o bbox;
  2. um retângulo SVG com stroke desenha o contorno (`stroke-dashoffset`);
  3. o elemento aparece (opacity + leve scale), e o stroke some.
  A fila acelera se o stream for mais rápido que ela, pra nunca atrasar o fim em mais de ~1 s. Com `prefers-reduced-motion` ou o toggle "sem animação", renderiza direto. Enquanto não chega chunk, mostra um skeleton com o título.
- **Diff animado** (edição livre ou Edit): compara a árvore anterior com a nova e anima só os elementos adicionados/alterados (cursor + contorno + troca).
- **Edit**: painel lateral com os tokens usados no card (color picker, escala tipográfica, espaçamento). Um token alterado regera o `:root`, todos os iframes atualizam na hora e o `tokens.json` é salvo. Sem LLM.
- **Controles** (os sliders que o agente cria): o card pode declarar controles de variáveis locais:

  ```html
  <script type="application/json" data-ds-controles>
  [{ "var": "--btn-pad-x", "rotulo": "Padding horizontal", "tipo": "range",
     "min": 8, "max": 32, "passo": 2, "unidade": "px" },
   { "var": "--btn-raio", "rotulo": "Raio", "tipo": "token", "grupo": "radius" }]
  </script>
  ```

  O `<script type="application/json">` não executa mesmo em iframe com script liberado, e aqui o sandbox não libera. Quem lê é o host. Mexer no slider muda a variável no iframe ao vivo; "Aplicar" grava o valor no card (o host escreve, sem LLM). O tipo `token` limita a escolha aos tokens de um grupo, pra não fugir do DS.
- **Feedback**: modo seleção dentro do card (a mesma lógica do inspector: seletor + outerHTML truncado) e textarea. O agente regera só aquele card, via protocolo, com streaming e verificação.
- **Versões**: `meta.json` guarda as últimas N versões por card, com "desfazer" por card e "tentar outra abordagem", que gera uma variante lado a lado e mantém a atual.

### 6. Sync com o código

- **Código → DS (ressincronizar)**: roda de novo o scan do §3, compara com `tokens.json` e mostra a diferença (token novo no código, valor alterado, token órfão). O usuário aprova item por item. Os cards afetados são regerados pelo agente (com verificação).
- **DS → código (conformidade)**: o agente varre os arquivos de front do projeto e lista hex, tamanhos e espaçamentos fora dos tokens, com sugestão de troca. Não altera nada sem pedido.
- **Injeção no pack**: com um DS ativo, `packer.ts` injeta um bloco curto com o caminho do DS, o `DESIGN.md` (limitado em tamanho) e um resumo dos tokens (nome → valor). O agente lê os cards em disco quando precisar.
- **Export**: CSS vars, Tailwind v4 `@theme`, Tailwind v3 `theme.extend` e `tokens.json`.

## Segurança

- O HTML dos cards é gerado por LLM e roda num iframe `sandbox` sem `allow-scripts`: não executa JS, não navega, não abre popup, não carrega recurso externo fora da allowlist de fontes.
- O caminho do DS é validado pra ficar dentro do projeto. O observador só vigia essa pasta.
- "Aplicar" dos Controles escreve só valores que passam na validação do tipo do controle (número dentro de min/max ou token existente).

## Fases

1. Storage + rotas + `tokensParaCss` + observador/lint + Canvas (pan/zoom, render dos cards, Edit de tokens, diff animado). Sem IA.
2. Coleta de contexto + Diretor + fan-out + protocolo `<ds-card>` (primeiro em replay) + verificação com reenvio automático.
3. Streaming real no `claude` (deltas opt-in, `doc.write` incremental, fila de animação e cursor).
4. Feedback por elemento + Controles + versões/variantes.
5. Sync com o código (ressincronizar, conformidade) + injeção no pack + exports.

## Riscos / em aberto

- **Custo:** um DS completo tem ~25–35 cards e ~8 agentes em paralelo. Mitigação: estimativa antes de gerar e geração por seção.
- **Streaming no `api`**: depende de o motor usar SSE. A verificar na fase 3.
- **Tamanho do pack:** um DESIGN.md grande infla todo turno de front. Limitar o tamanho e resumir.
- **`fs.watch` recursivo**: é estável no Windows/macOS. No Linux depende da versão do Node (recursivo nativo a partir do 20). Hoje o alvo é Windows.
- **Edição do agente e do Canvas ao mesmo tempo:** o Canvas grava por cima só se o arquivo não mudou desde a leitura (compara mtime/hash). Se mudou, recarrega e avisa.
