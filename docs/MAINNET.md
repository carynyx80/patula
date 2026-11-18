# Patula — mainnet readiness

Status as of 18 Nov 2026. Everything below "Built" is implemented and tested on devnet. Everything under
"Blockers" must be done by people (not code) before real funds go in. `scripts/mainnet/deploy.sh` refuses to
run until the first two blockers are recorded.

## Built

| Area | What | Where |
|---|---|---|
| Fixed supply | 1B minted at launch, mint authority revoked, no freeze authority | `programs/launchpad` `create_token` |
| Metadata | Immutable Metaplex metadata; images + JSON hosted by the relayer or pinned to IPFS (`PINATA_JWT`) | `create_token`, `relayer /metadata` |
| Creator fees | Creator picks buy fee, sell fee (≤ `max_token_fee_bps`, hard cap 10%) and staker share; immutable per token | `TokenFees` |
| Holders fee | Stake-to-earn: stakers receive the holder share of every trade pro-rata, claim any time, unstake any time | `stake` / `unstake` / `claim` |
| Platform fee | ≤ 2% hard cap in code; adjustable by the config authority within the cap | `update_config` |
| Liquidity lock | No withdraw instruction exists for curve SOL or reserved tokens | whole program |
| Graduation | Curve sells out → built-in constant-product pool seeded with raised SOL + 200M reserved tokens; liquidity locked forever; fees and staking continue | `execute_buy` |
| Anti-rug | Creator buy cap 5%, anti-sniper cap 1% per trade for 10 slots | `execute_buy` |
| Emergency pause | Stops launches and buys only; sells, unstake, claim always work | `set_paused` |
| Admin handover | Two-step: `propose_authority` → `accept_authority` (use a Squads multisig) | config |
| Private trading | Shielded pool v2: multi-asset notes, private buy/sell/transfer/withdraw via relayer | `programs/patula`, `circuits/spend.circom` |
| Anonymous launch | Relayer pays, fresh key is creator; paid by the user with a private withdrawal (`PRIVATE_LAUNCH_PRICE_LAMPORTS`) | `relayer /launch/*` |
| Deny list | Relayer refuses blocked recipients/creators; `/screen?address=` for the UI | `relayer` |
| Deposit cap | 100 SOL per deposit transaction | `programs/patula` |
| Config per cluster | `NEXT_PUBLIC_CLUSTER`, `NEXT_PUBLIC_RPC_URL`, program ID overrides; relayer `.env.example` | `web`, `relayer` |
| Tests | 20 localnet tests (launchpad 11, pool 9) + Rust unit tests for fee math, graduation and reward accounting | `tests/`, `programs/*/src` |

## Blockers (cannot be done in code)

1. **Multi-party trusted setup.** The current proving key comes from a single-machine dev setup. Whoever has
   its randomness could forge proofs and drain the pool. Run `scripts/ceremony/ceremony.sh` with several
   independent participants, finish with a public beacon, regenerate `verifying_key.rs`, then
   `touch circuits/CEREMONY_COMPLETE`.
2. **Independent audits** of both programs and the circuit (focus: fee/reward accounting, graduation, CPI
   account validation, nullifier handling, circuit constraints). Record the reports and `touch docs/AUDIT_COMPLETE`.
3. **Legal review** for your jurisdiction: a privacy pool plus a token launchpad has real regulatory exposure.
   Decide entity, terms, geo-restrictions, and whether screening via a chain-analytics provider is required.
4. **Operational keys.** Create a Squads multisig for upgrade + config authority, a separate hot wallet for the
   relayer with limited funds, and store the deployer key offline.

## Recommended before or soon after launch

- **Compressed nullifiers** (Light Protocol) to cut the ~0.0019 SOL rent per private transaction.
- **Association-set proofs** (privacy-pools model) so users can prove their deposit isn't from a flagged source.
- **Chain-analytics screening** of deposits in the UI (Range, TRM, Chainalysis) feeding the relayer deny list.
- **DEX aggregator listing** for graduated pools (Jupiter integration requires an adapter for the built-in AMM).
- **Monitoring**: relayer balance alerts, error rates, and an on-call runbook for `set_paused`.
- **Bug bounty** after audits.
- **Low caps first**: start with a lower `MAX_DEPOSIT_LAMPORTS` and raise it as the pool matures.

## Deploying (after the blockers)

```bash
# 1. ceremony finished, audits recorded
ls circuits/CEREMONY_COMPLETE docs/AUDIT_COMPLETE

# 2. deploy both programs, init config/pool/lookup table, hand upgrade authority to the multisig
DEPLOYER=~/.config/solana/mainnet-deployer.json MULTISIG=<squads vault> RPC_URL=<mainnet rpc> ./scripts/mainnet/deploy.sh

# 3. multisig calls launchpad accept_authority (Squads transaction)

# 4. relayer on Railway: copy relayer/.env.example, set CLUSTER=mainnet-beta, RPC_URL, RELAYER_SECRET_KEY,
#    ALT_ADDRESS, PROGRAM_ID, LAUNCHPAD_ID, PINATA_JWT, ALLOWED_ORIGINS

# 5. web on Vercel: NEXT_PUBLIC_CLUSTER=mainnet-beta, NEXT_PUBLIC_RPC_URL, NEXT_PUBLIC_API_URL,
#    NEXT_PUBLIC_LAUNCHPAD_ID, NEXT_PUBLIC_POOL_ID; copy the ceremony zkey/wasm into web/public/zk
```

Mainnet curve parameters live in `scripts/mainnet/init.ts` (`MAINNET_PARAMS`): 28 SOL virtual reserve, 800M tokens
on the curve, graduation at ≈ 89.6 SOL raised, 0.5% platform fee, creator fees up to 5% per side.
