use anyhow::{Result, bail};
use reqwest::Client;
use std::collections::HashMap;
use std::env;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
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
            if let Some(name) = key.strip_prefix("AOA_SECRET_")
                && !value.is_empty()
            {
                secrets.insert(name.to_lowercase(), value);
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

    let url = validate_proxied_url(opts.url).await?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let method = opts.method.unwrap_or("POST");
    let mut req = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST),
        url,
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

async fn validate_proxied_url(raw: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw).map_err(|e| anyhow::anyhow!("invalid url: {e}"))?;
    if url.scheme() != "https" {
        bail!("proxied_request only allows https URLs");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("proxied_request url is missing a host"))?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        bail!("proxied_request blocks local hosts");
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            bail!("proxied_request blocks non-public addresses");
        }
        return Ok(url);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let host_owned = host.to_string();
    let addrs = tokio::task::spawn_blocking(move || {
        (host_owned.as_str(), port)
            .to_socket_addrs()
            .map(|iter| iter.collect::<Vec<SocketAddr>>())
    })
    .await
    .map_err(|_| anyhow::anyhow!("dns lookup failed"))??;
    if addrs.is_empty() {
        bail!("proxied_request host did not resolve");
    }
    if addrs.iter().any(|addr| is_blocked_ip(addr.ip())) {
        bail!("proxied_request blocks non-public addresses");
    }
    Ok(url)
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_documentation()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
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
