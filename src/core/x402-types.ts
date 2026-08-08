/** Internal normalised payment (flat structure passed to facilitator). */
export interface X402Payment {
  signature: string
  sender: string
  amount: number        // cents
  network: string       // CAIP-2 network ID
  nonce: string
  /** Asset contract the payer claims to have used (v2 `accepted` block). */
  asset?: string
  /** Recipient the payer claims to have paid (v2 `accepted` block). */
  payTo?: string
}

export interface X402VerifyResult {
  valid: boolean
  txHash: string
  amount: number        // settled amount (cents)
  sender: string
}

export interface X402Facilitator {
  /**
   * Verify a payment payload. `requirements` carries the full advertised
   * payment requirements (amount, network, asset, payTo) so the facilitator
   * can validate the signed authorisation against them — a validly signed
   * underpayment or a payment on the wrong network/asset/recipient must
   * not verify.
   */
  verify(payload: X402Payment, requirements: X402PaymentRequirements): Promise<X402VerifyResult>
}

export interface X402RailConfig {
  receiverAddress: string
  network: string
  asset?: string
  facilitator: X402Facilitator
  creditMode?: boolean  // default: true
  facilitatorUrl?: string
  /** Max seconds before payment authorisation expires. Default 3600. */
  maxTimeoutSeconds?: number
  /** Storage backend — required for credit mode to persist balances. Injected by Booth. */
  storage?: import('../storage/interface.js').StorageBackend
}

/** Default USDC contract addresses by network */
export const DEFAULT_USDC_ASSETS: Record<string, string> = {
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'polygon': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
}

// ── x402 v2 wire format types ──────────────────────────────────────

export const X402_VERSION = 2

export interface X402PaymentRequirements {
  scheme: string
  network: string
  amount: string          // string for precision
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

export interface X402Resource {
  url: string
  description?: string
  mimeType?: string
}

/** PAYMENT-REQUIRED header (base64-encoded JSON). */
export interface X402ChallengeWire {
  x402Version: number
  accepts: X402PaymentRequirements[]
  resource?: X402Resource
}

/** PAYMENT-SIGNATURE header (base64-encoded JSON). */
export interface X402PaymentWire {
  x402Version: number
  resource?: X402Resource
  accepted?: X402PaymentRequirements
  payload: {
    signature: string
    authorization: {
      from: string
      to: string
      value: string
      validAfter: string
      validBefore: string
      nonce: string
    }
  }
}
