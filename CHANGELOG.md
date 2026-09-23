# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Adicionado

### Corrigido

- Depois de atualizar pra 0.5.1 com o Google Drive conectado, projetos, ícones e memória que
  estavam na pasta compartilhada manual pareciam resetados: o sync pela API não enxergava o que
  foi gravado direto nela. Agora o que falta vem de lá uma vez (sem sobrescrever nada; a pasta
  antiga fica intacta) e sobe pro Drive.
- O traço do painel de borda recolhido quase não aparecia em fundo escuro.

### Alterado

### Segurança

## [0.5.1] - 2026-09-23

### Adicionado

- Painel de borda no lugar do painel flutuante (inspirado no codenotch): uma pílula grudada numa
  borda da tela. No modo dinâmico é só um traço que abre ao aproximar o mouse e some ao afastar;
  no fixo fica sempre aberta. Mostra as conversas rodando (arco girando), as que esperam sua
  resposta (âmbar) e as que terminaram (verde), e dois anéis de uso por conta (dentro a sessão
  de 5 h, fora a semana), com o detalhe no card ao lado. Clique numa conversa abre ela no Nexos;
  clique no anel atualiza o uso da conta. Arraste pra qualquer borda de qualquer monitor.
- Quando uma conversa termina ou pede resposta, o painel abre sozinho por alguns segundos e toca
  um som; aviso do Windows ao chegar no limite crítico e nos 100%, e quando o limite renova.
- Configurações → Painel de borda: modo (fixo, dinâmico, desligado), borda, monitor, tamanho
  (60% a 160%), transparência do fundo (a cor segue o perfil de Aparência), um ou dois anéis,
  tempo aberto ao terminar, sons, avisos e as faixas de cor.
- Configurações → Pastas: escolher onde ficam os dados de cada projeto — numa pasta por projeto
  dentro da pasta configurada (como era) ou em `.nexos/` na raiz do próprio projeto (já entra no
  `.gitignore`). Agentes, times, hooks e skills gerais continuam na pasta configurada. Trocar de
  modo copia os dados pro lugar novo.
- O agente cria design systems e telas sozinho: ferramentas pra listar, criar (do zero, do padrão
  ou copiando o ativo), ativar e salvar card — "cria uma tela de login nos mocks" vira um canvas
  novo com o card lá.

### Corrigido

- Com o Google Drive conectado, a pasta compartilhada manual some das Configurações: eram dois
  sincronizadores mexendo na mesma pasta.
- Tempo até renovar o limite mostrava "23 h 60 min".
- Na atualização, o Nexos avisa que está instalando e que reabre sozinho (antes fechava sem
  explicar nada).

### Alterado

- Instalador bem mais leve: o motor vai compilado (de ~10.300 pra ~200 arquivos), então instalar
  e atualizar leva segundos. O gerador de APK do celular baixa na primeira vez que for usado.
- As regras do Nexos vão como instrução de sistema da sessão do Claude, em vez de repetidas em
  toda mensagem; regra que muda no meio da conversa chega no turno seguinte.

## [0.5.0] - 2026-09-23

### Adicionado

- Canvas de Design System: board com os tokens, as regras e os cards de componente do
  projeto, gerado por IA com streaming (o card se desenha enquanto chega). Feedback apontando
  elemento no card, controles (sliders), versões, variantes e verificação automática antes de
  mostrar.
- Board com layout editável: largura por card (⅓, ½, ⅔, inteira), alinhamento por seção (topo,
  mesma altura, alvenaria sem buracos), mover, apagar e ocultar. No chat, "alinha os cards" faz
  o agente reorganizar sozinho.
- "+ Card" por tipo: cores, tipografia, espaçamento e raio & sombra saem prontos marcando os
  tokens; componente e livre a IA desenha. Todos com o mesmo visual dos Fundamentos.
- Criar design system escolhendo a base: do zero, padrão do Nexos ou cópia de um que já existe
  (de qualquer projeto).
- Sincronia com o código: conformidade (cores e tamanhos soltos no front, com o token certo),
  ressincronizar item por item e exportar (CSS, Tailwind v4/v3, tokens.json).
- O agente vê o card renderizado (`nexo_ds_print`) e usa o design system em todo trabalho de
  front do projeto.
- Escolher o ícone do projeto pelo botão direito, quando o automático pega o arquivo errado.
- Barra lateral minimizada organizada, com indicador por projeto: selecionado, com LLM
  trabalhando (pulsando) e terminou sem você ver.
- Picker do browser manda só o pedido no chat, com os elementos como chips.
- Ferramentas do Nexos com nome legível no chat ("Navegando · lendo a página").
- Motor `api` com streaming.

### Corrigido

- Medidor de contexto mostrava 200k: agora usa a janela real do modelo.
- Resumo no fim do turno sumia a partir da segunda mensagem da conversa.
- Logos não apareciam na barra lateral minimizada.

## [0.4.0] - 2026-09-22

### Adicionado

- Agentes, times, Nexos Hooks e skills globais viajam junto com a pasta do Drive: cada item vira
  um arquivo em `_biblioteca/` dentro da pasta de projetos, e toda vez que o motor liga (e a
  cada 2min) o que tem lá e falta aqui é instalado, o que foi editado é atualizado e o que foi
  apagado num PC some nos outros. Funciona pelo Google Drive e também com a pasta de projetos
  apontada pra uma pasta sincronizada por fora. Hook de projeto chega com o caminho do mesmo
  projeto nesta máquina; agente de uma conta que não existe aqui usa a primeira conta pronta.
  Contas e logins não sincronizam.
- Tela Sobre mostra as novidades da versão instalada (seção dela no CHANGELOG.md, que agora
  vai junto do instalador).

### Corrigido

- Primeira abertura depois de instalar: enquanto o motor sobe, a tela mostra "Ligando o
  motor…" em vez de "Desligado / Liga pra conversar". A subida do boot agora grava no
  `daemon.log`, espera até 60s (antes desistia calada em 15s) e é a mesma do botão Ligar e da
  bandeja — clicar no meio não dispara um segundo `up`. Se falhar, o erro aparece no aviso.
- App abria com a aba Arquivos aberta em vez da tela inicial "Escolhe uma conversa".

## [0.3.0] - 2026-09-22

### Adicionado

- **Design System** (novo módulo): board com pan/zoom que mostra e edita o design system do
  projeto — tokens (W3C DTCG) viram CSS, Fundamentos gerados dos tokens, cards de componente em
  iframe sem scripts, edição de token ao vivo, tema claro/escuro, lint (cor solta, script,
  recurso externo, token inexistente) e animação só do que mudou em disco. Mora na pasta do
  projeto no Nexos, junto de memória e repo map.
- **Gerar com IA**: um agente "Diretor" define tokens e regras de uso, e um agente por seção
  desenha os cards em paralelo; card com erro volta pro agente corrigir antes de ser dado como
  pronto. Lê o código do projeto e uma URL de referência; a versão anterior de cada card fica
  guardada.
- **Coleta de design pelo Browser** (Configurações → Módulos): botão na barra do Browser que lê
  o estilo da página aberta + print e abre o "Gerar com IA" com isso de referência.
- **Logo do projeto na barra lateral** (Configurações → Aparência): favicon/logo achado no
  código no lugar do ícone de pasta; com a barra minimizada, os projetos viram só os ícones.
- **Times dentro do chat**: time chamado por `@menção`, pelo roteador ou por `nexo_delegar`
  roda dentro do chat que o chamou — em fila, com barra "trabalhando" acima do input (parar por
  time e por agente, cancelar o que está na fila), resultado de volta no chat e pergunta do
  subagente repassada pra você. Os passos saem da barra lateral.
- Pedido montado pelo Nexos (passo de time, geração do DS) aparece recolhido no chat.
- Toda conversa pede ao agente um resumo curto no fim do turno que usou ferramenta.
- `run.bat dev`: modo de teste isolado do Nexos instalado (motor e dados próprios) com recarga
  automática ao salvar.

### Alterado

- Bolhas "Lendo / Editando / Pensando" agora são uma por fase, independentes (antes as fases
  do turno empilhavam numa caixa só).

### Corrigido

- Update automático instalava mostrando o assistente do NSIS de novo (pedindo clique em
  "Concluir") em vez de instalar quieto e reabrir sozinho — faltava passar `isSilent: true,
  isForceRunAfter: true` pro `quitAndInstall` (main.cjs). Agora a atualização é realmente
  silenciosa, como o resto do fluxo (gate de turno-ativo) já prometia.
- Workflow de release ganhou um passo que apaga release duplicada da mesma tag — o publish do
  electron-builder às vezes cria duas releases pra uma tag só (uma com o `.exe`, outra só com o
  `.blockmap`), e `/releases/latest` podia apontar pra vazia. Já tinha acontecido em v0.1.0 e
  v0.2.0, corrigido à mão as duas vezes; agora o próprio workflow mantém a release com mais
  assets e apaga o resto.

## [0.2.0] - 2026-09-22

### Adicionado

- Botão "Atualizar agora" em Configurações → Contas → Atualizar CLI, pro Claude Code CLI e pro
  Codex CLI: reaproveita a mesma rota (`POST /v1/engines/:engine/install`, `npm install -g
  <pacote>@latest`) que já instalava automaticamente na criação de conta — agora dá pra atualizar
  uma CLI já instalada sem passar por criar/remover perfil.
- Sequência de ferramentas/raciocínio de um turno ("Trabalhando…", "Lendo…", "Editando…",
  "Pensando…") empilha uma linha por fase em vez de trocar o rótulo no lugar — fechar "Lendo…" e
  abrir "Editando…" antes só sobrescrevia o texto, escondendo que o agente tinha passado por ali.
  Só a fase mais recente pisca os 3 pontinhos; as anteriores ficam como texto simples, apagado.

### Corrigido

- **App empacotado (.exe) subia sem o motor — bug real de produção.** `pnpm deploy` monta o
  `node_modules` do daemon com NTFS junctions no Windows, e o `electron-builder` tem um filtro
  interno (`util/filter.js`) que descarta, em silêncio e sem nenhum erro no log do build, qualquer
  pasta chamada exatamente `node_modules` na raiz de um `extraResources` — o instalador saía sem
  `tsx`/`esbuild`/`@nexos/shared`, e "ligar o motor" nunca funcionava pra quem instalasse. Corrigido
  em duas partes: `deploy:daemon` (agora `scripts/deploy-daemon.mjs`) gera o deploy com
  `--config.node-linker=hoisted` (`node_modules` plano, sem junction) e tolera a flakiness conhecida
  do pnpm ao criar shims em `.bin` no Windows — o critério de sucesso é o conteúdo existir, não o
  exit code; `scripts/after-pack.cjs` (hook `afterPack` do electron-builder) copia essa pasta na
  mão depois do empacotamento, já que não tem `filter:` que desligue a exclusão. Validado
  instalando o `.exe` de verdade (não só `--dir`) e confirmando `/health` responder.
- Release do GitHub saía em rascunho (draft) — invisível em `/releases/latest`, que é justamente o
  que o `electron-updater` consulta — e ainda duplicava em duas entradas pra mesma tag. `publish.
  releaseType: release` no `electron-builder.yml` evita repetir; a v0.1.0 foi corrigida à mão.

### Alterado

- **Rebatizado de Nexo pra Nexos** — nome do app, pacotes do monorepo (`@nexo/*` → `@nexos/*`),
  comando de CLI (`nexo` → `nexos`), variáveis de ambiente (`NEXO_*` → `NEXOS_*`), `appId`/
  `productName` do instalador, projeto nativo do controle do Windows
  (`Nexo.WindowsControl` → `Nexos.WindowsControl`) e toda a UI/documentação visível. Compatibilidade
  com quem já usava o nome antigo, sempre com migração automática (nunca manual):
  - `~/.nexo` → `~/.nexos`: migra sozinho na primeira subida depois do update (rename, ou cópia se
    cruzar de dispositivo) — perfis, conversas e config continuam intactos.
  - Pasta de dados do Electron (`Roaming\Nexo`) → `Roaming\Nexos`: mesma migração automática que já
    existia pro formato ainda mais antigo (`@nexo\desktop`).
  - `nexo.json` (declaração de serviços locais do projeto) → `nexos.json`: o nome novo é o que o
    Nexos escreve, mas um `nexo.json` já existente no projeto continua sendo lido normalmente.
  - Prefixo de branch dos times (`nexo/<run>/...`) e nomes de ferramenta MCP (`nexo_agente_salvar`
    e afins) foram deixados como estão de propósito — são identificadores técnicos/protocolo, não
    marca, e mudar quebraria branch e histórico já existentes sem ganho nenhum pra quem usa.

## [0.1.0] - 2026-09-22

### Adicionado

- Conversa sem projeto ("chat geral"): `POST /v1/threads` sem `projectPath` cria uma conversa
  global, fora de qualquer repositório — cwd cai em `~/.nexo/chat-geral`, memória lê/grava em
  `~/.nexo/memoria-global` (única, sem hash por projeto). Sem git/kanban/repo-map/delegar-a-time
  nela: exigem projeto real. Enviar `projectPath` vazio continua erro, pra não nascer global sem
  querer. Desktop ganha seção "Chat geral" na árvore lateral e o modal de nova conversa aceita
  abrir sem projeto. Junto veio um importador de zip (`POST /v1/import/zip`, botão na seção
  "Chat geral"): o Data export do Claude.ai vira uma thread global por conversa, evento por
  evento, na ordem original.
- Empacotamento do desktop como instalador Windows (`electron-builder` + NSIS,
  `pnpm --filter @nexos/desktop build`) e o app se atualizando sozinho: rota
  `GET /v1/status/turno-ativo` no daemon e `electron-updater` integrado no processo main
  (check no boot + a cada 4h, download em background, `quitAndInstall` só dispara com
  `turno-ativo: false` — nunca interrompe um agente no meio de um turno; com turno ativo o
  update fica pendente pro próximo fechamento). Banner no topo do chat mostra progresso do
  download e "Reiniciar agora" quando pronto; Configurações → Sistema → Sobre mostra a
  versão instalada e o status do updater. Processo documentado em `docs/RELEASE.md` (inclui
  checklist de QA manual pra antes da primeira release pública). Sem assinatura de código
  por enquanto (decisão registrada no documento).
- Conversa agrupa a sequência de ferramentas/raciocínio de um turno numa bolha só —
  "Trabalhando…", "Lendo…" (`Read`), "Editando…" (`Edit`/`MultiEdit`/`Write`) ou "Pensando…"
  (raciocínio do motor), com 3 pontinhos sempre animados enquanto o turno roda, fechada por
  padrão — antes cada `Bash`, `Read` etc. virava uma linha solta (uma volta com 10 chamadas
  enchia a tela). Abrir mostra o passo a passo de sempre (clique em cada ferramenta continua
  abrindo argumentos/resultado). O rótulo troca sozinho pro que está rolando agora, e os
  pontinhos param de animar assim que o turno termina (mensagem final, sua próxima pergunta
  etc.).
- Google Drive sem o Drive para computador: Configurações → Google Drive tem um botão só,
  "Entrar com Google". Todo o resto acontece no navegador: consentimento do Google (escopo
  `drive.file` — o Nexo só enxerga o que cria ou o que a pessoa escolhe) e em seguida uma página
  "Onde guardar seus projetos?" com "Continuar em …" (a pasta que outro PC da mesma conta já usa,
  achada por uma marca em `appProperties`), "Criar a pasta Nexo no Meu Drive" ou "Escolher outra
  pasta…" (seletor do próprio Google). Depois disso o daemon sincroniza `projetos/<slug>/` nos dois
  sentidos, na subida, a cada 2min e no "Sincronizar agora"; "Trocar pasta" reabre só a escolha.
  Fluxo de app instalado (RFC 8252): servidor efêmero em `127.0.0.1`, PKCE S256 e um `state`
  aleatório que protege callback e página de escolha; só o refresh token fica no disco
  (`google.json`, 0600). Conflito: arquivo comum vale o mais recente, conversa é mesclada linha a
  linha; exclusão vai pra lixeira do Drive, e um lado esvaziado por acidente não apaga o outro.
  Nenhum ID/chave aparece pra quem usa: o registro do app no Google Cloud vai embutido em
  `google-client.ts` (preenchido uma vez por quem distribui o Nexo).
- Conversas também são gravadas na pasta do projeto (`projetos/<slug>/conversas/<id>.jsonl`), ao
  lado de memória, tarefas e repo map. `~/.nexo/threads` segue como fonte de verdade; a cópia é
  best-effort. Conversa que chega de outra máquina pelo sync aparece na lista, reapontada pro
  projeto e perfil daqui.
- Cartão de agente mostra a que times ele pertence, em chip clicável que abre o time — de
  dentro do agente se chega no time que o usa, sem passar pela aba Times pra descobrir. Agente
  fora de qualquer time não ganha a linha: a ausência já diz isso. A aba Agentes passou a
  carregar os times junto (antes eles só chegavam depois de abrir a aba Times).
- Tema da interface em Configurações → Aparência, com dois perfis: **grafite** (padrão, o neutro
  levemente frio alinhado ao roxo da marca) e **preto** (fundo preto e cinzas, contraste alto e
  bom em tela OLED). Só a rampa de superfície, traço e texto muda — tipografia, espaçamento, raio
  e a cor de destaque continuam iguais nos dois, então nenhum componente precisa saber qual tema
  está no ar. Guardado em `config.json → tema` (e no `localStorage`, pra pintar já no boot sem
  esperar o daemon): a janela principal nasce na cor certa (`main.cjs` lê o tema antes de criar a
  BrowserWindow, senão pisca grafite), e o painel flutuante e a interface de celular acompanham
  pelo `GET /v1/config` — no celular a `<meta name="theme-color">` muda junto, pra barra de
  status do Android não destoar. Splash e barras do APK (TWA) passam a usar a mesma cor de fundo
  do tema padrão.
- Interface de celular ganha o que faltava pra fechar com o desktop: botão "+ Nova" abre uma
  folha pra escolher conta pronta ou agente personalizado e cria a conversa; dentro de uma
  conversa com conta `claude`, um botão de ajustes abre folha de modelo/effort (`PATCH
  /v1/profiles/:id`, mesma rota do desktop); o compositor ganha o mesmo menu de autocomplete
  `/skill` e `@agente`/`@time` do desktop, reaproveitando `mention.js` do desktop via `./comum/`
  (adicionado à lista branca do daemon) — `@menção` dispara `POST /v1/runs` em paralelo ao turno
  de chat, igual no desktop.
- Árvore de arquivos ganha marcador por tipo (`file-kind.js`): reconhece por nome inteiro
  (`Dockerfile`, `.gitignore`) e por extensão, com o glifo/cor vivendo no CSS
  (`[data-kind]`) — arquivo que não se reconhece cai no marcador neutro de sempre.
- Painel flutuante ganha modo "mini": uma pílula compacta com passos/tempo/quota, que troca
  com o modo cheio sem esperar o próximo poll (as duas versões são sempre pintadas; o CSS
  escolhe qual mostra). Largura e altura acompanham o conteúdo real da pílula em vez de uma
  janela de tamanho fixo.
- `@agente`/`@time` no composer: citar um agente ou time específico numa mensagem dispara um Run
  de verdade em paralelo ao turno de chat normal (mesmo `POST /v1/runs` que o Team Studio já usa),
  sem esperar o modelo decidir usar — é a pessoa que dispara, preservando a regra de que run
  nunca sai de dentro de uma conversa comum. Autocomplete do `@` reaproveita o mesmo menu do `/`.
  Time citado direto usa o id dele; agente avulso vira (ou reusa, idempotente) um
  time-pipeline-de-1 oculto (`origem: "mencao"` em `TeamDef`) — `listTeams` filtra isso da tela,
  `getTeam` não, então o motor de Run funciona sem mudança nenhuma nele. Múltiplas menções na
  mesma mensagem disparam um Run por menção, todas com o mesmo pedido (a mensagem sem os `@`).
- Inspector de elemento no painel Browser: um modo de seleção que destaca o elemento sob o mouse
  dentro do preview local e, no clique, captura seletor/HTML resumido/texto visível — acumula
  várias seleções numa caixa lateral, e "Mandar" vira uma mensagem de chat normal (uma lista
  numerada dos elementos + o pedido livre da pessoa), pelo mesmo caminho de envio de sempre.
  Exigiu trocar o `<iframe>` do Browser por `<webview>`: o preview carrega origem diferente
  (`http://127.0.0.1:porta`) da do próprio app (`file://`), e a Same-Origin Policy bloquearia
  qualquer script do Nexo de tocar o DOM de um iframe comum — `<webview>` é o mecanismo do
  Electron pensado pra isso, com `will-attach-webview` travando `preload`/`nodeIntegration` nos
  valores esperados independente do que o HTML peça.

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
  ganhou 21 casos (`pnpm --filter @nexos/desktop test`), com foco em injeção — tag do modelo vira
  texto, `javascript:`/`data:`/`file:` não viram âncora, aspas não escapam do `href`, bloco de
  código é escapado. É o ponto onde texto do modelo vira HTML na janela; o CSP é a segunda linha
  de defesa, a primeira é escapar antes de formatar, e agora existe teste que trava essa ordem.
  `pnpm test` na raiz passou a rodar os dois pacotes.
- Mais dois módulos saídos do `renderer.js`, também só recorte: `format.js` (helpers puros de
  exibição e normalização de caminho) e `url.js` (`safeUrl`/`portaDaUrl`). `safeUrl` decide o que
  o iframe do preview carrega — o CSP deixa `frame-src` largo de propósito, então quem barra
  `javascript:` e `file:` é ela. 58 casos no app ao todo; os que caem em `toLocaleString` checam a
  forma e não o literal, porque o texto varia com a versão do ICU entre os jobs do CI.
- Interface de celular (`apps/mobile`), servida pelo próprio daemon em `/app/`: PWA, sem instalar
  nada e sem build, igual ao resto do projeto. Mostra o run em andamento, a quota das contas, a
  lista de conversas do projeto aberto, e deixa conversar com stream de verdade. Árvore de arquivos
  e terminal ficam de fora: hoje não existem como HTTP (vivem no processo principal do Electron), e
  telefone não é onde se lê diff.
  **Pareamento por código curto**, não por QR: o desktop mostra 6 dígitos, o celular digita, e o
  daemon troca o código pelo token. Assim o TOKEN nunca aparece numa tela — QR é foto, e foto vaza.
  `POST /pair` é a única rota de escrita sem autenticação do daemon, e o que a torna defensável são
  as travas: vale 2 minutos, serve uma vez, 5 erros queimam o código, comparação em tempo constante,
  e pedir um novo invalida o anterior. Dá 5 chances em 10^6 pra quem já alcança a porta.
  **Endereço de escuta configurável** (`config.host`, `NEXOS_HOST`), com `127.0.0.1` de padrão. Sem
  isso o celular não alcança nem por túnel: a interface do Tailscale tem IP próprio, não é loopback.
  A tela avisa quando o endereço só aceita a própria máquina, e avisa mais forte no `0.0.0.0`.
  O que a interface reaproveita do desktop vem de `/app/comum/`, com **lista branca** de módulos
  (`markdown.js`, `format.js`, `sse.js`, `widget-view.js`, `agent-trace.js`…). Sem cópia, porque
  arquivo copiado diverge; e lista branca porque servir uma pasta por prefixo é como se serve o
  disco por acidente.
  `/app` redireciona pra `/app/`, e a barra não é estética: sem ela o documento tem base `/`, os
  `./modulo.js` do HTML são pedidos na raiz, e a tela abre muda sem dar erro nenhum. Só apareceu
  carregando a página num navegador de verdade.
- O servidor MCP do supervisor declara `timeout` por servidor, maior que a paciência do próprio
  daemon. O padrão do CLI é 5 minutos por chamada de ferramenta, e é limite de PAREDE — a
  documentação interna dele diz que notificação de progresso não estica. Um membro fazendo trabalho
  de verdade passa disso: a chamada morreria no cliente com o membro ainda rodando, e o supervisor
  receberia um timeout cego em vez de um motivo.
  O valor é o teto de turno do daemon (`TURNO_TETO_MS`, 15 min) mais um minuto de folga. A ordem
  importa: quem tem que desistir primeiro é o daemon, porque só ele sabe DIZER o motivo ("motor
  falhou", "quota estourou") de um jeito que o supervisor entende e pode contornar.
  A constante mudou de casa pro `@nexos/shared` porque `mcp.ts` não pode importar `session.ts` sem
  fechar ciclo — o motor de CLI importa o mcp.
- `GET /v1/runs/atual`, e o painel flutuante passou a usar essa em vez da listagem. Ele consulta a
   cada 2s e mostra UM run; pedir a lista pra isso abria todo `run.json` da máquina e serializava o
   histórico inteiro. Medido com 1000 runs no disco: **29 ms e 2,3 MB por consulta viraram 0,5 ms e
   2 KB**, e agora é plano conforme o histórico cresce.
  O caso comum não toca no disco: o daemon já sabe em memória quais runs estão em voo, e é
  justamente quando há um rodando que o painel é consultado sem parar. Sem nada em voo, ele abre no
  máximo 40 arquivos — corte honesto pro que a rota responde ("está andando algo?"); histórico é o
  `GET /v1/runs`.
  Quem escolhe o run do momento passou a ser o daemon, não a tela: escolher na tela obrigava a
  baixar tudo pra jogar quase tudo fora. A listagem também ganhou teto de resultado (50) e ordem
  pelo id — que é cronológica, porque o id carrega o tempo em base36 com largura fixa.
- Motor `codex` funcionando, e MCP nele. **O motor nunca havia rodado um turno**: ele spawnava
  `codex` sem argumento nenhum, e `codex` puro abre a interface interativa, que morre na hora com
  stdin em pipe (`Error: stdin is not a terminal`). Além disso a saída era parseada com o parser do
  Claude, cujo esquema não tem nada a ver. Nenhum teste exercitava um turno de codex — não havia
  nem fixture — e foi essa ausência que deixou o defeito passar. Agora é `codex exec --json`, com
  parser próprio (`engines/parse-codex.ts`) e fixture que RECUSA qualquer invocação que não seja
  `exec --json`, pra a regressão ser barulhenta.
  As ferramentas de autoria (criar e editar agente e time) passam a valer em conta `codex`:
  `-c mcp_servers.nexo={url=…,bearer_token_env_var=NEXOS_MCP_TOKEN}`, com o token no ambiente do
  processo filho — nem em argv nem em arquivo, o que é melhor do que o arquivo `0600` que o
  `claude` exige. O supervisor por MCP segue só em `claude` (o servidor dele é preso ao run e vem
  carimbado como caminho de arquivo); em codex ele usa o canal por turno, que agora funciona.
  Duas coisas que só apareceram dirigindo o `codex` de verdade: `error` NÃO é fatal (o aviso
  "Model metadata not found" e a retentativa de rede chegam como `error` e o turno termina bem —
  traduzir isso em erro abortaria turno saudável; o canal fatal é `turn.failed`), e o `--json` do
  `exec` só emite item COMPLETO, então a resposta chega de uma vez em vez de palavra por palavra.
  `--skip-git-repo-check` é escolha: o `codex exec` se recusa a rodar fora de repositório git, e
  manter a recusa faria ele ser o único motor a falhar em projeto que funciona nos outros.
- `nexo branch ls | rm [pasta] [--run <id>]`: a limpeza dos branches que o fan-in deixa. Eles
  acumulam por desenho — a árvore de trabalho sai do disco no fim do run e o branch fica, porque é
  ele que guarda o que o agente fez — então um repositório com uso regular de time junta um por
  membro por run, pra sempre, e ninguém apaga dezenas à mão. O `rm` apaga **só o que já está no
  HEAD**, ou seja o que apagar não perde commit nenhum; o resto sai listado com a data, e forçar
  continua sendo `git branch -D`. Branch de run em andamento também não sai, e quem recusa é o
  próprio git (está em checkout numa árvore viva) — a checagem não é duplicada aqui pra não
  arriscar discordar dele. "Mesclado" é sempre em relação ao HEAD atual, e isso erra pro lado
  seguro: trabalho que entrou no `main` mas não neste HEAD é preservado.
- Teto do context pack derivado da janela do motor, em vez de 8000 fixo pra toda conta. Uma conta de
  janela grande recebia o mesmo corte de uma de 8k, então conversa longa "esquecia" coisa que
  caberia folgado. Agora é metade da janela, com piso em 8000 (o valor antigo, pra motor de janela
  desconhecida — nada regride) e teto em 128k. A outra metade da janela não é folga: paga o system
  prompt, as instruções do agente, a definição das ferramentas, o resultado de cada ida e volta de
  ferramenta DENTRO do turno, e a resposta. O teto de 128k existe porque o pack vai inteiro em TODO
  turno: 1M sem limite mandaria 500 mil tokens por mensagem.
  A janela vem do evento `window` novo, tirado do `autocompact_state` do CLI — a janela EFETIVA da
  sessão, que é o número que o próprio CLI usa pra decidir quando compactar. Medido contra o CLI de
  verdade: ele reporta o modelo como `claude-sonnet-5`, sem sufixo, numa sessão de janela 980k — a
  heurística antiga (`[1m]` no nome, senão 200k) subestimava em 5×. Ela continua como último
  recurso, pra quando o daemon subiu agora e ainda não viu turno daquela conta.
  De quebra o medidor de contexto da tela parou de mentir: passou de `40.4k / 200.0k (20%)` pra
  `40.4k / 980.0k (4%)` na mesma conversa.
  A janela reportada agora é **gravada no perfil**, em `contextWindows`, com o nome do modelo como
  chave. Sem isso o "último recurso" acima valia depois de CADA subida do daemon: o primeiro turno
  de cada conta voltava aos 200k deduzidos do nome, com teto de 100k em vez de 128k — e a
  compactação automática, que dispara em 80% do teto, disparava antes da hora. Por modelo, e não
  por conta, pra que trocar o modelo do perfil invalide o número sozinho, sem limpeza. Guarda os 12
  modelos mais recentes e descarta o mais antigo.
- Teto de tempo dos testes que rodam `git` de verdade subiu pra 30s (`worktree.test.ts` inteiro e o
  `isolamento no fan-in` do `runs.test.ts`). Os 5s padrão do vitest são pra teste de lógica; esses
  casos disparam de 5 a 10 processos contra disco, e num runner Windows lento um `worktree add` +
  `commit` + `worktree remove` passa disso — o caso morria por tempo sem nada de errado no código.
  O teto continua existindo em vez de virar infinito: git que não volta é defeito, e o teste tem que
  dizer isso em vez de pendurar o CI.
- Canal `mcp` no supervisor: o daemon vira servidor MCP e o supervisor chama os membros DENTRO do
  turno dele, em vez de um turno por decisão. Um run de 5 chamadas passa de 6 turnos pra 1.
  A ferramenta é presa a UM run pelo caminho (`/v1/mcp/<run>`): o bearer sozinho é o token da
  máquina inteira, e sem o escopo qualquer coisa com o token poderia disparar agente de outro run.
  A config vai em arquivo `0600` e não em argumento, porque carrega o token — argv é legível por
  qualquer processo do mesmo usuário. `--strict-mcp-config` impede que servidor MCP herdado do
  `~/.claude.json` entre no turno de um agente que ninguém configurou pra isso.
  Motor que não fala MCP (`api`, `stub`) cai de volta pro modo por turno, com o motivo em
  `canalOff` — recusar o run seria pior: o time continua fazendo sentido, só que mais caro. Por isso
  o `turno` segue sendo o padrão, e a tela só mostra a escolha no supervisor.
  O teto de passos vale dentro da ferramenta também: em MCP o laço é do modelo, e sem isso ele não
  passaria por nenhuma trava do daemon. Erro de argumento e membro inexistente voltam como
  `isError` (o modelo lê e corrige), enquanto exceção do daemon vira erro de protocolo — a
  diferença entre "você errou" e "nós quebramos".
  Duas coisas que a verificação contra o CLI de verdade corrigiu: `--allowed-tools` passou a sair
  UMA vez só com tudo dentro (a opção é variádica, e repeti-la fazia a segunda substituir a
  primeira, apagando as ferramentas do perfil ou as do MCP); e a resposta da ferramenta deixou de
  apontar pro artefato — ele mora fora da pasta do projeto, o supervisor não tem ferramenta pra
  abrir, e ele concluía que o membro não havia produzido nada.
- Painel flutuante (botão "Painel", Ctrl+Shift+W, ou a bandeja): janela própria, sem moldura,
  sempre por cima, com o passo do run em andamento, quantas conversas estão trabalhando, os anéis de
  quota por conta e o custo acumulado contra o teto. Janela separada e não um canto da principal
  porque o ponto dele é aparecer quando o Nexo NÃO está na frente — um time roda por minutos
  enquanto você está no editor, e painel embutido some junto com a janela.
  Ele mede o próprio conteúdo e pede a altura ao processo principal: altura fixa sobraria vazio com
  um run só e cortaria linha com quatro contas. Abre onde estava da última vez, não rouba foco
  (`showInactive`) e não entra na barra de tarefas nem no Alt+Tab.
  **Poll de 2s, não SSE, e é escolha:** cada fonte tem um stream próprio e nenhuma tem um agregado;
  três streams vivos pra uma faixa de 200px custariam mais que um GET contra um daemon da mesma
  máquina. Com o motor desligado o poll afrouxa pra 8s. Poll que falha não apaga a tela — o retrato
  anterior continua até a próxima resposta, senão o painel piscaria a cada soluço.
  Conta que nunca rodou um turno fica de fora dos anéis: anel vazio pareceria "quota sobrando", que
  é o oposto de "não sei". O relógio para no fim do run, em vez de crescer pra sempre depois de
  acabar.
  O painel é do PROJETO ABERTO, não da máquina: o daemon responde os runs e as conversas de todos os
  projetos, e com dois abertos o painel mostrava o do outro — sem dizer que era de outro, o que é
  pior que não mostrar nada. O projeto vem do processo principal (o painel é outra janela e não
  compartilha estado com o app) e é relido a cada volta, então trocar de projeto muda o painel sem
  reabrir; o cabeçalho passou a dizer qual é. A QUOTA não filtra: ela é da conta, não do projeto. E
  sem projeto aberto nada é filtrado — o daemon pode estar trabalhando por fora, disparado pela CLI.
- Conversas de um run agrupadas na barra lateral. Um time cria uma conversa por passo, e o
  supervisor cria quantas quiser: soltas, dez linhas do mesmo run afogavam a lista e empurravam pra
  baixo o que a pessoa estava usando. O run vira uma pasta, fechada por padrão, na posição da
  conversa mais recente dele; dentro, a ordem é a do RUN (passo 1, 2, 3), não a de atualização. Run
  de um passo só não vira pasta — a pasta a mais só esconderia.
  O carimbo (`runId`, `runStep`, `runTitle`) vai no `thread_meta` na criação da conversa: é verdade
  sobre a conversa, e sem ele a lista teria que abrir todo `run.json` do disco pra montar um
  cabeçalho. Junto veio o título por passo ("Leitor · passo 2"), que substitui o preview do primeiro
  pedido — nos passos de time esse pedido é o bloco inteiro de instruções, e a lista ficava com
  várias linhas idênticas começando em "# Objetivo do time".
- Retomada de run parado (`POST /v1/runs/:id/resume`, botão "Retomar" na tela do time): continua de
  onde parou, sem refazer o que já ficou `done`. A quota daquele passo já foi gasta e o artefato está
  no disco — refazer cobraria de novo por um resultado que já existe, e ainda daria um resultado
  diferente do que os passos seguintes viram. O que é refeito é o que falhou, foi pulado ou ficou
  preso em `running` (motor derrubado no meio).
  O orçamento mandado na retomada SUBSTITUI o antigo, e não mandar nenhum tira o teto: retomar com o
  mesmo teto que parou o run pararia na mesma linha, sem gastar nada, e pareceria defeito. O gasto
  das tentativas anteriores vira `gastoAnterior` e continua contando — senão retomar zeraria a conta
  e o teto de custo não valeria mais nada depois da primeira parada.
  No fan-in, o paralelo que deu certo não roda de novo e a saída dele vem do artefato, na ordem do
  time. No supervisor, a CONVERSA dele sobrevive e é o ponto todo: ele volta lembrando o que já
  mandou fazer e o que deu errado, com um pedido de retomada que não repete objetivo nem lista.
  Branch dos paralelos ganha sufixo por tentativa (`-r2`): o da tentativa anterior continua no
  repositório, com trabalho que ninguém olhou ainda.
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

- Sync do Google Drive nunca estabilizava (subia arquivo de novo a cada ciclo de 2min, sem
  parar) quando `projetosDir`/`memoriaDir`/`graphDir` apontavam pra dentro de uma pasta que o
  Drive para computador já sincronizava sozinho (dois motores de sync na mesma pasta, um deles
  varrendo cache de outra ferramenta que fica reescrevendo arquivo o tempo todo). O sync agora só
  entra em pasta de projeto de verdade (tem `meta.json`) na raiz de `projetosDir`, ignorando
  qualquer outra coisa que esteja lá.
- "Trocar pasta" do Google Drive nunca abria o navegador: a página de escolha é servida pelo
  próprio servidor efêmero do login (`http://127.0.0.1:<porta>`, RFC 8252), e o handler
  `shell:external` só deixava abrir link `https://`. Agora aceita esse `http://` também, só em
  loopback (127.0.0.1/::1/localhost) — link de fora continua exigindo https.
- Rodapé da barra lateral em duas linhas (estado + ligar/desligar em cima, ícones de foco,
  painel e configurações embaixo): numa linha só o grupo de botões não cabia nos 252px e vazava
  por cima do painel ao lado, em qualquer tela. O fundo em pílula que os agrupava saiu, e Foco e
  Painel viraram ícone como o resto do app.
- Aba ativa (Agentes/Times/Hooks, Kanban/Lista/Calendário/Timeline, abas do painel de agentes e
  da paleta) marcada por fundo em vez de traço embaixo: o `border-bottom` acompanhava o
  `border-radius` do botão e desenhava um risco curvado sob o rótulo.
- Cartão da lista de Times e de Hooks não tinha regra de CSS nenhuma — nome, resumo e o botão de
  abrir saíam em fluxo de texto corrido, grudados. Foram refeitos: nome e etiqueta (como o time
  trabalha / que evento dispara a regra) em cima, e embaixo o caminho dos membros em chip com a
  seta entre eles — `+` quando o time roda em paralelo, porque ali ninguém espera ninguém. Time
  com mais de três membros mostra os três primeiros e conta o resto; o cartão de hook mostra quem
  roda, "bloqueante" quando é, e escopo global ou branch.
- Faixa de cor na borda esquerda do cartão de agente virou um ponto antes do nome: a faixa cortava
  o canto arredondado e virava um risco colorido em cada item da lista. Saíram também a barra de
  acento à esquerda da nota do modelo de criação e o trilho roxo das conversas do repositório
  ativo, que passou a ser neutro.
- Linha de passo da bancada (Agentes/Times) quebrava em duas quando o painel ficava estreito.
  A linha agora responde à largura da BANCADA (container query) e vai soltando o que é
  secundário — tokens, depois o detalhe — em vez de truncar tudo em "ap…".

- Cor de destaque escolhida no desktop passa a valer na interface de celular — incluindo a gema
  do chapéu do maguinho, que é pintada a partir de `--accent`: o celular nunca lia `accent` do
  config e ficava preso no roxo padrão. Na tela de pareamento o maguinho virou canvas pintado
  pelo mesmo `tintPetGem` do compositor; era `<img>` com um giro de matiz no CSS, que aproximava
  o roxo mas ignorava o acento de verdade.
- `DEFAULT_CONFIG.accent` era azul (`#4d9cd6`) enquanto o renderer já nascia roxo (`#7c5cbf`):
  instalação nova abria roxa e virava azul no primeiro poll do config. Os dois agora são o
  mesmo valor, e o ícone da PWA acompanha.

- Skill `nexo-times` instalava direto em `~/.claude/skills/` (config REAL do Claude Code na
  máquina) em vez de `~/.nexo/skills/` (pasta global do Nexo). Isso furava o isolamento por
  perfil que o resto do sistema usa: a skill vazava pra qualquer sessão Claude Code do usuário —
  inclusive fora do Nexo — e mesmo assim não chegava em perfil nenhum do Nexo que não usasse por
  acaso esse mesmo `~/.claude` como config. `GET /v1/skills` também passou a esconder skill de
  perfil/global quando a conta é `codex`/`api`: esses motores não leem `SKILL.md`, então listar
  pra eles anunciava no menu "/" uma opção que nunca ia valer no turno de verdade.
- `run.bat` só checava se a PASTA `node_modules/electron` existia antes de pular a instalação —
  `pnpm install` cria a pasta mesmo quando bloqueia o script de postinstall que baixa o binário
  (`electron.exe`), e o app abria com um cmd vazio, sem log, na primeira vez. Agora checa o
  binário (`dist/electron.exe`) de verdade, e se `pnpm install` rodar sem baixá-lo, avisa o
  comando exato (`pnpm approve-builds`) em vez de deixar o cmd vazio sem explicação.
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

- Acabamento visual do desktop e do celular sobre uma camada de tokens única (cor, espaço,
  tipo, raio, sombra, movimento e anel de foco), declarada no topo de `apps/desktop/styles.css`
  e espelhada em `apps/mobile/mobile.css` e `apps/desktop/widget.css` — os três lados agora
  saem da mesma rampa neutra e do mesmo roxo, em vez de cada tela ter o seu cinza (o painel
  flutuante, por exemplo, era azul). Hierarquia de texto passou a ser explícita: chrome em
  13/1.45, prosa da conversa em 14/1.62, e rótulo de seção (Repositórios, Serviços, seções das
  Configurações, autor da mensagem) em caixa alta miúda com respiro entre letras. Um anel de
  foco só no app inteiro, conversa e item de navegação ativos marcados pelo fundo mais claro,
  campos de texto com base comum (nenhum input cai mais no visual nativo) e
  `--accent-text` derivado de `--accent`, pra cor trocada em Configurações continuar valendo em
  texto pequeno. O maguinho continua onde estava, sem mudança de arte nem de animação.
- Telas de Agentes, Times e Hooks no mesmo acabamento do resto: rótulo de seção em caixa alta
  miúda no lugar de `opacity: .6` (que sobre fundo escuro come contraste e faz tudo parecer
  desligado), campo de instruções com cara de campo e não de bloco de texto solto, cartões de
  agente com as ações separadas por um traço, nome do item aberto como título da área, ponto de
  "não salvo" como bolinha em vez de bullet gigante, e o editor com mais espaço que a bancada
  (1,2fr contra 0,8fr) — em Hooks, que não tem bancada, o formulário ganha teto de largura.
- Configurações ganham hierarquia: a navegação sai de uma lista de sete itens pra três grupos
  (**App**, **Motor**, **Fora desta máquina**) e cada painel divide as linhas em grupos rotulados
  — rótulo em caixa alta miúda e espaço entre os grupos, com as linhas de cada grupo separadas
  por hairline (sem cartão fechado em volta: numa tela plana, sem sombra pra descolar um nível
  do outro, a caixa por bloco pesa mais do que organiza). A busca
  agora esconde o grupo inteiro junto com o rótulo dele quando nenhuma linha casa, e painel sem
  `.set-row` (Pastas compartilhadas, que é um `.shared-card`) passa a casar pelo texto da seção —
  antes sumia em qualquer busca, inclusive pelas palavras escritas nele. O item "Memória" virou
  "Pastas", que é o título do painel que ele abre.
- Configurações: os sete itens da navegação e a busca trocam glifo de texto (◧ ☰ ▢ ⇅ ◈ ▣ ⇶ ⌕)
  por ícone SVG, no mesmo traço da barra lateral, e descrição com mais de um parágrafo
  (Roteamento IA, Módulos) ganha respiro entre eles — antes colavam num bloco só de texto.
- Celular: barra de abas com ícone + rótulo e marca de aba ativa, ícones de voltar/ajustes/enviar
  em SVG no lugar dos glifos de texto, pílula do motor com ponto de estado, bolha de chat
  ancorada pelo canto do lado de quem falou, folha com alça de arraste, e o maguinho também na
  tela de pareamento. O clique na aba passou a resolver por `closest("[data-aba]")`: com ícone
  dentro do botão, o alvo do evento é o filho, que não carrega o `data-aba`.
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
  fora do `NEXOS_HOME`. Exigia o token bearer, mas escapava do diretório de estado. Consulta de
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
- Pacotes internos (`@nexos/daemon`, `@nexos/shared`) marcados como `private` — não são publicáveis
  por acidente.
