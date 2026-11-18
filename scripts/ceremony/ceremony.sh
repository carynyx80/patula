#!/usr/bin/env bash
# Multi-party trusted setup for circuits/spend.circom (Groth16 phase 2).
#
# Phase 1 comes from the public Perpetual Powers of Tau (hundreds of
# contributors). Phase 2 is circuit-specific: every participant runs
# `contribute` on the latest zkey and passes it on. The setup is secure as long
# as ONE participant destroyed their randomness. Finish with a public random
# beacon (e.g. a future Bitcoin block hash) so nobody controls the last step.
#
#   ./ceremony.sh init                       # coordinator: start from public phase 1
#   ./ceremony.sh contribute <in> <out> <name>   # each participant, in turn
#   ./ceremony.sh verify <zkey>              # anyone, at any point
#   ./ceremony.sh finalize <last.zkey> <beacon-hex>  # coordinator
#
# Output: build/ceremony/spend_final.zkey + spend_final_vk.json, then
#   node scripts/vk_to_rust.js build/ceremony/spend_final_vk.json programs/patula/src/verifying_key.rs
#   touch circuits/CEREMONY_COMPLETE   (unlocks scripts/mainnet/deploy.sh)
set -euo pipefail
cd "$(dirname "$0")/../.."
D=build/ceremony
S="npx snarkjs"
mkdir -p "$D"
PTAU="$D/ppot_0080_15.ptau"
PTAU_URL="https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_15.ptau"

case "${1:-}" in
  init)
    [ -f build/circuits/spend.r1cs ] || npx circom2 circuits/spend.circom --r1cs --wasm --sym -o build/circuits
    if [ ! -f "$PTAU" ]; then
      echo "Download a public phase-1 file with >= 2^15 constraints from the Perpetual Powers of Tau and place it at $PTAU."
      echo "  Index: https://github.com/privacy-scaling-explorations/perpetualpowersoftau"
      echo "  Expected (check it is still current): $PTAU_URL"
      echo "Then verify it:  npx snarkjs powersoftau verify $PTAU"
      exit 1
    fi
    $S groth16 setup build/circuits/spend.r1cs "$PTAU" "$D/spend_0000.zkey"
    echo "Pass $D/spend_0000.zkey to the first participant."
    ;;
  contribute)
    in="$2"; out="$3"; name="$4"
    echo "Contributing as $name. You will be asked for random text; type a lot of it, then forget it."
    $S zkey contribute "$in" "$out" --name="$name"
    $S zkey verify build/circuits/spend.r1cs "$PTAU" "$out"
    echo "Done. Publish the contribution hash printed above, then pass $out on."
    ;;
  verify)
    $S zkey verify build/circuits/spend.r1cs "$PTAU" "$2"
    ;;
  finalize)
    $S zkey beacon "$2" "$D/spend_final.zkey" "$3" 10 -n="Final beacon"
    $S zkey verify build/circuits/spend.r1cs "$PTAU" "$D/spend_final.zkey"
    $S zkey export verificationkey "$D/spend_final.zkey" "$D/spend_final_vk.json"
    echo "Final key ready. Next: regenerate the Rust verifying key, copy the zkey/wasm to web/public/zk, rebuild, and"
    echo "  touch circuits/CEREMONY_COMPLETE"
    ;;
  *)
    sed -n '2,24p' "$0"; exit 1 ;;
esac
