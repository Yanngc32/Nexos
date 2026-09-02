export type EngineKind = "claude" | "codex" | "api" | "stub";
export type ProfileStatus = "unauthenticated" | "ready";
export type SwitchReason = "user" | "quota";
export type ApiProvider = "anthropic" | "openai" | "gemini";

export type Profile = {
  id: string;
  engine: EngineKind;
  createdAt: string;
  status: ProfileStatus;
  api?: { provider: ApiProvider; model: string };
};

export type NexoConfig = {
  port: number;
  fallbackOrder: string[];
  pack: { keepLastMessages: number; prefixCharBudget: number };
};

export const DEFAULT_CONFIG: NexoConfig = {
  port: 7432,
  fallbackOrder: [],
  pack: { keepLastMessages: 20, prefixCharBudget: 2000 },
};

export type ThreadEvent =
  | {
      ts: string;
      type: "thread_meta";
      threadId: string;
      projectPath: string;
      title?: string;
      profileId: string;
    }
  | { ts: string; type: "user"; threadId: string; text: string }
  | { ts: string; type: "assistant"; threadId: string; text: string }
  | { ts: string; type: "tool"; threadId: string; name: string; summary: string }
  | {
      ts: string;
      type: "switched";
      threadId: string;
      fromProfileId: string;
      toProfileId: string;
      reason: SwitchReason;
      resume?: boolean;
    }
  | {
      ts: string;
      type: "context_trimmed";
      threadId: string;
      keptMessages: number;
      droppedMessages: number;
    }
  | { ts: string; type: "error"; threadId: string; message: string; profileId: string };

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "done" }
  | { type: "quota" }
  | { type: "error"; message: string };

export type StartOpts = {
  threadId: string;
  projectPath: string;
  profileId: string;
  contextPack: string;
};

export type PackConfig = NexoConfig["pack"];
