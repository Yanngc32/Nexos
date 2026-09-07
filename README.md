# Nexo

Orquestrador local de agentes de código. Um daemon roda na sua máquina, fala com CLIs de
agente já instaladas nela (Claude Code, Codex) ou com API, e um app Electron serve de
interface: chat, árvore de arquivos, terminal, preview, gestão de serviços do projeto,
criação de agentes com bancada de teste e times que rodam esses agentes em sequência, em
paralelo ou sob um supervisor que decide quem trabalha. Também dá pra acompanhar e
conversar do celular, pela interface web que o próprio daemon serve.

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
apps/mobile      interface de celular (PWA), servida pelo próprio daemon
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

## Do celular

O daemon serve uma interface de celular em `/app/` — sem instalar nada, sem build.
Ela mostra o que está rodando e deixa conversar; árvore de arquivos e terminal ficam
de fora (hoje só existem no processo do Electron, e telefone não é onde se lê diff).

Duas coisas precisam estar no lugar:

1. **O daemon tem que estar alcançável.** O padrão `127.0.0.1` só aceita a própria
   máquina — nem o celular no mesmo Wi-Fi chega. Em **Configurações → Celular**,
   aponte o endereço de escuta pro IP do seu túnel (Tailscale, WireGuard): aí quem
   alcança é só quem está no túnel. Vale a partir da próxima subida do motor.
   `0.0.0.0` publica na rede inteira, e aí o token é a única barreira — não faça
   isso em Wi-Fi compartilhado.
2. **Pareamento.** Em **Configurações → Celular**, clique em **Gerar código**: aparecem
   um QR e os 6 dígitos. Aponte a câmera do celular pro QR — ele abre a página e conecta
   sozinho. Sem câmera, abra `http://<host>:<porta>/app/` e digite os dígitos. Vale 2
   minutos, serve uma vez, e 5 erros o queimam.

   **O QR carrega o endereço e o código — nunca o token.** É por isso que ele é aceitável:
   quem fotografa a tela leva um código que expira em 2 minutos e serve uma vez, não uma
   credencial permanente. O QR só poupa você de digitar `http://100.101.102.103:7432/app/`
   num teclado de telefone.

Ali no celular, **Adicionar à tela de início** deixa o Nexo como um app. O token fica
guardado no navegador; o daemon sorteia um novo a cada subida, então despareaer é normal —
a tela do código volta e você pareia de novo.

## Painel flutuante

`Ctrl+Shift+W`, o botão **Painel** no rodapé ou a bandeja abrem uma janela pequena que fica sempre
por cima: passo do run em andamento, conversas trabalhando, quota por conta e custo acumulado. Ela
existe pra responder "está andando?" sem trazer o Nexo pra frente — um time roda por minutos
enquanto você está no editor. Arraste pela faixa do título; ela reabre onde estava.

O que ela mostra é do **projeto aberto** (o cabeçalho diz qual). A quota é exceção: é da conta, não
do projeto. Sem projeto aberto, ela mostra tudo que o daemon está fazendo.

## Segurança

- O daemon escuta em `127.0.0.1` por padrão — nada de fora da máquina alcança. Isso é
  configurável (ver [Do celular](#do-celular)), e mudar é uma escolha de segurança: fora do
  loopback, quem alcançar a porta só é barrado pelo token, e não há TLS.
- Toda rota `/v1/*` exige `Authorization: Bearer <token>`, com o token sorteado a cada subida
  e gravado em `~/.nexo/daemon.token` (modo `0600`). A única exceção é `POST /pair`, que
  existe pra entregar o token a um celular que ainda não tem — e só serve com um código de
  6 dígitos que vale 2 minutos, serve uma vez e queima em 5 erros. O QR que a tela mostra
  carrega esse código e o endereço; o token não aparece em tela nenhuma.
- O terminal e a árvore de arquivos do app são presos à pasta do projeto aberto
  (resolução de symlink inclusa).
- O app dá ao agente acesso de leitura/escrita e execução de comandos no projeto aberto.
  Trate como o que é: um shell com um modelo na frente. Não aponte para pastas que você
  não confiaria a um script de terceiros.

## Licença

MIT — ver [LICENSE](LICENSE).
