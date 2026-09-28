# Política de privacidade do Nexos

_Última atualização: 21 de setembro de 2026_

O Nexos é um aplicativo de computador de código aberto (https://github.com/Yanngc32/Nexos). Ele roda
na sua máquina; não existe servidor do Nexos recebendo seus dados.

## O que acontece quando você entra com o Google

- O Nexos pede só a permissão `drive.file`: acesso **apenas** aos arquivos e pastas que o próprio
  Nexos cria no seu Google Drive (a pasta "Nexos" e o que vai dentro) ou que você escolhe
  explicitamente. O resto do seu Drive fica fora do alcance.
- Também recebe o seu e-mail (`openid email`), usado só pra mostrar na tela qual conta está conectada.
- O Nexos usa esse acesso para uma coisa: sincronizar a memória, as tarefas, o mapa do repositório e as
  conversas dos seus projetos entre os seus computadores.

## Onde os dados ficam

- O token de acesso do Google fica guardado **só no seu computador** (`~/.nexos/google.json`).
- Os dados sincronizados ficam no **seu** Google Drive e no seu computador. Ninguém mais, incluindo
  os autores do Nexos, recebe cópia deles.
- O Nexos não vende, não compartilha e não usa esses dados pra publicidade, nem para treinar modelos.

O uso das informações recebidas das APIs do Google segue a
[Política de dados do usuário dos serviços de API do Google](https://developers.google.com/terms/api-services-user-data-policy),
incluindo os requisitos de Uso Limitado.

## Como remover

- No Nexos: Configurações → Google Drive → **Desconectar** apaga o token local.
- No Google: https://myaccount.google.com/permissions → Nexos → **Remover acesso**.
- A pasta no Drive é sua: apague quando quiser.

## Motor de vídeo (painel Vídeo do Canvas)

- O render de vídeo usa o [Hyperframes](https://github.com/heygen-com/hyperframes) (HeyGen, Apache 2.0),
  baixado pelo `npx` na primeira vez que você renderiza. O Hyperframes envia **telemetria anônima de uso**
  para a HeyGen por padrão (o Nexos deixa como vem). Pra desligar, rode uma vez no terminal:
  `npx hyperframes telemetry disable`.
- O motor de vídeo não manda suas cenas nem suas músicas pra lugar nenhum. O MP4 renderizado
  fica só nesta máquina (não vai pro Drive).
- Créditos e licenças do que vem junto (músicas ende.app, efeitos Kenney, trechos do brag e do
  Hyperframes, GSAP): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contato

Dúvidas: abra uma issue em https://github.com/Yanngc32/Nexos/issues ou escreva para
yanngcruz@gmail.com.
