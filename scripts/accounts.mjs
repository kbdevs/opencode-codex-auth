#!/usr/bin/env node

import path from "node:path"

import {
  DEFAULT_ACCOUNTS_PATH,
  addOrReplaceRegistryAccount,
  createEmptyRegistry,
  importLegacyRegistries,
  loadRegistry,
  removeRegistryAccount,
  saveRegistry,
} from "../lib/accounts.js"
import { loginOAuthAccount } from "../lib/oauth.js"

function usage() {
  console.log(`Usage:
  node scripts/accounts.mjs init [--path PATH]
  node scripts/accounts.mjs list [--path PATH]
  node scripts/accounts.mjs login <id> [--path PATH] [--label LABEL]
  node scripts/accounts.mjs remove <id> [--path PATH]
  node scripts/accounts.mjs enable <id> [--path PATH]
  node scripts/accounts.mjs disable <id> [--path PATH]
  node scripts/accounts.mjs default <id> [--path PATH]
  node scripts/accounts.mjs strategy <round-robin|default> [--path PATH]
  node scripts/accounts.mjs import-legacy [--path PATH]
  node scripts/accounts.mjs path`)
}

function getFlag(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function cleanedArgs(args) {
  const result = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1
      continue
    }
    result.push(args[i])
  }
  return result
}

function accountsPath(args) {
  const value = getFlag(args, "--path")
  return value ? path.resolve(value) : DEFAULT_ACCOUNTS_PATH
}

function ensureAccount(registry, id) {
  const account = registry.accounts.find((item) => item.id === id)
  if (!account) throw new Error(`Account "${id}" was not found.`)
  return account
}

function printAccount(account) {
  const details = [
    `- ${account.id}`,
    account.label ? `label="${account.label}"` : undefined,
    `type=${account.type}`,
    account.enabled ? "enabled" : "disabled",
    account.email ? `email="${account.email}"` : undefined,
    account.authInvalid ? "auth-invalid" : undefined,
    account.rateLimitedUntil && account.rateLimitedUntil > Date.now()
      ? `rate-limited-until="${new Date(account.rateLimitedUntil).toISOString()}"`
      : undefined,
    account.includeModels.length ? `include=${account.includeModels.join(",")}` : undefined,
    account.excludeModels.length ? `exclude=${account.excludeModels.join(",")}` : undefined,
  ]
  console.log(details.filter(Boolean).join(" "))
}

async function run() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || command === "--help" || command === "-h") {
    usage()
    return
  }

  if (command === "path") {
    console.log(DEFAULT_ACCOUNTS_PATH)
    return
  }

  const targetPath = accountsPath(args)

  if (command === "init") {
    await saveRegistry(createEmptyRegistry(), targetPath)
    console.log(`Initialized account registry at ${targetPath}`)
    return
  }

  const positional = cleanedArgs(args)
  let registry = await loadRegistry(targetPath)

  if (command === "list") {
    if (registry.accounts.length === 0) {
      console.log(`No accounts configured in ${targetPath}`)
      return
    }
    console.log(`Registry: ${targetPath}`)
    console.log(`Strategy: ${registry.selection.strategy}`)
    console.log(`Default: ${registry.selection.defaultAccountId ?? "(none)"}`)
    for (const account of registry.accounts) {
      printAccount(account)
    }
    return
  }

  if (command === "import-legacy") {
    const imported = await importLegacyRegistries()
    registry = {
      ...registry,
      accounts: [...registry.accounts],
    }
    for (const account of imported.accounts) {
      registry = addOrReplaceRegistryAccount(registry, account)
    }
    if (!registry.selection.defaultAccountId) {
      registry.selection.defaultAccountId = imported.selection.defaultAccountId || registry.accounts[0]?.id || null
    }
    await saveRegistry(registry, targetPath)
    console.log(`Imported ${imported.accounts.length} account(s) into ${targetPath}`)
    return
  }

  if (command === "login") {
    const accountId = positional[1]
    if (!accountId) throw new Error("Account id is required for login.")
    const label = getFlag(args, "--label")
    const account = await loginOAuthAccount(accountId, { label })
    registry = addOrReplaceRegistryAccount(registry, account)
    await saveRegistry(registry, targetPath)
    console.log(`Saved OAuth account "${accountId}" to ${targetPath}`)
    return
  }

  if (command === "remove") {
    const accountId = positional[1]
    if (!accountId) throw new Error("Account id is required for remove.")
    ensureAccount(registry, accountId)
    registry = removeRegistryAccount(registry, accountId)
    await saveRegistry(registry, targetPath)
    console.log(`Removed account "${accountId}" from ${targetPath}`)
    return
  }

  if (command === "enable" || command === "disable") {
    const accountId = positional[1]
    if (!accountId) throw new Error(`Account id is required for ${command}.`)
    const account = ensureAccount(registry, accountId)
    account.enabled = command === "enable"
    await saveRegistry(registry, targetPath)
    console.log(`${command === "enable" ? "Enabled" : "Disabled"} account "${accountId}"`)
    return
  }

  if (command === "default") {
    const accountId = positional[1]
    if (!accountId) throw new Error("Account id is required for default.")
    ensureAccount(registry, accountId)
    registry.selection.defaultAccountId = accountId
    await saveRegistry(registry, targetPath)
    console.log(`Default account set to "${accountId}"`)
    return
  }

  if (command === "strategy") {
    const strategy = positional[1]
    if (!strategy || !["round-robin", "default"].includes(strategy)) {
      throw new Error('Strategy must be "round-robin" or "default".')
    }
    registry.selection.strategy = strategy
    await saveRegistry(registry, targetPath)
    console.log(`Selection strategy set to "${strategy}"`)
    return
  }

  usage()
  process.exitCode = 1
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
