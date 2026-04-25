import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getAccountIdFromClaims, getEmailFromClaims, getExpiryFromClaims, decodeJwtPayload } from "./oauth.js"

export const DEFAULT_ACCOUNTS_PATH = path.join(os.homedir(), ".config", "opencode", "codex-accounts.json")
export const LEGACY_ACCOUNT_PATHS = [
  path.join(os.homedir(), ".config", "opencode-multi-auth", "accounts.json"),
  path.join(os.homedir(), ".config", "opencode", "opencode-multi-auth-codex-accounts.json"),
]

const DEFAULT_STATE_FILE = ".codex-accounts.state.json"
const PLACEHOLDER_API_KEY = "plugin-managed-openai-key"
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000

function ensureObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function ensureStringArray(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : []
}

function isSupportedAccountType(account) {
  return account?.type === "oauth"
}

function finalizeRegistry(registry) {
  const accounts = (Array.isArray(registry.accounts) ? registry.accounts : []).filter(
    (account) => account.id && isSupportedAccountType(account),
  )
  const defaultAccountId = stringOrUndefined(registry.selection?.defaultAccountId)
  const hasDefault = defaultAccountId && accounts.some((account) => account.id === defaultAccountId)

  return {
    version: 2,
    selection: {
      strategy: registry.selection?.strategy === "default" ? "default" : "round-robin",
      defaultAccountId: hasDefault ? defaultAccountId : accounts[0]?.id ?? null,
    },
    accounts,
  }
}

export function getPlaceholderApiKey() {
  return PLACEHOLDER_API_KEY
}

export function defaultStatePath(accountsPath = DEFAULT_ACCOUNTS_PATH) {
  return path.join(path.dirname(accountsPath), DEFAULT_STATE_FILE)
}

export function createEmptyRegistry() {
  return {
    version: 2,
    selection: {
      strategy: "round-robin",
      defaultAccountId: null,
    },
    accounts: [],
  }
}

function inferAccountType(account) {
  if (account.type === "oauth" || account.refreshToken || account.accessToken || account.idToken) return "oauth"
  return "unsupported"
}

export function normalizeAccount(input, fallbackId) {
  const account = ensureObject(input)
  const accessClaims = decodeJwtPayload(account.accessToken)
  const idClaims = decodeJwtPayload(account.idToken)
  const id =
    stringOrUndefined(account.id) ||
    stringOrUndefined(account.alias) ||
    stringOrUndefined(fallbackId) ||
    stringOrUndefined(account.email) ||
    ""

  return {
    id,
    label: stringOrUndefined(account.label) || stringOrUndefined(account.alias),
    type: inferAccountType(account),
    accessToken: stringOrUndefined(account.accessToken),
    refreshToken: stringOrUndefined(account.refreshToken),
    idToken: stringOrUndefined(account.idToken),
    accountId: stringOrUndefined(account.accountId) || getAccountIdFromClaims(idClaims) || getAccountIdFromClaims(accessClaims),
    email: stringOrUndefined(account.email) || getEmailFromClaims(idClaims) || getEmailFromClaims(accessClaims),
    expiresAt:
      typeof account.expiresAt === "number"
        ? account.expiresAt
        : getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims),
    lastRefresh: stringOrUndefined(account.lastRefresh),
    lastUsed: typeof account.lastUsed === "number" ? account.lastUsed : undefined,
    usageCount: typeof account.usageCount === "number" ? account.usageCount : 0,
    enabled: account.enabled !== false,
    authInvalid: account.authInvalid === true,
    authInvalidatedAt: typeof account.authInvalidatedAt === "number" ? account.authInvalidatedAt : undefined,
    rateLimitedUntil: typeof account.rateLimitedUntil === "number" ? account.rateLimitedUntil : undefined,
    limitError: stringOrUndefined(account.limitError),
    includeModels: ensureStringArray(account.includeModels),
    excludeModels: ensureStringArray(account.excludeModels),
    availableModels: ensureStringArray(account.availableModels),
    availableModelsFetchedAt:
      typeof account.availableModelsFetchedAt === "number" ? account.availableModelsFetchedAt : undefined,
  }
}

function normalizeLegacyMapStore(store) {
  const rawAccounts = ensureObject(store.accounts)
  return finalizeRegistry({
    version: 2,
    selection: {
      strategy: store.rotationStrategy === "default" ? "default" : "round-robin",
      defaultAccountId: stringOrUndefined(store.activeAlias),
    },
    accounts: Object.entries(rawAccounts)
      .map(([alias, account]) => normalizeAccount(account, alias))
      .filter((account) => account.id),
  })
}

function normalizeLegacyArrayStore(store) {
  const accounts = Array.isArray(store.accounts) ? store.accounts : []
  const activeIndex = typeof store.activeIndex === "number" ? store.activeIndex : 0
  return finalizeRegistry({
    version: 2,
    selection: {
      strategy: "round-robin",
      defaultAccountId: normalizeAccount(accounts[activeIndex] || {}).id || null,
    },
    accounts: accounts.map((account, index) => normalizeAccount(account, account.id || account.alias || `account-${index + 1}`)).filter((account) => account.id),
  })
}

export function normalizeRegistry(input) {
  const registry = ensureObject(input, createEmptyRegistry())

  if (registry.accounts && !Array.isArray(registry.accounts) && typeof registry.accounts === "object") {
    return normalizeLegacyMapStore(registry)
  }

  if (
    Array.isArray(registry.accounts) &&
    (typeof registry.activeIndex === "number" ||
      (!registry.selection &&
        registry.accounts.some(
          (account) => ensureObject(account).accessToken || ensureObject(account).refreshToken || ensureObject(account).alias,
        )))
  ) {
    return normalizeLegacyArrayStore(registry)
  }

  return finalizeRegistry({
    version: 2,
    selection: {
      strategy: registry.selection?.strategy === "default" ? "default" : "round-robin",
      defaultAccountId: stringOrUndefined(registry.selection?.defaultAccountId) || null,
    },
    accounts: (Array.isArray(registry.accounts) ? registry.accounts : []).map((account) => normalizeAccount(account)),
  })
}

export async function loadRegistry(accountsPath = DEFAULT_ACCOUNTS_PATH) {
  try {
    const raw = await fs.readFile(accountsPath, "utf8")
    return normalizeRegistry(JSON.parse(raw))
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return createEmptyRegistry()
    }
    throw error
  }
}

export async function saveRegistry(registry, accountsPath = DEFAULT_ACCOUNTS_PATH) {
  const normalized = normalizeRegistry(registry)
  await fs.mkdir(path.dirname(accountsPath), { recursive: true })
  await fs.writeFile(accountsPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  try {
    await fs.chmod(accountsPath, 0o600)
  } catch {}
  return normalized
}

export async function loadState(statePath = defaultStatePath()) {
  try {
    const raw = await fs.readFile(statePath, "utf8")
    const parsed = ensureObject(JSON.parse(raw), {})
    return {
      version: 1,
      cursor: Number.isInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : 0,
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { version: 1, cursor: 0 }
    }
    throw error
  }
}

export async function saveState(state, statePath = defaultStatePath()) {
  const normalized = {
    version: 1,
    cursor: Number.isInteger(state?.cursor) && state.cursor >= 0 ? state.cursor : 0,
  }
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await fs.writeFile(statePath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  try {
    await fs.chmod(statePath, 0o600)
  } catch {}
  return normalized
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function patternToRegExp(pattern) {
  return new RegExp(`^${String(pattern).split("*").map(escapeRegExp).join(".*")}$`, "i")
}

export function modelMatchesPattern(modelId, pattern) {
  if (!pattern || pattern === "*") return true
  return patternToRegExp(pattern).test(String(modelId))
}

function accountHasCredentials(account) {
  if (account.type !== "oauth") return false
  return Boolean(account.refreshToken || account.accessToken)
}

function selectableModelIds(modelId) {
  const requestedModelId = String(modelId)
  const candidates = new Set([requestedModelId])

  if (requestedModelId.endsWith("-codex-fast")) {
    candidates.add(`${requestedModelId.slice(0, -"-codex-fast".length)}-fast`)
  }

  if (requestedModelId.endsWith("-codex")) {
    candidates.add(requestedModelId.slice(0, -"-codex".length))
  }

  if (candidates.has("gpt-5.5-fast")) {
    candidates.add("gpt-5.5")
  }

  return [...candidates]
}

export function accountSupportsModel(account, modelId, now = Date.now()) {
  if (account.type !== "oauth") return false
  if (!account.enabled) return false
  if (!accountHasCredentials(account)) return false
  if (account.authInvalid) return false
  if (typeof account.rateLimitedUntil === "number" && account.rateLimitedUntil > now) return false
  if (account.includeModels.length > 0 && !account.includeModels.some((pattern) => modelMatchesPattern(modelId, pattern))) {
    return false
  }
  if (account.excludeModels.some((pattern) => modelMatchesPattern(modelId, pattern))) {
    return false
  }
  if (
    account.includeModels.length === 0 &&
    account.availableModels.length > 0 &&
    !selectableModelIds(modelId).some((candidate) => account.availableModels.includes(candidate))
  ) {
    return false
  }
  return true
}

function uniqueAccounts(accounts) {
  const seen = new Set()
  const result = []
  for (const account of accounts) {
    const key = account.accountId || account.id || account.email
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(account)
  }
  return result
}

export function mergeRegistries(...registries) {
  const merged = createEmptyRegistry()
  for (const registry of registries.filter(Boolean)) {
    merged.accounts.push(...normalizeRegistry(registry).accounts)
    if (!merged.selection.defaultAccountId && registry.selection?.defaultAccountId) {
      merged.selection.defaultAccountId = registry.selection.defaultAccountId
    }
  }
  merged.accounts = uniqueAccounts(merged.accounts)
  return normalizeRegistry(merged)
}

export function updateRegistryAccount(registry, accountId, patch) {
  const next = normalizeRegistry(registry)
  next.accounts = next.accounts.map((account) => {
    if (account.id !== accountId) return account
    return normalizeAccount({ ...account, ...patch }, account.id)
  })
  return next
}

export function removeRegistryAccount(registry, accountId) {
  const next = normalizeRegistry(registry)
  next.accounts = next.accounts.filter((account) => account.id !== accountId)
  if (next.selection.defaultAccountId === accountId) {
    next.selection.defaultAccountId = next.accounts[0]?.id ?? null
  }
  return next
}

export function addOrReplaceRegistryAccount(registry, accountInput) {
  const next = normalizeRegistry(registry)
  const account = normalizeAccount(accountInput, accountInput.id || accountInput.alias)
  next.accounts = next.accounts.filter((item) => item.id !== account.id)
  next.accounts.push(account)
  if (!next.selection.defaultAccountId) {
    next.selection.defaultAccountId = account.id
  }
  return next
}

function findEligibleAccounts(registry, modelId, excludeAccountIds = []) {
  const excluded = new Set(excludeAccountIds)
  return registry.accounts.filter((account) => !excluded.has(account.id) && accountSupportsModel(account, modelId))
}

export function selectAccount({ registry, state, modelId, forcedAccountId, excludeAccountIds = [] }) {
  const eligible = findEligibleAccounts(registry, modelId, excludeAccountIds)

  if (forcedAccountId) {
    const forced = registry.accounts.find((account) => account.id === forcedAccountId)
    if (!forced) {
      throw new Error(`Forced account "${forcedAccountId}" was not found in the account registry.`)
    }
    if (!accountSupportsModel(forced, modelId)) {
      throw new Error(`Forced account "${forcedAccountId}" is not enabled for model "${modelId}".`)
    }
    return { account: forced, nextState: state, reason: "forced", eligible }
  }

  if (eligible.length === 0) {
    return null
  }

  const preferred = registry.selection.defaultAccountId
    ? eligible.find((account) => account.id === registry.selection.defaultAccountId)
    : undefined

  if (registry.selection.strategy === "default" && preferred) {
    return { account: preferred, nextState: state, reason: "default", eligible }
  }

  if (registry.selection.strategy === "default") {
    return { account: eligible[0], nextState: state, reason: "first-eligible", eligible }
  }

  const cursor = Number.isInteger(state?.cursor) && state.cursor >= 0 ? state.cursor : 0
  const index = cursor % eligible.length
  return {
    account: eligible[index],
    nextState: { version: 1, cursor: (cursor + 1) % eligible.length },
    reason: "round-robin",
    eligible,
  }
}

export function computeRateLimitUntil({ headers, fallbackMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS }) {
  const retryAfter = headers.get?.("retry-after")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) {
      return Date.now() + Math.max(1, seconds) * 1000
    }
    const dateValue = Date.parse(retryAfter)
    if (Number.isFinite(dateValue)) {
      return dateValue
    }
  }
  return Date.now() + fallbackMs
}

export async function importLegacyRegistries(paths = LEGACY_ACCOUNT_PATHS) {
  const registries = []
  for (const item of paths) {
    try {
      const raw = await fs.readFile(item, "utf8")
      registries.push(normalizeRegistry(JSON.parse(raw)))
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        throw error
      }
    }
  }
  return mergeRegistries(...registries)
}
