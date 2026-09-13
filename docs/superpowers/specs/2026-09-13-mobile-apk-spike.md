# Nexo Mobile — QR de download de APK Android (spike + Fase 1)

Data: 2026-09-13
Status: Fase 0 (spike) concluída, Fase 1 (infra do QR) implementada. Fase 2 (build do APK)
NÃO começou — depende do go/no-go desta spike.

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

### O que NÃO existe ainda (Fase 2, gated pelo go/no-go acima)

- Build do APK (TWA/Bubblewrap ou WebView mínimo — decisão pendente do go/no-go de TLS).
- Keystore em `~/.nexo` e assinatura.
- Servir o artefato de verdade (hoje `GET /apk` sempre responde "sem build").
- Retenção de builds (não há builds pra reter ainda).

## Critérios de aceite (do plano original) — status

- [x] Pair `#c=` / `POST /pair` / Bearer sem mudança de contrato.
- [x] QR de download ≠ QR de pair (módulos, estado e rotas inteiramente separados).
- [x] Nenhum `.apk` público em `/app/` sem gate (não existe `.apk` nenhum ainda; a rota que
      um dia vai servir o artefato real fica sob o mesmo gate de código curto).
- [ ] Keystore local `0600` sob `~/.nexo` — Fase 2, ainda não começou.
- [x] QR inclui código verificável (host + porta + código; URL + sha256 do artefato viram
      responsabilidade da página `/apk`, não do QR, pelo motivo de capacidade acima).
- [ ] Retenção de builds limitada — Fase 2.
- [x] Spike PWA documentado antes de Capacitor/TWA full (esta seção).
- [x] TWA só com hostname+HTTPS verificáveis, senão WebView mínimo explícito — e a spike
      mostrou que HTTPS falta pros DOIS caminhos, não só pro TWA.
