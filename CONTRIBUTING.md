# Contribuindo com o Nexo

Obrigado pelo interesse. Este arquivo não é etiqueta: são as decisões do projeto que
não se descobrem lendo o código de fora, e que já custaram commit de correção quando
foram violadas sem intenção.

Se algo aqui estiver errado ou desatualizado, abrir issue sobre isso é contribuição.

## O básico

```bash
pnpm install          # pnpm 9, Node >= 20
pnpm check            # typecheck + testes: é o que o CI roda
```

`pnpm check` é o portão. Se ele passa, o CI provavelmente passa — com uma ressalva
importante, na seção de portabilidade abaixo.

Para rodar de verdade: `pnpm up` sobe o daemon, `pnpm desktop` abre o app.

## Nada compila. Isto é de propósito.

Não existe passo de build em lugar nenhum do repositório:

- o daemon roda via `tsx`, direto do `.ts`;
- o `@nexo/shared` é consumido como **fonte** — o `exports` do `package.json` aponta
  para `./src/index.ts`, não para um `dist/`;
- o `apps/desktop` é JavaScript puro (`.mjs`/`.js`), sem transpilação;
- o `apps/mobile` é HTML/CSS/JS servido cru pelo daemon.

Então o `tsc` aqui é **só checador**: `pnpm typecheck` roda com `noEmit`. Não adicione
um passo de build, um bundler, nem um `dist/` — a ausência deles é o que faz `git pull`
já ser suficiente para rodar, e o que faz o daemon subir sem etapa intermediária.

Consequência prática: `apps/desktop` **não tem `typecheck`**, porque não tem TypeScript.
`pnpm -r typecheck` roda no daemon e no shared, e é isso.

## `apps/mobile` não tem `package.json`

E não deve ganhar um. Sem manifesto, o pnpm ignora a pasta — que é o que se quer, já
que ela não tem dependência nenhuma e é servida como arquivo estático pelo daemon
em `/app/`.

O efeito colateral é que ela também não tem lugar próprio para testes. Os testes do
código do celular moram em **`apps/desktop/test/`** (veja `mobile-pareamento.test.js`),
que é o workspace com `happy-dom` configurado. Sim, é estranho; a alternativa era um
manifesto inteiro para hospedar um `vitest`.

## Portabilidade: o Windows é usuário de primeira classe

O app é usado no Windows, e a matriz do CI roda `ubuntu-latest` e `windows-latest` ×
Node 20 e 22 justamente porque `pnpm check` na sua máquina cobre **um** sistema
operacional. As três armadilhas que já quebraram o CI deste repo:

1. **Caminho a partir de `import.meta.url`.** Use `fileURLToPath`, nunca
   `new URL(import.meta.url).pathname` — no Windows este devolve `/D:/a/...` e o
   `join` produz `D:\D:\a\...`. Existe um teste (`apps/daemon/test/caminhos.test.ts`)
   que varre as fontes e falha se o padrão errado voltar.
2. **Fim de linha.** O `core.autocrlf` do git faz checkout com CRLF no Windows. Teste
   que **lê arquivo do repositório** precisa normalizar na leitura
   (`.replace(/\r\n/g, "\n")`), senão `startsWith("---\n")` é falso lá e verdadeiro aqui.
3. **Nome de arquivo.** Dois-pontos é ilegal no Windows. Qualquer identificador que
   vire nome de arquivo (thread, run, pid) não pode conter `:`.

Não tem como testar isso localmente sem um Windows. O que dá para fazer é conhecer a
lista e reler o próprio diff contra ela.

## Dependências: a barra é alta

O `apps/daemon` tem três dependências de runtime, e isso é uma característica, não um
acidente. Antes de propor uma nova, considere:

- ela exige **compilação nativa**? Então está fora. O daemon roda sem build, e
  `node-gyp` na máquina do usuário é exatamente o que se está evitando. (Foi por isso
  que o SQLite ficou de fora e o histórico é JSONL append-only.)
- o `apps/desktop` alcança `node_modules`? O renderer **não** alcança. Código de
  renderer que precisa de biblioteca ou é escrito à mão ou passa pelo processo main.

## Testes

`vitest`. Os testes do daemon ficam em `apps/daemon/test/`, os do desktop (e do
celular) em `apps/desktop/test/`.

As CLIs de agente (`claude`, `codex`) são substituídas por fixtures em
`apps/daemon/test/fixtures/` — nenhum teste gasta quota de ninguém nem depende de rede.

Duas coisas que a experiência deste repo ensinou, e que valem como pedido:

- **Teste não substitui dirigir a coisa real.** As falhas mais graves que apareceram
  aqui — uma rota de API sem autenticação, dois daemons na mesma porta, um QR que não
  fazia nada com o app já aberto — nenhuma foi encontrada por teste. Foram encontradas
  usando o programa. Se a sua mudança toca em rede, processo ou tela, rode.
- **Teste que não vigia nada é pior que nenhum.** Se o seu teste depende de um regex
  ou de um formato, acrescente o caso que confirma que ele ainda casa com o jeito
  certo — senão, no dia em que o padrão mudar, ele passa a aprovar tudo em silêncio.

## Commits

O formato é `tipo(escopo): assunto`, assunto em minúscula, no imperativo:

```
fix(skill): caminho quebrava no Windows
feat(contexto): compactação automática
test(skill): CRLF do Windows
```

O corpo importa mais que o assunto. A convenção do repositório é que o corpo explique
o **motivo** — o que se tentou e falhou, por que a alternativa óbvia foi rejeitada, o
que foi medido. O diff já mostra o *o quê*; o histórico existe para guardar o *por quê*,
que é a única parte que não se redescobre lendo o código depois.

Escreva em português, para ficar consistente com o resto (código, comentários,
documentação e histórico estão todos em português).

## Pull requests

- Branch de trabalho é o `dev`; PR vai de `dev` para o `main`.
- Deixe o CI verde antes de pedir revisão. Se ele ficou vermelho, o vermelho é seu —
  não empilhe commit em cima (aconteceu, custou quatro execuções).
- Mudança de comportamento visível pede linha no `CHANGELOG.md`.
- Mudança em API HTTP, estado no disco ou telas pede atualização do `DOC_TEC.md`.

## Segurança

Não abra issue pública para vulnerabilidade — use o relatório privado do GitHub
(aba **Security** → *Report a vulnerability*) com o que dá para reproduzir. Se ele
estiver desabilitado no repositório, abra uma issue pedindo contato, sem o detalhe
técnico.

Duas regras de código que valem menção porque o descuido nelas já foi explorável aqui:

- **No Hono, o middleware autentica por ORDEM DE REGISTRO.** Rota registrada acima do
  `app.use` fica aberta e não dá erro nenhum. Toda rota `/v1/*` vai **abaixo** dele, e
  o `route-guard.test.ts` varre a tabela de rotas para garantir isso — se a sua rota
  precisa mesmo ser pública, ela entra na lista de liberadas *daquele teste*, com o
  motivo escrito. Hoje a lista tem um item só (`/v1/health`).
- **O token nunca viaja no QR nem em URL.** O QR carrega endereço e um código de
  pareamento de uso curto; o token sai do daemon só em resposta autenticada.

## Licença

Contribuição entra sob a licença MIT do projeto (veja `LICENSE`).
