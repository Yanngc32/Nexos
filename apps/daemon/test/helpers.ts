import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "nexo-"));
}

/** Mesmo formato do .credentials.json do Claude CLI. */
export function liveCred(): string {
  return JSON.stringify({
    accessToken: "at-live",
    refreshToken: "rt-live",
    expiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * 3_600_000,
  });
}

/** O que o CLI deixa depois de falhar o refresh: campos zerados. */
export function deadCred(): string {
  return JSON.stringify({
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * 3_600_000,
  });
}
