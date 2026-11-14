// src/qr.ts
import { encode, toSvg } from '@forgesworn/qr'

/**
 * Render a Lightning invoice as an SVG QR code. The `lightning:` URI is
 * upper-cased so the payload fits alphanumeric mode, which keeps the code
 * small. Error correction M and a two-module quiet zone, black on white.
 */
export function invoiceQrSvg(bolt11: string): string {
  return toSvg(encode(`lightning:${bolt11}`.toUpperCase(), { ecc: 'M' }), {
    margin: 2,
    dark: '#000',
    light: '#fff',
  })
}
