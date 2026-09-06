# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado

- Daemon HTTP (Hono) em `127.0.0.1`, com token bearer sorteado a cada subida e gravado em
  `~/.nexo/daemon.token` (modo `0600`).
- Motores de agente: `claude` e `codex` (CLI local), `api` (chave do provedor) e `stub` (testes).
- Perfis de conta isolados em `~/.nexo/profiles/<id>/`, com login por CLI, import da credencial
  global do Claude e fallback ordenado entre contas.
- Histórico de conversa em JSONL por thread, com corte de contexto (`/clear`), troca de conta no
  meio do turno (`switch`) e packer de contexto com teto de tokens por motor.
- Anexos de imagem por thread, servidos de volta pelo daemon pro chat renderizar o histórico.
- Relatório de uso por thread e painel de limites por conta.
- Agentes personalizados (nome, cor, conta padrão) e painel de agentes ativos.
- Gestão de serviços locais do projeto via `nexo.json`: start/stop/restart, logs, autostart
  atrelado a projeto marcado como confiável e sonda HTTP de URL.
- App Electron: árvore de arquivos, terminal, browser/preview, canvas, chat lateral, paleta de
  comandos, configurações (aparência, contas, fallback) e pet animado.
- CLI `nexo`: `up`, `down`, `profile`, `login`, `svc`, `thread`, `chat`, `switch`.
- Windows: `run.bat` (instala dependências e abre o app) e `make-shortcut.ps1` (atalho sem console).
- Licença MIT e README.
- CI no GitHub Actions: `pnpm typecheck` + `pnpm test` em Linux e Windows, Node 20 e 22.
- Scripts `pnpm typecheck` (por pacote, agregado na raiz) e `pnpm check` (typecheck + testes).
- Primeiros testes do app: `apps/desktop/markdown.js` saiu do `renderer.js` pra módulo próprio e
  ganhou 21 casos (`pnpm --filter @nexo/desktop test`), com foco em injeção — tag do modelo vira
  texto, `javascript:`/`data:`/`file:` não viram âncora, aspas não escapam do `href`, bloco de
  código é escapado. É o ponto onde texto do modelo vira HTML na janela; o CSP é a segunda linha
  de defesa, a primeira é escapar antes de formatar, e agora existe teste que trava essa ordem.
  `pnpm test` na raiz passou a rodar os dois pacotes.
- Mais dois módulos saídos do `renderer.js`, também só recorte: `format.js` (helpers puros de
  exibição e normalização de caminho) e `url.js` (`safeUrl`/`portaDaUrl`). `safeUrl` decide o que
  o iframe do preview carrega — o CSP deixa `frame-src` largo de propósito, então quem barra
  `javascript:` e `file:` é ela. 58 casos no app ao todo; os que caem em `toLocaleString` checam a
  forma e não o literal, porque o texto varia com a versão do ICU entre os jobs do CI.
- Topologia `supervisor` no time: o PRIMEIRO membro não trabalha — ele decide, a cada rodada, qual
  dos outros chamar e com que pedido, até dizer que acabou. A lista de passos deixa de sair pronta
  do `criarRun`: nasce só com o dele, e os demais são anexados durante o run (evento `step_add`).
  **Não é MCP, de propósito.** O supervisor não age no meio do turno dele: responde a ordem em JSON,
  o turno fecha, o daemon chama o membro e volta com o resultado no turno seguinte da MESMA conversa
  — então ele lembra do que já mandou fazer sem o daemon reenviar histórico. Custa um turno por
  decisão; em troca roda em qualquer motor, inclusive nos que não falam MCP (`api`, `stub`), sem
  processo novo nem credencial saindo do daemon. MCP passa a ser otimização, não pré-requisito.
  Três decisões que o código registra:
  - **Formato fechado, leitura tolerante.** Cerca de código, texto em volta e exemplo antes da
    resposta são aceitos (pega o último objeto balanceado); id de membro fora do time é RECUSADO,
    porque adivinhar quem ele quis dizer é pior que perguntar. Resposta inutilizável ganha uma
    correção — uma, não zero (derrubar o run por formatação desperdiçaria o que já foi gasto) e não
    N (insistir depois do pedido de correção na mão só queima quota).
  - **Falha de membro volta pro supervisor**, e não derruba o run: quem tem contexto pra decidir o
    que fazer com ela é ele. É o oposto do pipeline, onde não há ninguém pra decidir.
  - **O teto de passos é a única trava contra o laço**: o supervisor pode chamar o mesmo membro pra
    sempre. Ele vê quantas chamadas restam a cada turno, e o run para no teto mesmo que ele não
    queira parar.
  Time de supervisor exige pelo menos um membro além dele — sozinho, o run morreria no primeiro
  turno depois de já ter gasto esse turno. A tela mostra `sup` no lugar do número, avisa que o custo
  não sai da contagem de membros, e o texto sobre o que a ORDEM da lista significa passou a mudar
  com a topologia (dizia só o do pipeline, o que já era falso no fan-in).
- Isolamento por `git worktree` nos membros paralelos do fan-in: cada um ganha uma árvore própria
  do repositório, num branch `nexo/<run>/<n>-<agente>`, então dois agentes escrevendo o mesmo
  arquivo ao mesmo tempo deixaram de se destruir. A árvore sai do disco no fim do run; o branch
  fica, com o trabalho commitado — sem isso o `worktree remove --force` levaria a mudança junto e o
  branch existiria vazio. Nada é mesclado automaticamente.
  Só no fan-in: no pipeline, compartilhar a árvore costuma ser o ponto — se o primeiro escreve e o
  segundo revisa, separá-los faria o revisor não enxergar nada. Projeto sem git (ou sem commit)
  roda igual, sem isolar, e o run registra o motivo em `isolationOff` em vez de fingir que isolou.
- Topologia `fanin` no time: todos os membros menos o último rodam AO MESMO TEMPO, e o último
  recebe a saída de todos — cada uma identificada por quem produziu, senão o agregador não teria
  como saber quem disse o quê. Quem agrega é o último da lista; a ordem continua sendo a semântica.
  Falha de um paralelo não cancela os outros (já estão em voo, a quota já foi gasta): deixa
  terminar e pula o agregador.
  Aviso na tela ao escolher paralelo (ver isolamento por worktree acima): em repositório git cada
  membro trabalha no branch dele; sem git, todos dividem a pasta e se atropelam.
- Tela cheia do time (`team-studio.js`) e aba "Times" no painel de agentes: editor de membros à
  esquerda — trocar o agente, escrever o papel, subir, descer e remover, com a ordem valendo como a
  ordem do pipeline — e a execução à direita, com um passo por membro, duração, tokens e o total do
  run. O estado da execução vem do daemon (`run-view.js` só aplica os eventos e calcula o que está
  em voo): o tempo mostrado é o que o servidor mediu, não o de chegada do evento como na bancada de
  um agente.
- Times de agentes e execução de time no daemon. Um `TeamDef` é um nome, uma topologia e os membros
  em ordem, cada um com um papel — o mesmo agente pode ocupar papéis diferentes em times diferentes
  sem virar dois agentes. Rotas: `/v1/teams` (CRUD) e `/v1/runs` (criar, consultar, abortar, SSE de
  progresso).
  As topologias o daemon executa de FORA — cria a conversa do membro, manda o pedido, espera o
  turno fechar, lê a saída e alimenta o próximo. Não exigem canal de volta nem ferramenta nova no
  motor, então cabem no que já existe (vale também pro `supervisor`, adicionado depois).
  O que passa entre membros é artefato, não transcrição: cada passo grava a saída inteira em
  `~/.nexo/runs/<run>/passo-N-<agente>.md` e o seguinte recebe um trecho no pedido mais o caminho do
  arquivo. Falha PARA o run em vez de pular ou repetir — o passo seguinte receberia entrada vazia e
  produziria trabalho sem base, gastando quota pra piorar o resultado. Cada run aceita teto de custo
  e de passos, porque um time multiplica o gasto: cinco membros é cinco vezes o custo de um turno.
- Tela cheia de agente (`agent-studio.js`), no lugar do formulário espremido no painel lateral:
  editor à esquerda, bancada de teste à direita. Abre pelo painel de agentes, em "Novo agente" ou
  no lápis de um agente existente.
- Modelos de criação inspirados nos formatos do ADK do Google (`agent-templates.js`): agente de
  tarefa, pipeline sequencial, refinamento em laço, coordenador, revisor crítico e explicador de
  código. O Nexo não orquestra sub-agentes — o motor é uma CLI em `--print`, um turno por vez —
  então cada modelo dá a FORMA de trabalho pela instrução, e os que emprestam o nome de um agente
  composto do ADK dizem, na própria tela, onde o mecanismo difere. Vender orquestração que não
  existe seria mentira.
- Bancada de teste com timeline por etapas (`agent-trace.js`): cada evento do motor vira uma etapa
  com duração e barra proporcional, mais o total do turno em tempo, ferramentas, tokens, contexto e
  custo. O tempo é o de chegada do evento (o stream não carrega carimbo de hora), e o token de cada
  etapa vem marcado com `~` porque o motor reporta uso por requisição, não por etapa — o total do
  turno, esse é exato. A conversa de teste é descartável: some ao limpar ou fechar, pra não encher
  a lista de conversas do projeto.
- `sse.js`: o laço de leitura de event-stream estava escrito três vezes (chat, serviços, agentes),
  cada cópia sem teste, com a mesma sutileza repetida — o `read()` corta onde quiser, então um
  evento pode chegar partido entre duas leituras. Virou uma função só, com 11 casos.
- `agent-events.js`, `file-tree.js` e `services.js`: mais três módulos fora do `renderer.js`, que
  saiu de 4.793 para 4.149 linhas. Os painéis passaram a ser donos do próprio estado (`state.svc`,
  `state.fileSelected` e a constante do rabo de texto saíram do objeto global) e as saídas para a
  UI entram como callback, pra não fechar ciclo de import. `apps/desktop` ganhou `happy-dom` para
  testar código de DOM, ligado por docblock só nos arquivos que precisam.
- `api.js`: o cliente HTTP do daemon saiu do `renderer.js` como fábrica (`createApiClient`), com
  `daemonInfo` e `fetch` entrando por parâmetro. `req` é a função mais chamada do app e não tinha
  teste nenhum, apesar de re-tentar em falha de conexão e em 401 — reiniciar o motor troca porta e
  token. Agora são 23 casos cobrindo os dois retries, credencial nova na re-tentativa, corpo não
  JSON, 204 sem corpo e o erro do servidor virando mensagem. Porta e token deixaram o objeto
  `state` e passaram a viver só dentro do cliente; `state.ok`, que a UI lê em ~28 pontos, continua
  onde estava e é alimentado por um callback. As 49 chamadas de `req` não mudaram.

### Corrigido

- `renderMd` estava quebrado desde a extração do `markdown.js`: o `wireExternalLinks` foi junto
  para o módulo novo sem ser exportado, e o renderer continuou chamando uma função que não
  enxergava mais — todo render de resposta do modelo estourava. Não havia teste do renderer, então
  passou calado. As duas funções agora moram juntas no `markdown.js`, exportadas, com teste de DOM
  cobrindo o par.
- `run.bat` apontava para um `run.vbs` que não existe; agora indica `make-shortcut.ps1 -Desktop`.
- `tsc` não rodava em nenhum pacote: os imports mantêm a extensão `.ts` (exigência do runtime, que
  consome os pacotes como fonte) sem `allowImportingTsExtensions` ligado, então a checagem morria
  com ~60 erros `TS5097` antes de olhar uma linha de código — o `strict: true` era decorativo.
  `tsconfig.base.json` passa a declarar `noEmit` + `allowImportingTsExtensions` (nada no
  repositório compila; o tsc só checa) e as opções de emissão mortas (`declaration`, `outDir`,
  `rootDir`) saíram.
- Perfil rebaixado por recusa do servidor podia voltar a `ready` sozinho: o `mtime` da credencial
  tem fração de milissegundo e o `authFailedAt` é ISO (milissegundo cheio), então um arquivo
  escrito no mesmo milissegundo da recusa — antes dela — passava por "mais novo" e reabilitava o
  perfil. O `mtime` agora é truncado antes da comparação.
- `POST /v1/threads` sem `projectPath` criava conversa órfã: ela some da listagem (que filtra por
  pasta) e de `/v1/projects`, sem erro nenhum pra quem criou. Agora é 400.

### Alterado

- `waitTerminal` (session.ts) dorme até o turno fechar em vez de acordar a cada 20 ms — eram ~45
  mil despertares num turno de 15 minutos. `lastTerminal` só é fechado por `setTerminal`, que
  libera quem espera; o teto de 15 min continua virando erro.
- `renderer.js` passou a ser carregado como `type="module"` no `index.html`, primeiro passo pra
  quebrar o arquivo (4.793 linhas) em módulos testáveis. Verificado no app de verdade: o import
  sobre `file://` funciona no Electron 33 e o renderer segue executando até o fim.
- `src/sandbox.ts` virou `src/project-cwd.ts`. O módulo só resolve o `projectPath` pra usar de cwd
  do motor e não confina nada — o nome prometia um limite que não existe. O confinamento real
  continua onde sempre esteve: `boundPath` (main do Electron) e `assertInsideProject` (nexo.json).

- Barra lateral do app reorganizada: Nova conversa, Agentes e Paleta viraram uma lista plana de
  ícone + rótulo no topo (SVG inline em vez de glifo), o `+` de adicionar pasta só aparece no
  hover do cabeçalho, cada repositório ganhou ícone de pasta aberta/fechada em vez de triângulo
  (o repo ativo marca a pasta com a cor de acento, sem fundo competindo com a conversa aberta) e
  cada conversa passou de duas linhas para uma — título truncado com o texto inteiro no tooltip e
  horário à direita. Cabe cerca do dobro de conversas na mesma altura.
- Metadados de pacote para publicação do repositório: `license: MIT` nos quatro `package.json`,
  `description` e `engines.node >= 20` na raiz.
- `.gitignore` cobre `*.tsbuildinfo` e lixo de editor/SO (`.vscode/`, `.idea/`, `.DS_Store`,
  `Thumbs.db`).

### Segurança

- Todo caminho derivado de um id (`threadPath`, `attachmentsDir`, `enginePidPath`, `profileDir`)
  passa por `assertSlug` dentro do próprio construtor do caminho, e não só em alguns chamadores.
  O `appendEvent` não validava: em `POST /v1/threads/<id>/messages` o evento do usuário era
  gravado antes de `readThread` (que é quem validava), então um id como `..%2F..%2Fevil` criava
  arquivo — e pasta, via `mkdirSync` recursivo — em qualquer lugar onde o daemon tem escrita,
  fora do `NEXO_HOME`. Exigia o token bearer, mas escapava do diretório de estado. Consulta de
  perfil com id fora do formato passa a responder 404 em vez de estourar. Coberto por teste no
  nível da rota.

- Processo filho de motor/login não herda mais o `CLAUDE_CONFIG_DIR`/`CODEX_HOME` da máquina que
  subiu o daemon (novo `engineSpawnEnv`). Antes, um perfil `codex` rodava com o
  `CLAUDE_CONFIG_DIR` do host no env e podia escrever fora da pasta do perfil — furando o
  isolamento de conta.
- `keys.json` (chave de API em claro) passa a ser gravado com modo `0600`, e as pastas de perfil
  com `0700` — antes herdavam a umask e ficavam legíveis por outros usuários da máquina.
- `escapeHtml` do renderer passa a escapar `"` e `'`. O resultado é interpolado em valor de
  atributo em vários pontos (`href` do markdown, `class`, `data-*`); sem isso, texto vindo do
  modelo com aspas fechava o atributo. O CSP já barrava a execução, mas a saída saía corrompida.
- `.gitignore` cobre `.env*`, `*.pem`, `*.key`, `*.token`, `keys.json` e `.nexo/`.
- Pacotes internos (`@nexo/daemon`, `@nexo/shared`) marcados como `private` — não são publicáveis
  por acidente.
