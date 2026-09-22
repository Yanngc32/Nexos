/**
 * Registro do Nexo no Google Cloud — preenchido UMA vez por quem distribui o app; quem usa o Nexo
 * nunca vê nada disto, só o botão "Entrar com Google".
 *
 * Nada aqui é segredo: em app instalado o Google trata o client como público (RFC 8252) — o que
 * protege a conta é o consentimento + PKCE. Como registrar (console.cloud.google.com):
 *  - ligar "Google Drive API";
 *  - tela de consentimento com o escopo `.../auth/drive` (completo — "restrito" pro Google, pode
 *    pedir avaliação de segurança CASA antes de sair do modo teste/100 usuários);
 *  - credencial OAuth tipo "App para computador" → `clientId`/`clientSecret`.
 */
export const GOOGLE_CLIENT_PADRAO = {
  clientId: "596585511276-2mdnqh47u6gt9uhk0mvh35ua6c87osp2.apps.googleusercontent.com",
  clientSecret: "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",
};
