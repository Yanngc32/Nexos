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

### Corrigido

- `run.bat` apontava para um `run.vbs` que não existe; agora indica `make-shortcut.ps1 -Desktop`.

### Alterado

- Metadados de pacote para publicação do repositório: `license: MIT` nos quatro `package.json`,
  `description` e `engines.node >= 20` na raiz.
- `.gitignore` cobre `*.tsbuildinfo` e lixo de editor/SO (`.vscode/`, `.idea/`, `.DS_Store`,
  `Thumbs.db`).

### Segurança

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
