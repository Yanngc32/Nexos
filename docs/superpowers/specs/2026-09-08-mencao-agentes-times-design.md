# Nexo — @menção de agentes e times no composer (design)

Data: 2026-09-08
Status: aprovado pelo usuário, aguardando plano de implementação

## Problema

Hoje o modelo, numa conversa normal, só pode CRIAR ou EDITAR agente e time (ferramentas de autoria em `apps/daemon/src/autoria.ts`) — nunca executar. É regra deliberada: um run gasta quota de verdade e escreve branch no repositório, então quem dispara é sempre a pessoa, clicando no Team Studio.

Isso deixa uma lacuna: não existe um jeito rápido, de dentro da conversa, de dizer "quero que ESTE agente (ou time) específico trabalhe nisso agora" sem sair do chat e ir até a tela de Times. O usuário quer um `@nome` no composer que force esse disparo — o equivalente, pro Nexo, do que o `/nome-da-skill` já é pra CLI por baixo (convenção que a ferramenta externa interpreta e força a carregar).

## Objetivo

Digitar `@agente-x` ou `@time-y` numa mensagem do composer, ao lado de texto livre, deve:
1. Continuar mandando a mensagem normalmente pro modelo da conversa atual (nada muda nesse caminho).
2. Além disso, disparar um Run de verdade (mesmo mecanismo do botão "rodar" do Team Studio) pro agente/time citado, em paralelo, sem travar o chat.

## Fora do escopo

- Mudar o motor de turno da conversa (`session.ts`) — a menção não altera como o modelo responde, só dispara um Run à parte.
- Ferramenta MCP nova — o modelo continua sem poder disparar run sozinho; quem dispara aqui é a pessoa digitando `@`, o que preserva a regra existente ("quem dispara run é a pessoa").
- Progresso do Run inline na conversa (stream de passos) — quem quer acompanhar abre o Team Studio, que já tem isso.
- Detecção automática de menção sem autocomplete (ex.: aceitar qualquer palavra depois de `@` como tentativa) — sem casar com um id conhecido, é texto literal.

## Resolução da menção

Ao enviar a mensagem, o daemon (ou o composer, ver "Onde roda o parse" abaixo) varre por tokens `@<id>`, onde `<id>` casa com `AGENT_ID_RE`/`TEAM_ID_RE` (`^[a-z0-9][a-z0-9_-]{0,39}$`), delimitado por espaço/início/fim de string.

Pra cada token encontrado, nesta ordem:

1. Bate com um **time** existente (`getTeam`) → usa esse time direto.
2. Senão, bate com um **agente** existente (`getAgent`) → embrulha num time-pipeline-de-1 (ver seção seguinte).
3. Não bate com nada → texto literal, ignorado. Não gera erro nem impede o envio — evita falso positivo (e-mail colado, `@` de outro contexto).

Time e agente vivem em namespaces (arquivos) separados; em caso de um mesmo `id` existir nos dois, time ganha (passo 1 já resolve e para).

## Time oculto pra agente avulso

`Run` (`apps/daemon/src/runs.ts`) não guarda o time resolvido em memória — toda operação do ciclo de vida (retomar, abortar, nome de exibição, checagem de topologia) faz `getTeam(run.teamId, home)` lendo `teams.json` do disco de novo. Um time "só em memória, nunca salvo" quebraria retomar o run após reiniciar o daemon.

Por isso, citar um agente avulso faz o daemon persistir (não expor) um time de 1 membro:

- `id`: `mencao-<agentId>`, truncado a 40 caracteres (limite de `AGENT_ID_RE`/`TEAM_ID_RE`).
- `topology`: `"pipeline"`.
- `members`: `[{ agentId }]`.
- **Upsert, não duplicata**: citar o mesmo agente de novo atualiza o mesmo time oculto (idempotente), não cria um novo a cada menção — evita inflar o teto de `TEAMS_MAX = 50`.

`TeamDef` (`packages/shared/src/index.ts`) ganha um campo novo opcional:

```ts
export type TeamDef = {
  // ...campos existentes
  /** Time criado automaticamente por uma @menção de agente avulso — não aparece na tela de Times. */
  origem?: "mencao";
};
```

`listTeams`/`GET /v1/teams` (consumidos pela tela de Times) filtram `origem === "mencao"` do resultado. `getTeam` (usado internamente por `runs.ts`, `saveTeam`, MCP do supervisor) **não filtra** — continua vendo qualquer time, incluindo os ocultos, então todo o motor de Run funciona sem nenhuma mudança de código nele.

## Disparo do Run

Pra cada menção resolvida (passo 1 ou 2 acima), o daemon* chama o equivalente de `criarRun` + `executarRun` já usado por `POST /v1/runs` (mesmo caminho do Team Studio):

- `teamId`: o time resolvido (existente ou o oculto upsertado).
- `projectPath`: o projeto aberto na conversa atual (`getProjectPath()` no desktop).
- `goal`: a mensagem digitada com **todos** os tokens `@<id>` removidos e espaços colapsados. Se o resultado ficar vazio (ex.: mensagem era só `@revisor`), usa a mensagem original crua como goal.
- `budget`: omitido (mesmo default do Team Studio sem orçamento definido).

Múltiplas menções na mesma mensagem → um Run por menção, todas recebendo o mesmo `goal`.

\* Onde exatamente: o parse de menção e a chamada a `POST /v1/runs` acontecem no **desktop** (`renderer.js`, junto do handler que hoje manda a mensagem pro daemon), não no daemon — mantém a regra de que o daemon nunca decide sozinho disparar um run; ele só executa o que a UI pediu, do mesmo jeito que o Team Studio já pede.

## UI: autocomplete do `@`

Mesmo padrão do `/` já implementado (`SLASH_COMMANDS`/`state.slash` em `renderer.js`): digitar `@` abre um menu com agentes (`GET /v1/agents/defs`) e times (`GET /v1/teams` — já filtrado, então nunca sugere um time oculto) do perfil ativo. Selecionar insere `@id ` no composer. Nenhum endpoint novo é necessário pra listagem.

## Feedback na conversa

Cada Run aceito (`201` de `POST /v1/runs`) vira uma linha inline discreta na conversa, ex.:

> → Run disparado: **revisor** — acompanhar no Team Studio

Erro ao criar o run (ex.: time oculto sem agente válido, mais provável se o agente citado foi apagado entre o autocomplete e o envio) vira uma linha de erro inline equivalente, sem travar nem desfazer o envio da mensagem pro chat normal.

## Testes

- `packages/shared`: schema de `TeamDef` aceita `origem` opcional.
- `apps/daemon/test/teams.test.ts` (ou novo): `listTeams` omite time com `origem: "mencao"`; `getTeam` continua enxergando.
- `apps/daemon`: função de upsert do time oculto — idempotente (duas chamadas pro mesmo agente não duplicam), agente inexistente dá erro claro.
- `apps/desktop/test`: parser de menções (extrai ids, remove do texto pro goal, ignora token que não casa com agente/time nenhum, mensagem só com menção cai no fallback de goal = mensagem crua).
