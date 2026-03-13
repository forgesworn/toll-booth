import type { StorageBackend } from '../storage/interface.js'
import type { NwcPayRequest, NwcPayResult } from './types.js'
import { PAYMENT_HASH_RE } from './types.js'

export interface NwcPayDeps {
  nwcPay: (nwcUri: string, bolt11: string) => Promise<string>
  storage: StorageBackend
}

export async function handleNwcPay(
  deps: NwcPayDeps,
  request: NwcPayRequest,
): Promise<NwcPayResult> {
  try {
    const { nwcUri, bolt11, paymentHash, statusToken } = request
    if (
      typeof nwcUri !== 'string' || !nwcUri || nwcUri.length > 2048 ||
      typeof bolt11 !== 'string' || !bolt11 || bolt11.length > 2048 ||
      !PAYMENT_HASH_RE.test(paymentHash) ||
      typeof statusToken !== 'string' || !statusToken || statusToken.length > 128
    ) {
      return { success: false, error: 'Invalid request: nwcUri, bolt11, paymentHash and statusToken required', status: 400 }
    }

    // Validate NWC URI scheme to prevent SSRF via arbitrary WebSocket connections
    if (!nwcUri.startsWith('nostr+walletconnect://')) {
      return { success: false, error: 'nwcUri must use the nostr+walletconnect:// scheme', status: 400 }
    }

    const invoice = deps.storage.getInvoiceForStatus(paymentHash, statusToken)
    if (!invoice || invoice.bolt11 !== bolt11) {
      return { success: false, error: 'Unknown invoice or invoice mismatch', status: 400 }
    }

    const preimage = await deps.nwcPay(nwcUri, invoice.bolt11)
    return { success: true, preimage }
  } catch (err) {
    console.error('[toll-booth] NWC payment error:', err instanceof Error ? err.message.replace(/nostr\+walletconnect:\/\/\S+/g, '[redacted]') : 'unknown')
    return { success: false, error: 'NWC payment failed', status: 500 }
  }
}
