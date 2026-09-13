# Nexo — ferramentas de tarefas pro LLM (design)

Data: 2026-09-12
Status: aprovado pelo usuário, aguardando plano de implementação

Quarto e último spec da iniciativa "gestão de memória/tarefas entre dispositivos +
reformulação da página de tarefas/projeto". Ordem: A (storage) → B (modelo avançado) → C
(visualizações) → **D (este spec)**, os três primeiros já implementados.

## Problema

A ideia original de "D" era dar ao LLM acesso às tarefas via ferramenta. Só que
`ferramentasDeTarefas` (`apps/daemon/src/tarefas.ts:720`) **já existe e já está ligada** —
`nexo_tarefa_listar`/`nexo_tarefa_salvar` entram no conjunto de MCP de QUALQUER conversa com
`projectPath` (`http.ts`, boca `/v1/mcp`), e isso inclui os runs disparados por automação de
coluna (Spec B), porque pipeline steps criam thread com `projectPath` e passam pela MESMA
boca de MCP (`session.ts`/`runs.ts`, confirmado durante o Spec B). O que falta não é "dar
acesso" — é **atualizar essa ferramenta pros campos que o Spec B criou** (ela não conhece
`tipo`/`parentId`/`dependeDe`, nem dá acesso a checklist/comentário/commits).

## Objetivo

`nexo_tarefa_salvar` passa a aceitar `tipo`/`parentId`/`dependeDe`. Três ferramentas novas:
checklist, comentário, e consulta de commits relacionados — mesmo conjunto MCP
`ferramentasDeTarefas`, sem endpoint HTTP novo (essas três já existem como rota HTTP pra UI;
aqui só ganham uma casca de ferramenta MCP chamando a MESMA função que a rota já chama).

## Fora de escopo

- **Apagar tarefa por ferramenta.** Decisão do usuário: mantém a assimetria já documentada no
  código ("sem apagar por aqui, só a pessoa apaga na tela") — evita perda de dado por um
  agente confuso. Vale pra checklist/comentário também (sem `nexo_tarefa_checklist_apagar`
  nem editar/apagar comentário — a UI de comentário já nem tem apagar hoje).
- **Ferramenta pras visualizações do Spec C** (tabela/calendário/timeline não são dado novo,
  são só forma de mostrar o mesmo `Tarefa[]` que `nexo_tarefa_listar` já devolve — nada a
  expor de novo pro LLM).
- **Coluna/marco/etiqueta por ferramenta** (criar/editar/apagar) — continua só pela UI. O LLM
  só REFERENCIA colunaId/marcoId/etiquetaIds já existentes (mesma limitação de hoje).

## `nexo_tarefa_salvar`: campos novos

`inputSchema.properties` ganha:

```ts
tipo: { type: "string", enum: TIPOS_TAREFA as unknown as string[] },
parentId: { type: "string", description: "id de outra tarefa deste projeto — esta vira subtarefa dela" },
dependeDe: { type: "array", items: { type: "string" }, description: "ids de tarefas que bloqueiam esta (só informativo)" },
```

Sem `enum` fechado em `parentId`/`dependeDe` (ao contrário de `colunaId`/`marcoId`/
`etiquetaIds`) — a lista de ids de tarefa pode ser grande e mudar a cada chamada de
`nexo_tarefa_listar`; o servidor já valida existência em `salvarTarefa` (`limparParentId`/
`limparDependeDe`, Spec B) e devolve erro claro pro modelo corrigir (mesmo `tentar()` já
usado). `nexo_tarefa_listar` (a ferramenta "chame isto primeiro") já lista todas as tarefas
com id — é de lá que o modelo tira o id certo pra `parentId`/`dependeDe`, igual já faz hoje
pra saber um `colunaId` válido antes de chamar `salvar`.

## Ferramenta nova: `nexo_tarefa_checklist`

Uma ferramenta só, com um campo `acao` (em vez de três ferramentas separadas — mais simples
pro modelo escolher um enum do que decorar três nomes):

```ts
{
  name: "nexo_tarefa_checklist",
  inputSchema: {
    properties: {
      tarefaId: { type: "string" },
      acao: { type: "string", enum: ["adicionar", "marcar", "desmarcar"] },
      texto: { type: "string", description: "obrigatório só pra 'adicionar'" },
      itemId: { type: "string", description: "obrigatório só pra 'marcar'/'desmarcar'" },
    },
  },
}
```

Chama `adicionarChecklistItem`/`alternarChecklistItem` (já existem, `tarefas.ts`) — zero
lógica nova, só validação de qual campo cada `acao` exige antes de chamar.

## Ferramenta nova: `nexo_tarefa_comentar`

```ts
{ name: "nexo_tarefa_comentar", inputSchema: { properties: { tarefaId, texto } } }
```

Chama `adicionarComentario` (já existe). `autor` não é exposto — comentário de agente não
tem "nome de pessoa" pra assinar; a UI já mostra comentário sem autor de forma normal (campo
opcional).

## Ferramenta nova: `nexo_tarefa_commits`

```ts
{ name: "nexo_tarefa_commits", inputSchema: { properties: { tarefaId } } }
```

Chama `commitsRelacionados(projectPath, tarefaId)` (`tarefas-git.ts`, Spec B) e formata como
lista de linhas (`hash curto — mensagem — data`), mesmo estilo de `nexo_tarefa_listar`. Vazio
→ texto "nenhum commit menciona esta tarefa ainda" (não erro — lista vazia é resultado válido).

## Testes

- `apps/daemon/test/tarefas.test.ts`: `nexo_tarefa_salvar` aceita `tipo`/`parentId`/
  `dependeDe` e devolve erro (não lança) pra `parentId`/tipo inválido, mesmo padrão do teste
  já existente pra `colunaId` inválido.
- `apps/daemon/test/tarefas.test.ts`: `nexo_tarefa_checklist` — "adicionar" sem `texto` é
  erro pro modelo; "marcar"/"desmarcar" sem `itemId` é erro; fluxo completo (adicionar →
  marcar) reflete em `getTarefa` depois.
- `apps/daemon/test/tarefas.test.ts`: `nexo_tarefa_comentar` — adiciona e aparece em
  `getTarefa(...).comentarios`, sem `autor`.
- `apps/daemon/test/tarefas.test.ts`: `nexo_tarefa_commits` — projeto com commit mencionando
  o id devolve a linha certa; sem nenhum, devolve o texto de vazio (não erro).
