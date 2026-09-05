# Nexo

Orquestrador local de agentes de código. Um daemon roda em `127.0.0.1`, fala com CLIs de
agente já instaladas na máquina (Claude Code, Codex) ou com API, e um app Electron serve
de interface: chat, árvore de arquivos, terminal, preview e gestão de serviços do projeto.

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
| `daemon.token` | token bearer da API local (modo `0600`) |
| `run/` | PIDs do daemon e dos motores |

Nada disso está no repositório — e não deve ser commitado.

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
