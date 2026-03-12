# toll-booth L402 demo
# Each scene clears the screen for maximum legibility at small sizes.
#
# Run:  cd toll-booth && vhs demo/demo.tape

Output "demo/toll-booth-demo.gif"

Require bash
Require curl
Require jq

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 600
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 24
Set PlaybackSpeed 1

# Hidden: set up PATH and cd
Hide
Type `export PATH="/Users/darren/.nvm/versions/node/v22.17.0/bin:$PATH"`
Enter
Type "cd /Users/darren/WebstormProjects/toll-booth && clear"
Enter
Sleep 1s
Show

# ── Scene 1: Boot the server (real, visible banner) ──────────────────────────
Type "npx tsx demo/demo.ts &"
Enter
Sleep 4s

# ── Scene 2: Free request ────────────────────────────────────────────────────
Hide
Type "clear"
Enter
Sleep 300ms
Show

Type "curl -s localhost:3000/api/joke | jq ."
Enter
Sleep 2s

Hide
Type "echo ''"
Enter
Show
Type "echo '# Free tier - 1 request per day, no payment needed'"
Enter
Sleep 3s

# ── Scene 3: 402 Payment Required ────────────────────────────────────────────
Hide
Type "clear"
Enter
Sleep 300ms
Show

Type `curl -s -w '\nHTTP %{http_code}\n' -o /dev/null localhost:3000/api/joke`
Enter
Sleep 1.5s

Hide
Type "echo ''"
Enter
Show
Type "echo '# Free tier exhausted - 402 Payment Required'"
Enter
Sleep 3s

# ── Scene 4: Paid request ────────────────────────────────────────────────────

# Hidden: create invoice, wait for auto-settle, extract credentials via files
Hide
Type "curl -s -X POST localhost:3000/create-invoice > /tmp/inv.json"
Enter
Type "sleep 2"
Enter
Sleep 3s
Type `MAC=$(jq -r .macaroon /tmp/inv.json)`
Enter
Type `PURL=$(jq -r .payment_url /tmp/inv.json)`
Enter
Type `curl -s "localhost:3000$PURL" > /tmp/status.json`
Enter
Sleep 500ms
Type `PRE=$(jq -r .preimage /tmp/status.json)`
Enter
Type "clear"
Enter
Sleep 300ms
Show

Type `curl -s -H "Authorization: L402 $MAC:$PRE" localhost:3000/api/joke | jq .`
Enter
Sleep 2s

Hide
Type "echo ''"
Enter
Show
Type "echo '# Paid with Lightning - 10 sats per joke'"
Enter
Sleep 4s

# Clean up
Hide
Type "kill %1 2>/dev/null"
Enter
Show

Sleep 500ms
