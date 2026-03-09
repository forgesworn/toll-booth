// src/payment-page.ts
import QRCode from 'qrcode'
import type { CreditTier } from './types.js'
import type { StoredInvoice } from './invoice-store.js'

export interface PaymentPageData {
  invoice: StoredInvoice
  paid: boolean
  preimage?: string
  tiers: CreditTier[]
  nwcEnabled: boolean
  cashuEnabled: boolean
}

export interface PaymentPageErrorData {
  paymentHash: string
  message: string
}

export async function renderPaymentPage(data: PaymentPageData): Promise<string> {
  const { invoice, paid, preimage, tiers, nwcEnabled, cashuEnabled } = data
  const qrSvg = await QRCode.toString(`lightning:${invoice.bolt11}`.toUpperCase(), { type: 'svg', margin: 2 })

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment${paid ? ' Complete' : ' Required'} — toll-booth</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#161622;border:1px solid #2a2a3a;border-radius:16px;padding:2rem;max-width:480px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:1.4rem;text-align:center;margin-bottom:1.5rem;color:#fff}
.qr-wrap{background:#fff;border-radius:12px;padding:1rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;max-width:280px}
.qr-wrap svg{width:100%;height:auto}
.invoice-str{font-family:monospace;font-size:.7rem;word-break:break-all;background:#0d0d15;border:1px solid #2a2a3a;border-radius:8px;padding:.75rem;margin-bottom:1rem;max-height:80px;overflow-y:auto;color:#a0a0b0}
.btn{display:block;width:100%;padding:.75rem;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;margin-bottom:.75rem;transition:all .15s ease}
.btn-primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}
.btn-primary:hover{opacity:.9}
.btn-secondary{background:#1e1e30;border:1px solid #3a3a50;color:#c0c0d0}
.btn-secondary:hover{background:#252540}
.btn-success{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff}
.status{text-align:center;padding:.5rem;border-radius:8px;margin-bottom:1rem;font-size:.85rem}
.status-polling{background:#1e1e30;color:#a0a0b0}
.status-paid{background:#052e16;color:#4ade80;border:1px solid #16a34a}
.tiers{display:grid;gap:.5rem;margin-bottom:1rem}
.tier{background:#1e1e30;border:2px solid #2a2a3a;border-radius:8px;padding:.75rem;cursor:pointer;transition:all .15s ease;text-align:center}
.tier:hover,.tier.selected{border-color:#6366f1;background:#1e1e35}
.tier-label{font-weight:600;color:#fff;font-size:.95rem}
.tier-price{color:#a0a0b0;font-size:.8rem;margin-top:.25rem}
.tier-bonus{color:#6366f1;font-size:.75rem;font-weight:500}
.wallets{margin-bottom:1rem}
.wallet-label{font-size:.8rem;color:#808090;margin-bottom:.5rem}
.success-icon{font-size:3rem;text-align:center;margin:1rem 0}
.token-box{font-family:monospace;font-size:.65rem;word-break:break-all;background:#0d0d15;border:1px solid #2a2a3a;border-radius:8px;padding:.75rem;margin:.75rem 0}
.token-label{font-size:.75rem;color:#808090;margin-bottom:.25rem}
.info{font-size:.8rem;color:#808090;text-align:center;margin-top:.75rem}
.info a{color:#6366f1}
.noscript-refresh{display:inline-block;margin-top:.5rem;color:#6366f1;text-decoration:underline}
.hidden{display:none}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #404060;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:.5rem}
@keyframes spin{to{transform:rotate(360deg)}}
.credit-bal{font-size:1.1rem;text-align:center;color:#fff;margin:.5rem 0}
</style>
</head>
<body>
<div class="card" id="card"
  data-payment-hash="${esc(invoice.paymentHash)}"
  data-macaroon="${esc(invoice.macaroon)}"
  data-paid="${paid}"
  data-nwc="${nwcEnabled}"
  data-cashu="${cashuEnabled}"
>

${paid ? renderPaidState(invoice, preimage!) : renderAwaitingState(invoice, qrSvg, tiers, nwcEnabled, cashuEnabled)}

<div class="info">Powered by <strong>toll-booth</strong> &middot; L402</div>
</div>

<script>
${paid ? '' : clientScript()}
</script>

<noscript>
${paid ? '' : `<div style="text-align:center;margin-top:1rem;color:#a0a0b0;font-size:.85rem">JavaScript is disabled. <a class="noscript-refresh" href="">Refresh to check payment status</a>.</div>`}
</noscript>
</body>
</html>`
}

function renderAwaitingState(
  invoice: StoredInvoice,
  qrSvg: string,
  tiers: CreditTier[],
  nwcEnabled: boolean,
  cashuEnabled: boolean,
): string {
  const tiersHtml = tiers.length > 0 ? `
<div class="tiers" id="tiers">
  ${tiers.map((t, i) => {
    const bonus = t.creditSats > t.amountSats
      ? `<div class="tier-bonus">+${Math.round(((t.creditSats - t.amountSats) / t.amountSats) * 100)}% bonus</div>`
      : ''
    return `<div class="tier${i === 0 ? ' selected' : ''}" data-amount="${t.amountSats}" data-credit="${t.creditSats}" onclick="selectTier(this)">
      <div class="tier-label">${esc(t.label)}</div>
      <div class="tier-price">${formatSats(t.amountSats)} sats &rarr; ${formatSats(t.creditSats)} credits</div>
      ${bonus}
    </div>`
  }).join('\n  ')}
</div>` : ''

  const walletButtons: string[] = []
  walletButtons.push(`<button class="btn btn-primary" id="btn-copy" onclick="copyInvoice()">Copy Invoice</button>`)
  walletButtons.push(`<button class="btn btn-secondary hidden" id="btn-webln" onclick="payWebLN()">Pay with WebLN</button>`)
  if (nwcEnabled) {
    walletButtons.push(`<button class="btn btn-secondary" id="btn-nwc" onclick="showNwc()">Pay with Nostr Wallet Connect</button>`)
  }
  if (cashuEnabled) {
    walletButtons.push(`<button class="btn btn-secondary" id="btn-cashu" onclick="showCashu()">Redeem Cashu Token</button>`)
  }

  return `
<h1>Payment Required</h1>
<div class="status status-polling" id="status">
  <span class="spinner"></span> Waiting for payment&hellip;
</div>

<div class="qr-wrap" id="qr-wrap">${qrSvg}</div>

<div class="invoice-str" id="invoice-str">${esc(invoice.bolt11)}</div>

${tiersHtml}

<div class="wallets">
  ${walletButtons.join('\n  ')}
</div>

<div class="hidden" id="nwc-form">
  <input type="text" placeholder="nostr+walletconnect://..." id="nwc-uri"
    style="width:100%;padding:.5rem;border-radius:8px;border:1px solid #3a3a50;background:#0d0d15;color:#e0e0e0;font-size:.85rem;margin-bottom:.5rem">
  <button class="btn btn-primary" onclick="payNwc()">Pay via NWC</button>
</div>

<div class="hidden" id="cashu-form">
  <textarea placeholder="cashuA..." id="cashu-token"
    style="width:100%;padding:.5rem;border-radius:8px;border:1px solid #3a3a50;background:#0d0d15;color:#e0e0e0;font-size:.85rem;height:80px;resize:vertical;margin-bottom:.5rem"></textarea>
  <button class="btn btn-primary" onclick="redeemCashu()">Redeem Token</button>
</div>`
}

function renderPaidState(invoice: StoredInvoice, preimage: string): string {
  return `
<h1>Payment Complete</h1>
<div class="status status-paid" id="status">Invoice paid successfully</div>
<div class="success-icon">&#9889;</div>
<div class="credit-bal" id="credit-bal">${formatSats(invoice.amountSats)} sats credited</div>

<div>
  <div class="token-label">Payment preimage</div>
  <div class="token-box" id="preimage">${esc(preimage)}</div>
</div>

<div>
  <div class="token-label">L402 Token (macaroon:preimage)</div>
  <div class="token-box" id="l402-token">${esc(invoice.macaroon)}:${esc(preimage)}</div>
</div>

<button class="btn btn-success" onclick="copyToken()">Copy L402 Token</button>`
}

function clientScript(): string {
  return `
(function(){
  var card = document.getElementById('card');
  var hash = card.dataset.paymentHash;
  if (card.dataset.paid === 'true') return;

  // Detect WebLN
  if (typeof window.webln !== 'undefined') {
    document.getElementById('btn-webln').classList.remove('hidden');
  }

  // Poll for payment
  var pollInterval = setInterval(function(){
    fetch('/invoice-status/' + hash, {headers:{'Accept':'application/json'}})
      .then(function(r){return r.json()})
      .then(function(d){
        if(d.paid){
          clearInterval(pollInterval);
          showPaid(d.preimage);
        }
      })
      .catch(function(){});
  }, 3000);

  window.copyInvoice = function(){
    var str = document.getElementById('invoice-str').textContent;
    navigator.clipboard.writeText(str).then(function(){
      var btn = document.getElementById('btn-copy');
      btn.textContent = 'Copied!';
      setTimeout(function(){btn.textContent='Copy Invoice'},2000);
    });
  };

  window.copyToken = function(){
    var str = document.getElementById('l402-token').textContent;
    navigator.clipboard.writeText(str).then(function(){
      var btn = document.querySelector('.btn-success');
      btn.textContent = 'Copied!';
      setTimeout(function(){btn.textContent='Copy L402 Token'},2000);
    });
  };

  window.payWebLN = async function(){
    try {
      await window.webln.enable();
      var invoice = document.getElementById('invoice-str').textContent;
      await window.webln.sendPayment(invoice);
    } catch(e) {
      console.error('WebLN payment failed:', e);
    }
  };

  window.selectTier = function(el){
    document.querySelectorAll('.tier').forEach(function(t){t.classList.remove('selected')});
    el.classList.add('selected');
    // Create a new invoice for this tier, then update the page in-place
    fetch('/create-invoice', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({amountSats: parseInt(el.dataset.amount)})
    })
    .then(function(r){return r.json()})
    .then(function(d){
      if (!d.bolt11) return;
      // Update QR code in-place
      var qrWrap = document.getElementById('qr-wrap');
      if (qrWrap && d.qr_svg) qrWrap.innerHTML = d.qr_svg;
      // Update invoice string
      var invStr = document.getElementById('invoice-str');
      if (invStr) invStr.textContent = d.bolt11;
      // Update payment hash for polling
      hash = d.payment_hash;
      card.dataset.paymentHash = d.payment_hash;
      if (d.macaroon) card.dataset.macaroon = d.macaroon;
      // Update browser URL without reload
      if (d.payment_url) history.replaceState(null, '', d.payment_url);
      // Restart polling with new hash
      clearInterval(pollInterval);
      pollInterval = setInterval(function(){
        fetch('/invoice-status/' + hash, {headers:{'Accept':'application/json'}})
          .then(function(r){return r.json()})
          .then(function(d){
            if(d.paid){
              clearInterval(pollInterval);
              showPaid(d.preimage);
            }
          })
          .catch(function(){});
      }, 3000);
    })
    .catch(function(e){ console.error('Tier selection failed:', e) });
  };

  window.showNwc = function(){
    document.getElementById('nwc-form').classList.toggle('hidden');
  };

  window.showCashu = function(){
    document.getElementById('cashu-form').classList.toggle('hidden');
  };

  window.payNwc = function(){
    var uri = document.getElementById('nwc-uri').value.trim();
    if (!uri) return;
    var invoice = document.getElementById('invoice-str').textContent;
    fetch('/nwc-pay', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({nwcUri: uri, bolt11: invoice, paymentHash: hash})
    })
    .then(function(r){return r.json()})
    .then(function(d){
      if (d.preimage) showPaid(d.preimage);
      else if (d.error) alert(d.error);
    })
    .catch(function(e){ alert('NWC payment failed: ' + e.message) });
  };

  window.redeemCashu = function(){
    var token = document.getElementById('cashu-token').value.trim();
    if (!token) return;
    fetch('/cashu-redeem', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: token, paymentHash: hash})
    })
    .then(function(r){return r.json()})
    .then(function(d){
      if (d.credited) showPaid(null, d.credited, d.macaroon);
      else if (d.error) alert(d.error);
    })
    .catch(function(e){ alert('Cashu redemption failed: ' + e.message) });
  };

  function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  function fmtSats(n){return Number(n).toLocaleString('en-GB')}

  function showPaid(preimage, creditedAmount, cashuMacaroon){
    clearInterval(pollInterval);
    var status = document.getElementById('status');
    status.className = 'status status-paid';
    status.textContent = 'Invoice paid successfully';

    // Replace card content with success state
    var h1 = document.querySelector('h1');
    h1.textContent = 'Payment Complete';
    document.title = 'Payment Complete \\u2014 toll-booth';

    // Hide payment UI, show success
    var qr = document.getElementById('qr-wrap');
    if(qr) qr.style.display = 'none';
    var inv = document.getElementById('invoice-str');
    if(inv) inv.style.display = 'none';
    var tiers = document.getElementById('tiers');
    if(tiers) tiers.style.display = 'none';
    var wallets = document.querySelector('.wallets');
    if(wallets) wallets.style.display = 'none';
    var nwcForm = document.getElementById('nwc-form');
    if(nwcForm) nwcForm.style.display = 'none';
    var cashuForm = document.getElementById('cashu-form');
    if(cashuForm) cashuForm.style.display = 'none';

    // Add success content after status
    var successHtml = '<div class="success-icon">&#9889;</div>';
    if (creditedAmount) {
      successHtml += '<div class="credit-bal">' + fmtSats(creditedAmount) + ' sats credited</div>';
    }

    // Determine the macaroon and auth token format
    var macStr = cashuMacaroon ? escHtml(cashuMacaroon) : (card.dataset.macaroon ? escHtml(card.dataset.macaroon) : '');

    if (preimage) {
      var safePreimage = escHtml(preimage);
      successHtml += '<div><div class="token-label">Payment preimage</div><div class="token-box" id="preimage">' + safePreimage + '</div></div>';
      if (macStr) {
        successHtml += '<div><div class="token-label">L402 Token (macaroon:preimage)</div><div class="token-box" id="l402-token">' + macStr + ':' + safePreimage + '</div></div>';
        successHtml += '<button class="btn btn-success" onclick="copyToken()">Copy L402 Token</button>';
      }
    } else if (macStr) {
      // Cashu path: no preimage, use "settled" as the auth placeholder
      successHtml += '<div><div class="token-label">L402 Token</div><div class="token-box" id="l402-token">' + macStr + ':settled</div></div>';
      successHtml += '<button class="btn btn-success" onclick="copyToken()">Copy L402 Token</button>';
    }
    status.insertAdjacentHTML('afterend', successHtml);
  }
})();`
}

export function renderErrorPage(data: PaymentPageErrorData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice Not Found — toll-booth</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#161622;border:1px solid #2a2a3a;border-radius:16px;padding:2rem;max-width:480px;width:100%;text-align:center}
h1{font-size:1.4rem;margin-bottom:1rem;color:#fff}
p{color:#a0a0b0;font-size:.9rem;line-height:1.5}
.hash{font-family:monospace;font-size:.7rem;color:#606070;word-break:break-all;margin-top:1rem}
</style>
</head>
<body>
<div class="card">
  <h1>Invoice Not Found</h1>
  <p>${esc(data.message)}</p>
  <div class="hash">${esc(data.paymentHash)}</div>
</div>
</body>
</html>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatSats(sats: number): string {
  return sats.toLocaleString('en-GB')
}
