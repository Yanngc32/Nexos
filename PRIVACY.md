# Política de privacidade do Nexo

_Última atualização: 21 de setembro de 2026_

O Nexo é um aplicativo de computador de código aberto (https://github.com/Yanngc32/Nexos). Ele roda
na sua máquina; não existe servidor do Nexo recebendo seus dados.

## O que acontece quando você entra com o Google

- O Nexo pede só a permissão `drive.file`: acesso **apenas** aos arquivos e pastas que o próprio
  Nexo cria no seu Google Drive (a pasta "Nexo" e o que vai dentro) ou que você escolhe
  explicitamente. O resto do seu Drive fica fora do alcance.
- Também recebe o seu e-mail (`openid email`), usado só pra mostrar na tela qual conta está conectada.
- O Nexo usa esse acesso para uma coisa: sincronizar a memória, as tarefas, o mapa do repositório e as
  conversas dos seus projetos entre os seus computadores.

## Onde os dados ficam

- O token de acesso do Google fica guardado **só no seu computador** (`~/.nexo/google.json`).
- Os dados sincronizados ficam no **seu** Google Drive e no seu computador. Ninguém mais, incluindo
  os autores do Nexo, recebe cópia deles.
- O Nexo não vende, não compartilha e não usa esses dados pra publicidade, nem para treinar modelos.

O uso das informações recebidas das APIs do Google segue a
[Política de dados do usuário dos serviços de API do Google](https://developers.google.com/terms/api-services-user-data-policy),
incluindo os requisitos de Uso Limitado.

## Como remover

- No Nexo: Configurações → Google Drive → **Desconectar** apaga o token local.
- No Google: https://myaccount.google.com/permissions → Nexos → **Remover acesso**.
- A pasta no Drive é sua: apague quando quiser.

## Contato

Dúvidas: abra uma issue em https://github.com/Yanngc32/Nexos/issues ou escreva para
yanngcruz@gmail.com.
