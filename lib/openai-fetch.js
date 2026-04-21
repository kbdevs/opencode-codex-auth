import {
  computeRateLimitUntil,
  defaultStatePath,
  loadRegistry,
  loadState,
  saveRegistry,
  saveState,
  selectAccount,
  updateRegistryAccount,
} from "./accounts.js"
import { ensureOAuthAccessToken } from "./oauth.js"

const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/"
const OPENAI_BETA_RESPONSES = "responses=experimental"
const ORIGINATOR_CODEX = "codex_cli_rs"

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function extractRequestUrl(input) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

async function readBodyText(input, init) {
  if (typeof init?.body === "string") return init.body
  if (init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer) {
    return Buffer.from(init.body).toString("utf8")
  }
  if (input instanceof Request) {
    return input.clone().text()
  }
  return ""
}

function extractPathAndSearch(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {}

  const text = String(url || "").trim()
  if (!text) return "/v1/responses"
  if (text.startsWith("/")) return text
  const firstSlash = text.indexOf("/")
  return firstSlash >= 0 ? text.slice(firstSlash) : "/v1/responses"
}

function buildCodexUrl(originalUrl) {
  const pathAndSearch = extractPathAndSearch(originalUrl)
  let path = pathAndSearch

  if (path.includes("/v1/responses")) {
    path = path.replace("/v1/responses", "/codex/responses")
  } else if (path.includes("/responses")) {
    path = path.replace("/responses", "/codex/responses")
  } else if (path.includes("/v1/chat/completions")) {
    path = path.replace("/v1/chat/completions", "/codex/chat/completions")
  } else if (path.includes("/chat/completions")) {
    path = path.replace("/chat/completions", "/codex/chat/completions")
  }

  return new URL(path.replace(/^\/+/, ""), CHATGPT_CODEX_BASE).toString()
}

function normalizeModel(model) {
  if (!model) return { model: "gpt-5.4", forceFast: false }
  const full = String(model)
  const value = full.includes("/") ? full.split("/").pop() : full
  if (value.endsWith("-fast")) {
    return {
      model: value.slice(0, -"-fast".length),
      forceFast: true,
    }
  }
  return { model: value, forceFast: false }
}

function normalizeResponsesBody(body) {
  const next = body && typeof body === "object" ? { ...body } : {}
  const normalized = normalizeModel(next.model)

  next.model = normalized.model
  if (!Array.isArray(next.input) && typeof next.input === "string") {
    next.input = [
      {
        role: "user",
        content: [{ type: "input_text", text: next.input }],
      },
    ]
  }

  if (typeof next.instructions !== "string" || !next.instructions.trim()) {
    next.instructions = "You are OpenCode, a helpful coding assistant."
  }

  if (normalized.forceFast && next.service_tier === undefined) {
    next.service_tier = "priority"
  }

  return {
    body: next,
    modelId: normalized.model,
    forceFast: normalized.forceFast,
  }
}

function parseJsonBody(text) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function parseSseStream(sseText) {
  let finalResponse = null
  const outputTexts = []

  const lines = sseText.split("\n")
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue
    try {
      const data = JSON.parse(line.slice(6))
      if (data?.type === "response.output_text.done" && typeof data.text === "string") {
        outputTexts.push(data.text)
      }
      if (data?.type === "response.completed" || data?.type === "response.done") {
        finalResponse = data.response ?? null
      }
    } catch {}
  }

  if (
    finalResponse &&
    Array.isArray(finalResponse.output) &&
    finalResponse.output.length === 0 &&
    outputTexts.length > 0
  ) {
    finalResponse.output = [
      {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: outputTexts.join(""),
            annotations: [],
            logprobs: [],
          },
        ],
      },
    ]
  }

  return finalResponse
}

async function convertSseToJson(response) {
  const text = await response.text()
  const parsed = parseSseStream(text)
  if (!parsed) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    })
  }

  return new Response(JSON.stringify(parsed), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  })
}

function errorMessageFromBody(payload, fallback = "") {
  if (!payload || typeof payload !== "object") return fallback
  return (
    (typeof payload.detail === "string" && payload.detail) ||
    (typeof payload.detail?.message === "string" && payload.detail.message) ||
    (typeof payload.error?.message === "string" && payload.error.message) ||
    (typeof payload.message === "string" && payload.message) ||
    fallback
  )
}

async function chooseRegistryAccount({
  accountsPath,
  modelId,
  forcedAccountId,
  excludeAccountIds = [],
}) {
  const registry = await loadRegistry(accountsPath)
  const statePath = defaultStatePath(accountsPath)
  const state = await loadState(statePath)
  const selection = selectAccount({
    registry,
    state,
    modelId,
    forcedAccountId,
    excludeAccountIds,
  })

  if (!selection) return null

  if (selection.reason === "round-robin") {
    await saveState(selection.nextState, statePath)
  }

  return selection.account
}

async function updateAccount(accountsPath, accountId, patch) {
  const registry = await loadRegistry(accountsPath)
  const next = updateRegistryAccount(registry, accountId, patch)
  await saveRegistry(next, accountsPath)
}

async function markAccountUsed(accountsPath, account) {
  if (!account?.id) return
  await updateAccount(accountsPath, account.id, {
    lastUsed: Date.now(),
    usageCount: (account.usageCount || 0) + 1,
    rateLimitedUntil: undefined,
    limitError: undefined,
  })
}

function stripManagedHeaders(headers) {
  const next = new Headers(headers || {})
  next.delete("authorization")
  next.delete("Authorization")
  next.delete("x-api-key")
  next.delete("X-API-Key")
  next.delete("openai-beta")
  next.delete("OpenAI-Beta")
  next.delete("chatgpt-account-id")
  next.delete("ChatGPT-Account-Id")
  next.delete("originator")
  next.delete("Originator")
  return next
}

async function dispatchOAuthRequest({
  account,
  url,
  method,
  body,
  headers,
  signal,
}) {
  const nextHeaders = stripManagedHeaders(headers)
  nextHeaders.set("content-type", "application/json")
  nextHeaders.set("accept", "text/event-stream")
  nextHeaders.set("authorization", `Bearer ${account.accessToken}`)
  nextHeaders.set("chatgpt-account-id", account.accountId)
  nextHeaders.set("OpenAI-Beta", OPENAI_BETA_RESPONSES)
  nextHeaders.set("originator", ORIGINATOR_CODEX)

  return fetch(url, {
    method,
    headers: nextHeaders,
    body: JSON.stringify(body),
    signal,
  })
}

export function createMultiAccountFetch(options = {}) {
  const accountsPath = options.accountsPath
  const debug = options.debug === true
  const forcedAccountId = stringOrUndefined(options.accountId)

  return async (input, init = {}) => {
    const originalUrl = extractRequestUrl(input)
    const method = init.method || (input instanceof Request ? input.method : "POST")
    const originalBodyText = await readBodyText(input, init)
    const parsedBody = parseJsonBody(originalBodyText)
    const normalized = normalizeResponsesBody(parsedBody)
    const modelId = normalized.modelId
    const requestedStream = normalized.body.stream === true
    const triedAccountIds = new Set()

    for (;;) {
      let account =
        accountsPath &&
        (await chooseRegistryAccount({
          accountsPath,
          modelId,
          forcedAccountId,
          excludeAccountIds: Array.from(triedAccountIds),
        }))

      if (!account) {
        throw new Error(
          `No enabled Codex OAuth account is configured for model "${modelId}". ` +
            `Use node ./scripts/accounts.mjs list to inspect the registry.`,
        )
      }

      triedAccountIds.add(account.id)

      if (account.type !== "oauth") {
        if (forcedAccountId || !accountsPath) {
          throw new Error(`Account "${account.id}" is not a Codex OAuth account.`)
        }
        continue
      }

      try {
        const refreshed = await ensureOAuthAccessToken(account)
        if (refreshed.account && refreshed.refreshed && accountsPath) {
          account = refreshed.account
          await updateAccount(accountsPath, account.id, refreshed.account)
        }
      } catch (error) {
        if (accountsPath) {
          await updateAccount(accountsPath, account.id, {
            authInvalid: true,
            authInvalidatedAt: Date.now(),
            limitError: error instanceof Error ? error.message : String(error),
          })
        }

        if (forcedAccountId || !accountsPath) {
          throw error
        }
        continue
      }

      const oauthBody = {
        ...normalized.body,
        store: false,
        stream: true,
      }

      const response = await dispatchOAuthRequest({
        account,
        url: buildCodexUrl(originalUrl),
        method,
        body: oauthBody,
        headers: init.headers || (input instanceof Request ? input.headers : undefined),
        signal: init.signal,
      })

      if (debug) {
        console.log(
          `[opencode-codex] oauth:${account.id} ${modelId} -> ${response.status} ${buildCodexUrl(originalUrl)}`,
        )
      }

      if (response.status === 401 || response.status === 403) {
        const payload = parseJsonBody(await response.clone().text())
        if (accountsPath) {
          await updateAccount(accountsPath, account.id, {
            authInvalid: true,
            authInvalidatedAt: Date.now(),
            limitError: errorMessageFromBody(payload, `HTTP ${response.status}`),
          })
        }

        if (forcedAccountId || !accountsPath) {
          return response
        }
        continue
      }

      if (response.status === 429 && accountsPath) {
        const payload = parseJsonBody(await response.clone().text())
        await updateAccount(accountsPath, account.id, {
          rateLimitedUntil: computeRateLimitUntil({ headers: response.headers }),
          limitError: errorMessageFromBody(payload, "rate limited"),
        })

        if (!forcedAccountId) {
          continue
        }
      }

      if (response.ok && accountsPath) {
        await markAccountUsed(accountsPath, account)
      }

      if (!requestedStream) {
        return convertSseToJson(response)
      }

      return response
    }
  }
}
