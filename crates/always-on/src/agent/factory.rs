use super::anthropic::{create_anthropic_brain, AnthropicBrainOptions};
use super::gemini::{create_gemini_brain, GeminiBrainOptions};
use super::mock::create_mock_brain;
use super::openai_compat::{create_openai_brain, OpenAiBrainOptions};
use super::types::{Brain, TokenUsage};
use crate::config::Config;
use std::sync::Arc;

pub struct CreateBrainOptions {
    pub config: Arc<Config>,
    pub on_usage: Option<Arc<dyn Fn(TokenUsage) + Send + Sync>>,
}

fn shared_model(config: &Config, provider_default: &str) -> String {
    if std::env::var("LLM_MODEL")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some()
    {
        config.llm_model.clone()
    } else {
        provider_default.to_string()
    }
}

fn shared_base_url(config: &Config, provider_default: &str) -> String {
    if std::env::var("LLM_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some()
    {
        config.llm_base_url.clone()
    } else {
        provider_default.to_string()
    }
}

/// Select a brain implementation from `BRAIN_PROVIDER` and API keys on [`Config`].
pub fn create_brain(opts: CreateBrainOptions) -> Arc<dyn Brain> {
    let provider = opts.config.brain_provider.trim().to_lowercase();

    match provider.as_str() {
        "mock" => create_mock_brain(),
        "anthropic" => {
            let api_key = opts
                .config
                .anthropic_api_key
                .clone()
                .filter(|k| !k.is_empty())
                .expect("ANTHROPIC_API_KEY required for anthropic brain");
            create_anthropic_brain(AnthropicBrainOptions {
                api_key,
                model: shared_model(&opts.config, &opts.config.anthropic_model),
                base_url: Some(shared_base_url(
                    &opts.config,
                    &opts.config.anthropic_base_url,
                )),
                client: None,
                on_usage: opts.on_usage.clone(),
            })
        }
        "openai" | "openai_compat" => {
            let api_key = opts
                .config
                .openai_api_key
                .clone()
                .filter(|k| !k.is_empty())
                .expect("OPENAI_API_KEY required for openai brain");
            create_openai_brain(OpenAiBrainOptions {
                api_key,
                model: shared_model(&opts.config, &opts.config.openai_model),
                base_url: Some(shared_base_url(&opts.config, &opts.config.openai_base_url)),
                client: None,
                on_usage: opts.on_usage.clone(),
            })
        }
        "gemini" => {
            let api_key = opts
                .config
                .gemini_api_key
                .clone()
                .filter(|k| !k.is_empty())
                .expect("GEMINI_API_KEY required for gemini brain");
            create_gemini_brain(GeminiBrainOptions {
                api_key,
                model: shared_model(&opts.config, &opts.config.gemini_model),
                base_url: Some(shared_base_url(&opts.config, &opts.config.gemini_base_url)),
                client: None,
                on_usage: opts.on_usage.clone(),
            })
        }
        _ => {
            if opts
                .config
                .anthropic_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                return create_anthropic_brain(AnthropicBrainOptions {
                    api_key: opts.config.anthropic_api_key.clone().unwrap(),
                    model: shared_model(&opts.config, &opts.config.anthropic_model),
                    base_url: Some(shared_base_url(
                        &opts.config,
                        &opts.config.anthropic_base_url,
                    )),
                    client: None,
                    on_usage: opts.on_usage,
                });
            }
            if opts
                .config
                .openai_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                return create_openai_brain(OpenAiBrainOptions {
                    api_key: opts.config.openai_api_key.clone().unwrap(),
                    model: shared_model(&opts.config, &opts.config.openai_model),
                    base_url: Some(shared_base_url(&opts.config, &opts.config.openai_base_url)),
                    client: None,
                    on_usage: opts.on_usage,
                });
            }
            if opts
                .config
                .gemini_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                return create_gemini_brain(GeminiBrainOptions {
                    api_key: opts.config.gemini_api_key.clone().unwrap(),
                    model: shared_model(&opts.config, &opts.config.gemini_model),
                    base_url: Some(shared_base_url(&opts.config, &opts.config.gemini_base_url)),
                    client: None,
                    on_usage: opts.on_usage,
                });
            }
            create_mock_brain()
        }
    }
}