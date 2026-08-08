import { describe, it, expect, vi, beforeEach } from 'vitest'

// Must define mocks BEFORE vi.mock since vitest hoists vi.mock calls
const mockCreateMeltQuoteBolt11 = vi.fn()
const mockSend = vi.fn()
const mockMeltProofsBolt11 = vi.fn()

vi.mock('@cashu/cashu-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cashu/cashu-ts')>()
  return {
    ...actual,
    Wallet: vi.fn(function (this: any) {
      this.createMeltQuoteBolt11 = mockCreateMeltQuoteBolt11
      this.send = mockSend
      this.meltProofsBolt11 = mockMeltProofsBolt11
    }),
  }
})

import { Amount } from '@cashu/cashu-ts'
import { meltToLightning } from './melt-to-lightning.js'

describe('meltToLightning', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockCreateMeltQuoteBolt11.mockResolvedValue({
      amount: Amount.from(10),
      fee_reserve: Amount.from(1),
      quote: 'q1',
      state: 'UNPAID',
    })
    mockSend.mockResolvedValue({
      send: [{ amount: 11, id: 'k1', secret: 's1', C: 'c1' }],
      keep: [],
    })
    mockMeltProofsBolt11.mockResolvedValue({
      quote: { state: 'PAID', payment_preimage: 'abc123' },
      change: [],
    })
  })

  it('melts proofs and returns paid result', async () => {
    const result = await meltToLightning({
      mintUrl: 'https://mint.example.com',
      proofs: [{ amount: 15, id: 'k1', secret: 's1', C: 'c1' }] as any,
      createInvoice: async (amount) => `lnbc${amount}n1test`,
    })

    expect(result).toEqual({ paid: true, amountSats: 10, preimage: 'abc123' })
    expect(mockCreateMeltQuoteBolt11).toHaveBeenCalledWith('lnbc15n1test')
    expect(mockSend).toHaveBeenCalledWith(11, expect.any(Array), { includeFees: true })
    expect(mockMeltProofsBolt11).toHaveBeenCalled()
  })

  it('returns error when proofs are empty', async () => {
    const result = await meltToLightning({
      mintUrl: 'https://mint.example.com',
      proofs: [],
      createInvoice: async () => 'lnbc1n1test',
    })

    expect(result).toEqual({ paid: false, error: 'No proofs to melt' })
    expect(mockCreateMeltQuoteBolt11).not.toHaveBeenCalled()
  })

  it('returns error when fee_reserve exceeds proof amount', async () => {
    mockCreateMeltQuoteBolt11.mockResolvedValue({
      amount: Amount.from(10),
      fee_reserve: Amount.from(50),
      quote: 'q1',
      state: 'UNPAID',
    })

    const result = await meltToLightning({
      mintUrl: 'https://mint.example.com',
      proofs: [{ amount: 10, id: 'k1', secret: 's1', C: 'c1' }] as any,
      createInvoice: async () => 'lnbc10n1test',
    })

    expect(result.paid).toBe(false)
    expect((result as any).error).toContain('insufficient for fees')
  })

  it('returns error when melt state is not PAID', async () => {
    mockMeltProofsBolt11.mockResolvedValue({
      quote: { state: 'PENDING' },
      change: [],
    })

    const result = await meltToLightning({
      mintUrl: 'https://mint.example.com',
      proofs: [{ amount: 15, id: 'k1', secret: 's1', C: 'c1' }] as any,
      createInvoice: async () => 'lnbc10n1test',
    })

    expect(result).toEqual({ paid: false, error: 'Melt state: PENDING' })
  })

  it('discards change proofs (never returned)', async () => {
    mockMeltProofsBolt11.mockResolvedValue({
      quote: { state: 'PAID', payment_preimage: 'pre1' },
      change: [{ amount: 2, id: 'k1', secret: 'change1', C: 'cc1' }],
    })
    mockSend.mockResolvedValue({
      send: [{ amount: 11, id: 'k1', secret: 's1', C: 'c1' }],
      keep: [{ amount: 3, id: 'k1', secret: 'keep1', C: 'ck1' }],
    })

    const result = await meltToLightning({
      mintUrl: 'https://mint.example.com',
      proofs: [{ amount: 14, id: 'k1', secret: 's1', C: 'c1' }] as any,
      createInvoice: async () => 'lnbc14n1test',
    })

    expect(result).toEqual({ paid: true, amountSats: 10, preimage: 'pre1' })
  })
})
