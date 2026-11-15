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
};

export function createCredentialStore(
  initial: Record<string, string> = {},
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
    withSecret(name, fn) {
      const secret = secrets.get(name);
      if (!secret) throw new Error(`credential not configured: ${name}`);
      return fn(secret);
    },
  };
}

/**
 * Build an authenticated fetch that injects Authorization outside the agent sandbox.
 * The agent only receives the response text — never the Authorization header value.
 */
export async function proxiedFetch(
  store: CredentialStore,
  opts: {
    credential: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string }> {
  return store.withSecret(opts.credential, async (secret) => {
    const res = await fetch(opts.url, {
      method: opts.method ?? "POST",
      headers: {
        ...(opts.headers ?? {}),
        Authorization: `Bearer ${secret}`,
      },
      body: opts.body,
    });
    const body = await res.text();
    return { status: res.status, body: body.slice(0, 8_000) };
  });
}
