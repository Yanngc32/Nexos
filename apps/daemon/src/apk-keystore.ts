import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, JdkHelper, KeyTool } from "@bubblewrap/core";

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
  const jdkHelper = new JdkHelper(process, new Config(jdkPath, ""));
  const keyTool = new KeyTool(jdkHelper);
  await keyTool.createSigningKey({
    path: arqKeystore,
    alias,
    password: senha,
    keypassword: senha,
    fullName: "Nexo",
    organizationalUnit: "Nexo",
    organization: "Nexo",
    country: "BR",
  });

  const meta: Meta = { alias, senha };
  writeFileSync(arqMeta, JSON.stringify(meta), { mode: 0o600 });
  return { path: arqKeystore, alias, senha };
}
