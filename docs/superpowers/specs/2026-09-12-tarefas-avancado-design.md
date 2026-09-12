# Nexo — modelo de tarefa avançado (design)

Data: 2026-09-12
Status: aprovado pelo usuário, aguardando plano de implementação

Segundo de 4 specs da iniciativa "gestão de memória/tarefas entre dispositivos +
reformulação da página de tarefas/projeto" (ver
[2026-09-12-storage-cross-device-design.md](2026-09-12-storage-cross-device-design.md), Spec
A, já implementado). Ordem combinada com o usuário: A → **B (este spec)** → C (novas
visualizações) → D (ferramenta de LLM).

## Problema

O quadro Kanban (`apps/daemon/src/tarefas.ts`) hoje é só coluna/marco/etiqueta/checklist/
comentário — sem hierarquia entre tarefas, sem categorização por tipo, sem rastro de qual
código resolveu qual tarefa, e sem nenhuma reação automática a mudança de estado (tudo é o
usuário movendo card à mão). Para uma gestão "profissional" faltam: subtarefas, dependências,
tipo de tarefa, vínculo com commits, e automação simples de coluna.

## Objetivo

Estender o modelo de `Tarefa` com subtarefas/dependências/tipo; expor commits relacionados
via busca sob demanda no git; e permitir regras "tarefa entrou na coluna X → dispara agente
Y", reaproveitando a infraestrutura de Nexo Hooks já existente (`hooks.ts`) em vez de criar
um motor de automação paralelo.

## Fora de escopo

- **C/D** (novas visualizações, ferramenta de LLM) — specs próprios depois deste.
- **Bloqueio de movimentação por dependência.** "Bloqueada por" é só informativo (badge no
  card + lista no modal) — não impede mover pra nenhuma coluna. Decisão do usuário: manter
  simples, sem regra de validação nova em `salvarTarefa` pra isso.
- **Motor de automação genérico (condição/ação livre).** As automações deste spec são
  estritamente "tarefa mudou pra coluna X" → "roda agente/time Y" — mesmo modelo de regra que
  `git.post-commit`/`git.pre-push` já usam, só um evento novo. Nada de editor de regras
  arbitrárias.
- **Detecção automática de branch por tarefa.** Vínculo com código é só busca de commit por
  menção do id da tarefa na mensagem (ver seção própria) — não cria branch nem nomeia branch
  a partir da tarefa.
- **Hierarquia visual de subtarefas no board.** Uma subtarefa é um card normal no quadro (com
  um indicador de "sub de X"); agrupar visualmente sob o card pai fica pro Spec C (que já vai
  mexer a fundo no layout do kanban).

## Modelo de dados (`tarefas.ts`)

`Tarefa` ganha três campos, todos opcionais (retrocompatível — tarefa antiga sem os campos
continua válida):

```ts
export const TIPOS_TAREFA = ["bug", "feature", "chore", "spike"] as const;
export type TipoTarefa = (typeof TIPOS_TAREFA)[number];

type Tarefa = {
  // ...campos existentes...
  tipo?: TipoTarefa;
  /** Tarefa-mãe, se esta for uma subtarefa. Precisa existir no MESMO projeto. */
  parentId?: string;
  /** Ids de tarefas que bloqueiam esta (mesmo projeto). Só informativo — ver "Fora de escopo". */
  dependeDe?: string[];
};
```

Validação em `salvarTarefa` (mesmo estilo de `limparEtiquetaIds`):

- `tipo`: enum `TIPOS_TAREFA`, mesmo tratamento de `prioridade` (`limparTipo`).
- `parentId`: se informado, precisa existir (`lerTarefaDoDisco`) e não pode ser a própria
  tarefa (`id === parentId` → 400) nem criar ciclo direto (`parentId` da tarefa apontada não
  pode ser a tarefa atual — checagem de 1 nível, não persegue a cadeia inteira; ciclo mais
  profundo é edge case aceito como limitação, igual outras validações rasas do arquivo).
- `dependeDe`: array de ids, cada um precisa existir (mesmo padrão de `limparEtiquetaIds`),
  sem duplicado, sem o próprio id.

`corpoDaTarefa` (render Markdown) ganha linhas opcionais: `- Tipo: bug`, `- Subtarefa de:
<id>`, `- Bloqueada por: <ids>` — mesmo padrão das linhas condicionais já existentes.

## Commits relacionados (git)

Sem campo novo persistido — computado sob demanda, sempre fresco (evita cache
desatualizado). Nova função em `tarefas.ts` (ou módulo próprio `tarefas-git.ts`, se o arquivo
já estiver longo demais na hora de implementar):

```ts
function commitsRelacionados(projectPath: string, tarefaId: string): { hash: string; mensagem: string; data: string }[]
```

`execFileSync("git", ["log", "--all", "--fixed-strings", "--grep", tarefaId, "-n", "20",
"--format=%H%x1f%s%x1f%aI"], { cwd: projectPath, ... })`, parseado por `\x1f` (separador que
não aparece em mensagem de commit normal). Best-effort — sem `.git`, sem `git` no PATH, ou
projeto sem nenhum commit mencionando o id: lista vazia, nunca lança (mesmo padrão de
`listarArquivos` em `repo-map-indice.ts`).

Novo endpoint `GET /v1/tarefas/:id/commits?projectPath=...` (`http.ts`) devolve a lista.
Consumido só pelo MODAL de edição da tarefa (não pelo card do board — evita rodar `git log`
uma vez por card visível na tela). Convenção de uso: quem quiser que o Nexo ache o commit
inclui o id da tarefa (`tk-...`) na mensagem — nada força isso, é convenção, igual "Refs #123"
em outras ferramentas.

## Automação de coluna (`hooks.ts`)

Reaproveita o modelo de regra existente em vez de um sistema novo:

- `HOOK_EVENTS` ganha `"tarefa.mudou-coluna"` (bate com `HOOK_EVENT_RE`, mesmo formato
  `categoria.nome` dos eventos já existentes).
- `RegraHook` ganha `colunaId?: string` — mesmo papel do `branch` pros eventos de push:
  filtro opcional (vazio/ausente = qualquer coluna). Validado por um novo `EVENTOS_COM_COLUNA
  = new Set(["tarefa.mudou-coluna"])`, mesmo formato de `EVENTOS_COM_BRANCH`/`limparBranch`
  (`limparColunaId`, recusa se informado num evento que não seja esse).
- `regrasCasando` passa a receber também `colunaId` e casar `!r.colunaId || r.colunaId ===
  colunaId`, ao lado do casamento de branch existente.
- `fireHook` troca o parâmetro posicional `branch = ""` por um objeto de opções `{ branch?,
  colunaId?, contexto? }` — os dois call sites atuais (`POST /v1/hooks/fire` em `http.ts`, e o
  script `.git/hooks/*` que roda `nexo hook fire`) passam a mandar `{ branch }` em vez do
  positional. `contexto` é texto livre opcional que `metaDoEvento` anexa ao `goal` quando
  presente — é como o evento de tarefa entrega título/descrição/id sem `metaDoEvento` precisar
  saber o que é uma "tarefa" (mantém o despacho agnóstico, mesmo princípio já documentado no
  topo do arquivo).
- Disparo: em `salvarTarefa` (`tarefas.ts`), quando `colunaId` do resultado final é DIFERENTE
  do `atual?.colunaId` (mudança de coluna de verdade, não toda gravação), chama `fireHook(
  "tarefa.mudou-coluna", projectPath, home, { colunaId: novoColunaId, contexto:
  \`Tarefa ${id} — "${titulo}"${descricao ? \`: ${descricao}\` : ""}\` })`. Import de
  `hooks.ts` em `tarefas.ts` — sem ciclo, `hooks.ts` não importa `tarefas.ts`.
- **Sem mudança de infraestrutura de MCP.** Confirmado em `runs.ts:458-460`/`session.ts:466`:
  todo passo de run (inclusive o time-pipeline-de-1 oculto que uma regra de hook dispara) já
  cria a thread com `projectPath`, e a boca de MCP daquele projectPath (`urlDeMcpAutoria`) já
  inclui `ferramentasDeTarefas` (`nexo_tarefa_listar`/`nexo_tarefa_salvar`, já ligadas hoje,
  ver `http.ts:1260`) — o agente disparado pela automação JÁ consegue mover a própria tarefa
  ou comentar nela ao terminar, sem nenhum código de ferramenta novo.

## UI

**Tela Hooks** (`apps/desktop`, tela existente): evento novo na lista de eventos possíveis;
quando `evento === "tarefa.mudou-coluna"`, mostra um seletor de coluna do projeto escolhido
(em vez do campo de texto de branch) — mesmo padrão condicional que já existe pra habilitar
"branch" só nos eventos de push.

**Card do kanban** (`tarefas-board.js`): ícone/badge de `tipo` (cor por tipo, texto curto tipo
"🐛"/"✨"/"🔧"/"🔬"), badge "sub de <título curto do pai>" quando `parentId` presente, badge
"bloqueada por N" quando `dependeDe.length > 0`.

**Modal de edição**: campo `tipo` (select), campo `parentId` (select de tarefas do mesmo
projeto, excluindo a própria e suas subtarefas diretas — evita ciclo óbvio na hora de
escolher), campo `dependeDe` (multi-select), e uma seção nova "Commits relacionados"
(carregada via `GET /v1/tarefas/:id/commits` só quando o modal abre, com estado vazio "nenhum
commit menciona o id desta tarefa ainda").

## Testes

- `apps/daemon/test/tarefas.test.ts`: `tipo` válido/inválido; `parentId` inexistente é 400;
  `parentId === id` é 400; `parentId` cujo alvo já tem a tarefa atual como PAI (ciclo direto) é
  400; `dependeDe` com id inexistente é 400, sem duplicado, aceita vazio; render Markdown
  mostra as linhas novas condicionalmente.
- `apps/daemon/test` (novo, `tarefas-git.test.ts` ou dentro de `tarefas.test.ts`):
  `commitsRelacionados` — projeto git com um commit mencionando o id acha o commit; sem
  menção nenhuma devolve vazio; projeto sem `.git` devolve vazio sem lançar.
- `apps/daemon/test/hooks.test.ts`: `tarefa.mudou-coluna` casa por `colunaId` igual ou ausente
  na regra; `colunaId` num evento de push é 400 (`limparColunaId`); `branch` no evento de
  tarefa é 400 (`limparBranch` já recusa evento fora de `EVENTOS_COM_BRANCH` — confirmar que
  `tarefa.mudou-coluna` também cai nessa recusa); `fireHook` com `contexto` anexa o texto ao
  `goal` do run disparado.
- `apps/daemon/test/tarefas.test.ts` (integração com hooks): `salvarTarefa` mudando
  `colunaId` dispara `fireHook` com o evento/colunaId certos; gravar a MESMA `colunaId` (só
  editar outro campo) não dispara nada.
- `apps/daemon/test/http.test.ts`: `GET /v1/tarefas/:id/commits` devolve a lista (ou vazia);
  404 se a tarefa não existe.
