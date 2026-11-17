//! Patula shielded pool — Phase 0 prototype.
//!
//! A single-asset (SOL) UTXO pool. Every `transact` spends 2 notes and creates
//! 2 notes, proven with a Groth16 proof verified on-chain via the alt_bn128
//! syscalls. Deposits, private transfers and withdrawals are all `transact`
//! with a different `ext_amount`.
//!
//! NOT AUDITED. DEV TRUSTED SETUP. Do not deploy to mainnet.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_lang::system_program::{transfer, Transfer};
use groth16_solana::groth16::Groth16Verifier;
use solana_poseidon::{Endianness, Parameters};

mod verifying_key;
use verifying_key::{NR_PUBLIC_INPUTS, VERIFYING_KEY};

declare_id!("GVrC5uW3cXm3JReHtG7R1zmJ8Sf1Zx6PHr1Hnt9Ld8GV");

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: usize = 32;
/// Compliance decision: no KYC, capped deposits (100 SOL per transaction).
pub const MAX_DEPOSIT_LAMPORTS: i64 = 100_000_000_000;

/// BN254 scalar field modulus, big-endian.
const FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[program]
pub mod patula {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mut pool = ctx.accounts.pool.load_init()?;
        let mut zero = [0u8; 32];
        for i in 0..LEVELS {
            pool.zeros[i] = zero;
            pool.filled_subtrees[i] = zero;
            zero = poseidon2(&zero, &zero)?;
        }
        pool.roots[0] = zero; // empty-tree root
        pool.current_root_index = 0;
        pool.next_index = 0;
        drop(pool);

        // Keep the vault rent-exempt so withdrawals can never drain it below rent.
        let rent = Rent::get()?.minimum_balance(0);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            rent,
        )?;
        Ok(())
    }

    pub fn transact(ctx: Context<Transact>, args: TransactArgs) -> Result<()> {
        require!(args.ext_amount <= MAX_DEPOSIT_LAMPORTS, PatulaError::DepositTooLarge);
        require!(args.ext_amount > i64::MIN, PatulaError::InvalidExtAmount);

        // 1. Root must be one the pool has produced recently.
        {
            let pool = ctx.accounts.pool.load()?;
            require!(pool.is_known_root(&args.root), PatulaError::UnknownRoot);
        }

        // 2. publicAmount must equal extAmount - fee (mod p).
        require!(
            args.public_amount == public_amount_field(args.ext_amount, args.fee),
            PatulaError::InvalidPublicAmount
        );

        // 3. extDataHash binds recipient, relayer and amounts into the proof,
        //    so a relayer cannot redirect funds or change its fee.
        let ext_data_hash = ext_data_hash(
            &ctx.accounts.recipient.key(),
            &ctx.accounts.signer.key(),
            args.ext_amount,
            args.fee,
        );

        // 4. Verify the Groth16 proof.
        let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
            args.root,
            args.public_amount,
            ext_data_hash,
            args.input_nullifiers[0],
            args.input_nullifiers[1],
            args.output_commitments[0],
            args.output_commitments[1],
        ];
        let mut verifier = Groth16Verifier::new(
            &args.proof_a,
            &args.proof_b,
            &args.proof_c,
            &public_inputs,
            &VERIFYING_KEY,
        )
        .map_err(|_| error!(PatulaError::InvalidProof))?;
        verifier.verify().map_err(|_| error!(PatulaError::InvalidProof))?;

        // 5. Nullifier PDAs were created by `init` above: a reused nullifier
        //    fails account creation, which blocks double spends.

        // 6. Insert the two new commitments.
        let first_index = {
            let mut pool = ctx.accounts.pool.load_mut()?;
            pool.insert_pair(&args.output_commitments[0], &args.output_commitments[1])?
        };
        emit!(NewCommitments {
            index: first_index,
            commitments: args.output_commitments,
        });
        emit!(NullifiersSpent { nullifiers: args.input_nullifiers });

        // 7. Move SOL.
        let vault_bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[b"vault", &[vault_bump]];
        if args.ext_amount > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.signer.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                ),
                args.ext_amount as u64,
            )?;
        } else if args.ext_amount < 0 {
            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.recipient.to_account_info(),
                    },
                    &[seeds],
                ),
                args.ext_amount.unsigned_abs(),
            )?;
        }
        if args.fee > 0 {
            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.signer.to_account_info(),
                    },
                    &[seeds],
                ),
                args.fee,
            )?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account(zero_copy)]
pub struct Pool {
    pub next_index: u64,
    pub current_root_index: u64,
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub zeros: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

impl Pool {
    fn is_known_root(&self, root: &[u8; 32]) -> bool {
        *root != [0u8; 32] && self.roots.iter().any(|r| r == root)
    }

    /// Inserts two leaves at once (next_index is always even), costing
    /// LEVELS Poseidon hashes instead of 2 * LEVELS.
    fn insert_pair(&mut self, left: &[u8; 32], right: &[u8; 32]) -> Result<u64> {
        let index = self.next_index;
        require!(index + 2 <= 1u64 << LEVELS, PatulaError::TreeFull);
        let mut current = poseidon2(left, right)?;
        let mut idx = index >> 1;
        for i in 1..LEVELS {
            let (l, r) = if idx & 1 == 0 {
                self.filled_subtrees[i] = current;
                (current, self.zeros[i])
            } else {
                (self.filled_subtrees[i], current)
            };
            current = poseidon2(&l, &r)?;
            idx >>= 1;
        }
        self.current_root_index = (self.current_root_index + 1) % ROOT_HISTORY as u64;
        self.roots[self.current_root_index as usize] = current;
        self.next_index = index + 2;
        Ok(index)
    }
}

#[account]
pub struct Nullifier {}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + std::mem::size_of::<Pool>(), seeds = [b"pool"], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransactArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_amount: i64,
    pub fee: u64,
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[derive(Accounts)]
#[instruction(args: TransactArgs)]
pub struct Transact<'info> {
    #[account(mut, seeds = [b"pool"], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: SystemAccount<'info>,
    #[account(init, payer = signer, space = 8,
        seeds = [b"nullifier", args.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Box<Account<'info, Nullifier>>,
    #[account(init, payer = signer, space = 8,
        seeds = [b"nullifier", args.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Box<Account<'info, Nullifier>>,
    /// Depositor for deposits; the relayer for private transfers/withdrawals.
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: only receives lamports; bound to the proof via ext_data_hash.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct NewCommitments {
    pub index: u64,
    pub commitments: [[u8; 32]; 2],
}

#[event]
pub struct NullifiersSpent {
    pub nullifiers: [[u8; 32]; 2],
}

#[error_code]
pub enum PatulaError {
    #[msg("Poseidon hash failed")]
    Poseidon,
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Root is not in recent history")]
    UnknownRoot,
    #[msg("publicAmount does not match extAmount - fee")]
    InvalidPublicAmount,
    #[msg("Invalid zero-knowledge proof")]
    InvalidProof,
    #[msg("Deposit exceeds the per-transaction cap")]
    DepositTooLarge,
    #[msg("Invalid extAmount")]
    InvalidExtAmount,
}

// ---------------------------------------------------------------- helpers

fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
    solana_poseidon::hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b])
        .map(|h| h.to_bytes())
        .map_err(|_| error!(PatulaError::Poseidon))
}

/// sha256(recipient || relayer || ext_amount_le || fee_le) with the top byte
/// cleared so it is always a valid field element.
pub fn ext_data_hash(recipient: &Pubkey, relayer: &Pubkey, ext_amount: i64, fee: u64) -> [u8; 32] {
    let mut h = hashv(&[
        recipient.as_ref(),
        relayer.as_ref(),
        &ext_amount.to_le_bytes(),
        &fee.to_le_bytes(),
    ])
    .to_bytes();
    h[0] = 0;
    h
}

/// (ext_amount - fee) mod p, big-endian.
pub fn public_amount_field(ext_amount: i64, fee: u64) -> [u8; 32] {
    let v = ext_amount as i128 - fee as i128;
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&v.unsigned_abs().to_be_bytes());
    if v >= 0 {
        return out;
    }
    // p - |v|
    let mut res = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = FIELD_MODULUS[i] as i16 - out[i] as i16 - borrow;
        if d < 0 {
            res[i] = (d + 256) as u8;
            borrow = 1;
        } else {
            res[i] = d as u8;
            borrow = 0;
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_public_amount_wraps() {
        let a = public_amount_field(-1, 0);
        let mut expect = FIELD_MODULUS;
        expect[31] = 0x00; // p - 1
        assert_eq!(a, expect);
        assert_eq!(public_amount_field(5, 2)[31], 3);
    }
}
