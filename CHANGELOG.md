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
- `api.js`: o cliente HTTP do daemon saiu do `renderer.js` como fábrica (`createApiClient`), com
  `daemonInfo` e `fetch` entrando por parâmetro. `req` é a função mais chamada do app e não tinha
  teste nenhum, apesar de re-tentar em falha de conexão e em 401 — reiniciar o motor troca porta e
  token. Agora são 23 casos cobrindo os dois retries, credencial nova na re-tentativa, corpo não
  JSON, 204 sem corpo e o erro do servidor virando mensagem. Porta e token deixaram o objeto
  `state` e passaram a viver só dentro do cliente; `state.ok`, que a UI lê em ~28 pontos, continua
  onde estava e é alimentado por um callback. As 49 chamadas de `req` não mudaram.

### Corrigido

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
