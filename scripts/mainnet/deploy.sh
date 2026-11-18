#!/usr/bin/env bash
# Mainnet deployment for Patula. Run it yourself with your own deployer wallet.
#
# Refuses to run until the safety preconditions in docs/MAINNET.md are met.
#
#   DEPLOYER=~/.config/solana/mainnet-deployer.json \
#   MULTISIG=<Squads vault address> \
#   RPC_URL=https://<your mainnet rpc> \
#   ./scripts/mainnet/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${DEPLOYER:?set DEPLOYER to your mainnet deployer keypair path}"
: "${MULTISIG:?set MULTISIG to the multisig that will own upgrades and admin}"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
KEYS=.keys/mainnet

fail() { echo "✗ $1"; exit 1; }
[ -f circuits/CEREMONY_COMPLETE ] || fail "No multi-party trusted setup yet. The dev setup's toxic waste could forge proofs and drain the pool. Run scripts/ceremony first."
[ -f docs/AUDIT_COMPLETE ] || fail "No completed audit recorded (docs/AUDIT_COMPLETE). Get the programs and circuit audited first."
grep -q "Bn254X5" programs/patula/src/lib.rs || fail "unexpected pool program source"
command -v anchor >/dev/null || fail "anchor CLI not found"

mkdir -p "$KEYS"
for p in launchpad patula; do
  [ -f "$KEYS/$p-keypair.json" ] || solana-keygen new --no-bip39-passphrase -s -o "$KEYS/$p-keypair.json" >/dev/null
  cp "$KEYS/$p-keypair.json" "target/deploy/$p-keypair.json"
  echo "$p program id: $(solana-keygen pubkey "$KEYS/$p-keypair.json")"
done

echo "→ Syncing program IDs into the source and rebuilding (verifiable build recommended: anchor build --verifiable)"
anchor keys sync
anchor build

BAL=$(solana balance -k "$DEPLOYER" --url "$RPC_URL" | awk '{print $1}')
echo "Deployer balance: $BAL SOL (needs ≈ 6 SOL for both programs + rent)"
read -r -p "Deploy BOTH programs to MAINNET with $DEPLOYER? Type 'deploy mainnet': " ok
[ "$ok" = "deploy mainnet" ] || fail "aborted"

for p in launchpad patula; do
  solana program deploy "target/deploy/$p.so" --program-id "$KEYS/$p-keypair.json" -k "$DEPLOYER" --url "$RPC_URL" --with-compute-unit-price 50000
done

echo "→ Initialising config, pool and lookup table"
RPC_URL="$RPC_URL" DEPLOYER="$DEPLOYER" MULTISIG="$MULTISIG" npx ts-node -P tsconfig.json scripts/mainnet/init.ts

echo "→ Handing upgrade authority to the multisig"
for p in launchpad patula; do
  solana program set-upgrade-authority "$(solana-keygen pubkey "$KEYS/$p-keypair.json")" \
    --new-upgrade-authority "$MULTISIG" --skip-new-upgrade-authority-signer-check -k "$DEPLOYER" --url "$RPC_URL"
done
echo "✓ Done. The multisig must now call accept_authority on the launchpad config (see docs/MAINNET.md)."
