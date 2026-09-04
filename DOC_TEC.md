# Documentação técnica

Estado atual do app. Histórico de mudanças fica no [CHANGELOG.md](CHANGELOG.md).

## Arquitetura

```
apps/desktop     app Electron (main.mjs / preload.mjs / renderer.js) — nenhuma dependência de framework
apps/daemon      servidor HTTP (Hono) + CLI `nexo` + motores de agente
packages/shared  tipos e constantes compartilhados
docs/            specs e plano de implementação
```

Três processos:

1. **Daemon** (`apps/daemon`) — escuta em `127.0.0.1:7432` (porta configurável). Dono de todo o
   estado: perfis, threads, anexos, serviços. Não fala com o disco do projeto, só com `~/.nexo`.
2. **Motor** — um processo por conversa ativa, filho do daemon. É a CLI do agente (`claude`,
   `codex`) ou uma chamada HTTP à API do provedor.
3. **App Electron** — cliente do daemon. O `main.mjs` também é dono do acesso ao disco do projeto
   (árvore de arquivos, terminal), separado do daemon de propósito.

O renderer é `contextIsolation: true`, `nodeIntegration: false`, e só alcança o main pelo
`preload.mjs`. CSP: `default-src 'self'` e `connect-src http://127.0.0.1:*`.

## Estado no disco

Tudo em `~/.nexo` (ou `NEXO_HOME`). Nada disso vai pro repositório.

| caminho | conteúdo | modo |
| --- | --- | --- |
| `config.json` | porta, ordem de fallback, tema, projetos, projetos confiáveis | — |
| `profiles/<id>/profile.json` | motor, status, modelo, effort, permission mode | `0700` na pasta |
| `profiles/<id>/keys.json` | chave de API (engine `api`) | `0600` |
| `profiles/<id>/claude` \| `codex` | credencial isolada da CLI (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) | `0700` |
| `agents/<id>.json` | agentes personalizados | — |
| `threads/<id>.jsonl` | histórico da conversa, um evento por linha | — |
| `attachments/<thread>/` | imagens coladas no chat | — |
| `daemon.token` | token bearer da API local | `0600` |
| `run/` | PIDs do daemon e dos motores | — |

## Motores

| engine | como fala | credencial |
| --- | --- | --- |
| `claude` | spawn da CLI `claude`, stream JSON parseado em `engines/parse-claude.ts` | login da CLI, isolado por perfil |
| `codex` | spawn da CLI `codex` | login da CLI, isolado por perfil |
| `api` | HTTP direto ao provedor | `keys.json` do perfil |
| `stub` | eco determinístico | nenhuma — só testes |

Perfil `claude`/`codex` exige o binário no PATH na criação. `nexo login <id>` roda o login da CLI
com o `CONFIG_DIR` apontado pro perfil, então duas contas do mesmo provedor não se atropelam.
`POST /v1/profiles/:id/import` copia a credencial global do Claude pro perfil.

## API HTTP

Toda rota `/v1/*` exige `Authorization: Bearer <token>`, com o token lido de `~/.nexo/daemon.token`.
Exceções: `/health` e `/v1/health`.

| grupo | rotas |
| --- | --- |
| saúde | `GET /health`, `GET /v1/health` |
| perfis | `GET/POST /v1/profiles`, `GET/PATCH /v1/profiles/:id`, `POST /v1/profiles/:id/import`, `POST /v1/profiles/:id/login` |
| login interativo | `POST /v1/profiles/:id/login/start` \| `/code` \| `/cancel`, `GET .../login/status` |
| contas | `GET /v1/accounts`, `GET /v1/accounts/limits`, `GET /v1/accounts/:id?live=1` |
| threads | `GET/POST /v1/threads`, `GET/DELETE /v1/threads/:id`, `GET /v1/threads/:id/usage`, `POST .../messages` \| `/switch` \| `/abort` \| `/clear` |
| anexos | `GET /v1/threads/:id/attachments/:file` |
| agentes | `GET /v1/agents`, `GET/POST /v1/agents/defs`, `PUT/DELETE /v1/agents/defs/:id` |
| serviços | `GET /v1/services`, `POST /v1/services/trust` \| `/autostart`, `GET /v1/services/:id/logs`, `POST /v1/services/:id/start` \| `/stop` \| `/restart`, `GET /v1/probe` |
| config | `GET/PUT /v1/config` |
| streams (SSE) | `GET /v1/agents/events`, `GET /v1/threads/:id/events`, `GET /v1/services/events` |

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
  ponto pulsando e "trabalhando…".
- **Serviços** — o que o `nexo.json` do projeto declara: status, start/stop/restart, log em
  overlay. Autostart só roda em projeto marcado como confiável (botão "Confiar neste projeto").
- **Rodapé** — status do motor, ligar/desligar, modo foco, configurações.

### Painéis da área de trabalho

| painel | atalho | o que faz |
| --- | --- | --- |
| Arquivos | `Ctrl+G` | árvore e preview do projeto aberto; texto até 256 KB, binário só mostra tamanho |
| Terminal | `Ctrl+J` | PowerShell (Windows) ou bash, preso ao `cwd` do projeto, um comando por vez |
| Browser | `Ctrl+Shift+B` | iframe pra preview de servidor de dev, com limpeza de cache e service worker |
| Canvas | — | área de rascunho |
| Chat | — | conversa com o agente |
| Chat lateral | `Ctrl+Shift+S` | chat junto de outro painel |

Outros atalhos: `Ctrl+P` paleta de comandos, `Ctrl+Shift+A` painel de agentes ativos,
`Ctrl+Shift+F` modo foco, `Ctrl+R` recarregar.

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

### Painel de agentes

Uma linha por conversa com motor de pé: conta, motor, modelo, projeto, prévia do que está sendo
escrito, nome e cor do agente personalizado. Alimentado pelo SSE global.

### Configurações

Três abas: **Aparência** (tema, cor de destaque), **Contas** (cadastro, login, import, modelo,
effort, permission mode, limites) e **Fallback** (ordem de tentativa entre contas).

## CLI

```
nexo up | down
nexo profile add <id> --engine stub|claude|codex|api
nexo profile ls | rm <id>
nexo profile set <id> [--model ...] [--effort ...] [--mode ...]
nexo login <id>
nexo svc ls | up <id>|--all | down <id>|--all | restart <id> | logs <id> | trust
nexo thread new <perfil> | ls [pasta] | show <id>
nexo chat <perfil>
nexo switch <perfil> --thread <id>
```

## Limites de acesso

- Daemon só em `127.0.0.1`; token sorteado por subida (`randomBytes(24)`).
- Árvore de arquivos e terminal do app resolvem symlink e recusam qualquer caminho fora da raiz
  do projeto (`boundPath` em `main.mjs`).
- `shell.openExternal` só aceita `https://`.
- Dentro do projeto aberto, o agente tem leitura, escrita e execução de comando. É um shell com um
  modelo na frente — o limite é a pasta, não a ação.

## Testes

`pnpm test` (vitest, no daemon). Cobre perfis, threads, packer, roteamento de fallback, sessão,
HTTP, login, serviços, anexos, agentes, config, relatório de uso, spawn e kill de árvore de
processo. As CLIs de agente são substituídas por fixtures em `apps/daemon/test/fixtures/`.
