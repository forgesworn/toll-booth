// src/payment-page.test.ts
import { describe, it, expect } from 'vitest'
import { renderPaymentPage, renderErrorPage } from './payment-page.js'
import type { StoredInvoice } from './invoice-store.js'

const mockInvoice: StoredInvoice = {
  paymentHash: 'abc123def456',
  bolt11: 'lnbc1000n1ptest...',
  amountSats: 1000,
  macaroon: 'bWFjYXJvb24=',
  createdAt: '2026-03-01T00:00:00Z',
}

describe('renderPaymentPage', () => {
  it('renders awaiting payment state with QR code', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).toContain('Payment Required')
    expect(html).toContain('<svg')
    expect(html).toContain('lnbc1000n1ptest...')
    expect(html).toContain('Copy Invoice')
    expect(html).toContain('Waiting for payment')
    expect(html).toContain('data-payment-hash="abc123def456"')
    expect(html).toContain('data-macaroon="bWFjYXJvb24="')
  })

  it('renders paid state with preimage and L402 token', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: true,
      preimage: 'deadbeef'.repeat(8),
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).toContain('Payment Complete')
    expect(html).toContain('Invoice paid successfully')
    expect(html).toContain('deadbeef'.repeat(8))
    expect(html).toContain('Copy L402 Token')
    expect(html).toContain('1,000 sats credited')
  })

  it('renders credit tiers with volume discounts', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [
        { amountSats: 1000, creditSats: 1000, label: 'Starter' },
        { amountSats: 10_000, creditSats: 11_100, label: 'Pro' },
        { amountSats: 100_000, creditSats: 125_000, label: 'Business' },
      ],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).toContain('Starter')
    expect(html).toContain('Pro')
    expect(html).toContain('Business')
    expect(html).toContain('+11% bonus')
    expect(html).toContain('+25% bonus')
    // Starter has no bonus (amount === credit)
    expect(html).not.toContain('+0% bonus')
  })

  it('shows NWC button when enabled', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [],
      nwcEnabled: true,
      cashuEnabled: false,
    })

    expect(html).toContain('Pay with Nostr Wallet Connect')
    expect(html).toContain('id="nwc-form"')
  })

  it('shows Cashu button when enabled', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: true,
    })

    expect(html).toContain('Redeem Cashu Token')
    expect(html).toContain('id="cashu-form"')
  })

  it('hides NWC/Cashu when disabled', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).not.toContain('Pay with Nostr Wallet Connect')
    expect(html).not.toContain('Redeem Cashu Token')
  })

  it('escapes HTML in invoice strings', async () => {
    const xssInvoice: StoredInvoice = {
      ...mockInvoice,
      bolt11: '<script>alert("xss")</script>',
    }
    const html = await renderPaymentPage({
      invoice: xssInvoice,
      paid: false,
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).not.toContain('<script>alert("xss")</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('includes no-JS fallback', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).toContain('<noscript>')
    expect(html).toContain('Refresh to check payment status')
  })

  it('updates QR in-place on tier selection (no page redirect)', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [
        { amountSats: 1000, creditSats: 1000, label: 'Starter' },
        { amountSats: 10_000, creditSats: 11_100, label: 'Pro' },
      ],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    // Should update QR in-place, not redirect
    expect(html).toContain('qrWrap.innerHTML')
    expect(html).not.toContain('window.location.href')
    // Should update the browser URL without reload
    expect(html).toContain('history.replaceState')
    // Must update macaroon for the newly selected invoice
    expect(html).toContain('card.dataset.macaroon = d.macaroon')
  })

  it('includes polling script when not paid', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: false,
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).toContain('setInterval')
    expect(html).toContain('/invoice-status/')
  })

  it('does not include polling script when paid', async () => {
    const html = await renderPaymentPage({
      invoice: mockInvoice,
      paid: true,
      preimage: 'deadbeef'.repeat(8),
      tiers: [],
      nwcEnabled: false,
      cashuEnabled: false,
    })

    expect(html).not.toContain('setInterval')
  })
})

describe('renderErrorPage', () => {
  it('renders error message with payment hash', () => {
    const html = renderErrorPage({
      paymentHash: 'abc123',
      message: 'This invoice was not found or has expired.',
    })

    expect(html).toContain('Invoice Not Found')
    expect(html).toContain('This invoice was not found or has expired.')
    expect(html).toContain('abc123')
  })

  it('escapes HTML in error messages', () => {
    const html = renderErrorPage({
      paymentHash: '<script>x</script>',
      message: '<img onerror=alert(1)>',
    })

    expect(html).not.toContain('<script>x</script>')
    expect(html).not.toContain('<img onerror=alert(1)>')
  })
})
