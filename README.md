# Nexo

Orquestrador local de agentes de código. Um daemon roda em `127.0.0.1`, fala com CLIs de
agente já instaladas na máquina (Claude Code, Codex) ou com API, e um app Electron serve
de interface: chat, árvore de arquivos, terminal, preview, gestão de serviços do projeto,
criação de agentes com bancada de teste e times que rodam esses agentes em sequência, em
paralelo ou sob um supervisor que decide quem trabalha.

Tudo é local: nenhum dado sai da máquina além do que a própria CLI do agente já manda pro
provedor dela.

## Requisitos

- Node.js 20+
- pnpm 9 (`corepack enable`)
- Para o motor `claude`/`codex`: a CLI correspondente instalada e logada
- Para o motor `api`: uma chave do provedor (guardada em `~/.nexo/profiles/<id>/`)

## Instalação

```bash
pnpm install
```

## Uso

```bash
pnpm up          # sobe o daemon (http://127.0.0.1:7432)
pnpm desktop     # abre o app Electron
pnpm test        # testes do daemon e do app (vitest)
pnpm typecheck   # tsc --noEmit nos pacotes TypeScript
pnpm check       # typecheck + testes (é o que o CI roda)
```

No Windows, `run.bat` instala as dependências se faltarem e abre o app.
`make-shortcut.ps1 -Desktop` cria um atalho que abre o app sem console.

### CLI

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

## Estrutura

```
apps/daemon      servidor HTTP (Hono) + CLI + motores
apps/desktop     app Electron (main/preload/renderer + módulos do renderer)
packages/shared  tipos e constantes compartilhados
docs/            specs e plano de implementação
```

Nenhum pacote compila: o daemon roda via `tsx` e o `@nexo/shared` é consumido como fonte
(`exports` aponta para o `.ts`). O `tsc` existe só como checador (`pnpm typecheck`).

## Estado no disco

Tudo fica em `~/.nexo` (ou `NEXO_HOME`):

| caminho | conteúdo |
| --- | --- |
| `config.json` | porta, perfis de fallback, tema, projetos |
| `profiles/<id>/` | credenciais e config por perfil |
| `threads/<id>.jsonl` | histórico das conversas |
| `attachments/<thread>/` | imagens anexadas |
| `agents.json` | agentes personalizados |
| `teams.json` | times de agentes |
| `runs/<id>/` | execução de time: `run.json` e o artefato de cada passo |
| `daemon.token` | token bearer da API local (modo `0600`) |
| `run/` | PIDs do daemon e dos motores |

Nada disso está no repositório — e não deve ser commitado.

### Como um time trabalha

| topologia | quem roda | pra quê |
| --- | --- | --- |
| sequência | um por vez, a saída de um vira a entrada do próximo | escrever e depois revisar |
| paralelo | todos menos o último ao mesmo tempo; o último junta | várias leituras independentes do mesmo código |
| supervisor | o primeiro decide quem chamar, uma rodada por vez, até encerrar | trabalho cujo caminho não dá pra escrever antes |

O supervisor manda por um de dois canais:

- **por turno** (padrão): ele responde a ordem em texto, o daemon executa e volta com o resultado
  no turno seguinte da mesma conversa. Custa **um turno por decisão** e roda em qualquer motor.
- **por ferramenta (MCP)**: o daemon vira servidor MCP e ele chama os membros sem sair do turno —
  o run inteiro cabe num turno só. Só em conta `claude`; nas outras o Nexo cai de volta pro canal
  por turno e registra o motivo em `canalOff`.

Nos dois casos quem executa o membro é o daemon, e quantas rodadas vão acontecer é o supervisor
quem escolhe — use `maxSteps` no orçamento do run pra fechar a conta.

### O que o Nexo escreve no SEU repositório

Um time em paralelo (fan-in) dá a cada membro uma árvore de trabalho própria via `git worktree`,
num branch `nexo/<run>/<n>-<agente>`. A árvore sai do disco quando o run acaba; **o branch fica**,
porque é ele que guarda o que o agente fez. Nada é mesclado automaticamente — quem decide o que
fazer com o trabalho é você:

```bash
git branch --list 'nexo/*'          # o que os agentes produziram
git diff master..nexo/<run>/1-<ag>  # o que um membro mudou
git branch -D nexo/<run>/1-<ag>     # descartar
```

Projeto que não é repositório git roda igual, mas sem isolamento: os membros paralelos dividem a
mesma pasta e vão se atropelar se escreverem arquivo. O run registra isso, e a tela avisa.

## Painel flutuante

`Ctrl+Shift+W`, o botão **Painel** no rodapé ou a bandeja abrem uma janela pequena que fica sempre
por cima: passo do run em andamento, conversas trabalhando, quota por conta e custo acumulado. Ela
existe pra responder "está andando?" sem trazer o Nexo pra frente — um time roda por minutos
enquanto você está no editor. Arraste pela faixa do título; ela reabre onde estava.

## Segurança

- O daemon só escuta em `127.0.0.1`. Toda rota `/v1/*` exige `Authorization: Bearer <token>`,
  com o token sorteado a cada subida e gravado em `~/.nexo/daemon.token`.
- O terminal e a árvore de arquivos do app são presos à pasta do projeto aberto
  (resolução de symlink inclusa).
- O app dá ao agente acesso de leitura/escrita e execução de comandos no projeto aberto.
  Trate como o que é: um shell com um modelo na frente. Não aponte para pastas que você
  não confiaria a um script de terceiros.

## Licença

MIT — ver [LICENSE](LICENSE).
