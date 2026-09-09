# Nexo — memória persistente de projeto (design)

Data: 2026-09-09
Status: aprovado pelo usuário, aguardando plano de implementação

## Problema

Todo agente/time que abre um projeto começa do zero: sem saber onde ficam os models, as
rotas, as convenções, ele remapeia o repositório inteiro via `grep`/`Read` antes de fazer
qualquer trabalho de verdade. Num run de time (vários agentes no mesmo projeto), cada
membro repete essa varredura por conta própria — foi o que aconteceu no run "Tech lead" +
"Product manager" do projeto Dilegno: 93 chamadas de ferramenta, boa parte redundante entre
os dois agentes remapeando o mesmo backend/frontend.

Isso é agravado (não causado) pelo bug de perda de contexto corrigido em
[session.ts](../../../apps/daemon/src/session.ts) nesta mesma sessão — mesmo com esse bug
corrigido, o conhecimento de projeto não sobrevive entre CONVERSAS/runs diferentes, só
dentro de uma. Não existe hoje nenhum mecanismo de memória entre conversas.

## Objetivo

Cada projeto ganha uma memória durável, escrita automaticamente após commit/push, e
disponível pra qualquer conversa/run futuro naquele projeto — sem o usuário mexer em nada
manualmente no dia a dia.

## Fora de escopo

- **Memória de usuário/preferência pessoal** (ex.: "sempre usa RTK", "responde em
  caveman") — problema separado, registrado aqui só pra não ser esquecido, não desenhado
  nesta spec.
- **Sync automático entre PCs feito pelo Nexo** — a solução é apontar
  `memoriaDir` pra uma pasta já sincronizada (Drive, etc.); o Nexo não implementa
  transporte de sync próprio.
- **Hooks pra eventos além de git** (`run.done`, `thread.created`, ...) — o despacho é
  genérico (não hardcoded só pra git), mas nenhum consumidor além de
  `git.post-commit`/`git.post-push` é implementado agora.
- **Reconstrução do grafo estrutural do graphify** — reaproveita `graphify hook install`
  (mecanismo próprio do graphify, AST puro, sem LLM) em vez de reimplementar.

## Por que a memória não pode morar no projeto

Projetos do usuário podem ser open-source. Notas de memória (decisões, causas-raiz,
convenções internas) não podem arriscar ir num `git push` de um repositório público. Por
isso:

- `MEMORIA.md` (o que este design escreve) vive **fora** do projeto, em
  `~/.nexo/memoria/<hash>/`.
- `graphify-out/` (gerado pelo `graphify`, que exige escrever relativo ao cwd) continua
  **dentro** do projeto — é regenerável do código (não é segredo tão grave quanto memória
  curada), mas o daemon garante que ele entra no `.gitignore` do projeto na primeira vez
  que liga isso, pra nunca ser commitado por acidente.

## Armazenamento

```
~/.nexo/memoria/<hash>/
  meta.json     — { "projectPath": "<caminho real>" }
  MEMORIA.md    — fatos escritos pelo agente "memória"
```

`<hash>` = sha1 de `projectKey(projectPath)` (a mesma normalização já usada em
`services.ts`: resolve, barra normalizada, minúsculo) — precisa ser hash porque
`projectPath` tem barra e não serve de nome de pasta direto. `meta.json` guarda o caminho
real pra o hash não virar caixa-preta (ex.: listar memórias existentes, ferramenta de
diagnóstico).

Raiz configurável: `config.json` ganha `memoriaDir?: string` (default
`join(home, "memoria")`). Apontar pra uma pasta dentro de uma sincronizada (Drive, etc.) é
o mecanismo de "memória entre PCs" — nenhum código de sync no Nexo.

## Nexo Hooks

Despacho genérico de evento → ação, não hardcoded só pra memória de projeto (mesmo que o
único consumidor de hoje seja esse).

**Config** (`~/.nexo/hooks.json`):

```json
{
  "<projectPath>": {
    "git.post-commit": [{ "action": "run-agent", "agentId": "memoria" }],
    "git.post-push": [{ "action": "run-agent", "agentId": "memoria" }]
  }
}
```

**Despacho** (`apps/daemon/src/hooks.ts`): um `EventEmitter` próprio (irmão do `sessionBus`
que já existe em `session.ts`), com uma função `fireHook(event, projectPath, home)` que lê
`hooks.json`, acha as ações configuradas pra aquele projeto+evento, e executa cada uma. A
única ação implementada agora é `run-agent`: dispara um run de 1 passo do agente indicado,
igual o que `criarRun`/`executarRun` (`runs.ts`) já fazem — sem motor novo.

**Endpoint**: `POST /v1/hooks/fire` — body `{ event: string, projectPath: string }`,
autenticado com o bearer token do daemon (mesmo de toda `/v1/*`). Só aceita
`event` que bata com `/^[a-z]+\.[a-z-]+$/` (evita injeção de nome de ação arbitrária vinda
de um script comprometido).

**Gatilho git**: `nexo hook install <path>` (novo subcomando CLI) escreve/anexa em
`<path>/.git/hooks/post-commit` e `post-push` uma linha que chama
`curl -s -m 5 -X POST http://127.0.0.1:<porta>/v1/hooks/fire -H "Authorization: Bearer
<token>" -d '{"event":"git.post-commit","projectPath":"<path>"}' || true` — o `|| true`
(e o timeout de 5s) garante que `git commit`/`git push` nunca falha ou trava por causa do
Nexo estar fechado ou lento. Porta e token lidos de `~/.nexo/config.json` e
`~/.nexo/daemon.token` no momento da instalação (mesmo padrão que `graphify hook install`
já usa pra AST, só que chamando o Nexo em vez do graphify direto). Se já existir um
post-commit/post-push, anexa (não substitui) — mesma regra do graphify.

## Agente "memória"

Entrada nova em `agents.json` (criada automaticamente na primeira vez que
`nexo hook install` roda num projeto, se ainda não existir): conta barata (ex. `haiku`),
instructions:

> Leia o `git diff` desde a última vez que você atualizou a memória deste projeto (o hash
> do commit fica no fim do `MEMORIA.md` atual, se existir) e o `graphify-out/GRAPH_REPORT.md`
> se existir. Escreva/atualize `MEMORIA.md` só com fatos NOVOS ou DIFERENTES do que já está
> lá — arquitetura, convenção, decisão não-óbvia, causa-raiz de bug corrigido. Não resuma o
> diff linha a linha. Termine o arquivo com uma linha `<!-- commit: <hash> -->` marcando até
> onde você leu.

A ação `run-agent` do hook reaproveita o MESMO mecanismo de time oculto pipeline-de-1 que a
`@menção` de agente avulso já criou (`teams.ts`, `origem: "mencao"` — ver spec
[2026-09-08-mencao-agentes-times-design.md](2026-09-08-mencao-agentes-times-design.md)):
upsert de um time `hook-<agentId>` de 1 membro, disparado via o mesmo `criarRun`/
`executarRun` que o Team Studio e a `@menção` já usam. Nenhum primitivo de execução novo —
só mais uma origem que upserta um time oculto e chama o run.

Implica dois ajustes pequenos em `teams.ts`: `TeamDef.origem` (hoje só `"mencao"`) vira
`"mencao" | "hook"`, e o filtro de `listTeams` (`t.origem !== "mencao"`) vira `!t.origem` —
esconde da tela de Times QUALQUER time de origem automática, não só o de menção.

**Coalescência**: `hooks.ts` mantém um `Set<string>` de projetos com o agente memória em
voo. Fire que chega enquanto já tem um rodando pra aquele projeto não dispara outro — marca
um flag `pendente`; ao terminar, se `pendente` estava marcado, dispara de novo uma vez (git
diff mais recente ainda é lido do zero, então cobre os commits que chegaram no meio).

## Uso no turno

- `MEMORIA.md` do projeto (se existir) entra no pack de TODA conversa daquele projeto, no
  mesmo lugar que `withInstructions` já injeta instrução de agente
  ([session.ts](../../../apps/daemon/src/session.ts)) — antes do histórico, sempre presente,
  sem precisar de ferramenta.
- `graphify query "<pergunta>"` e `graphify explain "<nó>"` viram ferramentas MCP do daemon
  (mesmo `/v1/mcp` HTTP que as ferramentas de autoria já usam — nenhum transporte novo),
  disponíveis em qualquer conversa do projeto quando `graphify-out/graph.json` existe.
  Implementado como mais um `Conjunto` (`apps/daemon/src/mcp.ts`), rodando o CLI `graphify`
  como subprocesso curto por chamada, cwd no projeto.

## Testes

- `apps/daemon/test/hooks.test.ts` (novo): `fireHook` acha e roda a ação configurada;
  evento sem config nenhuma não faz nada (não é erro); nome de evento fora do padrão é
  recusado; coalescência (dois fires em sequência rápida = um run só, com re-run agendado).
- `apps/daemon/test`: `memoriaDir` resolve pro default ou pro que `config.json` declarar;
  hash do projeto é estável (mesmo path sempre dá o mesmo hash) e diferente projetos não
  colidem.
- `apps/daemon/test`: `.gitignore` do projeto ganha `graphify-out/` na primeira vez, e não
  duplica se já tiver a entrada.
- `apps/daemon/test`: pack da conversa inclui `MEMORIA.md` quando existe, e não quebra
  quando não existe.
- `apps/daemon/test`: ferramentas MCP de `graphify query`/`explain` — presentes só quando
  `graphify-out/graph.json` existe; ausentes (sem erro) quando não existe.
