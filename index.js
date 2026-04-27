import {
  DEFAULT_ACCOUNTS_PATH,
  getPlaceholderApiKey,
} from "./lib/accounts.js"
import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_MODELS,
  discoverProviderModels,
  isGpt55ModelId,
} from "./lib/models.js"
import { createMultiAccountFetch } from "./lib/openai-fetch.js"

const DEFAULT_FAST_VARIANT = "fast"
const DEFAULT_PROVIDER_ID = "openai"

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

function finitePositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function mergedLimit(modelId, defaults, existing) {
  const defaultLimit = defaults.limit ?? {}
  const existingLimit = existing.limit ?? {}
  const merged = { ...defaultLimit, ...existingLimit }
  const apiModelId = typeof defaults.id === "string" ? defaults.id : modelId

  if (isGpt55ModelId(modelId) || isGpt55ModelId(apiModelId)) {
    const context = Math.max(
      finitePositiveNumber(defaultLimit.context) ?? 0,
      finitePositiveNumber(existingLimit.context) ?? 0,
    )

    if (context > 0) merged.context = context
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

function shouldAddFastVariant(modelId, defaults, modelIds) {
  const apiModelId = typeof defaults.id === "string" ? defaults.id : modelId
  return (
    modelId !== "gpt-5.5" &&
    apiModelId !== "gpt-5.5" &&
    !modelId.endsWith("-fast") &&
    !apiModelId.endsWith("-fast") &&
    !modelIds.has(`${modelId}-fast`) &&
    !modelIds.has(`${apiModelId}-fast`)
  )
}

function clientVersion(options) {
  return (
    stringOrUndefined(options.clientVersion) ||
    stringOrUndefined(process.env.OPENCODE_CODEX_CLIENT_VERSION) ||
    DEFAULT_CLIENT_VERSION
  )
}

function mergedModels(existingModels = {}, discoveredCatalog = { models: {}, resolved: false }, options = {}) {
  const variantName = fastVariantName(options)
  const defaultsById = discoveredCatalog.resolved ? discoveredCatalog.models : DEFAULT_MODELS
  const modelIds = new Set(Object.keys(defaultsById))
  const result = { ...existingModels }

  for (const [modelId, defaults] of Object.entries(defaultsById)) {
    const existing = result[modelId] ?? {}
    const variants = { ...(defaults.variants ?? {}), ...(existing.variants ?? {}) }
    const limit = mergedLimit(modelId, defaults, existing)

    if (shouldAddFastVariant(modelId, defaults, modelIds)) {
      variants[variantName] = {
        ...(existing.variants?.[variantName] ?? {}),
        serviceTier: "priority",
      }
    }

    result[modelId] = {
      ...defaults,
      ...existing,
      variants,
      ...(limit ? { limit } : {}),
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
      const discoveredModels = await discoverProviderModels({
        accountsPath: pluginOptions.accountsPath,
        forcedAccountId: pluginOptions.accountId,
        debug: pluginOptions.debug,
        clientVersion: clientVersion(options),
      })

      config.provider[targetProvider] = {
        ...existing,
        name: existing.name ?? "Codex",
        models: mergedModels(existing.models ?? {}, discoveredModels, options),
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
