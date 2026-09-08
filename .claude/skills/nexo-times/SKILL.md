---
name: nexo-times
description: Montar agentes, times e supervisores no Nexo. Use quando o pedido envolver criar/ajustar um agente, montar um time, escolher entre pipeline, fan-in e supervisor, ou quando um trabalho for grande o bastante pra valer dividir entre agentes em vez de fazer sozinho.
---

# Montar agentes e times no Nexo

As ferramentas `nexo_contexto`, `nexo_agente_salvar` e `nexo_time_salvar` (MCP,
servidor `nexo`) já descrevem os campos e as regras. Esta skill é a parte que
elas não cabem: **quando** vale montar um time, e o que faz um time ser bom.

Se as ferramentas não estiverem disponíveis, a conta desta conversa não é
`claude` — só ela fala MCP. Diga isso em vez de tentar editar `~/.nexo/*.json`
na mão: o daemon tem os arquivos em memória e sobrescreveria sua edição.

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
