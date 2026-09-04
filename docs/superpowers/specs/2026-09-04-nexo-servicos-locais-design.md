# Nexo — gestão de serviços locais (design)

Data: 2026-09-04
Status: aprovado pelo usuário, aguardando plano de implementação

## Problema

Um projeto real tem mais de um servidor local. No caso que motivou este design: Vite na `5173` e uvicorn na `8003`. Hoje o Nexo:

1. Não sabe que esses serviços existem — subir cada um é trabalho manual, fora do Nexo ou pedindo pro agente rodar como tool call (e aí o processo vive dentro da árvore do CLI, invisível pro Nexo).
2. Guarda **uma** URL por projeto no painel Browser, sem noção de porta, processo ou status.
3. Quando o iframe do Browser falha em carregar (conexão recusada), o Chromium não renderiza página de erro nenhuma: dá branco puro, sem uma palavra de explicação.

Os três são a mesma lacuna: o Nexo não tem o conceito de "serviço local deste projeto".

## Objetivos

1. Declarar os serviços do projeto num arquivo versionado; o agente pode escrever esse arquivo via chat.
2. Subir, derrubar e reiniciar serviço com um clique, sem sair do Nexo.
3. Status visível de qualquer tela, sem trocar de painel.
4. Ler o log de um serviço sem terminal externo.
5. Preview que falha explica o motivo em vez de mostrar branco.

## Fora do escopo

- Detecção automática de serviços (decidido contra: heurística sem fim, erra em stack fora do padrão).
- Docker / docker-compose.
- Ordem de dependência entre serviços (`api` antes de `web`).
- Supervisão: reinício automático em crash.
- Editar o `nexo.json` pela UI — pede-se ao agente, ou edita-se o arquivo.

## Declaração: `nexo.json` na raiz do projeto

```json
{
  "services": [
    {
      "id": "web",
      "name": "Frontend (Vite)",
      "cmd": "npm run dev",
      "cwd": ".",
      "url": "http://localhost:5173",
      "autostart": true
    },
    {
      "id": "api",
      "name": "Backend (uvicorn)",
      "cmd": "python -m uvicorn main:app --reload --port 8003",
      "cwd": "backend",
      "url": "http://127.0.0.1:8003/docs",
      "autostart": true,
      "env": { "PYTHONUNBUFFERED": "1" }
    }
  ]
}
```

| Campo | Obrigatório | Regra |
|---|---|---|
| `id` | sim | slug `[a-z0-9-]+`, único no projeto. Identifica o serviço na API, na UI e no arquivo de pid |
| `name` | não | rótulo da UI; sem ele, usa o `id` |
| `cmd` | sim | linha de comando como o usuário digitaria. Roda via shell (`cmd /d /s /c` no Windows, `sh -c` no resto) |
| `cwd` | não | relativo à raiz do projeto, default `.`. **Não pode escapar da raiz** — mesma regra do `boundPath` (desktop) e do `sandbox.ts` (daemon) |
| `url` | não | o que a sonda testa e o que o botão "abrir no Browser" carrega. Serviço sem `url` (worker, fila) mostra só status de processo |
| `autostart` | não | default `false`. Só vale em projeto confiável (ver abaixo) |
| `env` | não | variáveis extras, mescladas sobre o ambiente do daemon |

Arquivo inválido (JSON quebrado, `id` repetido, `cmd` ausente, `cwd` escapando) não derruba nada: a seção de serviços mostra o erro de parse e nenhum serviço.

### Confiança do projeto

`nexo.json` é um arquivo do repositório que diz qual comando executar. Abrir o repositório de terceiro com `autostart: true` seria execução de código arbitrário na máquina do usuário.

Mitigação: `autostart` só é honrado em caminho de projeto marcado como confiável. Na primeira vez que o Nexo vê um `nexo.json` num projeto novo, pede confirmação ("confio neste projeto?") e grava o caminho aprovado em `~/.nexo/config.json` (`trustedProjects: string[]`). Sem confiança, os serviços aparecem na lista, mas só sobem por clique explícito. Mesmo modelo do workspace trust do VSCode.

## Arquitetura

Quem sobe os processos é o **daemon**, não o Electron. Razões: o serviço sobrevive a fechar a janela, funciona com `nexo` puro no terminal (objetivo do v1 original), e reusa o que já existe lá (`kill-tree.ts`, pid em `~/.nexo/run/`, varredura de órfão no `nexo up`).

Novo módulo `apps/daemon/src/services.ts`:

| Função | Faz | Não faz |
|---|---|---|
| `listServices(projectPath, home)` | lê e valida `nexo.json`, devolve declaração + status | não spawna |
| `startService(projectPath, id, home)` | spawn via shell, grava pid, começa a capturar saída | não sonda porta |
| `stopService(projectPath, id, home)` | `killTree` do pid, limpa o arquivo de pid | não apaga log |
| `restartService(projectPath, id, home)` | stop + start | — |
| `serviceLogs(projectPath, id)` | devolve o ring buffer atual | não persiste em disco |
| `probe(url)` | requisição HTTP curta em loopback | não conhece serviço |

Processo é chaveado por `projectPath + id`: o daemon é global e vários projetos podem estar abertos ao mesmo tempo.

Pid: `~/.nexo/run/svc-<hash do projectPath>-<id>.pid`, seguindo o padrão do `enginePidPath`.

Ciclo de vida:

- `nexo up` varre pid de serviço órfão e mata, igual já faz com pid de motor.
- `nexo down` / SIGTERM derruba todo serviço vivo: são filhos nossos, não devem sobreviver ao daemon.
- Serviço que morre sozinho vira status `exited` com o código, preservado até o próximo start.

Log: ring buffer em memória, teto de 64 KB por serviço. Não vai pro disco e não entra no JSONL da thread — log de servidor não é histórico de conversa.

## Status: dois sinais, não um

| Sinal | Valores | Origem |
|---|---|---|
| processo | `off` \| `running` \| `exited` (+ código) | o pid é nosso, o daemon sabe |
| porta | `unknown` \| `up` \| `down` | sonda HTTP na `url` |

Os dois são necessários: o uvicorn fica `running` alguns segundos antes de escutar na porta, e a porta pode estar ocupada por um processo que não é o nosso.

Bolinha na UI: verde = `running` + porta `up`; âmbar = `running` + porta não responde ainda; vermelho = `off` / `exited`; cinza = sem `url` (só processo).

### Sonda

`GET /v1/probe?url=…` — requisição curta (timeout 1500 ms) que devolve `{ ok, status?, error? }`.

Restrição de segurança: aceita só `http`/`https` com host de loopback (`localhost`, `127.0.0.1`, `[::1]`). Qualquer outro host é recusado com 400 — sem isso o endpoint viraria proxy aberto/vetor de SSRF, já que o daemon não tem as restrições de CSP do renderer.

A sonda vive no daemon (e não no renderer) por dois motivos: o CSP do desktop libera `connect-src` só pra `http://127.0.0.1:*`, então o renderer não conseguiria sondar `http://localhost:5173`; e o mesmo endpoint serve o CLI.

## Preview que falha explica o motivo

Dois sinais independentes, porque cobrem falhas diferentes:

1. **Sonda** — antes/depois de carregar no painel Browser, o desktop consulta `/v1/probe`. Falhou: mostra sobreposição no lugar do branco — `127.0.0.1:8003 não respondeu (conexão recusada) · serviço "api" parado — [Rodar]`. O botão só aparece quando existe serviço declarado com aquela URL.
2. **`did-fail-load` de subframe** — o `main.mjs` escuta esse evento do webContents e repassa por IPC. Pega o caso que a sonda não detecta: servidor que responde bem por HTTP mas recusa ser embutido em iframe (`X-Frame-Options`, `frame-ancestors`). Mensagem diferente: o servidor está no ar, mas proíbe embutir — com atalho pra abrir no navegador do sistema (`shell:external` já existe).

## UI: faixa na sidebar

Seção nova na `<aside class="side">`, entre a árvore de repositórios e o rodapé (pet + botões), colapsável:

```
SERVIÇOS
● Frontend (Vite)     5173   ▷ ■
● Backend (uvicorn)   8003   ▷ ■
```

- Uma linha por serviço: bolinha de status, nome, porta (extraída da `url`), botões rodar/parar.
- Clicar no nome abre o log num painel sobreposto, no estilo do `.meter-more` que já existe (mesma linguagem visual, `<pre>` com rolagem automática).
- Projeto sem `nexo.json`: a seção não aparece. Sem seção vazia poluindo a barra.
- A sidebar já é disputada (repos + conversas + pet + rodapé): a faixa é de uma linha por serviço e colapsa.

## HTTP

Prefixo `/v1`, mesma autenticação bearer dos outros endpoints.

| Método | Path | Ação |
|---|---|---|
| GET | `/services?projectPath=` | declaração + status de cada serviço |
| POST | `/services/:id/start` | `{ projectPath }` |
| POST | `/services/:id/stop` | `{ projectPath }` |
| POST | `/services/:id/restart` | `{ projectPath }` |
| GET | `/services/:id/logs?projectPath=` | ring buffer atual |
| GET | `/services/events?projectPath=` | SSE: mudança de status + linha de log |
| GET | `/probe?url=` | sonda de loopback |

Serviço não declarado → 404. `nexo.json` inválido → 422 com o erro de parse. Start em serviço já rodando → 200 idempotente (não spawna segundo processo).

## CLI

```
nexo svc ls                 # lista serviços do cwd + status
nexo svc up <id> | --all    # sobe
nexo svc down <id> | --all  # derruba
nexo svc logs <id>          # despeja o buffer e segue acompanhando
```

## Erros

| Caso | Comportamento |
|---|---|
| `nexo.json` ausente | sem serviços; nada aparece na UI |
| `nexo.json` inválido | erro de parse na UI, nenhum serviço listado |
| `cwd` escapando da raiz | serviço recusado na validação, com motivo |
| `cmd` que sai imediatamente | status `exited` + código; log preserva a saída |
| porta ocupada por processo alheio | o comando falha ao subir: processo `exited`, mas a porta responde `up`. Bolinha vermelha (manda o processo), e o log mostra o motivo real (`address already in use`) |
| daemon cai com serviço no ar | pid em disco; `nexo up` varre e mata órfão |
| projeto não confiável | `autostart` ignorado; serviço só sobe por clique |

## Testes

- `services.ts`: parse e validação (`id` repetido, `cmd` ausente, `cwd` com `..`), start/stop com script fixture de processo longo (padrão dos fixtures `fake-*.mjs` que já existem), ciclo do arquivo de pid, teto do ring buffer.
- `probe`: recusa host fora de loopback (400), `down` em porta fechada, `up` contra servidor HTTP de teste (padrão do `api-engine.test.ts`).
- HTTP: caminho felizes dos endpoints, 404 de serviço desconhecido, 422 de arquivo inválido, start idempotente.
- Confiança: `autostart` não sobe nada em projeto fora de `trustedProjects`.

## Critério de pronto

- [ ] `nexo.json` com dois serviços (Vite + uvicorn) aparece na faixa da sidebar com status correto.
- [ ] Rodar/parar pela UI funciona e o status acompanha (âmbar → verde conforme a porta sobe).
- [ ] Log de cada serviço legível na UI, com rolagem automática.
- [ ] Preview de porta morta mostra o motivo e o botão de rodar — nunca tela branca.
- [ ] Servidor que recusa iframe mostra mensagem própria e atalho pro navegador do sistema.
- [ ] `nexo down` não deixa serviço órfão.
- [ ] `autostart` ignorado em projeto não confiável.
