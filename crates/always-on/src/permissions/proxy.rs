use anyhow::Result;
use reqwest::Client;
use std::collections::HashMap;
use std::env;
use std::sync::{Arc, RwLock};

/// Credential proxy: tools never see raw secrets.
/// Callers register named credentials; outbound helpers inject them outside the agent.
#[derive(Clone)]
pub struct CredentialStore {
    secrets: Arc<RwLock<HashMap<String, String>>>,
}

impl CredentialStore {
    pub fn new(initial: HashMap<String, String>) -> Self {
        let mut secrets = HashMap::new();
        for (k, v) in initial {
            if !v.is_empty() {
                secrets.insert(k, v);
            }
        }
        for (key, value) in env::vars() {
            if let Some(name) = key.strip_prefix("AOA_SECRET_") {
                if !value.is_empty() {
                    secrets.insert(name.to_lowercase(), value);
                }
            }
        }
        Self {
            secrets: Arc::new(RwLock::new(secrets)),
        }
    }

    pub fn has(&self, name: &str) -> bool {
        self.secrets.read().unwrap().contains_key(name)
    }

    /// Returns a redacted label only — never the secret — for agent-visible logs.
    pub fn label(&self, name: &str) -> String {
        if self.has(name) {
            format!("[credential:{name}]")
        } else {
            format!("[missing:{name}]")
        }
    }

    /// Inject secret into a request builder; agent code must not call this.
    pub fn with_secret<T, F>(&self, name: &str, f: F) -> Result<T>
    where
        F: FnOnce(&str) -> Result<T>,
    {
        let secret = self
            .secrets
            .read()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("credential not configured: {name}"))?;
        f(&secret)
    }
}

pub fn create_credential_store(initial: HashMap<String, String>) -> CredentialStore {
    CredentialStore::new(initial)
}

impl Default for CredentialStore {
    fn default() -> Self {
        Self::new(HashMap::new())
    }
}

/// Build an authenticated fetch that injects Authorization outside the agent sandbox.
/// The agent only receives the response text — never the Authorization header value.
pub async fn proxied_fetch(
    store: &CredentialStore,
    opts: ProxiedFetchOptions<'_>,
) -> Result<ProxiedResponse> {
    let secret = store
        .secrets
        .read()
        .unwrap()
        .get(opts.credential)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("credential not configured: {}", opts.credential))?;

    let client = Client::new();
    let method = opts.method.unwrap_or("POST");
    let mut req = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST),
        opts.url,
    );
    for (k, v) in &opts.headers {
        req = req.header(k, v);
    }
    req = req.header("Authorization", format!("Bearer {secret}"));
    if let Some(b) = opts.body {
        req = req.body(b.to_string());
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let text = res.text().await?;
    let truncated = if text.len() > 8_000 {
        text[..8_000].to_string()
    } else {
        text
    };
    Ok(ProxiedResponse {
        status,
        body: truncated,
    })
}

pub struct ProxiedFetchOptions<'a> {
    pub credential: &'a str,
    pub url: &'a str,
    pub method: Option<&'a str>,
    pub headers: HashMap<String, String>,
    pub body: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct ProxiedResponse {
    pub status: u16,
    pub body: String,
}
