import {
  DEFAULT_ACCOUNTS_PATH,
  getPlaceholderApiKey,
} from "./lib/accounts.js"
import { createMultiAccountFetch } from "./lib/openai-fetch.js"

const DEFAULT_FAST_VARIANT = "fast"
const DEFAULT_PROVIDER_ID = "openai"

function createModel(name) {
  return {
    name,
    reasoning: true,
    attachment: true,
    tool_call: true,
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    limit: {
      context: 400000,
      output: 128000,
    },
  }
}

const DEFAULT_MODELS = {
  "gpt-5-codex": createModel("GPT-5 Codex"),
  "gpt-5.1-codex": createModel("GPT-5.1 Codex"),
  "gpt-5.1-codex-mini": createModel("GPT-5.1 Codex mini"),
  "gpt-5.1-codex-max": createModel("GPT-5.1 Codex Max"),
  "gpt-5.2-codex": createModel("GPT-5.2 Codex"),
  "gpt-5.3-codex": createModel("GPT-5.3 Codex"),
  "gpt-5": createModel("GPT-5"),
  "gpt-5.1": createModel("GPT-5.1"),
  "gpt-5.2": createModel("GPT-5.2"),
  "gpt-5.4": createModel("GPT-5.4"),
  "gpt-5.4-mini": createModel("GPT-5.4 mini"),
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function configuredAccountsPath(options) {
  return (
    stringOrUndefined(options.accountsPath) ||
    stringOrUndefined(process.env.OPENCODE_CODEX_ACCOUNTS_FILE) ||
    DEFAULT_ACCOUNTS_PATH
  )
}

function providerId(options) {
  return stringOrUndefined(options.providerId) || DEFAULT_PROVIDER_ID
}

function fastVariantName(options) {
  return stringOrUndefined(options.fastVariantName) || DEFAULT_FAST_VARIANT
}

function mergedModels(existingModels = {}, options = {}) {
  const variantName = fastVariantName(options)
  const result = { ...existingModels }

  for (const [modelId, defaults] of Object.entries(DEFAULT_MODELS)) {
    const existing = result[modelId] ?? {}
    result[modelId] = {
      ...defaults,
      ...existing,
      variants: {
        ...(existing.variants ?? {}),
        [variantName]: {
          ...(existing.variants?.[variantName] ?? {}),
          serviceTier: "priority",
        },
      },
    }
  }

  return result
}

function buildPluginOptions(rawOptions) {
  return {
    accountsPath: configuredAccountsPath(rawOptions),
    accountId:
      stringOrUndefined(rawOptions.accountId) ||
      stringOrUndefined(process.env.OPENCODE_CODEX_ACCOUNT),
    debug:
      rawOptions.debug === true || process.env.OPENCODE_CODEX_DEBUG === "1",
    placeholderApiKey: getPlaceholderApiKey(),
  }
}

export async function OpencodeCodexMultiAuthPlugin(_input, rawOptions = {}) {
  const options = rawOptions && typeof rawOptions === "object" ? rawOptions : {}
  const targetProvider = providerId(options)
  const pluginOptions = buildPluginOptions(options)

  return {
    async config(config) {
      config.provider = config.provider ?? {}
      const existing = config.provider[targetProvider] ?? {}

      config.provider[targetProvider] = {
        ...existing,
        name: existing.name ?? "Codex",
        models: mergedModels(existing.models ?? {}, options),
        options: {
          ...(existing.options ?? {}),
          reasoningEffort:
            existing.options?.reasoningEffort ??
            stringOrUndefined(options.reasoningEffort) ??
            stringOrUndefined(process.env.OPENCODE_CODEX_REASONING_EFFORT) ??
            "low",
        },
      }
    },

    auth: {
      provider: targetProvider,
      async loader() {
        return {
          apiKey: pluginOptions.placeholderApiKey,
          baseURL: "https://api.openai.com/v1",
          fetch: createMultiAccountFetch(pluginOptions),
        }
      },
      methods: [
        {
          type: "api",
          label: "Manage Codex OAuth accounts via script",
        },
      ],
    },
  }
}

export default {
  id: "opencode-codex-multi-auth",
  server: OpencodeCodexMultiAuthPlugin,
}
