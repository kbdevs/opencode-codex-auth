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

const DEFAULT_PROVIDER_ID = "codex"

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

function finitePositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function modelIdSlug(modelId) {
  if (typeof modelId !== "string") return ""
  const trimmed = modelId.trim()
  return trimmed.includes("/") ? trimmed.split("/").pop() : trimmed
}

function gpt55DefaultsFor(modelId) {
  const slug = modelIdSlug(modelId)
  return DEFAULT_MODELS[slug] ?? DEFAULT_MODELS[modelId] ?? DEFAULT_MODELS["gpt-5.5"]
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

function isArtificialCodexAlias(modelId, model) {
  const apiModelId = typeof model.id === "string" ? model.id : modelId
  return (
    apiModelId !== modelId &&
    !apiModelId.includes("codex") &&
    (modelId.endsWith("-codex") || modelId.endsWith("-codex-fast"))
  )
}

function priorityVariants(variants = {}) {
  return Object.fromEntries(
    Object.entries(variants).map(([variantId, variant]) => [
      variantId,
      {
        ...variant,
        serviceTier: "priority",
      },
    ]),
  )
}

function shouldAddFastModel(modelId, model, modelIds) {
  const apiModelId = typeof model.id === "string" ? model.id : modelId
  return (
    !modelId.endsWith("-fast") &&
    !apiModelId.endsWith("-fast") &&
    !modelIds.has(`${modelId}-fast`) &&
    !modelIds.has(`${apiModelId}-fast`)
  )
}

function withFastModels(models) {
  const result = { ...models }
  const modelIds = new Set(Object.keys(result))

  for (const [modelId, model] of Object.entries(models)) {
    if (!shouldAddFastModel(modelId, model, modelIds)) continue

    const fastModelId = `${modelId}-fast`
    result[fastModelId] = {
      ...model,
      id: typeof model.id === "string" ? model.id : modelId,
      name: `${model.name ?? modelId} Fast`,
      variants: priorityVariants(model.variants),
    }
    modelIds.add(fastModelId)
  }

  return result
}

function clientVersion(options) {
  return (
    stringOrUndefined(options.clientVersion) ||
    stringOrUndefined(process.env.OPENCODE_CODEX_CLIENT_VERSION) ||
    DEFAULT_CLIENT_VERSION
  )
}

function mergedModels(existingModels = {}, discoveredCatalog = { models: {}, resolved: false }, options = {}) {
  const discoveredModels = discoveredCatalog.resolved ? discoveredCatalog.models : {}
  const baseDefaultsById = discoveredCatalog.resolved
    ? {
        ...discoveredModels,
        "gpt-5.5": discoveredModels["gpt-5.5"] ?? DEFAULT_MODELS["gpt-5.5"],
        "gpt-5.5-fast": discoveredModels["gpt-5.5-fast"] ?? DEFAULT_MODELS["gpt-5.5-fast"],
        "gpt-5.5-codex": discoveredModels["gpt-5.5-codex"] ?? DEFAULT_MODELS["gpt-5.5-codex"],
        "gpt-5.5-codex-fast": discoveredModels["gpt-5.5-codex-fast"] ?? DEFAULT_MODELS["gpt-5.5-codex-fast"],
      }
    : DEFAULT_MODELS
  const defaultsById = withFastModels(baseDefaultsById)
  const result = { ...existingModels }

  for (const [modelId, defaults] of Object.entries(defaultsById)) {
    const existing = result[modelId] ?? {}
    const variants = { ...(defaults.variants ?? {}), ...(existing.variants ?? {}) }
    const limit = mergedLimit(modelId, defaults, existing)

    result[modelId] = {
      ...defaults,
      ...existing,
      variants,
      ...(limit ? { limit } : {}),
    }
  }

  for (const [modelId, existing] of Object.entries(result)) {
    const apiModelId = typeof existing.id === "string" ? existing.id : modelId
    if (!isGpt55ModelId(modelId) && !isGpt55ModelId(apiModelId)) continue

    const defaults = gpt55DefaultsFor(apiModelId) ?? gpt55DefaultsFor(modelId)
    const variants = { ...(defaults.variants ?? {}), ...(existing.variants ?? {}) }
    const limit = mergedLimit(modelId, defaults, existing)

    result[modelId] = {
      ...existing,
      variants,
      ...(limit ? { limit } : {}),
    }
  }

  if (providerId(options) === "codex") {
    for (const [modelId, model] of Object.entries(result)) {
      if (isArtificialCodexAlias(modelId, model)) delete result[modelId]
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
          apiKey: existing.options?.apiKey ?? pluginOptions.placeholderApiKey,
          baseURL: existing.options?.baseURL ?? "https://api.openai.com/v1",
          fetch: existing.options?.fetch ?? createMultiAccountFetch(pluginOptions),
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
