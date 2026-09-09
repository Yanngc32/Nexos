# Nexo — memória persistente de projeto (design)

Data: 2026-09-09
Status: aprovado pelo usuário, aguardando plano de implementação

**Revisão**: a seção "Nexo Hooks" original (instalação manual via `nexo hook install`,
config por projeto) foi substituída pelo desenho abaixo ("Hooks v2") depois do usuário pedir
que hooks fossem uma feature configurável dentro do app, com escopo global e capacidade de
BARRAR um push (gate de segurança), não só notificar. Memória de projeto, `graphify.ts` e a
injeção de `MEMORIA.md` no pack não mudaram.

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
  genérico (não hardcoded só pra git), mas os únicos eventos implementados agora são
  `git.post-commit`, `git.post-push` e `git.pre-push`.
- **Condição além de branch** — sem filtro por autor, por arquivo alterado, etc. Só
  "qual branch está sendo empurrada" (relevante pros dois eventos de push).
- **Múltiplos vereditos combinados** (ex.: exigir maioria de vários agentes) — uma regra
  `pre-push` reprovando já barra; não há "2 de 3 aprovam".
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

## Hooks v2: regra configurável, escopo global ou por projeto

### Modelo de dados

`~/.nexo/hooks.json` vira uma LISTA de regras (não mais indexado por projeto):

```json
{
  "rules": [
    {
      "id": "r-8f2a",
      "escopo": { "tipo": "projeto", "projectPath": "C:/Users/.../Dilegno" },
      "evento": "git.post-commit",
      "agentId": "memoria"
    },
    {
      "id": "r-c910",
      "escopo": { "tipo": "global" },
      "evento": "git.pre-push",
      "branch": "main",
      "agentId": "seguranca"
    }
  ]
}
```

- `evento`: `"git.post-commit" | "git.post-push" | "git.pre-push"`.
- `branch`: opcional, nome exato (não glob) — só faz sentido nos dois eventos de push;
  vazio/ausente = qualquer branch. Em `post-commit` o campo é ignorado mesmo que venha
  preenchido (commit não tem branch remota, é sempre local) — a UI nem mostra o campo pra
  esse evento, mas o backend não confia só nisso.
- Quem BLOQUEIA é o evento, não um campo à parte: `pre-push` roda ANTES do push existir no
  remoto (dá pra abortar); `post-commit`/`post-push` já aconteceram — só notificam.
- CRUD via funções em `hooks.ts` (`listarRegras`, `criarRegra`, `atualizarRegra`,
  `apagarRegra`, todas em `home`) e endpoints `GET/POST/PUT/DELETE /v1/hooks/rules[/:id]`,
  autenticados como toda `/v1/*`. A UI (ver seção própria) consome esses endpoints.

### Despacho

`fireHook(event, projectPath, branch, home)` em `apps/daemon/src/hooks.ts`: acha as regras
que casam (escopo global OU escopo do projeto certo) E (evento igual) E (branch vazio na
regra OU branch bate) — pode haver mais de uma regra casando (ex.: uma global de segurança +
uma do projeto). Pra `post-commit`/`post-push` roda todas em paralelo, fire-and-forget
(coalescido por projeto+evento — ver abaixo). Pra `pre-push` roda em SÉRIE, síncrono, parando
na primeira reprovação (ver "Fluxo bloqueante").

**Endpoint de disparo**: `POST /v1/hooks/fire` — body `{ event, projectPath, branch? }`.
Só aceita `event` batendo com `/^[a-z]+\.[a-z-]+$/`. Pra `pre-push` a resposta HTTP só
volta depois do agente terminar (ou do teto de turno estourar) — é essa espera que faz o
script do git segurar o push.

### Sincronização automática dos scripts de git (sem comando manual)

Nada de `nexo hook install` como passo que a pessoa lembra de rodar. Uma função
`sincronizarHooksDoProjeto(projectPath, home)`:

1. Calcula quais eventos (`post-commit`/`post-push`/`pre-push`) este projeto precisa, olhando
   as regras cujo escopo é `global` OU é este projeto.
2. Pra cada evento necessário, garante a linha em `.git/hooks/<arquivo>` (reaproveita
   `installGitHookScript`, já escrito). Pra evento que NINGUÉM mais pede (regra apagada), tira
   a linha (`uninstallGitHookScript`, novo — contraparte simétrica).

Disparada em dois momentos:

- **Regra criada/editada/apagada**: se o escopo é `projeto`, resincroniza só ele; se é
  `global`, resincroniza TODOS os projetos que o Nexo conhece — mesma lista que
  `GET /v1/projects` já calcula (`config.repos` ∪ projetos das conversas gravadas,
  `projectsFromThreads`), reexportada de onde já existe hoje.
- **Projeto novo aberto/adicionado**: resincroniza só ele (cobre as regras globais e as que
  já existiam de escopo `projeto` pra caminhos que a pessoa reabriu depois).

Regra `global` vale em TODO projeto sem exceção — não existe toggle de "ignorar hook global"
por projeto (decisão deliberada: um gate de segurança que dá pra desligar por projeto já
nasce fraco).

### Fluxo bloqueante (`git.pre-push`) e o veredito

1. Script `pre-push` instalado pelo Nexo lê o stdin que o `git` manda nesse hook (uma linha
   por ref sendo empurrada: `<local ref> <local sha> <remote ref> <remote sha>`), extrai o(s)
   nome(s) de branch do `remote ref`, e chama `nexo hook fire git.pre-push --branch <nome>`
   (novo modo do subcomando `nexo hook fire` já existente — aguarda a resposta em vez de
   disparar e sair).
2. O CLI faz `POST /v1/hooks/fire` e esse endpoint, pra `pre-push`, RODA o run de verdade
   (não fire-and-forget): `upsertTimeDeHook` + `criarRun` + `executarRun`, esperado.
3. Esse run ganha uma ferramenta MCP presa a ELE (mesmo mecanismo por-run que o supervisor já
   usa — `configDeMcp(porta, token, runId)`): `nexo_veredito({ aprovado: boolean, motivo:
   string })`. O agente é instruído a SEMPRE chamá-la no fim.
4. Se o run terminar sem o agente ter chamado `nexo_veredito`, o veredito default é
   **reprovado** com motivo `"agente não declarou veredito"` — falha FECHADA, não aberta.
   Múltiplas regras casando: roda uma de cada vez, na ordem; qualquer reprovação para a
   série ali (as seguintes nem rodam) e já barra o push; só libera se TODAS aprovarem.
5. O CLI recebe `{ aprovado, motivo }` do endpoint e sai com código `0` (libera o push) ou
   `1` (barra), imprimindo `motivo` em stderr — é isso que a pessoa vê no terminal do `git
   push` quando é barrada.

### Agente de exemplo: "memória" (post-commit, escopo projeto)

Continua exatamente como no desenho original: instructions de ler `git diff` +
`GRAPH_REPORT.md` e atualizar `MEMORIA.md` (ver seção "Uso no turno" abaixo). A diferença é
só COMO a regra nasce agora — pela tela de Hooks (escopo "este projeto", evento
`git.post-commit`, agente `memoria`), não mais por `nexo hook install`. Se o agente
`memoria` ainda não existe quando a regra é criada, a UI pede a conta (perfil) que ele vai
usar e cria o `AgentDef` na hora, com as instructions padrão.

`agentId` de qualquer regra reaproveita o MESMO mecanismo de time oculto pipeline-de-1 que a
`@menção` de agente avulso já criou (`teams.ts`, `origem: "mencao"` — ver spec
[2026-09-08-mencao-agentes-times-design.md](2026-09-08-mencao-agentes-times-design.md)):
upsert de um time `hook-<agentId>` de 1 membro, disparado via o mesmo `criarRun`/
`executarRun` que o Team Studio e a `@menção` já usam. Nenhum primitivo de execução novo.

Implica dois ajustes pequenos em `teams.ts`: `TeamDef.origem` (hoje só `"mencao"`) vira
`"mencao" | "hook"`, e o filtro de `listTeams` (`t.origem !== "mencao"`) vira `!t.origem` —
esconde da tela de Times QUALQUER time de origem automática, não só o de menção.

**Coalescência** (só `post-commit`/`post-push`, que são fire-and-forget): `hooks.ts` mantém
um `Set<string>` de `projeto::evento` com execução em voo. Fire que chega enquanto já tem um
rodando pra aquele par não dispara outro — marca um flag `pendente`; ao terminar, se
`pendente` estava marcado, dispara de novo uma vez (o diff mais recente ainda é lido do zero
na próxima rodada, então cobre tudo que chegou no meio). `pre-push` não coalesce — é
síncrono, cada `git push` espera o seu.

### graphify: checagem/instalação automática

`ensureGraphifyInstalled()` em `graphify.ts`: roda `graphify --version`; se não achar,
tenta `uv tool install graphifyy` e, sem `uv`, `pip install graphifyy`; loga o resultado (uma
linha, sucesso ou falha) sem lançar erro — nunca impede o daemon de subir nem a regra de ser
salva. Chamada em dois pontos: (1) no boot do daemon (`cmdUp`, uma vez, em paralelo ao resto
da subida, sem esperar por ela); (2) quando uma regra com evento `post-commit`/`post-push` e
agente que produz memória de projeto é criada pela UI (best-effort, mesmo padrão).

### UI: tela "Hooks"

Tela nova no desktop, mesmo nível de Team Studio/Agent Studio: tabela de regras (escopo,
evento, branch, agente), botão "+ Nova regra" abrindo formulário (escopo: Global ou
dropdown com os projetos conhecidos; evento: post-commit/post-push/pre-push; branch: campo
texto, só habilitado pros eventos de push; agente: dropdown dos agentes existentes, com
opção de criar um novo ali). Editar/apagar reusam os mesmos endpoints CRUD. Nenhuma tela
nova pro "veredito" — ele só aparece no terminal de quem deu `git push` (motivo do
`nexo_veredito`), não dentro do Nexo.

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

- `apps/daemon/test/hooks.test.ts`: CRUD de regra; `fireHook` casa escopo (global E projeto)
  × evento × branch corretamente; evento sem regra nenhuma não faz nada; nome de evento fora
  do padrão é recusado; coalescência de `post-commit`/`post-push` (dois fires em sequência
  rápida = um run só, com re-run agendado); `pre-push` roda em série e para na primeira
  reprovação; agente que não chama `nexo_veredito` reprova por padrão; erro dentro da
  execução não vira unhandled rejection (loga e libera o estado "em voo").
- `apps/daemon/test`: `sincronizarHooksDoProjeto` — regra de projeto só mexe naquele
  projeto; regra global mexe em TODOS os conhecidos; remover a última regra de um evento tira
  a linha do script (`uninstallGitHookScript`); projeto novo aberto puxa as regras globais já
  existentes sozinho.
- `apps/daemon/test`: `nexo_veredito` (ferramenta MCP por-run) grava o veredito só pro run
  dela, não vaza pra outro run concorrente.
- `apps/daemon/test`: `memoriaDir` resolve pro default ou pro que `config.json` declarar;
  hash do projeto é estável (mesmo path sempre dá o mesmo hash) e diferente projetos não
  colidem.
- `apps/daemon/test`: `.gitignore` do projeto ganha `graphify-out/` na primeira vez, e não
  duplica se já tiver a entrada.
- `apps/daemon/test`: pack da conversa inclui `MEMORIA.md` quando existe, e não quebra
  quando não existe.
- `apps/daemon/test`: ferramentas MCP de `graphify query`/`explain` — presentes só quando
  `graphify-out/graph.json` existe; ausentes (sem erro) quando não existe.
- `apps/daemon/test`: `ensureGraphifyInstalled` nunca lança, mesmo sem `uv`/`pip` no PATH.
- `apps/desktop/test`: tela Hooks — lista, cria regra (global e de projeto), edita, apaga;
  campo branch desabilitado pra `post-commit`.
