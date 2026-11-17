#!/usr/bin/env bash
# DEV-ONLY trusted setup. Production needs a multi-party ceremony.
set -euo pipefail
cd "$(dirname "$0")/.."
B=build/circuits
S="npx snarkjs"
E1=$(head -c 32 /dev/urandom | xxd -p -c 64)
E2=$(head -c 32 /dev/urandom | xxd -p -c 64)
E3=$(head -c 32 /dev/urandom | xxd -p -c 64)
if [ ! -f $B/pot15_final.ptau ]; then
  $S powersoftau new bn128 15 $B/pot15_0.ptau
  $S powersoftau contribute $B/pot15_0.ptau $B/pot15_1.ptau --name=dev1 -e="$E1"
  $S powersoftau prepare phase2 $B/pot15_1.ptau $B/pot15_final.ptau
fi
$S groth16 setup $B/transaction.r1cs $B/pot15_final.ptau $B/transaction_0.zkey
# Phase-2 contribution is mandatory: without it delta == gamma and proofs are forgeable.
$S zkey contribute $B/transaction_0.zkey $B/transaction_1.zkey --name=dev2 -e="$E2"
$S zkey beacon $B/transaction_1.zkey $B/transaction.zkey "$E3" 10 -n="dev beacon"
$S zkey export verificationkey $B/transaction.zkey $B/verification_key.json
rm -f $B/transaction_0.zkey $B/transaction_1.zkey
echo "setup done"
