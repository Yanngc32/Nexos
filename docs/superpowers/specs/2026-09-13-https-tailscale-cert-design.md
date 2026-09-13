# Nexo — HTTPS no daemon via `tailscale cert` (design)

Data: 2026-09-13
Status: **implementado** (aprovado pelo usuário — "Segue"). O desenho abaixo é o que foi
construído, com testes reais rodando (`apk-share`, `tls-tailscale`, `escuta-https`) — inclusive
um teste que sobe um socket HTTPS de verdade com certificado autoassinado e faz o handshake TLS
completo. Três dos quatro riscos listados na seção "Riscos e perguntas em aberto" seguem SEM
resolver — ver o rodapé "O que ficou pra depois".

Nasce do achado da spike de APK
([2026-09-13-mobile-apk-spike.md](2026-09-13-mobile-apk-spike.md)): o daemon não serve HTTPS em
lugar nenhum, e isso trava tanto uma PWA instalável de verdade (Chrome exige HTTPS ou
`localhost` pra `display: standalone` valer) quanto um TWA (Digital Asset Links exige
hostname+HTTPS verificáveis). Resolver aqui destrava os dois ao mesmo tempo — por isso a
recomendação foi consertar a causa, não contornar com Capacitor.

## Não-objetivos

- **Não** expõe o daemon pra internet pública — o modelo de acesso continua sendo túnel
  (Tailscale/WireGuard) ou LAN, exatamente como hoje.
- **Não** muda pareamento, `/apk`, CORS, nem a autenticação Bearer — tudo isso já foi
  explicitamente marcado fora de escopo da iniciativa de mobile, e continua fora aqui.
- **Não** tenta certificar endereço de LAN puro (IP privado) — nenhuma CA pública emite
  certificado pra isso; só o hostname do Tailscale (MagicDNS) é alcançável por este caminho.
- **Não** decide TWA vs. Capacitor — esse spec só entrega a pré-condição (HTTPS); a escolha do
  empacotamento do APK continua sendo a Fase 2 do plano de mobile, decidida depois.

## Por que `tailscale cert`, e não uma CA própria

Rodar uma CA caseira (gerar cert autoassinado, instalar como confiável no celular) resolveria o
"HTTPS" no sentido técnico, mas não resolve o requisito de verdade: Digital Asset Links do
Android e o critério de instalabilidade do Chrome pedem um certificado que a cadeia de
confiança do SISTEMA já reconheça — instalar uma CA própria como confiável no Android é fricção
manual, por dispositivo, e frágil (a pessoa desinstala sem saber por quê, ou o passo é longo
demais pra alguém tentar uma vez e desistir).

`tailscale cert <hostname>` resolve isso de graça: emite um certificado real via Let's Encrypt
pro hostname MagicDNS do próprio node (algo como `desktop-do-yann.tailXXXX.ts.net`), que o
Android já confia nativamente — zero passo extra no celular. O preço é a dependência: só
funciona com (a) o binário `tailscale` no PATH, (b) HTTPS habilitado no admin console do
tailnet, e (c) o node efetivamente dentro daquele tailnet. As três coisas já são pré-requisito
de quem hoje usa o painel Celular fora da LAN — não é uma dependência nova imposta a quem só usa
localhost.

## Arquitetura atual (o que este spec muda)

`apps/daemon/src/escuta.ts` (`religar`) mantém uma lista de sockets HTTP abertos — um por host
alcançável (loopback sempre, mais cada interface de túnel detectada por
`enderecos.ts`/`enderecosDaMaquina`), todos na MESMA porta, todos via `@hono/node-server`'s
`serve()` com o `createServer` padrão (`node:http`).

`enderecos.ts` hoje detecta Tailscale só inspecionando `os.networkInterfaces()` (padrão de nome
de interface) — **nunca** chama o binário `tailscale`. Este spec seria o primeiro lugar do
código a fazer isso, e esse é o motivo de tratar cada falha do binário exatamente como o
`escuta.ts` já trata túnel fora do ar: registra e segue a vida, nunca derruba a subida do
daemon.

## Desenho proposto

### 1. Emissão e cache do certificado (`apps/daemon/src/tls-tailscale.ts`, novo módulo)

- `obterCertTailscale(hostname): Promise<{ cert: Buffer; key: Buffer } | null>`
  - Roda `tailscale cert --cert-file <tmp> --key-file <tmp> <hostname>` (via
    `node:child_process`, com timeout — mesma disciplina de `auth-status.ts`, que já invoca
    CLI externa e trata ausência/erro sem derrubar nada).
  - Binário ausente, tailnet sem HTTPS habilitado, ou hostname não é MagicDNS válido → `null` +
    log, nunca exceção que suba até `main()`.
  - Sucesso → grava `cert.pem`/`key.pem` em `~/.nexo/tls/`, modo `0600` (mesmo padrão de
    `daemon.token`), e devolve o par pro caller.
- **Renovação**: `tailscale cert` já é idempotente — rodar de novo antes do vencimento (~90
  dias, Let's Encrypt) só reemite se estiver perto de expirar; um timer no daemon (na mesma
  cadência generosa de `enderecos.ts`, tipo 1x/dia) chama de novo e recarrega os sockets HTTPS
  só se o cert mudou de fato (compara hash do arquivo antes de derrubar conexões à toa).

### 2. Um socket HTTPS a mais, não uma troca

`religar()` ganha um segundo conjunto de sockets: quando `obterCertTailscale` devolve um
certificado válido pro hostname MagicDNS atual, abre TAMBÉM um listener HTTPS nesse host,
numa porta PRÓPRIA (ex.: `porta + 1`, configurável) — usando `serve({ fetch, hostname, port,
createServer: https.createServer, serverOptions: { cert, key } })`, que o
`@hono/node-server` já suporta nativamente (confirmado lendo os tipos do pacote — nenhuma
dependência nova).

**Loopback e LAN continuam só em HTTP.** Não dá certificado público pra IP privado nem pra
`127.0.0.1`, então não há o que fazer ali — e o app desktop (que fala só com loopback) nunca
precisa mudar uma linha.

### 3. QR e URLs escolhem `https://` quando existe

`urlDoCelular`/`urlDoApk` (desktop) e o `GET /v1/escuta` (que alimenta a tela) passam a
informar também se há HTTPS disponível pro host escolhido, e com qual porta — o QR usa
`https://<magicdns>:<porta-https>/...` quando existe, e cai pro `http://` de hoje quando não
(túnel sem HTTPS habilitado, ou tailscale ausente). Nenhuma mudança de CONTEÚDO do QR além
do protocolo/porta — `#c=` e `?c=` continuam exatamente como são.

### 4. Onde isso NÃO mexe

- CORS continua `origin: "*"` — já era a política aceita pro HTTP; HTTPS não piora nem
  resolve isso, e mudar CORS é outra frente, já marcada fora de escopo.
- Nenhuma rota muda de autenticada pra aberta ou vice-versa.
- `route-guard.test.ts` continua valendo sem alteração — é sobre autenticação, não sobre
  transporte.

## Riscos e perguntas em aberto (pra revisar ANTES de implementar)

1. **Renovação falhando silenciosamente.** Se o timer de renovação parar de funcionar (bug, ou
   o daemon nunca fica de pé por 90 dias seguidos — o que é o comum, já que reinicia toda hora),
   o cert expira e o Android para de confiar. Precisa de um aviso visível na tela (painel
   Celular) quando o cert estiver a poucos dias de vencer, não só log.
2. **Custo de infraestrutura em cada subida.** Rodar `tailscale cert` na subida do daemon (pra
   pegar HTTPS o quanto antes) tem custo de rede/tempo pequeno mas não-zero; decidir se isso
   roda toda subida ou só quando o cert local não existir/estiver velho.
3. **Múltiplas contas/tailnets.** Se a máquina trocar de tailnet (login diferente), o hostname
   MagicDNS muda, e o cert velho fica órfão — precisa detectar e reemitir, não só cachear pra
   sempre.
4. **Teste automatizado.** Não dá pra testar emissão de cert de verdade em CI (depende de rede
   e de uma conta Tailscale real) — o módulo precisa ser desenhado pra isolar a chamada ao
   binário atrás de uma interface que os testes possam trocar por um fake, do jeito que
   `login-session.ts`/`auth-status.ts` já isolam CLI externa hoje.

## O que foi construído

Seguiu o plano incremental à risca, testado passo a passo (nunca um commit só):

1. `apps/daemon/src/tls-tailscale.ts` — `hostnameTailscale()` (lê `Self.DNSName` de
   `tailscale status --json`) e `pedirCertTailscale(hostname, home)` (roda `tailscale cert`,
   grava em `~/.nexo/tls/`, `chmod 0600` na chave). As DUAS best-effort, nunca lançam. Testado
   com `node:child_process` mockado (`apps/daemon/test/tls-tailscale.test.ts`).
2. `apps/daemon/src/escuta.ts` — `EstadoHttps`/`Estado.https`, socket HTTPS separado
   (`ligadoHttps`/`httpsPort`/`httpsInfo`, tudo estado PRÓPRIO — nunca reusa `ligados`/`porta`
   do HTTP), relógio próprio (`manterHttpsEmDia`, a cada 6h — bem mais espaçado que os 20s do
   HTTP, porque `tailscale cert` já decide sozinho quando renovar). `tentarHttps` só age quando
   há hostname MagicDNS E um socket de túnel de fato de pé; qualquer falha fecha o HTTPS e
   nunca deita o HTTP. Testado com um handshake TLS REAL (`apps/daemon/test/escuta-https.test.ts`,
   usando um certificado autoassinado de fixture, `test/fixtures/fake-tls-*.pem`).
3. `apps/daemon/src/server.ts` — `manterHttpsEmDia` chamada logo depois de `manterEmDia`, sem
   bloquear a subida (confirmado por smoke test manual: `religar()` continua levando poucos ms).
4. Desktop — `urlDoCelular`/`urlDoApk` (`apps/desktop/url.js`) ganham um 4º parâmetro opcional
   `https: {hostname, port}`; quando presente, a URL vira `https://hostname:porta/...` em vez de
   `http://ip:porta/...`. `renderer.js` só passa esse parâmetro quando `https.host` bate com o
   host que a tela já está mostrando (`httpsSeAplica`). `GET /v1/escuta` já expõe `https` de
   graça (é um espalhamento de `estadoAtual()`, sem rota nova).

### O que ficou pra depois (riscos 1-3 acima, nenhum resolvido)

- **Sem aviso de expiração na tela.** O painel Celular não avisa quando o certificado está perto
  de vencer — hoje, se a renovação falhar silenciosamente, o único sintoma é o Android parar de
  confiar, sem pista nenhuma na UI.
- **Sem otimização do custo de subida** — hoje `manterHttpsEmDia` sempre tenta na subida
  (`hostnameTailscale` falha rápido sem Tailscale, então o custo é baixo quando não se aplica,
  mas continua sem cache entre subidas).
- **Sem tratamento de troca de tailnet** — se o hostname MagicDNS mudar, `tentarHttps` religa
  pro hostname novo na tentativa seguinte (funciona), mas não há nada que detecte ou avise
  ativamente sobre a troca em si.

Nenhum dos três bloqueia o uso — HTTPS aparece quando as condições batem e nunca atrapalha o
HTTP quando não batem. São lacunas de robustez/UX pra tratar numa iteração futura, não bugs.
