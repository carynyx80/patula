# Patula

Privacy launchpad on Solana: creators and buyers choose, per action, whether their wallet is public or private.
**Prototype. Not audited. Dev trusted setup. Do not use with real funds.**

| Folder | What | Deploys to |
|---|---|---|
| `programs/patula`, `circuits/`, `client/` | Shielded pool + ZK circuit (Phase 0) | Solana devnet |
| `programs/launchpad` | Bonding-curve launchpad, public mode (Phase 1) | Solana devnet |
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

## Devnet

Program `GVrC5uW3cXm3JReHtG7R1zmJ8Sf1Zx6PHr1Hnt9Ld8GV` is deployed on devnet with an initialized pool.
`RELAYER_URL=https://relayer-production-a1eda68c.up.railway.app npx ts-node -P tsconfig.json scripts/devnet.ts`
initializes the pool if needed, tops up the relayer, deposits 0.05 SOL and withdraws it privately to a fresh address through the hosted relayer.

## Launchpad (Phase 1, public mode)

Program `C7eYK9wzuSWcC5daBfLB2MxXg34PNBQjMtDKcRkBdsFP` on devnet. Fixed 1B supply with minting revoked, no freeze authority,
curve SOL locked in a program vault, creator buy capped at 5%, anti-sniper cap of 1% per trade for the first 10 slots,
1% trade fee (0.7% platform, 0.3% creator). Devnet curves graduate after ~0.8 SOL. Migration to a DEX on graduation is not built yet.

`npx ts-node -P tsconfig.json scripts/launchpad-devnet.ts` initialises the config and seeds a demo token.
The web app lives at `/app` (explore), `/app/create` (launch) and `/app/t/<mint>` (trade).
