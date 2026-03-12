# toll-booth L402 demo
# Records a terminal GIF showing the complete L402 payment flow.
#
# Prerequisites:  npm install (in toll-booth root)
# Run:            cd toll-booth && vhs demo/demo.tape

Output "demo/toll-booth-demo.gif"

Require bash
Require curl
Require jq

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 600
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms
Set Padding 20
Set PlaybackSpeed 1

# Boot the demo server before recording starts
Hide
Type `export PATH="/Users/darren/.nvm/versions/node/v22.17.0/bin:$PATH"`
Enter
Type "cd /Users/darren/WebstormProjects/toll-booth && npx tsx demo/demo.ts > /dev/null 2>&1 &"
Enter
Type "sleep 3 && clear"
Enter
Sleep 4s
Show

Sleep 300ms

# Step 1: free-tier request succeeds
Type "# 1. Free-tier request (no auth needed)"
Enter
Sleep 400ms
Type "curl -s localhost:3000/api/joke | jq ."
Enter
Sleep 1.5s

# Step 2: second request hits 402
Type "# 2. Free tier exhausted — 402 Payment Required"
Enter
Sleep 400ms
Type `curl -s -o /dev/null -w 'HTTP %{http_code}\n' localhost:3000/api/joke`
Enter
Sleep 1.5s

# Step 3: create an invoice and save to file
Type "# 3. Create a Lightning invoice (10 sats)"
Enter
Sleep 400ms
Type "curl -s -X POST localhost:3000/create-invoice > /tmp/inv.json"
Enter
Sleep 500ms
Type `jq '{amount_sats, payment_hash}' /tmp/inv.json`
Enter
Sleep 2s

# Step 4: wait for auto-settle, check status via payment_url
Type "# 4. Invoice auto-settles — check payment status"
Enter
Sleep 400ms
Type "sleep 2"
Enter
Sleep 2.5s
Type "STATUS_URL=$(jq -r .payment_url /tmp/inv.json)"
Enter
Type `curl -s "localhost:3000$STATUS_URL" | jq '{paid, preimage: (.preimage // .token_suffix)}'`
Enter
Sleep 2s

# Step 5: authenticated request with L402 token
Type "# 5. Authenticated request with L402 token"
Enter
Sleep 400ms
Type "MAC=$(jq -r .macaroon /tmp/inv.json)"
Enter
Type `PRE=$(curl -s "localhost:3000$STATUS_URL" | jq -r '(.preimage // .token_suffix)')`
Enter
Sleep 500ms
Type `curl -s -H "Authorization: L402 $MAC:$PRE" localhost:3000/api/joke | jq .`
Enter
Sleep 3s

# Shut down
Hide
Type "kill %1 2>/dev/null"
Enter
Show

Sleep 500ms
