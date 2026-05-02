# opencode-codex-auth

Local OpenCode plugin that rotates between multiple Codex OAuth accounts for Codex-capable models.

## What it does

- Routes OpenCode `codex/*` requests through a local account registry.
- Supports ChatGPT/Codex OAuth logins only. No API-key mode.
- Supports easy `login`, `remove`, `enable`, `disable`, `default`, and `strategy` account management.
- Fetches the Codex model catalog each enabled account can use and injects the union into the OpenCode `codex` provider config.
- Adds explicit `*-fast` model entries that request `serviceTier: "priority"`.
- Defaults OpenCode requests to `reasoningEffort: "low"` when no provider default is already set.

The plugin refreshes ChatGPT/Codex OAuth tokens and forwards OpenCode's Responses API traffic to the ChatGPT Codex backend.

## Files

- [index.js](./index.js)
- [lib/accounts.js](./lib/accounts.js)
- [lib/openai-fetch.js](./lib/openai-fetch.js)
- [lib/oauth.js](./lib/oauth.js)
- [scripts/accounts.mjs](./scripts/accounts.mjs)
- [opencode.example.jsonc](./opencode.example.jsonc)

## Setup

1. Add the plugin to your OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-codex",
      {
        "accountsPath": "~/.config/opencode/codex-accounts.json",
        "clientVersion": "1.0.0",
        "reasoningEffort": "low"
      }
    ]
  ]
}
```

2. Create or import the account registry:

```bash
node ./scripts/accounts.mjs init
node ./scripts/accounts.mjs import-legacy
```

3. Add accounts:

```bash
node ./scripts/accounts.mjs login personal
node ./scripts/accounts.mjs login work
```

4. Choose how selection works:

```bash
node ./scripts/accounts.mjs strategy round-robin
node ./scripts/accounts.mjs default personal
```

5. Start OpenCode and pick models from the `codex` provider, for example:

- `codex/gpt-5.3-codex`
- `codex/gpt-5.4`
- `codex/gpt-5.5`
- `codex/gpt-5.4-fast`

The plugin fetches those model IDs from `https://chatgpt.com/backend-api/codex/models` at startup using each enabled OAuth account, then caches the discovered slugs in the registry so account rotation can respect per-account model access.

## Registry format

The default registry path is `~/.config/opencode/codex-accounts.json`.

```json
{
  "version": 2,
  "selection": {
    "strategy": "round-robin",
    "defaultAccountId": "personal"
  },
  "accounts": [
    {
      "id": "personal",
      "label": "Personal",
      "type": "oauth",
      "accessToken": "...",
      "refreshToken": "...",
      "idToken": "...",
      "accountId": "...",
      "email": "you@example.com",
      "expiresAt": 1777590611000,
      "lastRefresh": "2026-04-20T23:10:10.889Z",
      "enabled": true,
      "includeModels": [],
      "excludeModels": [],
      "availableModels": ["gpt-5.4", "gpt-5.5"],
      "availableModelsFetchedAt": 1777590611000
    }
  ]
}
```

## Commands

```bash
node ./scripts/accounts.mjs list
node ./scripts/accounts.mjs login personal
node ./scripts/accounts.mjs import-legacy
node ./scripts/accounts.mjs remove work
node ./scripts/accounts.mjs disable personal
node ./scripts/accounts.mjs enable personal
node ./scripts/accounts.mjs default work
```

Run those commands from the repository root, or replace `./scripts/accounts.mjs` with the absolute path to the script.

## Environment overrides

- `OPENCODE_CODEX_ACCOUNTS_FILE` overrides the registry path.
- `OPENCODE_CODEX_ACCOUNT` forces a specific configured account for the current process.
- `providerId` plugin option overrides the OpenCode provider ID. Default: `codex`.
- `clientVersion` plugin option overrides the `client_version` used when fetching the Codex model catalog. Default: `1.0.0`.
- `OPENCODE_CODEX_CLIENT_VERSION` overrides the `client_version` used when fetching the Codex model catalog. Default: `1.0.0`.
- `OPENCODE_CODEX_DEBUG=1` enables plugin debug logging.
- `OPENCODE_CODEX_REASONING_EFFORT` overrides the default reasoning effort used when OpenCode does not set one.

## Notes

- OAuth accounts are sent to `https://chatgpt.com/backend-api/codex/responses` with account-specific OAuth headers.
- Model discovery uses `https://chatgpt.com/backend-api/codex/models?client_version=...` and falls back to a baked-in model list if discovery is unavailable.
- Unsupported non-OAuth entries are ignored if they appear in imported legacy registries.
- `*-fast` models map request intent to `serviceTier: "priority"`. On ChatGPT-backed Codex OAuth accounts, the backend currently reports `service_tier: "auto"` in responses even when priority is requested.
