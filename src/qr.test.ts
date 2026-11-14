import { describe, it, expect } from 'vitest'
import { decode, encode } from '@forgesworn/qr'
import { invoiceQrSvg } from './qr.js'

const BOLT11 =
  'lnbc10u1p3q9xhppp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'

describe('invoiceQrSvg', () => {
  it('draws a black-on-white SVG with a two-module quiet zone', () => {
    const svg = invoiceQrSvg(BOLT11)
    const side = encode(`lightning:${BOLT11}`.toUpperCase(), { ecc: 'M' }).size + 4
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`)
    expect(svg).toContain('fill="#fff"')
    expect(svg).toContain('fill="#000"')
  })

  it('upper-cases the URI so it fits alphanumeric mode', () => {
    const upper = encode(`lightning:${BOLT11}`.toUpperCase(), { ecc: 'M' })
    const mixed = encode(`lightning:${BOLT11}`, { ecc: 'M' })
    expect(upper.mode).toBe('alphanumeric')
    expect(upper.size).toBeLessThan(mixed.size)
  })

  it('reads back to the upper-cased lightning URI', () => {
    const qr = encode(`lightning:${BOLT11}`.toUpperCase(), { ecc: 'M' })
    const scale = 4
    const margin = 2
    const side = (qr.size + margin * 2) * scale
    const data = new Uint8ClampedArray(side * side * 4).fill(255)
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y * qr.size + x] !== 1) continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4
            data[i] = data[i + 1] = data[i + 2] = 0
          }
        }
      }
    }
    expect(decode({ data, width: side, height: side })?.text).toBe(`lightning:${BOLT11}`.toUpperCase())
  })
})
