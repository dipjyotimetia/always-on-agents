/**
 * Credential proxy: tools never see raw secrets.
 * Callers register named credentials; outbound helpers inject them outside the agent.
 */

export type CredentialStore = {
  has(name: string): boolean;
  /** Returns a redacted label only — never the secret — for agent-visible logs. */
  label(name: string): string;
  /** Inject secret into a request builder; agent code must not call this. */
  withSecret<T>(name: string, fn: (secret: string) => T): T;
  allows(name: string, url: URL, method: string): boolean;
};

export function createCredentialStore(
  initial: Record<string, string> = {},
  policies: Readonly<Record<string, { url: string; methods: readonly string[] }>> = {},
): CredentialStore {
  const secrets = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) {
    if (v) secrets.set(k, v);
  }

  // Optional env-backed secrets (never exposed to tools directly)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AOA_SECRET_") && value) {
      secrets.set(key.slice("AOA_SECRET_".length).toLowerCase(), value);
    }
  }

  return {
    has(name) {
      return secrets.has(name);
    },
    label(name) {
      return secrets.has(name) ? `[credential:${name}]` : `[missing:${name}]`;
    },
    allows(name, url, method) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) return false;
      const policy = Object.hasOwn(policies, name) ? policies[name] : undefined;
      const endpoint = policy?.url ?? process.env[`AOA_ENDPOINT_${name.toUpperCase()}`];
      const methods = policy?.methods ??
        (process.env[`AOA_METHODS_${name.toUpperCase()}`] ?? "GET").split(",");
      return Boolean(endpoint && new URL(endpoint).href === url.href &&
        methods.some((allowed) => allowed.trim().toUpperCase() === method));
    },
    withSecret(name, fn) {
      const secret = secrets.get(name);
      if (!secret) throw new Error(`credential not configured: ${name}`);
      return fn(secret);
    },
  };
}

/**
 * Build an authenticated fetch that injects Authorization outside the agent sandbox.
 * Expose the response status without forwarding remote headers or content.
 */
export async function proxiedFetch(
  store: CredentialStore,
  opts: {
    credential: string;
    url: string;
    method?: string;
    idempotencyKey: string;
    signal: AbortSignal;
    body?: string;
  },
): Promise<{ status: number }> {
  const url = new URL(opts.url);
  const method = (opts.method ?? "POST").toUpperCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !store.allows(opts.credential, url, method)) {
    throw new Error("request outside credential policy");
  }
  opts.signal.throwIfAborted();
  return store.withSecret(opts.credential, async (secret) => {
    const res = await fetch(url, {
      method,
      redirect: "error",
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        "idempotency-key": opts.idempotencyKey,
        Authorization: `Bearer ${secret}`,
      },
      body: opts.body,
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`credential endpoint returned HTTP ${res.status}`);
    return { status: res.status };
  });
}
