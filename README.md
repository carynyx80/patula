# Patula

Privacy launchpad on Solana: creators and buyers choose, per action, whether their wallet is public or private.
**Prototype. Not audited. Dev trusted setup. Do not use with real funds.**

| Folder | What | Deploys to |
|---|---|---|
| `programs/`, `circuits/`, `client/`, `tests/` | Anchor program + ZK circuit (Phase 0 shielded pool) | Solana (localnet/devnet) |
| `web/` | Marketing site with WebGL fluid simulation (Next.js) | Vercel |
| `relayer/` | Relayer API: `/health`, `/stats`, `POST /relay` | Railway |

## Phase 0 spike

## Layout

- `circuits/transaction.circom` — 2-in/2-out spend circuit (Poseidon, depth-20 Merkle tree, 64-bit amounts)
- `programs/patula` — Anchor program: `initialize`, `transact` (Groth16 verify via alt_bn128, nullifier PDAs, Poseidon-syscall Merkle insert, SOL in/out, relayer fee)
- `client/pool.ts` — notes, keys, off-chain Merkle tree, proof generation + encoding
- `tests/patula.ts` — deposit → relayed private transfer → withdraw to fresh address, double-spend and tampered-recipient rejection, metrics
- `scripts/setup.sh` — dev powers-of-tau + phase-2 contribution; `scripts/vk_to_rust.js` — verifying key → Rust

## Run

```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
npm install
npx circom2 circuits/transaction.circom --r1cs --wasm --sym -o build/circuits
./scripts/setup.sh            # ~8-9 min
node scripts/vk_to_rust.js build/circuits/verification_key.json programs/patula/src/verifying_key.rs
anchor test                   # metrics → build/metrics.json
```
