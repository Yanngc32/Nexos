# Nexo v1 — design

Data: 2026-09-02  
Status: aguardando revisão do usuário  
Nome de trabalho: `nexo` (renomear depois não muda o desenho)

## Problema

Trocar de conta ou de produto LLM (Claude Code, Codex, API) no meio de um trabalho de código hoje perde o contexto: cada ferramenta guarda a conversa no formato dela, com uma login só.

Nexo é um daemon CLI + desktop que **é o dono do histórico** e usa os CLIs oficiais (ou API key) só como motor.

## Fora de v1

- Cursor como motor (ToS + sem CLI estável pra wrap)
- Agente próprio (loop de tools reimplementado)
- Diff visual / editor de arquivo no desktop
- Tools no `adapter-api` (chat only)
- Sandbox estrito (bloquear path fora do projeto no CLI filho)
- Resumo de contexto via LLM extra na troca
- Multi-root workspace
- Bind de rede fora de localhost
- Login OAuth desenhado por nós (usa o login do CLI do produto)

## Objetivos de v1

1. Uma thread sobrevive a troca de perfil/produto e a restart do app.
2. Contas do mesmo produto não se pisam (perfil = pasta isolada).
3. Quota/rate-limit **não** troca motor sozinho: toast pede confirmação.
4. Processo do agente nasce com `cwd` na pasta do projeto (escape de path pelo CLI filho = limitação conhecida).
5. Dá pra usar só o CLI, sem desktop.

## Arquitetura

Dois processos. O desktop nunca spawna `claude`/`codex`.

```
nexo-desktop (Tauri 2)
        │  HTTP 127.0.0.1 + bearer de sessão
        ▼
nexo (daemon TypeScript)          ← mesmo binário do CLI
        │
        ├─ ~/.nexo/profiles/<id>/     credencial isolada do CLI
        ├─ ~/.nexo/threads/<id>.jsonl fonte da verdade da conversa
        ├─ ~/.nexo/config.json        ordem de fallback, porta, token
        │
        └─ engines
             adapter-claude  → spawn `claude` com env do perfil
             adapter-codex   → spawn `codex`  com env do perfil
             adapter-api     → Anthropic / OpenAI / Gemini (key no perfil)
```

Windows: raiz de dados = `%USERPROFILE%\.nexo\`.  
Linux/macOS: `$HOME/.nexo/`.  
Override: env `NEXO_HOME`.

Bind: `127.0.0.1` apenas. Porta default `7432`, gravada em `config.json`.  
Token: gerado em `nexo up`, arquivo `~/.nexo/daemon.token` mode `0600`. Request sem `Authorization: Bearer` → 401. Host ≠ loopback → recusar.

Uma janela desktop = um `projectPath`. Processo filho nasce com `cwd` = essa pasta. v1 não bloqueia o CLI de escapar do root.

## Monorepo

```
cli/
  apps/daemon/     CLI + HTTP + adapters (TypeScript, Node)
  apps/desktop/    Tauri 2 (webview fala só com o daemon)
  packages/shared/ tipos HTTP, schema JSONL, IDs
```

Package manager: `pnpm`. Daemon publica binário `nexo`. Desktop chama `nexo up` se o daemon não estiver no ar.

## Componentes do daemon

Cada módulo tem uma função, interface estável, teste independente.

| Módulo | Faz | Não faz |
|---|---|---|
| `profiles` | CRUD, pasta isolada, status `unauthenticated` / `ready` | não fala com LLM |
| `threads` | criar/listar, append atômico JSONL, ler histórico | não spawna processo |
| `engines` | contrato `start/send/abort` + eventos | não escolhe perfil |
| `adapter-claude` | spawn, stdin/stdout, mapear quota | não grava JSONL |
| `adapter-codex` | idem | idem |
| `adapter-api` | HTTP streaming oficial, **chat only** | não executa tools |
| `packer` | JSONL → `contextPack` pro motor novo | não chama LLM |
| `router` | perfil ativo da thread, candidato de fallback | não troca sem `confirmed: true` |
| `sandbox` | v1 só força `cwd` = projeto | não intercepta syscall do CLI filho |
| `http` | REST + SSE | não contém regra de negócio |

### Contrato de engine

Todo adapter implementa:

```ts
start(opts: { threadId, projectPath, profileId, contextPack }): Promise<void>
send(text: string): Promise<void>
abort(): Promise<void>
// eventos: text | tool | done | quota | error
```

`tool` é informativo na UI v1 (nome + resumo). O CLI do produto é quem executa o tool. Nexo não reimplementa Read/Write/Bash.

### Isolamento de perfil

`nexo profile add <id> --engine claude|codex|api`

Cria `~/.nexo/profiles/<id>/` com `profile.json`:

```json
{
  "id": "claude-trabalho",
  "engine": "claude",
  "createdAt": "2026-09-02T00:00:00.000Z"
}
```

Adapter declara quais env vars apontam pra essa pasta. v1:

| Engine | Isolamento |
|---|---|
| `claude` | `CLAUDE_CONFIG_DIR` = `profiles/<id>/claude` (criar a pasta antes do spawn) |
| `codex` | `CODEX_HOME` = `profiles/<id>/codex` (pasta **tem que existir** antes do spawn; exigência do CLI) |
| `api` | `profiles/<id>/keys.json` (`provider`: `anthropic` \| `openai` \| `gemini`, `apiKey`, `model`). Nunca copiar key pro JSONL |

`adapter-api` em v1 é **chat only**. Sem tools, sem editar arquivo. Toast de fallback tem que dizer isso: “Ir para `{perfil api}` (chat, sem tools)?”. Agente com tools = só `claude` e `codex` nesta fatia.

`nexo login <id>`: spawna o comando de login do CLI **no env do perfil**. Perfil só fica `ready` quando o adapter reporta credencial presente. Chat com perfil `unauthenticated` → 409 com mensagem pra rodar login.

Duas contas Claude = dois `id` = duas pastas. Nenhum adapter usa o `$HOME` global do usuário pro config do produto.

`profile add` falha cedo se o binário do engine não está no PATH (`claude` / `codex`), exceto `engine=api`.

### CLI

```
nexo up                         # sobe daemon (foreground). segundo up na mesma porta: erro.
nexo down                       # derruba
nexo login <perfil>
nexo profile add|ls|rm|use
nexo thread new|ls|show         # show imprime JSONL
nexo chat                       # REPL no cwd (cwd = projeto)
nexo switch <perfil>            # na thread ativa do REPL; equivalente HTTP com confirmed=true
```

Sem UI, o fluxo de quota no REPL é pergunta no stdin (`ir para <perfil>? y/n`). Mesma regra: sem confirmação não troca.

## Schema da thread (JSONL)

Um arquivo por thread: `~/.nexo/threads/<threadId>.jsonl`.  
Uma linha = um evento. Append-only. Nunca reescrever linha antiga.

Campos comuns: `ts` (ISO-8601), `type`, `threadId`.

Tipos v1:

| `type` | Payload |
|---|---|
| `thread_meta` | `projectPath`, `title` opcional. Primeira linha. |
| `user` | `text` |
| `assistant` | `text` (pode ser várias linhas, uma por flush de stream ou uma no `done` — ver regra abaixo) |
| `tool` | `name`, `summary` |
| `switched` | `fromProfileId`, `toProfileId`, `reason` (`user` \| `quota`) |
| `context_trimmed` | `keptMessages`, `droppedMessages` |
| `error` | `message`, `profileId` |

Regra de assistant: durante o stream, buffer em memória; no evento `done` ou no abort, **uma** linha `assistant` com o texto completo. Crash no meio: no restart, se houver user sem assistant seguinte, a UI mostra a pergunta; o motor **não** inventa a resposta perdida. A pergunta já está no JSONL (gravada **antes** de `send`).

IDs: `threadId` e `profileId` = slug `[a-z0-9-]+`, único.

## Packer

Input: linhas JSONL da thread + teto de tokens do motor destino (número configurável por engine, default conservador).

Output: `contextPack` string.

Regras v1 (determinísticas, sem LLM):

1. Incluir `user` e `assistant` em ordem cronológica.
2. Linha `tool` vira texto: `Agente executou {name}: {summary}`.
3. `switched` e `error` viram uma linha de sistema.
4. Se passar do teto: manter as **N últimas** mensagens user/assistant intactas (N default 20). O prefixo vira um parágrafo único: `Contexto anterior (cortado):` + concatenação truncada dos textos antigos até caber um budget fixo de 2000 caracteres. Gravar `context_trimmed`.
5. O JSONL completo continua no disco. Packer só afeta o que o **motor novo** vê. A UI sempre lê o JSONL inteiro.

## Fluxos

### Mensagem nova

1. `POST /threads/:id/messages` `{ "text": "..." }`.
2. Append `user` no JSONL **antes** de chamar o motor.
3. Se não há processo de engine vivo pra essa thread → `start` com pack atual.
4. `send(text)`.
5. SSE: `text` | `tool` | `done` | `quota` | `error`.
6. No `done`, append `assistant`.
7. Reload da UI = GET do JSONL. UI não é fonte da verdade.

### Quota com confirmação

1. Adapter detecta quota/rate-limit (stderr/stdout conhecido + HTTP 429 no API) → evento `quota` com `suggestedProfileId` (próximo da ordem em `config.json` que esteja `ready` e diferente do atual).
2. Motor **não** troca.
3. Desktop: toast “Quota estourou em `{atual}`. Ir para `{sugerido}`?”. REPL: prompt y/n.
4. Recusa: thread pausada. Cliente pode `switch` pra outro perfil depois.
5. Confirma: `POST /threads/:id/switch` `{ "profileId", "confirmed": true, "reason": "quota" }`.
6. Daemon `abort` do motor atual, append `switched`, packer, `start` no perfil novo, **não** reenvia a última user (já está no pack). O motor novo continua a thread; não dispara resposta sozinho até o user mandar a próxima msg, **exceto** se a quota estourou **no meio** de uma resposta: nesse caso, após switch, daemon manda um `send` sintético `"Continue de onde parou."` uma vez. Marcar na linha `switched` o campo `resume: true` pra não duplicar.

### Switch manual

Mesmo endpoint, `reason: "user"`. Sem `resume` sintético.

### Login

1. `profile add` cria pasta.
2. `login` spawna CLI de login no env isolado (processo TTY no CLI; no desktop, terminal embutido v1 mínimo = abrir o comando e pedir pra voltar quando terminar, depois `profiles` re-checa credencial).
3. Falha de login → perfil permanece `unauthenticated`.

Desktop v1 de login: não precisa embedar TTY completo. Botão “Login” roda `nexo login <id>` num terminal do SO (`wt` / `conhost` no Windows). Depois polling `GET /profiles/:id` até `ready` ou timeout 5 min.

## HTTP (localhost)

Prefixo `/v1`. JSON.

| Método | Path | Ação |
|---|---|---|
| GET | `/health` | daemon up |
| GET | `/profiles` | lista |
| POST | `/profiles` | add |
| POST | `/profiles/:id/login` | dispara login (CLI local) |
| GET | `/threads` | lista (query `projectPath`) |
| POST | `/threads` | `{ projectPath, profileId }` cria |
| GET | `/threads/:id` | eventos (JSON array parseado do JSONL) |
| GET | `/threads/:id/events` | SSE da thread ativa |
| POST | `/threads/:id/messages` | envia user |
| POST | `/threads/:id/switch` | `{ profileId, confirmed, reason }` |
| POST | `/threads/:id/abort` | abort motor |
| GET | `/config` | ordem de fallback |
| PUT | `/config` | atualiza ordem |

`switch` sem `confirmed: true` → 400.  
`switch` com perfil `unauthenticated` → 409.  
Dois switch/send no mesmo `threadId`: lock. Segundo request espera até 10s ou 409.

## Desktop (Tauri 2)

- Bandeja: daemon on/off, abrir janela.
- Janela: abrir pasta (projeto), sidebar de threads, chat stream, seletor de perfil, toast de quota.
- v1 **não** abre diff de arquivo. Mostra eventos `tool` como linhas no chat.
- Se daemon down: banner “motor off” + botão que executa `nexo up`.

## Erros

| Caso | Comportamento |
|---|---|
| CLI crash / exit ≠ 0 | `error` no SSE. Retry **uma** vez no mesmo perfil. Segunda falha → toast/prompt pra API ou outro perfil. JSONL intacto |
| Binário ausente | `profile add` falha |
| Path fora do projeto | v1: `cwd` do processo filho = `projectPath`. Nexo **não** intercepta tools do CLI. O filho ainda pode, na prática, tocar arquivo fora do root. Wrapper/sandbox estrito fica pra v1.1. Teste manual `../fora` é checagem de cwd, não garantia |
| Pack estoura teto | `context_trimmed` + corte heurístico |
| Daemon cai | estado no disco; `nexo up` recupera. Nenhum motor órfão: no `up`, kill de pids gravados em `~/.nexo/run/*.pid` |
| Token HTTP ruim | 401 |

Credencial nunca vai pra log nem JSONL. `adapter-api` lê key do arquivo do perfil na hora do request.

## Config

`~/.nexo/config.json`:

```json
{
  "port": 7432,
  "fallbackOrder": ["claude-trabalho", "claude-pessoal", "codex-main", "api-anthropic"],
  "pack": { "keepLastMessages": 20, "prefixCharBudget": 2000 }
}
```

`fallbackOrder` lista `profileId`. Perfis missing/unauthenticated são pulados na hora de sugerir.

## Testes

CI (sem login real):

- Unidade: packer (ordem, corte, tool→texto), spawn usa `cwd` = `projectPath`, router (nunca troca sem `confirmed`), threads append+reload.
- Contrato adapter: stub binário `claude`/`codex` (script que emite stream, modo `quota`, modo `crash`). Assert eventos + JSONL.
- API adapter: HTTP fake (429 e stream ok).

Manual local (não CI): dois perfis isolados, switch, reload do desktop, histórico idêntico; conferir que o processo filho iniciou com `cwd` no projeto.

## Riscos

- Formato de stream do `claude`/`codex` muda → adapter quebra. Isolar parse num arquivo por engine.
- Isolamento via env var: se o CLI ignorar a var, perfis vazam. v1 documenta a var; teste de contrato verifica que o stub **recebe** a var. Teste manual confirma no CLI real.
- Injeção de contexto no CLI filho é lossy. Aceito em v1. JSONL local não é lossy.
- Subscription vs ToS: v1 só spawna CLI que o usuário já instalou e loga. Não reverse-engineer API do Cursor.

## Critério de pronto (v1)

- [ ] `nexo up` + `nexo chat` numa pasta, mensagem ida e volta com `adapter-api` (CI/fake ou key local).
- [ ] Dois perfis stub, `switch` com `confirmed`, JSONL contém `switched`, UI/REPL mostra histórico completo.
- [ ] Evento `quota` **não** troca perfil até confirmação.
- [ ] Desktop conecta no daemon, stream SSE, toast de quota.
- [ ] Credencial de API não aparece em JSONL nem log de teste.
- [ ] Fallback pra perfil `api` mostra aviso de chat-only (sem tools) antes da confirmação.
