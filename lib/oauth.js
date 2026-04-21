import crypto from "node:crypto"
import http from "node:http"
import { execFile } from "node:child_process"

const OPENAI_ISSUER = "https://auth.openai.com"
const AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`
const TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`
const USERINFO_URL = `${OPENAI_ISSUER}/userinfo`
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEFAULT_REDIRECT_PORTS = [1455, 1456, 1457, 1458, 1459]
const SCOPES = ["openid", "profile", "email", "offline_access"]

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest()
}

function buildPkce() {
  const verifier = base64Url(crypto.randomBytes(48))
  return {
    verifier,
    challenge: base64Url(sha256(verifier)),
  }
}

function redirectUri(port) {
  return `http://localhost:${port}/auth/callback`
}

export function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".")
    if (parts.length !== 3) return null
    const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), "=")
    const normalized = padded.replaceAll("-", "+").replaceAll("_", "/")
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"))
  } catch {
    return null
  }
}

export function getEmailFromClaims(claims) {
  if (!claims || typeof claims !== "object") return undefined
  if (typeof claims.email === "string" && claims.email) return claims.email
  const profile = claims["https://api.openai.com/profile"]
  if (profile && typeof profile.email === "string" && profile.email) return profile.email
  return undefined
}

export function getAccountIdFromClaims(claims) {
  if (!claims || typeof claims !== "object") return undefined
  const auth = claims["https://api.openai.com/auth"]
  if (auth && typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id) {
    return auth.chatgpt_account_id
  }
  return undefined
}

export function getExpiryFromClaims(claims) {
  if (!claims || typeof claims !== "object") return undefined
  if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
    return claims.exp * 1000
  }
  return undefined
}

async function fetchUserEmail(accessToken) {
  try {
    const response = await fetch(USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
    if (!response.ok) return undefined
    const user = await response.json()
    return typeof user.email === "string" && user.email ? user.email : undefined
  } catch {
    return undefined
  }
}

function normalizeOAuthAccountPayload(id, label, tokens) {
  const accessClaims = decodeJwtPayload(tokens.access_token)
  const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null
  return {
    id,
    label,
    type: "oauth",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    accountId: getAccountIdFromClaims(idClaims) || getAccountIdFromClaims(accessClaims),
    expiresAt: getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || Date.now() + tokens.expires_in * 1000,
  }
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError)
      reject(error)
    }
    server.on("error", onError)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError)
      resolve(port)
    })
  })
}

async function findOpenPort(server, preferredPorts = DEFAULT_REDIRECT_PORTS) {
  for (const port of preferredPorts) {
    try {
      await tryListen(server, port)
      return port
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EADDRINUSE") {
        continue
      }
      throw error
    }
  }
  throw new Error(`No local OAuth callback port was available (${preferredPorts.join(", ")}).`)
}

async function maybeOpenBrowser(url) {
  if (process.platform !== "darwin") return
  await new Promise((resolve) => {
    execFile("open", [url], () => resolve())
  })
}

export async function loginOAuthAccount(id, options = {}) {
  const label = typeof options.label === "string" && options.label.trim() ? options.label.trim() : undefined
  const pkce = buildPkce()
  const state = crypto.randomBytes(16).toString("hex")
  const server = http.createServer()
  const port = await findOpenPort(server, DEFAULT_REDIRECT_PORTS)
  let timeoutId

  const resultPromise = new Promise((resolve, reject) => {
    server.removeAllListeners("request")
    server.on("request", async (request, response) => {
      if (!request.url?.startsWith("/auth/callback")) {
        response.writeHead(404)
        response.end("Not found")
        return
      }

      try {
        const url = new URL(request.url, "http://127.0.0.1")
        const code = url.searchParams.get("code")
        const returnedState = url.searchParams.get("state")

        if (!code) throw new Error("No authorization code was returned.")
        if (returnedState !== state) throw new Error("OAuth state mismatch.")

        const tokenResponse = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            code_verifier: pkce.verifier,
            redirect_uri: redirectUri(port),
          }),
        })

        if (!tokenResponse.ok) {
          throw new Error(`Token exchange failed with status ${tokenResponse.status}.`)
        }

        const tokens = await tokenResponse.json()
        if (!tokens.refresh_token) {
          throw new Error("OAuth flow did not return a refresh token.")
        }

        const account = normalizeOAuthAccountPayload(id, label, tokens)
        account.email = (await fetchUserEmail(tokens.access_token)) || getEmailFromClaims(decodeJwtPayload(tokens.id_token))
        account.enabled = true
        account.includeModels = []
        account.excludeModels = []
        account.authInvalid = false
        account.lastRefresh = new Date().toISOString()

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        response.end("<html><body style='font-family:system-ui;padding:32px'><h1>Login complete</h1><p>You can close this tab.</p></body></html>")
        resolve(account)
      } catch (error) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
        response.end("Authentication failed")
        reject(error)
      }
    })

    timeoutId = setTimeout(() => {
      reject(new Error("Timed out waiting for OAuth callback."))
    }, 5 * 60 * 1000)
  }).finally(() => {
    clearTimeout(timeoutId)
    server.close()
  })

  const authUrl = new URL(AUTHORIZE_URL)
  authUrl.searchParams.set("client_id", CLIENT_ID)
  authUrl.searchParams.set("redirect_uri", redirectUri(port))
  authUrl.searchParams.set("response_type", "code")
  authUrl.searchParams.set("scope", SCOPES.join(" "))
  authUrl.searchParams.set("code_challenge", pkce.challenge)
  authUrl.searchParams.set("code_challenge_method", "S256")
  authUrl.searchParams.set("state", state)
  authUrl.searchParams.set("audience", "https://api.openai.com/v1")
  authUrl.searchParams.set("id_token_add_organizations", "true")
  authUrl.searchParams.set("codex_cli_simplified_flow", "true")
  authUrl.searchParams.set("originator", "codex_cli_rs")

  if (options.openBrowser !== false) {
    await maybeOpenBrowser(authUrl.toString())
  }

  console.log(`Open this URL to authorize "${id}":\n${authUrl.toString()}\n`)
  return resultPromise
}

export async function refreshOAuthAccount(account) {
  if (!account?.refreshToken) return null

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: account.refreshToken,
    }),
  })

  if (!response.ok) {
    const error = new Error(`Refresh failed with status ${response.status}.`)
    error.status = response.status
    throw error
  }

  const tokens = await response.json()
  const refreshed = {
    ...account,
    ...normalizeOAuthAccountPayload(account.id, account.label, {
      ...tokens,
      refresh_token: tokens.refresh_token || account.refreshToken,
      id_token: tokens.id_token || account.idToken,
    }),
    email: account.email || (await fetchUserEmail(tokens.access_token)),
    lastRefresh: new Date().toISOString(),
    authInvalid: false,
  }

  return refreshed
}

export async function ensureOAuthAccessToken(account) {
  if (!account) return { account: null, token: null, refreshed: false }
  const needsRefresh = !account.accessToken || !account.expiresAt || account.expiresAt < Date.now() + 5 * 60 * 1000
  if (!needsRefresh) {
    return { account, token: account.accessToken, refreshed: false }
  }
  const refreshed = await refreshOAuthAccount(account)
  return { account: refreshed, token: refreshed.accessToken, refreshed: true }
}
