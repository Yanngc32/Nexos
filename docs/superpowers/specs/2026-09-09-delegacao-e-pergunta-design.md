# Nexo — delegação de subagente + modal de pergunta (design)

Data: 2026-09-09
Status: aprovado pelo usuário, aguardando plano de implementação

## Problema

Hoje, numa conversa normal, o modelo só pode CRIAR agente/time (`autoria.ts`) — nunca RODAR um.
Regra deliberada (ver `2026-09-08-mencao-agentes-times-design.md`): quem dispara Run é sempre a
pessoa, porque um Run gasta quota de verdade e pode escrever branch no repositório.

Isso tem dois efeitos que o usuário quer mudar:

1. **`@menção`** dispara um Run em paralelo, mas a conversa principal continua respondendo do
   jeito normal por cima — nada impede o modelo de fazer o MESMO trabalho que acabou de delegar
   (ex.: @menciona um agente pra investigar X, e o próprio modelo também sai grepando X). Gasto
   duplicado de token, sem coordenação nenhuma entre os dois.
2. **Sem jeito de perguntar.** Fora do Nexo, o Claude Code tem uma ferramenta (`AskUserQuestion`)
   pra pausar e perguntar algo à pessoa antes de decidir. Dentro do Nexo isso não existe em lugar
   nenhum — nem em conversa normal, nem em run de time/hook. Um agente incerto só pode: adivinhar,
   ou parar e escrever a dúvida em texto (sem estruturar opções, sem retomar automaticamente com a
   resposta).

## Objetivo

1. Uma ferramenta MCP genérica, `nexo_perguntar`, que qualquer conversa ou passo de Run pode
   chamar pra pausar, perguntar (múltipla escolha ou aberta) e retomar com a resposta — sem
   precisar reescrever o mecanismo pra cada caso de uso.
2. Uma ferramenta `nexo_delegar`, disponível em conversa NORMAL (não só em time supervisor), que
   chama um agente/time JÁ EXISTENTE e ESPERA o resultado antes do modelo continuar — delegação de
   verdade, não mais trabalho duplicado em paralelo.
3. `nexo_delegar` só existe conforme um **modo de delegação**, de 3 estados, configurável por
   conta: **Negado** (padrão, comportamento de hoje) / **Questionar** (cada chamada passa por
   `nexo_perguntar` antes de rodar) / **Liberado** (roda direto).
4. A execução de `nexo_delegar` (e do `nexo_chamar` que o supervisor já usa — mesmo mecanismo)
   aparece na conversa como uma bolha expansível com passos AO VIVO — um "subchat" — não só
   resultado final.

## Fora de escopo

- **Hooks continuam como estão.** `nexo.projeto-novo`/`git.post-commit`/etc. não ganham
  `nexo_delegar` nem mudam de fluxo — só a MEMÓRIA e o GRAFO automáticos, que já existem
  (2026-09-09-memoria-projeto-design.md). Este design mexe em conversa normal e nos passos de Run
  que já existiam (supervisor/pipeline/fanin).
- **`nexo_delegar` não cria agente/time.** Só aponta pra um `agentId`/`teamId` que já existe —
  criar continua sendo `nexo_agente_salvar`/`nexo_time_salvar`, ferramenta separada.
- **Sem recursão.** Um agente/time chamado via `nexo_delegar` NUNCA ganha `nexo_delegar` de volta
  — elimina qualquer cadeia A→B→A de propósito, não é um "teto configurável", é hard-coded off.
- **Sem retomar depois do teto do turno.** `TURNO_TETO_MS` (15 min, `packages/shared/src/index.ts`)
  já é o teto de QUALQUER turno hoje. `nexo_perguntar` não estica isso — se ninguém responder
  dentro do turno, a chamada estoura o mesmo jeito que qualquer ferramenta travada estouraria hoje,
  e o Run/turno termina em erro de timeout. Pra um hook disparado de madrugada, isso quer dizer que
  a pergunta só tem ~15 minutos de janela pra alguém responder — não "fica pendente até alguém
  abrir o Nexo horas depois". Documentar isso é MELHOR que fingir um mecanismo que a arquitetura
  atual não sustenta.

## `nexo_perguntar`: mecanismo de pausa

Ferramenta MCP, escopo por **`threadId`** (não por `runId`) — é o denominador comum entre conversa
normal (só tem thread) e passo de Run (tem thread E run, `executarPasso` já cria uma thread por
passo). Entra na MESMA boca que já serve `nexo_grafo_*`/`nexo_veredito` (`/v1/mcp`, com `threadId`
somado à URL igual `runId` já é hoje — ver `caminhoDaAutoria`, mcp.ts).

**Args**: `{ pergunta: string, opcoes?: string[] }`. Sem `opcoes` = resposta aberta (texto livre);
com `opcoes` = múltipla escolha — mas `opcoes` é só dica de RENDERIZAÇÃO (a UI desenha botão por
opção); o endpoint de resposta aceita texto livre de qualquer jeito, não valida contra a lista.

**Fluxo**:
1. `executar` grava e emite um evento novo `{ type: "pergunta", id, threadId, texto, opcoes? }` —
   mesmo par `appendEvent`+`emit` que `session.ts` já usa pra `tool`/`tool_result` — ANTES de
   esperar a resposta, pra a UI mostrar a pergunta na hora, não só depois de tudo resolver.
2. `executar` então `await` uma Promise pendente (registrada num `Map<threadId, resolver>`,
   mesmo padrão de `registrarVeredito`/`consumirVeredito` em `veredito.ts`, só que aqui é o
   HUMANO resolvendo, não o agente).
3. Novo endpoint `POST /v1/perguntas/:threadId/responder` — corpo `{ resposta: string }` — resolve
   a Promise pendente daquele thread. Grava e emite `{ type: "pergunta_resposta", id, threadId,
   resposta }` (par do evento 1, mesma lógica de correlação por `id` que `tool`/`tool_result`).
4. `executar` retorna a resposta como texto da ferramenta — o modelo recebe e continua o turno.

**UI**: a pergunta aparece como uma bolha própria na conversa (texto + botões, se `opcoes`; campo
de texto, se aberta) — só isso já cobre "tá com a conversa aberta". Pra descobrir sem estar
olhando: o mesmo badge que já conta "agentes rodando" (`#agents-badge`) ganha uma contagem de
perguntas pendentes, clicável, sem precisar estar na conversa certa pra saber que existe.

## `nexo_delegar`: delegação de verdade

Mesma mecânica que o supervisor já usa (`nexo_chamar`, `ferramentasDoSupervisor`, mcp.ts) —
generalizada pra conversa normal em vez de só dentro de um time supervisor rodando.

**Args**: `{ agentId?: string, teamId?: string, pedido: string }` (um dos dois, igual `RegraHook`
já decidiu pra hooks). Roda via `criarRun`+`executarRun` (mesmo motor de sempre), aguarda o passo
terminar, devolve o resultado como texto da ferramenta.

**Guarda-corpos** (hard-coded, não configurável):
- Só aceita `agentId`/`teamId` que já existe — sem criar no meio do caminho.
- O agente/time chamado NÃO ganha `nexo_delegar` no próprio pack — corta a cadeia na raiz.
- Teto de 3 chamadas de `nexo_delegar` por turno (contador por thread, resetado a cada mensagem).

## Modo de delegação — 3 estados, por conta

Mesmo lugar que "Ferramentas liberadas" hoje (Configurações → Contas). Novo campo no `Profile`
(`packages/shared/src/index.ts`): `delegacaoModo: "negado" | "questionar" | "liberado"`, padrão
`"negado"`.

- **Negado**: `nexo_delegar` nem entra no `Conjunto` da conversa — igual hoje.
- **Questionar**: a ferramenta existe, mas `executar` chama `nexo_perguntar` internamente
  ("Delegar pra `<agente/time>`: `<pedido>`? (sim/não)") ANTES de rodar de verdade. Resposta
  diferente de "sim" cancela sem gastar run nenhum.
- **Liberado**: roda direto.

## Subchat inline

A bolha de `nexo_delegar`/`nexo_chamar` na conversa vira uma versão "ao vivo" da bolha expansível
que já existe pra ferramenta comum (`tool`/`tool_result`, sessão anterior): em vez de só
argumentos+resultado final, mostra os PASSOS do Run conforme acontecem (reaproveita os eventos que
`team-studio.js`/`run-view.js` já sabem desenhar pra execução de time — é a mesma barra de passos,
só que dentro de uma bolha de chat em vez de na tela cheia de Times).

## Testes

- `nexo_perguntar`: emite o par de eventos certo, `POST /v1/perguntas/:threadId/responder` resolve
  a Promise pendente, resposta chega como texto da ferramenta; sem responder dentro do teto do
  turno, a ferramenta estoura como qualquer tool-call travada (não trava o processo).
- `nexo_delegar`: só aparece no `Conjunto` quando `delegacaoModo !== "negado"`; modo `questionar`
  chama `nexo_perguntar` antes de rodar e respeita a resposta; modo `liberado` roda direto; agente
  delegado nunca ganha `nexo_delegar` de volta; teto de 3 por turno é respeitado (4ª chamada no
  mesmo turno é recusada).
- UI: bolha de pergunta renderiza corretamente (múltipla escolha e aberta); badge conta perguntas
  pendentes; subchat mostra passos ao vivo, não só resultado final.
