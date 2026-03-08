import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'
import { readFileSync } from 'node:fs'

export interface LndConfig {
  /** LND REST API URL (e.g. https://localhost:8080) */
  url: string
  /** Admin macaroon as hex string */
  macaroon?: string
  /** Path to admin.macaroon file (alternative to hex) */
  macaroonPath?: string
}

/**
 * Lightning backend adapter for LND's REST API.
 *
 * Authenticates via the `Grpc-Metadata-macaroon` header using a hex-encoded
 * admin macaroon. The macaroon can be provided directly or read from a file.
 *
 * @see https://lightning.engineering/api-docs/api/lnd/
 */
export function lndBackend(config: LndConfig): LightningBackend {
  const baseUrl = config.url.replace(/\/$/, '')

  let macaroonHex: string
  if (config.macaroon) {
    macaroonHex = config.macaroon
  } else if (config.macaroonPath) {
    macaroonHex = readFileSync(config.macaroonPath).toString('hex')
  } else {
    throw new Error('LND backend requires either macaroon (hex) or macaroonPath')
  }

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const res = await fetch(`${baseUrl}/v1/invoices`, {
        method: 'POST',
        headers: {
          'Grpc-Metadata-macaroon': macaroonHex,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: String(amountSats), memo: memo ?? '' }),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LND createinvoice failed (${res.status}): ${text}`)
      }

      const data = await res.json() as { r_hash: string; payment_request: string }
      const paymentHash = Buffer.from(data.r_hash, 'base64').toString('hex')

      return { bolt11: data.payment_request, paymentHash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      const hashBase64 = Buffer.from(paymentHash, 'hex')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')

      const res = await fetch(`${baseUrl}/v1/invoice/${hashBase64}`, {
        headers: { 'Grpc-Metadata-macaroon': macaroonHex },
      })

      if (!res.ok) return { paid: false }

      const data = await res.json() as { settled: boolean; r_preimage?: string }

      return {
        paid: data.settled,
        preimage: data.settled && data.r_preimage
          ? Buffer.from(data.r_preimage, 'base64').toString('hex')
          : undefined,
      }
    },
  }
}
