/**
 * Environment Variable Bootstrap — auto-seed the credential vault from env vars.
 *
 * Intended for Docker / Unraid deployments where users configure OpenAlice
 * entirely through environment variables and the UI, without editing any files.
 *
 * Supported env vars (all optional):
 *
 *   LLM_PROVIDER=ollama|openai|lmstudio|vllm|litellm|localai|openrouter
 *
 *   OLLAMA_BASE_URL=http://host.docker.internal:11434    (Ollama host — /v1 appended)
 *   OPENAI_BASE_URL=http://...                           (generic OpenAI-compat base)
 *   OPENAI_API_KEY=sk-...                                (key for openai-compat endpoints)
 *   LMSTUDIO_BASE_URL=http://host.docker.internal:1234   (/v1 appended)
 *   VLLM_BASE_URL=http://vllm:8000                       (/v1 appended)
 *   LITELLM_BASE_URL=http://litellm:4000
 *   LOCALAI_BASE_URL=http://localai:8080                 (/v1 appended)
 *   MODEL_NAME=llama3.2                                  (optional model hint stored in the slug)
 *   FALLBACK_MODEL=deepseek-r1:8b                        (stored as separate note; no vault entry)
 *
 * Behaviour:
 *   - If no relevant env vars are set, this function is a no-op. Existing
 *     cloud workflows are unaffected.
 *   - If vars ARE set, a credential is written into the vault under the slug
 *     `env-local-llm`. On every boot the entry is UPDATED to reflect the current
 *     env, so changing an env var takes effect on the next container restart.
 *   - If the user later deletes the credential through the UI and no env vars
 *     are set on the next boot, nothing is re-created.
 *   - All operations are best-effort: any error is logged as a warning and boot
 *     continues normally.
 *
 * The resulting credential uses the `openai-chat` wire shape, compatible with
 * the `opencode` and `pi` workspace agents.
 */

import { writeCredential, type Credential } from './config.js'

export const ENV_LOCAL_LLM_SLUG = 'env-local-llm'

/** Normalise a base URL: strip trailing slash, optionally append a path. */
function normalise(raw: string, suffix = ''): string {
  return raw.replace(/\/+$/, '') + suffix
}

/**
 * Resolve the openai-chat endpoint from the env var set.
 * Returns null if no relevant env vars are present.
 */
function resolveEndpoint(): { endpoint: string; apiKey: string | undefined; label: string } | null {
  const provider = (process.env['LLM_PROVIDER'] ?? '').toLowerCase().trim()

  // Provider-specific vars take precedence over the generic OPENAI_BASE_URL.
  if (provider === 'ollama' || process.env['OLLAMA_BASE_URL']) {
    const base = process.env['OLLAMA_BASE_URL'] ?? 'http://host.docker.internal:11434'
    return { endpoint: normalise(base, '/v1'), apiKey: process.env['OPENAI_API_KEY'], label: 'Ollama' }
  }

  if (provider === 'lmstudio' || process.env['LMSTUDIO_BASE_URL']) {
    const base = process.env['LMSTUDIO_BASE_URL'] ?? 'http://host.docker.internal:1234'
    return { endpoint: normalise(base, '/v1'), apiKey: process.env['OPENAI_API_KEY'], label: 'LM Studio' }
  }

  if (provider === 'vllm' || process.env['VLLM_BASE_URL']) {
    const base = process.env['VLLM_BASE_URL'] ?? 'http://vllm:8000'
    return { endpoint: normalise(base, '/v1'), apiKey: process.env['OPENAI_API_KEY'], label: 'vLLM' }
  }

  if (provider === 'litellm' || process.env['LITELLM_BASE_URL']) {
    const base = process.env['LITELLM_BASE_URL'] ?? 'http://litellm:4000'
    return { endpoint: normalise(base), apiKey: process.env['OPENAI_API_KEY'], label: 'LiteLLM' }
  }

  if (provider === 'localai' || process.env['LOCALAI_BASE_URL']) {
    const base = process.env['LOCALAI_BASE_URL'] ?? 'http://localai:8080'
    return { endpoint: normalise(base, '/v1'), apiKey: process.env['OPENAI_API_KEY'], label: 'LocalAI' }
  }

  if (provider === 'openrouter') {
    return {
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: process.env['OPENAI_API_KEY'],
      label: 'OpenRouter',
    }
  }

  // Generic OpenAI-compatible endpoint (covers vLLM, LiteLLM, custom proxies
  // configured via OPENAI_BASE_URL without specifying LLM_PROVIDER explicitly).
  if (process.env['OPENAI_BASE_URL']) {
    return {
      endpoint: normalise(process.env['OPENAI_BASE_URL']),
      apiKey: process.env['OPENAI_API_KEY'],
      label: provider ? `${provider} (custom)` : 'OpenAI-compatible',
    }
  }

  return null
}

/**
 * Seed or refresh the `env-local-llm` credential from environment variables.
 * Call once during startup, after the config directory has been initialised.
 * Safe to call multiple times — idempotent per boot.
 */
export async function bootstrapFromEnv(): Promise<void> {
  const resolved = resolveEndpoint()
  if (!resolved) return // no local-LLM env vars set — nothing to do

  const { endpoint, apiKey, label } = resolved
  const model = process.env['MODEL_NAME']
  const fallback = process.env['FALLBACK_MODEL']

  const credential: Credential = {
    vendor: 'custom',
    authType: 'api-key',
    // Use the provided key; fall back to 'none' for providers that don't
    // require a key (Ollama, LocalAI, LM Studio) so the schema stays valid.
    apiKey: apiKey || 'none',
    wires: { 'openai-chat': endpoint },
  }

  try {
    await writeCredential(ENV_LOCAL_LLM_SLUG, credential)
    const parts = [`[env-bootstrap] seeded credential '${ENV_LOCAL_LLM_SLUG}' (${label}, ${endpoint})`]
    if (model) parts.push(`model=${model}`)
    if (fallback) parts.push(`fallback=${fallback}`)
    console.log(parts.join(' '))
  } catch (err) {
    console.warn(`[env-bootstrap] failed to write credential: ${err instanceof Error ? err.message : String(err)}`)
  }
}
