import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ApiProvider, EngineKind, Profile } from "@nexo/shared";
import { assertSlug } from "./ids.ts";
import { ensureHome, profileDir } from "./home.ts";

export type AddProfileInput = {
  id: string;
  engine: EngineKind;
  api?: { provider: ApiProvider; model: string };
};

export type AddProfileOpts = {
  apiKey?: string;
  skipBinCheck?: boolean;
};

type ApiKeysFile = {
  provider: NonNullable<Profile["api"]>["provider"];
  apiKey: string;
  model: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function which(bin: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, [bin], { encoding: "utf8" });
  return r.status === 0;
}

function profileJsonPath(id: string, home: string): string {
  return join(profileDir(id, home), "profile.json");
}

export function addProfile(input: AddProfileInput, home: string, opts: AddProfileOpts = {}): Profile {
  ensureHome(home);
  const id = assertSlug(input.id);
  const dir = profileDir(id, home);
  if (existsSync(profileJsonPath(id, home))) {
    throw new Error(`perfil já existe: ${id}`);
  }
  if (!opts.skipBinCheck && (input.engine === "claude" || input.engine === "codex")) {
    if (!which(input.engine)) {
      throw new Error(`${input.engine} não tá no PATH`);
    }
  }

  mkdirSync(dir, { recursive: true });
  if (input.engine === "claude") mkdirSync(join(dir, "claude"), { recursive: true });
  if (input.engine === "codex") mkdirSync(join(dir, "codex"), { recursive: true });

  let status: Profile["status"] = "unauthenticated";
  if (input.engine === "stub") status = "ready";
  if (input.engine === "api") {
    if (!input.api || !opts.apiKey) throw new Error("engine api precisa provider, model e apiKey");
    writeFileSync(
      join(dir, "keys.json"),
      JSON.stringify(
        { provider: input.api.provider, apiKey: opts.apiKey, model: input.api.model } satisfies ApiKeysFile,
        null,
        2,
      ),
      "utf8",
    );
    status = "ready";
  }

  const profile: Profile = {
    id,
    engine: input.engine,
    createdAt: nowIso(),
    status,
    ...(input.api ? { api: input.api } : {}),
  };
  writeFileSync(profileJsonPath(id, home), JSON.stringify(profile, null, 2), "utf8");
  return profile;
}

export function getProfile(id: string, home: string): Profile | undefined {
  const path = profileJsonPath(id, home);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Profile;
}

export function listProfiles(home: string): Profile[] {
  ensureHome(home);
  const root = join(home, "profiles");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => getProfile(d.name, home))
    .filter((p): p is Profile => Boolean(p));
}

export function markReady(id: string, home: string): Profile {
  const p = getProfile(id, home);
  if (!p) throw new Error(`perfil não existe: ${id}`);
  p.status = "ready";
  writeFileSync(profileJsonPath(id, home), JSON.stringify(p, null, 2), "utf8");
  return p;
}

export function readApiKey(id: string, home: string): string | undefined {
  const path = join(profileDir(id, home), "keys.json");
  if (!existsSync(path)) return undefined;
  const keys = JSON.parse(readFileSync(path, "utf8")) as ApiKeysFile;
  return keys.apiKey;
}

export function engineEnv(profile: Profile, home: string): Record<string, string> {
  const dir = profileDir(profile.id, home);
  if (profile.engine === "claude") return { CLAUDE_CONFIG_DIR: join(dir, "claude") };
  if (profile.engine === "codex") return { CODEX_HOME: join(dir, "codex") };
  return {};
}
