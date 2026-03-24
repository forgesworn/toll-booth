// src/init-prompts.ts — interactive prompt flow + config builder for `toll-booth init`

import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

// ---- Data types ----

export type Framework = 'express' | 'hono' | 'deno' | 'bun'
export type Backend = 'phoenixd' | 'lnd' | 'cln' | 'lnbits' | 'nwc' | 'cashu-only'
export type PricingMode = 'flat' | 'tiered' | 'per-token'

export interface InitConfig {
  framework: Framework
  backend: Backend
  pricingMode: PricingMode
  upstream: string
  projectName: string
}

export interface TemplateContext {
  framework: Framework
  backend: Backend
  pricingMode: PricingMode
  upstream: string
  projectName: string
  backendImport: string
  backendSetup: string
  envVars: Record<string, string>
  dependencies: string[]
}

export type PartialInitConfig = {
  [K in keyof InitConfig]?: InitConfig[K]
}

// ---- Constants ----

const FRAMEWORKS: Framework[] = ['express', 'hono', 'deno', 'bun']
const BACKENDS: Backend[] = ['phoenixd', 'lnd', 'cln', 'lnbits', 'nwc', 'cashu-only']
const PRICING_MODES: PricingMode[] = ['flat', 'tiered', 'per-token']

const BACKEND_MAP: Record<Backend, {
  importStatement: string
  setup: string
  envVars: Record<string, string>
}> = {
  phoenixd: {
    importStatement: "import { phoenixdBackend } from '@forgesworn/toll-booth/backends/phoenixd'",
    setup: "phoenixdBackend({ url: process.env.PHOENIXD_URL!, password: process.env.PHOENIXD_PASSWORD! })",
    envVars: {
      PHOENIXD_URL: 'Phoenixd HTTP endpoint (e.g. http://localhost:9740)',
      PHOENIXD_PASSWORD: 'Phoenixd authentication password',
    },
  },
  lnd: {
    importStatement: "import { lndBackend } from '@forgesworn/toll-booth/backends/lnd'",
    setup: "lndBackend({ url: process.env.LND_REST_URL!, macaroon: process.env.LND_MACAROON! })",
    envVars: {
      LND_REST_URL: 'LND REST API endpoint (e.g. https://localhost:8080)',
      LND_MACAROON: 'LND admin macaroon (hex-encoded)',
    },
  },
  cln: {
    importStatement: "import { clnBackend } from '@forgesworn/toll-booth/backends/cln'",
    setup: "clnBackend({ url: process.env.CLN_REST_URL!, rune: process.env.CLN_RUNE! })",
    envVars: {
      CLN_REST_URL: 'Core Lightning REST endpoint',
      CLN_RUNE: 'Core Lightning rune token',
    },
  },
  lnbits: {
    importStatement: "import { lnbitsBackend } from '@forgesworn/toll-booth/backends/lnbits'",
    setup: "lnbitsBackend({ url: process.env.LNBITS_URL!, apiKey: process.env.LNBITS_API_KEY! })",
    envVars: {
      LNBITS_URL: 'LNbits instance URL',
      LNBITS_API_KEY: 'LNbits admin API key',
    },
  },
  nwc: {
    importStatement: "import { nwcBackend } from '@forgesworn/toll-booth/backends/nwc'",
    setup: "nwcBackend({ uri: process.env.NWC_URI! })",
    envVars: {
      NWC_URI: 'Nostr Wallet Connect URI (nostr+walletconnect://...)',
    },
  },
  'cashu-only': {
    importStatement: '',
    setup: '',
    envVars: {
      CASHU_MINT_URL: 'Cashu mint URL (optional; for token validation)',
    },
  },
}

// ---- Config builder ----

export function buildTemplateContext(config: InitConfig): TemplateContext {
  const backendInfo = BACKEND_MAP[config.backend]

  // Common env vars
  const envVars: Record<string, string> = {
    PORT: 'HTTP listen port (default: 3000)',
    ROOT_KEY: 'Macaroon signing key (64-char hex; 32 bytes)',
    FREE_TIER_REQUESTS: 'Daily free requests per IP (default: 10)',
    ...backendInfo.envVars,
  }

  if (config.upstream !== 'stub') {
    envVars.UPSTREAM_URL = 'Upstream API URL to proxy'
  }

  // Dependencies
  const dependencies: string[] = ['@forgesworn/toll-booth']

  if (config.framework === 'express') {
    dependencies.push('express')
  } else if (config.framework === 'hono') {
    dependencies.push('hono')
  }
  // deno and bun have no extra framework dependency

  return {
    framework: config.framework,
    backend: config.backend,
    pricingMode: config.pricingMode,
    upstream: config.upstream,
    projectName: config.projectName,
    backendImport: backendInfo.importStatement,
    backendSetup: backendInfo.setup,
    envVars,
    dependencies,
  }
}

// ---- CLI flag parsing ----

export function parseCliFlags(argv: string[]): PartialInitConfig {
  const result: PartialInitConfig = {}

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]

    if (!flag?.startsWith('--') || value === undefined) continue

    switch (flag) {
      case '--name':
        result.projectName = value
        i++
        break
      case '--framework':
        if (FRAMEWORKS.includes(value as Framework)) {
          result.framework = value as Framework
        }
        i++
        break
      case '--backend':
        if (BACKENDS.includes(value as Backend)) {
          result.backend = value as Backend
        }
        i++
        break
      case '--pricing':
        if (PRICING_MODES.includes(value as PricingMode)) {
          result.pricingMode = value as PricingMode
        }
        i++
        break
      case '--upstream':
        result.upstream = value
        i++
        break
      default:
        i++ // skip unknown flag's value
        break
    }
  }

  return result
}

// ---- Interactive readline flow ----

async function askChoice<T extends string>(
  rl: readline.Interface,
  question: string,
  options: T[],
  defaultIndex: number,
): Promise<T> {
  const lines = options.map((opt, i) =>
    `  ${i + 1}) ${opt}${i === defaultIndex ? ' (default)' : ''}`,
  )
  const prompt = `${question}\n${lines.join('\n')}\n> `

  const answer = await rl.question(prompt)
  const trimmed = answer.trim()

  if (trimmed === '') return options[defaultIndex]!

  const num = parseInt(trimmed, 10)
  if (num >= 1 && num <= options.length) return options[num - 1]!

  // Try matching by name
  const match = options.find(o => o === trimmed.toLowerCase())
  if (match) return match

  // Fall back to default
  return options[defaultIndex]!
}

async function askText(
  rl: readline.Interface,
  question: string,
  defaultValue: string,
): Promise<string> {
  const prompt = `${question} (default: ${defaultValue})\n> `
  const answer = await rl.question(prompt)
  const trimmed = answer.trim()
  return trimmed === '' ? defaultValue : trimmed
}

export async function runInteractivePrompt(
  existingFlags?: PartialInitConfig,
): Promise<InitConfig> {
  const flags = existingFlags ?? parseCliFlags(process.argv.slice(3))

  // If all flags are provided, skip interactive prompt entirely
  if (
    flags.projectName !== undefined &&
    flags.framework !== undefined &&
    flags.backend !== undefined &&
    flags.pricingMode !== undefined &&
    flags.upstream !== undefined
  ) {
    return flags as InitConfig
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })

  try {
    const projectName = flags.projectName ??
      await askText(rl, 'Project name?', 'my-toll-booth-api')

    const framework = flags.framework ??
      await askChoice(rl, 'Framework?', FRAMEWORKS, 0)

    const backend = flags.backend ??
      await askChoice(rl, 'Lightning backend?', BACKENDS, 0)

    const pricingMode = flags.pricingMode ??
      await askChoice(rl, 'Pricing mode?', PRICING_MODES, 0)

    const upstream = flags.upstream ??
      await askText(rl, 'Upstream URL?', 'stub')

    return { projectName, framework, backend, pricingMode, upstream }
  } finally {
    rl.close()
  }
}
