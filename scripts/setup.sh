#!/usr/bin/env bash
# DEV-ONLY trusted setup. Production needs a multi-party ceremony.
set -euo pipefail
cd "$(dirname "$0")/.."
B=build/circuits
C=${1:-transaction}
S="npx snarkjs"
E1=$(head -c 32 /dev/urandom | xxd -p -c 64)
E2=$(head -c 32 /dev/urandom | xxd -p -c 64)
E3=$(head -c 32 /dev/urandom | xxd -p -c 64)
if [ ! -f $B/pot15_final.ptau ]; then
  $S powersoftau new bn128 15 $B/pot15_0.ptau
  $S powersoftau contribute $B/pot15_0.ptau $B/pot15_1.ptau --name=dev1 -e="$E1"
  $S powersoftau prepare phase2 $B/pot15_1.ptau $B/pot15_final.ptau
fi
$S groth16 setup $B/$C.r1cs $B/pot15_final.ptau $B/${C}_0.zkey
# Phase-2 contribution is mandatory: without it delta == gamma and proofs are forgeable.
$S zkey contribute $B/${C}_0.zkey $B/${C}_1.zkey --name=dev2 -e="$E2"
$S zkey beacon $B/${C}_1.zkey $B/$C.zkey "$E3" 10 -n="dev beacon"
$S zkey export verificationkey $B/$C.zkey $B/${C}_vk.json
rm -f $B/${C}_0.zkey $B/${C}_1.zkey
echo "setup done"
