---
name: nexo-times
description: Montar agentes, times e Nexo Hooks no Nexo. Use quando o pedido envolver criar/ajustar um agente, montar um time, escolher entre pipeline, fan-in e supervisor, disparar algo sozinho quando um evento acontecer (commit, push, projeto novo), ou quando um trabalho for grande o bastante pra valer dividir entre agentes em vez de fazer sozinho.
---

# Montar agentes, times e hooks no Nexo

As ferramentas `nexo_contexto`, `nexo_agente_salvar`, `nexo_time_salvar`,
`nexo_hook_salvar` e `nexo_hook_listar` (MCP, servidor `nexo`) já descrevem os
campos e as regras. Esta skill é a parte que elas não cabem: **quando** vale
montar um time ou uma regra, e o que faz cada um ser bom.

Se as ferramentas não estiverem disponíveis, é porque o Nexo só liga MCP em
conta `claude`. Diga isso e pare aí. Não tente editar `~/.nexo/agents.json` nem
`teams.json` na mão: nada valida o que você escrever, e uma escrita do daemon
entre a sua leitura e a sua gravação leva sua edição embora sem avisar.

## Primeiro: vale a pena?

Na maioria dos pedidos, **não**. Você resolve mais rápido e mais barato fazendo
o trabalho. Um time só ganha de você em três situações:

1. **Leituras independentes do mesmo código.** Três pareceres sobre a mesma
   mudança (segurança, desempenho, legibilidade) valem mais separados do que
   uma passada sua tentando ver tudo de uma vez.
2. **Volume que não cabe num turno.** Vinte arquivos pra migrar com a mesma
   regra: dividir é o que impede o contexto de estourar no meio.
3. **Caminho que não dá pra escrever antes.** Investigar um bug cuja causa
   ninguém sabe: a próxima ação depende do que a anterior achou.

Se o pedido não é um desses, faça o trabalho. Montar time pra tarefa pequena
gasta a quota da pessoa pra entregar mais devagar o mesmo resultado.

## Qual topologia

| se o trabalho é | use | por quê |
| --- | --- | --- |
| escrever e depois revisar | `pipeline` | a saída de um é a entrada do próximo |
| N olhares sobre a mesma coisa | `fanin` | rodam juntos; o último junta |
| descobrir enquanto anda | `supervisor` | ele decide a cada rodada |

**`fanin` fora de repositório git é perigoso**: sem git não há árvore de
trabalho separada, os membros dividem a pasta e se atropelam se escreverem
arquivo. Em projeto sem git, use `fanin` só com membros que LEEM.

**`supervisor` é o mais caro.** No canal `turno` (padrão) cada decisão custa um
turno inteiro, e é ele quem escolhe quantas rodadas vão acontecer. Só use
quando o caminho realmente não dá pra escrever antes — e nesse caso diga à
pessoa pra pôr `maxSteps` no orçamento.

## O que faz um agente ser útil

O `instructions` é o agente. Sem ele você criou um apelido, não um papel.

- **Diga o que ele NÃO faz.** "Você revisa e aponta; não edita arquivo" evita
  dois membros escrevendo no mesmo lugar.
- **Diga o formato da saída**, porque ela é a entrada do próximo membro num
  `pipeline`. "Liste achados como `arquivo:linha — problema`" vale mais que
  "seja claro".
- **Um papel por agente.** "Escritor e revisor" é um agente que vai revisar o
  próprio texto, o que é exatamente o que o time existia pra evitar.
- **Reaproveite antes de criar.** `nexo_contexto` primeiro: um agente com o
  papel certo já existente é melhor que um quase igual com id novo.

## Depois de criar

Criar **não executa**. Diga à pessoa, em uma linha, o que você montou e que o
run é o clique dela — com `maxSteps` se for supervisor. Não prometa resultado
de trabalho que ainda não rodou.

## Nexo Hooks: disparar sozinho quando algo acontece

`nexo_hook_salvar` cria uma regra que dispara um agente OU um time (`agentId`
ou `teamId`, nunca os dois) sozinho quando `git.post-commit`, `git.post-push`,
`git.pre-push` ou `nexo.projeto-novo` (primeira vez que o projeto abre no
Nexo) acontecem — sem ninguém pedir de novo. `nexo_hook_listar` mostra as
regras que já existem; confira antes de criar outra igual.

Vale a pena quando o gatilho é o EVENTO, não a conversa: "sempre que eu der
commit, atualize X" é hook; "faça X agora" é você trabalhando direto, sem
regra nenhuma.

**Você não consegue criar regra bloqueante.** `nexo_hook_salvar` recusa
`bloqueante: true` de propósito — isso trava o `git push` de quem casar com a
regra até alguém desligar na tela Hooks, e esse único botão fica só com a
pessoa. Se o pedido for "barre o push se X", diga que criou a regra
NÃO-bloqueante (só avisa) e que ligar o bloqueio é ela quem faz, na tela.
