export interface X402Payment {
  signature: string
  sender: string
  amount: number        // cents
  network: string       // CAIP-2 network ID
  nonce: string
}

export interface X402VerifyResult {
  valid: boolean
  txHash: string
  amount: number        // settled amount (cents)
  sender: string
}

export interface X402Facilitator {
  verify(payload: X402Payment): Promise<X402VerifyResult>
}

export interface X402RailConfig {
  receiverAddress: string
  network: string
  asset?: string
  facilitator: X402Facilitator
  creditMode?: boolean  // default: true
  facilitatorUrl?: string
}

/** Default USDC contract addresses by network */
export const DEFAULT_USDC_ASSETS: Record<string, string> = {
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'polygon': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
}
