const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSlug(id: string): string {
  if (!SLUG.test(id)) throw new Error(`slug inválido: ${id}`);
  return id;
}

export function newThreadId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newRunId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
