# Nexo Mobile — QR de download de APK Android (spike + Fases 1 e 2)

Data: 2026-09-13
Status: Fase 0 (spike) concluída. Fase 1 (infra do QR) e Fase 2 (build TWA via
`@bubblewrap/core`) implementadas — decisão: **build local por usuário** (exige SDK do Android na
máquina), não um APK genérico com hostname em runtime. Ver
[`apps/daemon/src/apk-build.ts`](../../../apps/daemon/src/apk-build.ts) e a seção "Fase 2" mais
abaixo pro que foi construído e o que não pôde ser validado de ponta a ponta neste ambiente.

Ordem combinada com o usuário, e não reaberta aqui: **PWA (Add to Home) → TWA/Bubblewrap →
Capacitor**, na ordem do menor esforço que resolva o problema. Pair (`#c=` → `POST /pair` →
Bearer) é imutável neste escopo — nada aqui muda contrato de autenticação.

## Fase 0 — o que "Adicionar à tela de início" já cobre

O manifest (`apps/mobile/nexo.webmanifest`) já declara `display: "standalone"`, ícone,
`theme_color` e `background_color` — a base pra um atalho que abre sem barra de endereço
já existe. Mas duas lacunas concretas nesse caminho, achadas lendo o código (não
hipotéticas):

1. **Sem service worker.** `apps/mobile/` não registra nenhum (`grep` por
   `serviceWorker`/`sw.js` no diretório inteiro: zero ocorrências). Isso não impede o atalho
   de aparecer, mas tira dois efeitos que costumam ser o motivo de alguém querer um "app de
   verdade": não sobrevive offline (nem a tela de erro fica bonita) e o Chrome não mostra o
   prompt de instalação rico (`beforeinstallprompt`) sem ele.
2. **Sem HTTPS.** O daemon (`apps/daemon/src/http.ts`, `escuta.ts`) serve tudo em HTTP puro
   — não existe uma linha de TLS/cert no código (`grep` por `tls`/`cert`/`ssl` no daemon:
   zero, fora URLs de terceiros). Critério de instalabilidade do Chrome/Android é HTTPS
   **ou** `localhost` — o daemon nunca é `localhost` do ponto de vista do celular (é sempre
   um IP de LAN ou do Tailscale). Na prática: o Android trata `http://100.x.x.x:7432/app/`
   como origem insegura, e "Adicionar à tela de início" vira um bookmark comum (abre com
   barra de endereço), não o `display: standalone` que o manifest pede.

**Conclusão da spike:** a PWA cobre navegação e uso no dia a dia (o app já funciona pelo
navegador), mas **não** entrega o "parece um app" que costuma ser o pedido real por trás de
"quero um APK" — porque falta HTTPS, não porque falte código de app. Isso muda o cálculo:
TLS no daemon deixa de ser só pré-requisito de TWA (como o plano original supunha) e vira
pré-requisito de a PRÓPRIA PWA instalar direito. Não implementado nesta rodada — seria
escopo de uma spec própria (provável caminho: `tailscale cert` no hostname MagicDNS, que
emite certificado confiável de graça, em vez de CA caseira).

**Go/no-go:** sem HTTPS, nem PWA nem TWA fecham — os dois esbarram no mesmo requisito.
Capacitor (WebView embutido, sem depender de HTTPS) seria o único caminho hoje SE alguém
precisasse de um instalável imediatamente. Recomendação: não construir Fase 2 (pipeline de
APK) até decidir se vale a pena resolver TLS primeiro — resolver TLS destrava PWA
instalável de verdade E o caminho TWA ao mesmo tempo, então é o investimento que mais
compra.

## Fase 1 — infra do QR (implementada)

Dois problemas técnicos do plano original, achados ao ler o gerador de QR e o modelo de
autenticação do daemon, e corrigidos aqui:

1. **QR não cabia.** `apps/desktop/qr.js` é um encoder à mão, capado em ~213 bytes (byte
   mode, correção M, versão 10) — o maior payload até então era o link de pareamento
   (~40 chars). `URL completa + sha256 (64 hex)` não cabe com folga. Resolvido do mesmo
   jeito que o pareamento resolve: o QR carrega **host + porta + um código curto** (6
   caracteres, mesmo alfabeto do pareamento); é o celular que troca o código pela
   informação de verdade, não o QR que carrega tudo.
2. **"Bearer ou one-shot" não podia ficar em aberto.** O ponto do QR de APK é instalar num
   celular que AINDA NÃO tem o app — logo, sem token. Exigir Bearer mataria esse caso.
   Reusar o `vivo` de `pair.ts` (que já é a única exceção de auth do daemon) misturaria
   dois fluxos concorrentes no mesmo slot. Resolvido com um módulo IRMÃO,
   `apps/daemon/src/apk-share.ts`, com o mesmo modelo de ameaça do pareamento (TTL, uso
   único, teto de erros) mas estado próprio — abrir um QR nunca fecha o outro.

### O que existe agora

- `packages/shared/src/index.ts`: `APK_CODE_LEN`, `APK_TTL_MS` (5 min), `APK_MAX_ERROS` —
  constantes próprias, não as de pareamento (evita que mudar uma mude a outra por engano).
- `apps/daemon/src/apk-share.ts`: `abrirDownload` / `downloadAberto` / `fecharDownload` /
  `resgatarDownload`, com teste em `apps/daemon/test/apk-share.test.ts` espelhando
  `pair.test.ts`.
- `apps/daemon/src/apk-pagina.ts`: página HTML solta (não a SPA de `/app/`) que
  `GET /apk` devolve — hoje só duas variantes, "código inválido" e "ainda sem build".
- Rotas em `apps/daemon/src/http.ts`:
  - `GET /apk` — NÃO autenticada (mesma classe de risco do `POST /pair`, mesma trava),
    registrada ANTES do middleware de bearer, nunca sob `/v1/*`.
  - `POST /v1/apk`, `GET /v1/apk`, `DELETE /v1/apk` — autenticadas (depois do middleware),
    visão do desktop: abrir/consultar/fechar um download, espelhando `/v1/pair`.
- Desktop: `apps/desktop/url.js` (`urlDoApk`), botão "Gerar QR de download" no painel
  Celular (`index.html`), lógica em `renderer.js` (`apkMostrar`/`apkPedirCodigo`) — QR e
  timer **completamente separados** dos de pareamento (`apkAberto`/`apkTimer` própria,
  nunca `celPar`/`celTimer`).

## Fase 2 — build do TWA (implementada)

Decisão do usuário: **build local por usuário**, não um APK genérico com hostname configurável em
runtime (a outra opção levantada). Isso mantém a promessa original do plano — keystore em
`~/.nexo`, build disparado do painel Celular — mas exige que a máquina tenha o **SDK do Android**
instalado (`ANDROID_HOME`/`ANDROID_SDK_ROOT`) além de um JDK (`JAVA_HOME`); a imensa maioria de
quem só usa o app de desktop não vai ter isso por padrão. Trade-off aceito explicitamente, não
descoberto depois.

Construído com `@bubblewrap/core` (a biblioteca por trás do `bubblewrap` CLI) chamada direto do
daemon, sem a CLI interativa:

- `apps/daemon/src/apk-keystore.ts` — `garantirKeystore`: gera UMA vez (via `KeyTool` do próprio
  `@bubblewrap/core`), nunca regenera depois — regenerar quebraria atualização de quem já
  instalou. Testado com `keytool` de verdade (`apps/daemon/test/apk-keystore.test.ts`).
- `apps/daemon/src/apk-build.ts` — `construirApk`/`estadoAtualBuild`: monta o `TwaManifest` (host =
  hostname MagicDNS do certificado HTTPS — TWA não builda em cima de IP), gera o projeto Android
  (`TwaGenerator.createTwaProject`), compila (`GradleWrapper.assembleRelease`), confere alinhamento
  e assina (`AndroidSdkTools.apksigner`) — mesma sequência do comando `bubblewrap build`, lida do
  código-fonte da `@bubblewrap/cli` pra reproduzir fielmente. Falha rápido e com mensagem clara sem
  `JAVA_HOME`/`ANDROID_HOME`, antes de gerar keystore ou projeto nenhum. Retenção de 2 builds em
  `apk/builds/`, estado persistido em `apk/atual.json` (sobrevive a reiniciar o daemon).
- `apps/mobile/icone-512.png` — PNG novo: o `icone.svg` existente não serve pro pipeline de ícones
  do Android (usa Jimp, que não decodifica SVG).
- `GET /apk` agora serve o `.apk` de verdade (bytes + `X-Nexo-Sha256`) quando há build pronto, em
  vez de sempre cair na página "sem build".
- `POST/GET /v1/apk/build` (autenticadas) — desktop dispara e faz polling; painel Celular ganhou
  um botão "Gerar APK" com status ao vivo.

**Validado com ferramentas reais nesta sessão**: geração de keystore (`keytool` de verdade) e
geração do projeto Android (`TwaGenerator.createTwaProject`, baixando um ícone de um servidor HTTP
real, com um teste que confere o hostname e o `packageId` no `AndroidManifest.xml`/`strings.xml`
gerados). **Não validado**: a compilação Gradle e a assinatura em si — o ambiente onde isto foi
escrito não tem acesso ao SDK do Android (o host de download, `dl.google.com`, está bloqueado pela
política de rede da sessão) e não pôde compilar um `.apk` de verdade. A sequência de chamadas segue
fielmente o que a `@bubblewrap/cli` faz, mas só roda de ponta a ponta numa máquina com o SDK
instalado.

## Critérios de aceite (do plano original) — status

- [x] Pair `#c=` / `POST /pair` / Bearer sem mudança de contrato.
- [x] QR de download ≠ QR de pair (módulos, estado e rotas inteiramente separados).
- [x] Nenhum `.apk` público em `/app/` sem gate — o `.apk` de verdade é servido só via `GET /apk`
      com código de uso único, nunca estático em `/app/`.
- [x] Keystore local `0600` sob `~/.nexo` — `apps/daemon/src/apk-keystore.ts`, testado com `keytool`
      de verdade.
- [x] QR inclui código verificável (host + porta + código; URL + sha256 do artefato viram
      responsabilidade da página `/apk`, não do QR, pelo motivo de capacidade acima).
- [x] Retenção de builds limitada — 2 builds, `apps/daemon/src/apk-build.ts`.
- [x] Spike PWA documentado antes de Capacitor/TWA full (esta seção).
- [x] TWA só com hostname+HTTPS verificáveis, senão WebView mínimo explícito — e a spike
      mostrou que HTTPS falta pros DOIS caminhos, não só pro TWA.
