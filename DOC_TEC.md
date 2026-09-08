# Documentação técnica

Estado atual do app. Histórico de mudanças fica no [CHANGELOG.md](CHANGELOG.md).

## Arquitetura

```
apps/desktop     app Electron (main.cjs / preload.cjs / renderer.js) — nenhuma dependência de framework
apps/daemon      servidor HTTP (Hono) + CLI `nexo` + motores de agente
packages/shared  tipos e constantes compartilhados
docs/            specs e plano de implementação
```

Três processos:

1. **Daemon** (`apps/daemon`) — escuta em `127.0.0.1:7432` (porta configurável). Dono de todo o
   estado: perfis, threads, anexos, serviços, agentes, times, runs. Não fala com o disco do
   projeto, só com `~/.nexo`.
2. **Motor** — um processo por conversa ativa, filho do daemon. É a CLI do agente (`claude`,
   `codex`) ou uma chamada HTTP à API do provedor.
3. **App Electron** — cliente do daemon. O `main.cjs` também é dono do acesso ao disco do projeto
   (árvore de arquivos, terminal), separado do daemon de propósito. `.cjs` e não `.mjs`/`.js`
   porque `apps/desktop/package.json` declara `"type": "module"`, e o processo main/preload do
   Electron precisa ser CommonJS — a extensão força isso independente do `type` do pacote.

O renderer é `contextIsolation: true`, `nodeIntegration: false`, e só alcança o main pelo
`preload.cjs`. CSP: `default-src 'self'` e `connect-src http://127.0.0.1:*`.

O painel Browser usa `<webview>` (não `<iframe>`) desde a chegada do inspector de elemento —
ver seção própria abaixo. `webviewTag: true` só na janela principal; `will-attach-webview`
trava `preload`/`nodeIntegration`/`contextIsolation` do webview nos valores esperados,
ignorando o que o HTML pedir (proteção padrão do Electron contra HTML comprometido anexando
webview com privilégio a mais).

## Estado no disco

Tudo em `~/.nexo` (ou `NEXO_HOME`). Nada disso vai pro repositório.

| caminho | conteúdo | modo |
| --- | --- | --- |
| `config.json` | porta, ordem de fallback, tema, projetos, projetos confiáveis | — |
| `profiles/<id>/profile.json` | motor, status, modelo, effort, permission mode, janela por modelo | `0700` na pasta |
| `profiles/<id>/keys.json` | chave de API (engine `api`) | `0600` |
| `profiles/<id>/claude` \| `codex` | credencial isolada da CLI (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) | `0700` |
| `profiles/<id>/claude/skills/` | skills que o motor `claude` deste perfil enxerga — sincronizado a partir de `skills/` (ver Skills) | — |
| `agents/<id>.json` | agentes personalizados | — |
| `teams.json` | times de agentes (inclui os ocultos criados por `@menção`, ver Times) | — |
| `threads/<id>.jsonl` | histórico da conversa, um evento por linha | — |
| `attachments/<thread>/` | imagens coladas no chat | — |
| `skills/` | skills globais do Nexo (`SKILL.md` por pasta) — valem em toda conta, não só uma | — |
| `runs/<id>/` | artefato de cada passo de um run (`passo-N-<agente>.md`) | — |
| `daemon.token` | token bearer da API local | `0600` |
| `run/` | PIDs do daemon e dos motores | — |

## Motores

| engine | como fala | credencial |
| --- | --- | --- |
| `claude` | `claude --print --output-format stream-json`, parseado em `engines/parse-claude.ts` | login da CLI, isolado por perfil |
| `codex` | `codex exec --json`, stream parseado em `engines/parse-codex.ts` | login da CLI, isolado por perfil |
| `api` | HTTP direto ao provedor | `keys.json` do perfil |
| `stub` | eco determinístico | nenhuma — só testes |

Perfil `claude`/`codex` exige o binário no PATH na criação. `nexo login <id>` roda o login da CLI
com o `CONFIG_DIR` apontado pro perfil, então duas contas do mesmo provedor não se atropelam.
`POST /v1/profiles/:id/import` copia a credencial global do Claude pro perfil.

MCP: `claude` recebe `--mcp-config` (arquivo `0600`, porque carrega o token) e `codex` recebe
`-c mcp_servers.nexo={url=…,bearer_token_env_var=NEXO_MCP_TOKEN}`, com o token no ambiente do
filho — nem em argv nem em arquivo. As ferramentas de autoria valem nos dois; o servidor do
supervisor, preso ao run, só em `claude`. `api` e `stub` não têm cliente MCP.

O `codex exec` recusa rodar fora de repositório git; o Nexo passa `--skip-git-repo-check` pra o
motor não ser o único a falhar em projeto que funciona nos outros.

## Skills

Um `SKILL.md` (frontmatter `name`/`description` + corpo) em `~/.nexo/skills/<nome>/` vale em
qualquer perfil `claude` — `syncGlobalSkills` (`apps/daemon/src/skills.ts`) copia cada pasta pra
dentro do `CLAUDE_CONFIG_DIR` isolado do perfil a cada turno (é o que faz o CLI de fato enxergar,
já que ele só lê skill do próprio config dir ou do `.claude/skills` do projeto aberto). `nexo
skill install` instala a skill `nexo-times` (o julgamento de quando montar time/agente) nessa
mesma pasta global.

`GET /v1/skills` (menu "/" do composer) lista skill do projeto + perfil + global, mas **só
quando o perfil é `claude`** — `codex`/`api` não leem `SKILL.md`, então listar pra eles anunciaria
uma opção que nunca funciona de verdade no turno.

## Agentes, times e autoria

Agente personalizado (`agents.json`) é conta + instructions + modelo/effort/permissão. Time
(`teams.json`) é uma topologia (`pipeline`, `fanin`, `supervisor`) + membros em ordem, cada um
podendo repetir agente com papel diferente.

Numa conversa normal o modelo só pode **criar/editar** agente e time — nunca executar. É regra
deliberada: quem dispara um run é sempre a pessoa (clique na tela, ou `@menção` no composer — ver
abaixo), porque um run gasta quota de verdade e escreve branch no repositório, enquanto uma
definição errada se corrige em um segundo. Ferramentas MCP da conversa normal
(`mcp__nexo__nexo_contexto` lista contas/agentes/times existentes; `nexo_agente_salvar`;
`nexo_time_salvar`) só escrevem `agents.json`/`teams.json`.

Dentro de um run com topologia `supervisor` e canal `mcp`, o supervisor tem ferramentas
diferentes (`nexo_membros`, `nexo_chamar`) que EXECUTAM membros do próprio run — presas a esse
run pelo caminho (`/v1/mcp/:runId`), pra um token vazado não virar "dispare qualquer agente da
máquina".

**Time oculto de `@menção`** (`upsertTimeDeMencao`, em `teams.ts`): citar `@agente-x` no composer
sem ele já ter um time cria (ou reaproveita, idempotente) um time-pipeline-de-1 com
`origem: "mencao"`. `listTeams`/`GET /v1/teams` filtram esse campo — some da tela — mas
`getTeam` não filtra, então o motor de Run enxerga ele igual a qualquer time salvo.

## Runs

`POST /v1/runs` cria e dispara um time (`teamId` + `projectPath` + `goal`); progresso sai por SSE
(`GET /v1/runs/:id/events`). `fanin` isola cada paralelo numa `git worktree` própria (branch
`nexo/<run>/<n>-<agente>`, que fica depois do run); `supervisor` decide membro a membro, por
turno ou por MCP. `POST /v1/runs/:id/resume` continua do que não ficou `done`. `nexo branch ls |
rm` limpa os branches `nexo/*` que já foram mesclados.

## Composer: `/` e `@`

- **`/comando`**: só quando é a mensagem inteira. Autocomplete lista comando embutido (`/cost`,
  `/clear`…) e skill descoberta (`GET /v1/skills`). Selecionar é só texto — quem interpreta
  `/nome-da-skill` como carregar a skill é a própria CLI por baixo, não o Nexo.
- **`@agente`/`@time`**: em qualquer ponto do texto. Ao enviar, o Nexo (lado desktop,
  `renderer.js`) varre a mensagem por `@<id>` (`mention.js`, `extrairMencoes`) e, pra cada um que
  bate com agente ou time existente, dispara um `POST /v1/runs` EM PARALELO ao turno de chat
  normal — a mensagem inteira ainda vai pro modelo, sem alteração. Agente avulso passa por
  `POST /v1/teams/mencao/:agentId` primeiro (ver time oculto acima). Cada `@menção` é o próprio
  Run; erro numa não impede as outras. Feedback (`Run disparado: …` ou erro) vira uma linha
  discreta na conversa, sem progresso inline — quem quer acompanhar abre o Team Studio.

## Inspector de elemento (painel Browser)

O painel Browser usa `<webview>` porque o preview (`http://127.0.0.1:<porta>`, origem diferente
de `file://`) bloquearia qualquer script do Nexo de tocar no DOM de dentro de um `<iframo>`
comum (Same-Origin Policy) — `<webview>` é o mecanismo do Electron pensado pra isso.

`browser-inspector-preload.cjs` roda dentro do preview (só ele tem Node/Electron; a página
carregada continua sem `nodeIntegration`). Ligado pelo botão da toolbar do Browser
(`nexo-inspector:toggle` via `webview.send`), destaca o elemento sob o mouse (overlay próprio,
não mexe no estilo real) e, no clique, captura seletor/`outerHTML` resumido/texto visível
(`inspector-selector.cjs`, lógica pura) e manda pro host via `ipcRenderer.sendToHost`. O host
acumula numa caixa lateral (`#inspector-box`); "Mandar" monta UMA mensagem (`inspector-mensagem.js`,
`montarMensagem`) com a lista numerada + o pedido livre e chama o envio normal do chat — herda
fila e `@menção` de graça.

## API HTTP

Toda rota `/v1/*` exige `Authorization: Bearer <token>`, com o token lido de `~/.nexo/daemon.token`.
Exceções: `/health`, `/v1/health`, `/pair` (pareamento do celular, com suas próprias travas — ver
Limites de acesso).

| grupo | rotas |
| --- | --- |
| saúde | `GET /health`, `GET /v1/health` |
| pareamento do celular | `POST/GET/DELETE /v1/pair`, `POST /pair`, `GET /v1/escuta`, `POST /v1/token/rotate` |
| interface mobile | `GET /app`, `GET /app/*` |
| perfis | `GET/POST /v1/profiles`, `GET/PATCH /v1/profiles/:id`, `POST /v1/profiles/:id/import`, `POST /v1/profiles/:id/login` |
| login interativo | `POST /v1/profiles/:id/login/start` \| `/code` \| `/cancel`, `GET .../login/status` |
| contas | `GET /v1/accounts`, `GET /v1/accounts/limits`, `GET /v1/accounts/:id?live=1` |
| threads | `GET/POST /v1/threads`, `GET/DELETE /v1/threads/:id`, `GET /v1/threads/:id/usage`, `POST .../messages` \| `/switch` \| `/abort` \| `/clear` |
| anexos | `GET /v1/threads/:id/attachments/:file` |
| projetos | `GET /v1/projects` |
| agentes | `GET /v1/agents`, `GET/POST /v1/agents/defs`, `PUT/DELETE /v1/agents/defs/:id` |
| times | `GET/POST /v1/teams`, `GET/PUT/DELETE /v1/teams/:id`, `POST /v1/teams/mencao/:agentId` |
| runs | `GET /v1/runs`, `GET /v1/runs/atual`, `POST /v1/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/resume` \| `/abort`, `GET /v1/runs/:id/events` |
| MCP | `POST /v1/mcp` (autoria, conversa normal), `POST /v1/mcp/:runId` (supervisor, preso ao run) |
| skills | `GET /v1/skills` |
| serviços | `GET /v1/services`, `POST /v1/services/trust` \| `/autostart`, `GET /v1/services/:id/logs`, `POST /v1/services/:id/start` \| `/stop` \| `/restart`, `GET /v1/probe` |
| config | `GET/PUT /v1/config` |
| streams (SSE) | `GET /v1/agents/events`, `GET /v1/threads/:id/events`, `GET /v1/services/events`, `GET /v1/runs/:id/events` |

## Telas

Layout único: barra lateral fixa + área de trabalho que troca de painel.

### Barra lateral

- **Ações** — lista plana de ícone + rótulo no topo: Nova conversa (segue o projeto ativo),
  Agentes (`Ctrl+Shift+A`, com contador e ícone pulsando quando há agente ocupado) e
  Paleta (`Ctrl+P`).
- **Repositórios** — árvore de pastas abertas; o `+` do cabeçalho abre uma pasta nova e só aparece
  no hover (na barra estreita fica sempre visível). A lista junta o que está no `config.json` com
  o que as conversas gravadas revelam; esconder um repo vence a dedução. Cada repo usa ícone de
  pasta aberta/fechada; o repo ativo marca a pasta com a cor de acento.
- Lista de threads do projeto: uma linha por conversa, título truncado com o texto inteiro no
  tooltip e horário à direita (substituído pelo `×` de apagar no hover). Conversa ocupada mostra
  ponto pulsando e "trabalhando…". Conversa de um run agrupada numa pasta pelo run, fechada por
  padrão.
- **Serviços** — o que o `nexo.json` do projeto declara: status, start/stop/restart, log em
  overlay. Autostart só roda em projeto marcado como confiável (botão "Confiar neste projeto").
- **Rodapé** — status do motor, ligar/desligar, modo foco, configurações.

### Painéis da área de trabalho

| painel | atalho | o que faz |
| --- | --- | --- |
| Arquivos | `Ctrl+G` | árvore e preview do projeto aberto; texto até 256 KB, binário só mostra tamanho |
| Terminal | `Ctrl+J` | PowerShell (Windows) ou bash, preso ao `cwd` do projeto, um comando por vez |
| Browser | `Ctrl+Shift+B` | `<webview>` pra preview de servidor de dev, com limpeza de cache/service worker e inspector de elemento (ver seção própria) |
| Canvas | — | área de rascunho |
| Chat | — | conversa com o agente; `@agente`/`@time` dispara Run em paralelo (ver Composer) |
| Chat lateral | `Ctrl+Shift+S` | chat junto de outro painel |
| Time (Team Studio) | — | editor de membros de um time + execução do run (passos, duração, tokens, custo) |
| Agente (Agent Studio) | — | editor de um agente + bancada de teste |

Outros atalhos: `Ctrl+P` paleta de comandos, `Ctrl+Shift+A` painel de agentes ativos,
`Ctrl+Shift+F` modo foco, `Ctrl+R` recarregar, `Ctrl+Shift+W` painel flutuante.

### Chat

Markdown próprio (código, tabela, título, lista, citação, régua, link `http`/`https`), bloco de
raciocínio recolhível, linha de chamada de ferramenta, aviso de troca de conta e de corte de
contexto. Aceita imagem colada. Comandos de barra:

| grupo | comandos |
| --- | --- |
| Conta | `/account [id]`, `/accounts`, `/switch <id>`, `/login [id]` |
| Sessão | `/cost`, `/context`, `/usage`, `/export`, `/clear` |
| Tarefas | `/init`, `/review`, `/security-review` |
| Ajuda | `/help` |

Mais o que a skill descoberta acrescentar (ver Skills), e `@agente`/`@time` (ver Composer).

### Painel de agentes

Uma linha por conversa com motor de pé: conta, motor, modelo, projeto, prévia do que está sendo
escrito, nome e cor do agente personalizado. Alimentado pelo SSE global. Abas "Meus agentes" e
"Times" abrem o Agent Studio / Team Studio.

### Painel flutuante

Janela própria, sem moldura, sempre por cima — passo do run em andamento, conversas trabalhando,
anéis de quota por conta e custo acumulado. Poll de 2s (8s com motor desligado), do PROJETO
ABERTO, não da máquina inteira.

### Configurações

Três abas: **Aparência** (tema, cor de destaque), **Contas** (cadastro, login, import, modelo,
effort, permission mode, limites) e **Fallback** (ordem de tentativa entre contas).

### Interface de celular (`apps/mobile`)

PWA servida pelo próprio daemon em `/app/`, sem instalar nada. Mostra run em andamento, quota das
contas, lista de conversas do projeto aberto, e permite conversar com stream de verdade. Sem
árvore de arquivos nem terminal (só existem no processo Electron). Pareamento por código curto de
6 caracteres (nunca QR do token), com trava de tempo/tentativa/uso único.

"+ Nova" abre uma folha (bottom sheet) com conta pronta (`status: "ready"`) ou agente
personalizado; tocar cria a thread (`POST /v1/threads`) e já abre o chat. Dentro de uma conversa
de conta `claude`, um botão de ajustes (⚙) abre outra folha com modelo e effort — mesma rota
`PATCH /v1/profiles/:id` do desktop; conta de outro motor ou agente sem conta própria não mostra
o botão. O compositor tem o mesmo menu de autocomplete do desktop: `/skill` (mensagem inteira,
`GET /v1/skills`) e `@agente`/`@time` (em qualquer ponto, `GET /v1/agents/defs` + `GET
/v1/teams`), com `@menção` disparando `POST /v1/runs` em paralelo ao turno de chat — reaproveita
`extrairMencoes` de `mention.js` do desktop, servido via `./comum/` (lista branca do daemon em
`web.ts`).

## CLI

```
nexo up | down
nexo skill install
nexo profile add <id> --engine stub|claude|codex|api
nexo profile ls | rm <id>
nexo profile set <id> [--model ...] [--effort ...] [--mode ...]
nexo login <id>
nexo svc ls | up <id>|--all | down <id>|--all | restart <id> | logs <id> | trust
nexo thread new <perfil> | ls [pasta] | show <id>
nexo branch ls | rm [pasta] [--run <id>]
nexo chat <perfil>
nexo switch <perfil> --thread <id>
```

Windows: `run.bat` instala dependência (via pnpm) e abre o app — checa o binário de
`electron.exe` de verdade, não só a pasta do pacote, porque `pnpm` pode instalar sem baixar o
binário se o postinstall estiver bloqueado (`pnpm approve-builds`). `make-shortcut.ps1` gera
atalho sem console.

## Limites de acesso

- Daemon só em `127.0.0.1`; token sorteado por subida (`randomBytes(24)`).
- Árvore de arquivos e terminal do app resolvem symlink e recusam qualquer caminho fora da raiz
  do projeto (`boundPath` em `main.cjs`).
- `shell.openExternal` só aceita `https://`.
- `<webview>` do painel Browser: `will-attach-webview` trava `preload`/`nodeIntegration`/
  `contextIsolation` nos valores esperados, independente do que o HTML pedir.
- Dentro do projeto aberto, o agente tem leitura, escrita e execução de comando. É um shell com um
  modelo na frente — o limite é a pasta, não a ação.

## Testes

`pnpm test` (vitest) nos dois apps. No daemon: perfis, threads, packer, roteamento de fallback,
sessão, HTTP, login, serviços, anexos, agentes, times (incluindo o time oculto de `@menção`),
runs, skills, config, relatório de uso, spawn e kill de árvore de processo. As CLIs de agente são
substituídas por fixtures em `apps/daemon/test/fixtures/`.

No desktop: módulos puros de UI (`markdown.js`, `format.js`, `url.js`, `file-kind.js`, `mention.js`,
`inspector-selector.cjs`, `inspector-mensagem.js`…) com `happy-dom` ligado por docblock só onde
precisa de DOM. `main.cjs`/`preload.cjs`/`browser-inspector-preload.cjs` (processo
Electron/preload) não têm teste automatizado — só checagem de sintaxe; validação de comportamento
é manual, rodando o app de verdade.
