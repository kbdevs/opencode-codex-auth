import { loadRegistry, modelMatchesPattern, saveRegistry } from "./accounts.js"
import { ensureOAuthAccessToken } from "./oauth.js"

const CHATGPT_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"
const OPENAI_BETA_RESPONSES = "responses=experimental"
const ORIGINATOR_CODEX = "codex_cli_rs"
const DEFAULT_CONTEXT_LIMIT = 400000
const DEFAULT_OUTPUT_LIMIT = 128000
const GPT_5_5_CONTEXT_LIMIT = 1000000
const OPENCODE_OAUTH_ALLOWED_MODELS = new Set([
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
])
const GPT_5_5_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"]

export const DEFAULT_CLIENT_VERSION = "1.0.0"

function createModel(name, overrides = {}) {
  const input = Array.isArray(overrides.modalities?.input)
    ? overrides.modalities.input
    : ["text", "image", "pdf"]

  return {
    ...(overrides.id ? { id: overrides.id } : {}),
    name,
    reasoning: overrides.reasoning ?? true,
    attachment: overrides.attachment ?? true,
    tool_call: overrides.tool_call ?? true,
    modalities: {
      input,
      output: ["text"],
    },
    limit: {
      context: overrides.limit?.context ?? DEFAULT_CONTEXT_LIMIT,
      output: overrides.limit?.output ?? DEFAULT_OUTPUT_LIMIT,
    },
    ...(overrides.variants ? { variants: overrides.variants } : {}),
  }
}

function openaiReasoningVariants(efforts) {
  return Object.fromEntries(
    uniqueStrings(efforts).map((effort) => [
      effort,
      {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    ]),
  )
}

function withPriorityTier(variants) {
  return Object.fromEntries(
    Object.entries(variants).map(([variantId, variant]) => [variantId, {
      ...variant,
      serviceTier: "priority",
    }]),
  )
}

function gpt55Model(name, actualModelId) {
  return createModel(name, {
    id: actualModelId,
    limit: { context: GPT_5_5_CONTEXT_LIMIT, output: DEFAULT_OUTPUT_LIMIT },
    variants: openaiReasoningVariants(GPT_5_5_REASONING_EFFORTS),
  })
}

function gpt55FastModel(name, actualModelId = "gpt-5.5") {
  return createModel(name, {
    id: actualModelId,
    limit: { context: GPT_5_5_CONTEXT_LIMIT, output: DEFAULT_OUTPUT_LIMIT },
    variants: withPriorityTier(openaiReasoningVariants(GPT_5_5_REASONING_EFFORTS)),
  })
}

export const DEFAULT_MODELS = {
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
  "gpt-5.5": gpt55Model("GPT-5.5"),
  "gpt-5.5-fast": gpt55FastModel("GPT-5.5 Fast"),
  "gpt-5.5-codex": gpt55Model("GPT-5.5", "gpt-5.5"),
  "gpt-5.5-codex-fast": gpt55FastModel("GPT-5.5 Fast", "gpt-5.5"),
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function uniqueStrings(values) {
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))]
}

function sameStringArray(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function finitePositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function accountHasCredentials(account) {
  return Boolean(account?.refreshToken || account?.accessToken)
}

function discoveryCandidates(registry, forcedAccountId) {
  if (forcedAccountId) {
    return registry.accounts.filter(
      (account) =>
        account.id === forcedAccountId &&
        account.enabled !== false &&
        account.type === "oauth" &&
        accountHasCredentials(account),
    )
  }

  return registry.accounts.filter(
    (account) => account.enabled !== false && account.type === "oauth" && accountHasCredentials(account),
  )
}

function exactIncludedModels(account) {
  return account.includeModels.filter((pattern) => !String(pattern).includes("*"))
}

function modelAllowedForAccount(account, modelId) {
  if (account.excludeModels.some((pattern) => modelMatchesPattern(modelId, pattern))) {
    return false
  }

  if (account.includeModels.length === 0) {
    return true
  }

  return account.includeModels.some((pattern) => modelMatchesPattern(modelId, pattern))
}

function accountVisibleModelIds(account, modelIds = []) {
  const result = modelIds.filter((modelId) => modelAllowedForAccount(account, modelId))

  for (const modelId of exactIncludedModels(account)) {
    if (modelAllowedForAccount(account, modelId)) {
      result.push(modelId)
    }
  }

  return uniqueStrings(result)
}

function fallbackModelName(modelId) {
  return DEFAULT_MODELS[modelId]?.name || modelId
}

function codexAliasModelId(modelId) {
  if (modelId.endsWith("-fast")) return `${modelId.slice(0, -"-fast".length)}-codex-fast`
  return `${modelId}-codex`
}

function needsCodexAlias(modelId) {
  return modelId.startsWith("gpt-") && !modelId.includes("codex") && !OPENCODE_OAUTH_ALLOWED_MODELS.has(modelId)
}

function catalogModelName(entry, actualModelId) {
  return stringOrUndefined(entry?.display_name) || fallbackModelName(actualModelId)
}

function catalogReasoningEfforts(entry, modelId) {
  const rawEfforts = [
    ...(Array.isArray(entry?.supported_reasoning_efforts) ? entry.supported_reasoning_efforts : []),
    ...(Array.isArray(entry?.supported_reasoning_levels) ? entry.supported_reasoning_levels : []),
  ]
  const efforts = uniqueStrings(
    rawEfforts
      .map(
        (effort) =>
          stringOrUndefined(effort) ||
          stringOrUndefined(effort?.effort) ||
          stringOrUndefined(effort?.level) ||
          stringOrUndefined(effort?.id) ||
          stringOrUndefined(effort?.name) ||
          stringOrUndefined(effort?.value),
      )
      .filter(Boolean),
  )

  if (efforts.length > 0) return efforts
  if (modelId === "gpt-5.5" || modelId === "gpt-5.5-fast") return GPT_5_5_REASONING_EFFORTS
  return []
}

function createCatalogModel(modelId, entry, actualModelId = modelId, name = catalogModelName(entry, actualModelId)) {
  const contextLimit =
    actualModelId === "gpt-5.5"
      ? GPT_5_5_CONTEXT_LIMIT
      : finitePositiveNumber(entry?.max_context_window) ||
        finitePositiveNumber(entry?.context_window) ||
        DEFAULT_CONTEXT_LIMIT

  if (!entry || typeof entry !== "object") {
    return createModel(name, {
      id: actualModelId !== modelId ? actualModelId : undefined,
      limit: { context: contextLimit, output: DEFAULT_OUTPUT_LIMIT },
      variants:
        actualModelId === "gpt-5.5" || actualModelId === "gpt-5.5-fast"
          ? openaiReasoningVariants(GPT_5_5_REASONING_EFFORTS)
          : undefined,
    })
  }

  const inputModalities = uniqueStrings(
    Array.isArray(entry.input_modalities) && entry.input_modalities.length > 0
      ? entry.input_modalities
      : ["text"],
  )

  return createModel(name, {
    id: actualModelId !== modelId ? actualModelId : undefined,
    reasoning: Boolean(
      entry.default_reasoning_level ||
        entry.default_reasoning_effort ||
        entry.supports_reasoning_summaries ||
        (Array.isArray(entry.supported_reasoning_levels) && entry.supported_reasoning_levels.length > 0) ||
        (Array.isArray(entry.supported_reasoning_efforts) && entry.supported_reasoning_efforts.length > 0),
    ),
    attachment: inputModalities.some((modality) => modality !== "text"),
    tool_call: Boolean(
      entry.apply_patch_tool_type || entry.web_search_tool_type || entry.supports_parallel_tool_calls || entry.shell_type,
    ),
    modalities: {
      input: inputModalities,
      output: ["text"],
    },
    limit: {
      context: contextLimit,
      output: DEFAULT_OUTPUT_LIMIT,
    },
    variants: openaiReasoningVariants(catalogReasoningEfforts(entry, actualModelId)),
  })
}

function createPriorityCatalogModel(modelId, entry, actualModelId = modelId, name = catalogModelName(entry, actualModelId)) {
  return {
    ...createCatalogModel(modelId, entry, actualModelId, name),
    variants: withPriorityTier(openaiReasoningVariants(catalogReasoningEfforts(entry, actualModelId))),
  }
}

function registerCatalogModel(catalog, modelId, entry, actualModelId = modelId) {
  const baseName = catalogModelName(entry, actualModelId)
  catalog[modelId] = catalog[modelId] ?? createCatalogModel(modelId, entry, actualModelId, baseName)

  if (needsCodexAlias(actualModelId)) {
    const aliasModelId = codexAliasModelId(actualModelId)
    const aliasName = baseName
    catalog[aliasModelId] = catalog[aliasModelId] ?? createCatalogModel(aliasModelId, entry, actualModelId, aliasName)
  }
}

function registerGpt55Models(catalog, entry) {
  catalog["gpt-5.5"] = catalog["gpt-5.5"] ?? createCatalogModel("gpt-5.5", entry, "gpt-5.5", "GPT-5.5")
  catalog["gpt-5.5-fast"] =
    catalog["gpt-5.5-fast"] ?? createPriorityCatalogModel("gpt-5.5-fast", entry, "gpt-5.5", "GPT-5.5 Fast")
  catalog["gpt-5.5-codex"] =
    catalog["gpt-5.5-codex"] ?? createCatalogModel("gpt-5.5-codex", entry, "gpt-5.5", "GPT-5.5")
  catalog["gpt-5.5-codex-fast"] =
    catalog["gpt-5.5-codex-fast"] ??
    createPriorityCatalogModel("gpt-5.5-codex-fast", entry, "gpt-5.5", "GPT-5.5 Fast")
}

function mergeDiscoveredModels(catalog, account, models) {
  const discovered = new Map(
    models
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => [stringOrUndefined(entry.slug), entry])
      .filter(([slug]) => slug),
  )

  for (const modelId of accountVisibleModelIds(account, [...discovered.keys()])) {
    registerCatalogModel(catalog, modelId, discovered.get(modelId))
    if (modelId === "gpt-5.5") registerGpt55Models(catalog, discovered.get(modelId))
  }
}

function mergeCachedModels(catalog, account) {
  for (const modelId of accountVisibleModelIds(account, account.availableModels)) {
    registerCatalogModel(catalog, modelId)
    if (modelId === "gpt-5.5") registerGpt55Models(catalog)
  }
}

async function fetchCodexModels(account, clientVersion) {
  const url = new URL(CHATGPT_CODEX_MODELS_URL)
  url.searchParams.set("client_version", clientVersion)

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${account.accessToken}`,
      "chatgpt-account-id": account.accountId,
      "openai-beta": OPENAI_BETA_RESPONSES,
      originator: ORIGINATOR_CODEX,
    },
  })

  let payload = null
  try {
    payload = await response.json()
  } catch {}

  if (!response.ok) {
    const detail =
      (typeof payload?.detail === "string" && payload.detail) ||
      (typeof payload?.error?.message === "string" && payload.error.message) ||
      `HTTP ${response.status}`
    throw new Error(detail)
  }

  return Array.isArray(payload?.models) ? payload.models : []
}

export async function discoverProviderModels(options = {}) {
  const accountsPath = stringOrUndefined(options.accountsPath)
  if (!accountsPath) {
    return { models: {}, resolved: false }
  }

  const debug = options.debug === true
  const forcedAccountId = stringOrUndefined(options.forcedAccountId)
  const clientVersion = stringOrUndefined(options.clientVersion) || DEFAULT_CLIENT_VERSION
  const registry = await loadRegistry(accountsPath)
  const accounts = registry.accounts.map((account) => ({ ...account }))
  const catalog = {}
  const candidates = discoveryCandidates(registry, forcedAccountId)
  let dirty = false
  let resolved = false

  for (const candidate of candidates) {
    const index = accounts.findIndex((account) => account.id === candidate.id)
    if (index < 0) continue

    let account = accounts[index]

    try {
      const refreshed = await ensureOAuthAccessToken(account)
      if (refreshed.account) {
        account = {
          ...account,
          ...refreshed.account,
          authInvalid: false,
        }
        accounts[index] = account
        if (refreshed.refreshed || candidate.authInvalid) {
          dirty = true
        }
      }

      const models = await fetchCodexModels(account, clientVersion)
      const availableModels = uniqueStrings(
        models.map((entry) => stringOrUndefined(entry?.slug)).filter(Boolean),
      ).sort()

      if (
        !sameStringArray(account.availableModels, availableModels) ||
        typeof account.availableModelsFetchedAt !== "number"
      ) {
        account = {
          ...account,
          availableModels,
          availableModelsFetchedAt: Date.now(),
          authInvalid: false,
        }
        accounts[index] = account
        dirty = true
      }

      mergeDiscoveredModels(catalog, account, models)
      resolved = true
    } catch (error) {
      if (debug) {
        console.warn(
          `[opencode-codex] failed to discover models for ${account.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      mergeCachedModels(catalog, account)
      if (account.availableModels.length > 0 || exactIncludedModels(account).length > 0) {
        resolved = true
      }
    }
  }

  if (dirty) {
    try {
      await saveRegistry({
        ...registry,
        accounts,
      }, accountsPath)
    } catch (error) {
      if (debug) {
        console.warn(
          `[opencode-codex] failed to save discovered models: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  return {
    models: Object.fromEntries(Object.entries(catalog).sort(([left], [right]) => left.localeCompare(right))),
    resolved,
  }
}
