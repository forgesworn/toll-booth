#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.test.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Flags ────────────────────────────────────────────────────────────
RUN_LN=true
RUN_CASHU=true
for arg in "$@"; do
  case "$arg" in
    --ln-only)    RUN_CASHU=false ;;
    --cashu-only) RUN_LN=false ;;
  esac
done

# ── Cleanup ──────────────────────────────────────────────────────────
cleanup() {
  echo "Cleaning up containers..."
  $COMPOSE down -v 2>/dev/null || true
  rm -f /tmp/toll-booth-alice.macaroon /tmp/toll-booth-bob.macaroon
}
trap cleanup EXIT INT TERM

# ── Prerequisites ────────────────────────────────────────────────────
for cmd in docker curl jq xxd; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$cmd is required to run integration tests." >&2
    exit 1
  fi
done

# ── Start services ───────────────────────────────────────────────────
if $RUN_LN && $RUN_CASHU; then
  $COMPOSE up -d
elif $RUN_LN; then
  $COMPOSE up -d bitcoind lnd-alice lnd-bob
else
  $COMPOSE up -d nutshell
fi

# ── Helper: bitcoin-cli via docker ───────────────────────────────────
btcli() {
  $COMPOSE exec -T bitcoind bitcoin-cli -regtest -rpcuser=test -rpcpassword=test "$@"
}

# ── Helper: lncli via docker ─────────────────────────────────────────
alice_cli() {
  $COMPOSE exec -T lnd-alice lncli --network=regtest "$@"
}

bob_cli() {
  $COMPOSE exec -T lnd-bob lncli --network=regtest "$@"
}

# ── Lightning setup ──────────────────────────────────────────────────
if $RUN_LN; then
  echo "Waiting for bitcoind..."
  for i in $(seq 1 30); do
    if btcli getblockchaininfo >/dev/null 2>&1; then break; fi
    sleep 1
  done

  wait_for_lnd() {
    local name=$1
    shift
    echo "Waiting for $name..."
    for i in $(seq 1 60); do
      if "$@" getinfo >/dev/null 2>&1; then return 0; fi
      sleep 1
    done
    echo "$name failed to start within 60s" >&2
    $COMPOSE logs --tail 30 >&2
    return 1
  }

  wait_for_lnd "lnd-alice" alice_cli
  wait_for_lnd "lnd-bob" bob_cli

  # Fund Bob with regtest coins
  BOB_ADDR=$(bob_cli newaddress p2wkh | jq -r .address)
  echo "Mining 110 blocks to Bob ($BOB_ADDR)..."
  btcli generatetoaddress 110 "$BOB_ADDR" >/dev/null

  # Wait for chain sync
  echo "Waiting for chain sync..."
  for i in $(seq 1 30); do
    SYNCED=$(bob_cli getinfo 2>/dev/null | jq -r .synced_to_chain)
    if [ "$SYNCED" = "true" ]; then break; fi
    sleep 1
  done
  for i in $(seq 1 30); do
    SYNCED=$(alice_cli getinfo 2>/dev/null | jq -r .synced_to_chain)
    if [ "$SYNCED" = "true" ]; then break; fi
    sleep 1
  done

  # Connect and open channel
  ALICE_PUBKEY=$(alice_cli getinfo | jq -r .identity_pubkey)
  echo "Connecting Bob to Alice ($ALICE_PUBKEY)..."
  bob_cli connect "${ALICE_PUBKEY}@lnd-alice:9735" 2>/dev/null || true

  echo "Opening channel (1,000,000 sats)..."
  bob_cli openchannel "$ALICE_PUBKEY" 1000000 >/dev/null

  # Mine blocks to confirm channel
  MINER_ADDR=$(alice_cli newaddress p2wkh | jq -r .address)
  btcli generatetoaddress 6 "$MINER_ADDR" >/dev/null

  # Wait for channel to become active
  echo "Waiting for channel to activate..."
  ACTIVE=0
  for i in $(seq 1 30); do
    ACTIVE=$(bob_cli listchannels 2>/dev/null | jq '[.channels[] | select(.active==true)] | length')
    if [ "$ACTIVE" -gt 0 ]; then break; fi
    sleep 1
  done

  if [ "$ACTIVE" -eq 0 ]; then
    echo "Channel failed to activate within 30s" >&2
    bob_cli listchannels >&2
    exit 1
  fi

  echo "Channel active. Bob can pay Alice's invoices."

  # Extract macaroons
  $COMPOSE cp lnd-alice:/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon /tmp/toll-booth-alice.macaroon
  $COMPOSE cp lnd-bob:/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon /tmp/toll-booth-bob.macaroon
  ALICE_MACAROON=$(xxd -p -c 10000 /tmp/toll-booth-alice.macaroon | tr -d '\n')
  BOB_MACAROON=$(xxd -p -c 10000 /tmp/toll-booth-bob.macaroon | tr -d '\n')
fi

# ── Cashu mint setup ─────────────────────────────────────────────────
if $RUN_CASHU; then
  echo "Waiting for Cashu mint..."
  MINT_READY=0
  for i in $(seq 1 45); do
    if curl -fsS "http://127.0.0.1:13338/v1/info" >/dev/null 2>&1; then
      MINT_READY=1
      break
    fi
    sleep 1
  done
  if [ "$MINT_READY" -ne 1 ]; then
    echo "Cashu mint failed to start within 45s" >&2
    $COMPOSE logs --tail 30 nutshell >&2
    exit 1
  fi
  echo "Cashu mint ready."
fi

# ── Run tests ────────────────────────────────────────────────────────
echo ""
echo "=== Running integration tests ==="
echo ""

set +e
TEST_EXIT=0

if $RUN_LN; then
  echo "--- Lightning tests ---"
  NODE_TLS_REJECT_UNAUTHORIZED=0 \
  LND_REST_URL=https://127.0.0.1:18080 \
  LND_MACAROON="$ALICE_MACAROON" \
  LND_BOB_REST_URL=https://127.0.0.1:18081 \
  LND_BOB_MACAROON="$BOB_MACAROON" \
    npx vitest run src/backends/lnd.integration.test.ts src/e2e/l402-flow.integration.test.ts
  TEST_EXIT=$?
fi

if $RUN_CASHU && [ $TEST_EXIT -eq 0 ]; then
  echo "--- Cashu tests ---"
  RUN_INTEGRATION=true \
  CASHU_MINT_URL=http://127.0.0.1:13338 \
    npx vitest run src/e2e/cashu-redeem.integration.test.ts
  CASHU_EXIT=$?
  [ $CASHU_EXIT -ne 0 ] && TEST_EXIT=$CASHU_EXIT
fi

set -e

if [ $TEST_EXIT -ne 0 ]; then
  echo ""
  echo "Integration tests FAILED. Container logs:" >&2
  $COMPOSE logs --tail 50 >&2
fi

exit $TEST_EXIT
