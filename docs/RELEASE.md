# Processo de release do Nexos desktop

## Versionamento

`apps/desktop/package.json → version` segue [SemVer](https://semver.org/lang/pt-BR/):
`MAJOR.MINOR.PATCH`. Enquanto o app não tem base de usuário externa, incrementos são por
julgamento (não há API pública versionada) — `MINOR` pra funcionalidade nova, `PATCH` pra
correção, `MAJOR` reservado pra mudança que quebra dado gravado em `~/.nexos` de versão anterior.

## Cortar uma release

1. Atualizar `apps/desktop/package.json → version`.
2. Mover o conteúdo de `## [Não lançado]` no `CHANGELOG.md` da raiz pra uma seção nova
   `## [X.Y.Z] - AAAA-MM-DD`, deixando `## [Não lançado]` vazio (mantém as subseções
   Adicionado/Corrigido/Alterado/Segurança como cabeçalho, mesmo vazias).
3. Commit desses dois arquivos.
4. `git tag vX.Y.Z` na branch `main`, depois `git push origin vX.Y.Z`.
5. A tag dispara `.github/workflows/release.yml` (runner `windows-latest`), que builda e publica
   o instalador no GitHub Releases — nenhum passo manual de upload.

Publish manual (sem esperar a tag), se precisar: `pnpm --filter @nexos/desktop build:publish`
numa máquina Windows, com `GH_TOKEN` no ambiente (permissão de escrita em Releases do repo).

**Build com `--dir` (sem instalador) não gera `app-update.yml`** — esse arquivo só sai no
build completo (NSIS), então testar auto-update local exige `pnpm run build`, não
`--dir`. Validado nesta sessão: instalador completo gerou `app-update.yml`, o app instalado
alcançou o GitHub de verdade e tratou `No published versions on GitHub` (repo sem tag ainda)
sem derrubar nada — erro só aparece na tela Sobre, banner fica escondido.

**Build local numa pasta sincronizada pelo OneDrive falha com `EPERM: operation not permitted,
rename ... win-unpacked.tmp -> win-unpacked`** — o OneDrive segura o diretório durante a
extração do Electron. Não acontece no runner do GitHub Actions (não sincroniza nada) nem se o
repositório estiver fora de uma pasta sincronizada. Contorno local: apontar a saída pra fora da
árvore sincronizada, ex. `pnpm exec electron-builder --win --config.directories.output=C:\build`.

## O que vai no instalador (e o que não vai)

O motor vai **compilado**: `apps/daemon/scripts/build-bundle.mjs` junta `src/` + `@nexos/shared` +
as dependências JS em `dist/nexos.mjs` (o `deploy:daemon` roda isso antes do `pnpm deploy`). No
`node_modules` do pacote só ficam `web-tree-sitter` e `tree-sitter-wasms` (carregam `.wasm` do
disco). Resultado: ~120 arquivos em vez de ~10.000 — a atualização troca arquivo em segundos.

O **gerador de APK** (`@bubblewrap/core` + ~240 dependências) NÃO vai no instalador: na primeira
geração de APK o daemon baixa `apk-deps-<v>.zip` e guarda em `~/.nexos/apk-deps/v<v>/`
(`src/apk-deps.ts`). O zip mora numa release própria, fora do ciclo das versões do app. Só muda
quando a versão da bubblewrap mudar:

```bash
# 1) suba APK_DEPS_VERSAO em apps/daemon/src/apk-deps.ts
node apps/daemon/scripts/build-apk-deps.mjs
# 2) --latest=false é OBRIGATÓRIO: o electron-updater lê a release "latest" — se ela virasse a
#    do zip, o auto-update do app quebraria
gh release create apk-deps-<v> apps/daemon/dist/apk-deps-<v>.zip --latest=false \
  --title "Dependências do gerador de APK <v>" --notes "Baixado sob demanda pelo Nexos."
```

## Como o app se atualiza sozinho

`electron-updater` (Ticket G, Onda 2 — implementado em `main.cjs`) consulta o feed do
GitHub Releases do `Yanngc32/Nexos` (repositório público — sem token necessário pro feed)
no boot e a cada 4h enquanto o app fica aberto. `autoInstallOnAppQuit` é `false`: a
instalação nunca dispara sozinha, só pelo gate no `before-quit`.

Update baixado (`update-downloaded`) marca um flag; no próximo fechamento do app (janela
fechada, tray "Sair" ou `window.nexo.quitApp()`), o listener de `before-quit` intercepta,
consulta `GET /v1/status/turno-ativo` (daemon) de forma assíncrona e decide:
- `{ ativo: false }` → `autoUpdater.quitAndInstall()` — fecha, instala, reabre sozinho.
- `{ ativo: true }` → fecha normal, sem instalar — o update fica pendente. No próximo
  boot o `electron-updater` reaproveita o instalador já baixado (não baixa de novo) e o
  mesmo gate se repete no fechamento seguinte.

Eventos do updater (`checking`, `available`, `not-available`, `downloading`, `downloaded`,
`error`) chegam ao renderer via IPC `update:status` e pintam dois lugares a partir da mesma
função (`pintarUpdateStatus`, `renderer.js`): o banner no topo do chat (barra de progresso
em `downloading`, botão "Reiniciar agora" em `downloaded`) e a linha de status na tela
Configurações → Sistema → Sobre (que também mostra a versão instalada, via IPC
`app:version`). Sem modal de confirmação separado — o gate de turno-ativo já cobre o "não
interromper o agente", um diálogo a mais seria fricção sem função.

### Troca de pasta (caminho principal desde a 0.7.0)

Com a instalação gravável (padrão: `%LOCALAPPDATA%\Programs\Nexos`), o instalador vira reserva.
`apps/desktop/atualizador.cjs`:

1. `update-available` do electron-updater → baixa o `Nexos-<v>-win.zip` da release (o build gera
   o alvo `zip` junto do NSIS), confere contra o `nexos-portatil.json` (sha512 + tamanho, gerado por
   `scripts/after-all-artifacts.cjs` e publicado junto) e extrai com o `tar.exe` do Windows em
   `Programs\Nexos.proxima`. Banner "pronta" como antes.
2. Fechar o app (turno livre) ou abrir de novo com versão pronta → um PowerShell destacado espera o
   Nexos sair, mata o que roda do exe da pasta (o motor), leva o `Uninstall Nexos.exe`, renomeia
   `Nexos` → `Nexos.antiga` e `Nexos.proxima` → `Nexos`, atualiza a versão em "Aplicativos
   instalados" e abre. Log em `Programs\Nexos.troca.log`.
3. O app novo grava `Nexos.subiu-ok` ao carregar a janela; só então a antiga é apagada. Sem isso em
   90 s, volta a antiga e a versão entra em `Nexos.recusadas.json` (pra ela, só o instalador).

Qualquer falha (Program Files sem escrita, release sem o json, sha512 errado) cai no NSIS de sempre.
A primeira atualização PRA 0.7.0 ainda vai pelo NSIS: quem roda 0.6.x não tem o atualizador novo.

## Assinatura de código

Decisão registrada (não implementado por enquanto): sem certificado de assinatura de código.
O instalador NSIS não assinado dispara o aviso padrão do SmartScreen do Windows ("Editor
desconhecido") — aceito nesta fase pelo custo de um certificado EV/OV frente ao estágio do
projeto. Revisitar se a base de instalação crescer o suficiente pra justificar.

## Escopo de cada wave (referência)

- **Onda 1** — empacotamento sozinho (`electron-builder` + NSIS), este documento, rota
  `GET /v1/status/turno-ativo` no daemon.
- **Onda 2** — empacotar o daemon junto do `.exe` (Ticket E), workflow de CI (Ticket F),
  `electron-updater` no processo main com gate de turno-ativo (Ticket G).
- **Onda 3** — UI de update (banner + progresso, tela "Sobre" com versão e status).
- **Onda 4** — checklist de QA manual ponta-a-ponta antes da primeira release pública (ver
  abaixo).

## Checklist de QA manual (Onda 4)

Roda numa máquina Windows limpa (sem o repo, sem Node — é exatamente o que valida o
empacotamento). Precisa de uma release de verdade publicada (`git tag vX.Y.Z && git push
origin vX.Y.Z`) e de uma versão anterior já instalada pra testar o update em cima.

**Instalação do zero**
- [ ] Baixar o `Nexos Setup X.Y.Z.exe` do GitHub Releases e rodar — o instalador NSIS abre
      sem precisar de Node/pnpm na máquina.
- [ ] SmartScreen mostra o aviso "Editor desconhecido" esperado (sem assinatura de código —
      ver seção acima); "Mais informações" → "Executar assim mesmo" segue normal.
- [ ] App abre, motor sobe sozinho (`ensureDaemon`), consegue logar uma conta e mandar
      mensagem — confirma que `daemon-dist` empacotado funciona sem Node instalado à parte.

**Auto-update**
- [ ] Com uma versão anterior instalada, publicar uma release nova e abrir o app: o banner
      de "Baixando atualização…" aparece com a barra de progresso subindo.
- [ ] Terminado o download, o banner vira "Atualização pronta" com o botão "Reiniciar agora".
- [ ] **Gate de turno ativo**: iniciar uma conversa (deixar o agente rodando um turno) e só
      então clicar "Reiniciar agora" (ou fechar o app) — o app deve fechar SEM instalar (o
      turno não pode ser interrompido). Reabrir e fechar de novo com o motor ocioso: agora
      instala e reabre na versão nova.
- [ ] Configurações → Sistema → Sobre mostra a versão certa antes e depois do update, e
      "Verificar agora" funciona sem update pendente (mostra "você está na versão mais
      recente").
- [ ] Update falho (ex.: sem internet) não derruba o app — banner/Sobre mostram o erro e o
      app segue funcionando normal.

**Desinstalação**
- [ ] Desinstalar pelo painel do Windows remove o app; `~/.nexos` (config, conversas, tokens)
      continua no disco — desinstalar não é "esquecer" o usuário.
