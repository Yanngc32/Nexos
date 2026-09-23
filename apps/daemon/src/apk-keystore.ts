import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { carregarBubblewrap } from "./apk-deps.ts";

/**
 * Keystore de assinatura do APK — gerado UMA VEZ e reusado pra sempre depois.
 *
 * Regenerar trocaria a assinatura do app: quem já instalou uma versão nunca
 * mais receberia atualização (Android recusa instalar um APK assinado por
 * chave diferente por cima de um já instalado) — então esta função NUNCA
 * sobrescreve um keystore que já existe, só cria quando falta.
 *
 * Reusa o `KeyTool` do próprio `@bubblewrap/core` (o mesmo que o comando
 * `bubblewrap` usa) em vez de invocar `keytool` à mão — mesmo comportamento
 * que o resto do ecossistema Bubblewrap/Android espera.
 */

export function apkDir(home: string): string {
  return join(home, "apk");
}

function keystorePath(home: string): string {
  return join(apkDir(home), "keystore.jks");
}

function metaPath(home: string): string {
  return join(apkDir(home), "keystore.json");
}

export type KeystoreInfo = { path: string; alias: string; senha: string };

type Meta = { alias: string; senha: string };

/**
 * Garante que o keystore existe, gerando um novo só se ainda não houver.
 * `jdkPath` é o `JAVA_HOME` a usar — sem ele (ou com ele inválido), lança:
 * diferente de `tls-tailscale.ts`, aqui NÃO faz sentido seguir sem — é o
 * próprio propósito da chamada.
 */
export async function garantirKeystore(home: string, jdkPath: string): Promise<KeystoreInfo> {
  const dir = apkDir(home);
  mkdirSync(dir, { recursive: true });

  const arqKeystore = keystorePath(home);
  const arqMeta = metaPath(home);

  if (existsSync(arqKeystore) && existsSync(arqMeta)) {
    const meta = JSON.parse(readFileSync(arqMeta, "utf8")) as Meta;
    return { path: arqKeystore, alias: meta.alias, senha: meta.senha };
  }

  const senha = randomBytes(24).toString("hex");
  const alias = "nexo";
  const { Config, JdkHelper, KeyTool } = await carregarBubblewrap(home);
  const jdkHelper = new JdkHelper(process, new Config(jdkPath, ""));
  const keyTool = new KeyTool(jdkHelper);
  await keyTool.createSigningKey({
    path: arqKeystore,
    alias,
    password: senha,
    keypassword: senha,
    fullName: "Nexos",
    organizationalUnit: "Nexos",
    organization: "Nexos",
    country: "BR",
  });

  const meta: Meta = { alias, senha };
  writeFileSync(arqMeta, JSON.stringify(meta), { mode: 0o600 });
  return { path: arqKeystore, alias, senha };
}

export function assetLinksPath(home: string): string {
  return join(apkDir(home), "assetlinks.json");
}

/**
 * Gera `assetlinks.json` — o arquivo que `GET /.well-known/assetlinks.json`
 * serve pro Android verificar Digital Asset Links. Sem ele (ou com o
 * fingerprint errado), o TWA nunca abre em tela cheia: o Android não confia
 * que o app tem permissão de representar o site, e cai pro Chrome com a
 * barra de endereço à mostra — o app instala e funciona, só não parece um
 * app.
 *
 * Depende só do keystore (nunca muda depois de criado) e do `applicationId`
 * (fixo) — não do hostname nem de HTTPS, então pode ser gerado assim que o
 * keystore existir, sem esperar o build completo.
 */
export async function gerarAssetLinks(home: string, jdkPath: string, applicationId: string): Promise<string> {
  const info = await garantirKeystore(home, jdkPath);
  const { Config, DigitalAssetLinks, JdkHelper, KeyTool } = await carregarBubblewrap(home);
  const jdkHelper = new JdkHelper(process, new Config(jdkPath, ""));
  const keyTool = new KeyTool(jdkHelper);
  const { fingerprints } = await keyTool.keyInfo({
    path: info.path,
    alias: info.alias,
    password: info.senha,
    keypassword: info.senha,
  });
  const sha256 = fingerprints.get("SHA256");
  if (!sha256) throw new Error("não consegui ler o fingerprint SHA-256 do keystore");
  const conteudo = DigitalAssetLinks.generateAssetLinks(applicationId, sha256);
  writeFileSync(assetLinksPath(home), conteudo, "utf8");
  return conteudo;
}
