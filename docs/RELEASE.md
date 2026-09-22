# Processo de release do Nexo desktop

## Versionamento

`apps/desktop/package.json → version` segue [SemVer](https://semver.org/lang/pt-BR/):
`MAJOR.MINOR.PATCH`. Enquanto o app não tem base de usuário externa, incrementos são por
julgamento (não há API pública versionada) — `MINOR` pra funcionalidade nova, `PATCH` pra
correção, `MAJOR` reservado pra mudança que quebra dado gravado em `~/.nexo` de versão anterior.

## Cortar uma release

1. Atualizar `apps/desktop/package.json → version`.
2. Mover o conteúdo de `## [Não lançado]` no `CHANGELOG.md` da raiz pra uma seção nova
   `## [X.Y.Z] - AAAA-MM-DD`, deixando `## [Não lançado]` vazio (mantém as subseções
   Adicionado/Corrigido/Alterado/Segurança como cabeçalho, mesmo vazias).
3. Commit desses dois arquivos.
4. `git tag vX.Y.Z` na branch `main`, depois `git push origin vX.Y.Z`.
5. A tag dispara `.github/workflows/release.yml` (runner `windows-latest`), que builda e publica
   o instalador no GitHub Releases — nenhum passo manual de upload.

Publish manual (sem esperar a tag), se precisar: `pnpm --filter @nexo/desktop build:publish`
numa máquina Windows, com `GH_TOKEN` no ambiente (permissão de escrita em Releases do repo).

**Build local numa pasta sincronizada pelo OneDrive falha com `EPERM: operation not permitted,
rename ... win-unpacked.tmp -> win-unpacked`** — o OneDrive segura o diretório durante a
extração do Electron. Não acontece no runner do GitHub Actions (não sincroniza nada) nem se o
repositório estiver fora de uma pasta sincronizada. Contorno local: apontar a saída pra fora da
árvore sincronizada, ex. `pnpm exec electron-builder --win --config.directories.output=C:\build`.

## Como o app se atualiza sozinho

`electron-updater` (Ticket G, Onda 2) consulta o feed do GitHub Releases do
`Yanngc32/Nexos` (repositório público — sem token necessário pro feed) no boot e a cada
intervalo. Update baixado não é aplicado na hora: `quitAndInstall` só dispara se
`GET /v1/status/turno-ativo` (daemon) responder `{ ativo: false }` — nunca interrompe um
agente no meio de um turno. Com turno ativo, o update fica pronto e é aplicado no próximo
fechamento do app.

## Assinatura de código

Decisão registrada (não implementado por enquanto): sem certificado de assinatura de código.
O instalador NSIS não assinado dispara o aviso padrão do SmartScreen do Windows ("Editor
desconhecido") — aceito nesta fase pelo custo de um certificado EV/OV frente ao estágio do
projeto. Revisitar se a base de instalação crescer o suficiente pra justificar.

## Escopo de cada wave (referência)

- **Onda 1** — empacotamento sozinho (`electron-builder` + NSIS), este documento, rota
  `GET /v1/status/turno-ativo` no daemon.
- **Onda 2** — empacotar o daemon junto do `.exe`, workflow de CI, `electron-updater` no
  processo main.
- **Onda 3** — UI de update (banner, progresso, modal de confirmação) e tela "Sobre".
- **Onda 4** — checklist de QA manual ponta-a-ponta antes da primeira release pública.
