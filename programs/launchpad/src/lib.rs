//! Patula launchpad v2.
//!
//! Every token gets, enforced by this program:
//! - fixed supply: all minted at creation, mint authority revoked, no freeze authority
//! - immutable Metaplex metadata (name, ticker, uri)
//! - liquidity that can never be withdrawn: curve SOL and the reserved tokens
//!   stay in program vaults; there is no withdraw instruction for anyone
//! - creator-chosen buy and sell fees (within platform caps, locked at launch),
//!   split between the creator and stakers ("holders fee")
//! - capped creator buy and an anti-sniper window
//!
//! Pricing: a constant-product bonding curve over virtual reserves. When the
//! curve's tokens sell out the token graduates into a built-in constant-product
//! pool seeded with the raised SOL and the reserved tokens. Trading, fees and
//! staking rewards continue there; the pool's liquidity is locked forever.
//!
//! Holders fee: holders stake tokens and earn SOL pro-rata (accumulator model),
//! claimable any time. Unstaking is always allowed.
//!
//! Admin: the config authority can pause buys and launches (never sells,
//! unstakes or claims), adjust the platform fee within hard caps, and hand
//! authority to a new key (e.g. a multisig) in two steps.
//!
//! NOT AUDITED.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::{
    self, set_authority, spl_token::instruction::AuthorityType, Mint, MintTo, SetAuthority, Token, TokenAccount,
    Transfer as SplTransfer,
};

declare_id!("3yiXiMT2GYNVAjvas5KNFpHvijTj823AA9DsuhWVo3BQ");

pub const DECIMALS: u8 = 6;
const BPS: u128 = 10_000;
/// Hard caps baked into the program; no admin can exceed them.
pub const MAX_PLATFORM_FEE_BPS: u16 = 200; // 2%
pub const MAX_TOKEN_FEE_BPS: u16 = 1_000; // 10% creator-chosen fee per side
pub const MIN_STAKE: u64 = 1_000_000; // 1 whole token
const ACC_SCALE: u128 = 1_000_000_000_000; // reward-per-share precision

#[program]
pub mod launchpad {
    use super::*;

    // ------------------------------------------------------------- admin

    pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.pending_authority = Pubkey::default();
        c.paused = false;
        c.bump = ctx.bumps.config;
        c.apply(&params);
        Ok(())
    }

    /// Platform settings for future launches and the platform fee. Existing
    /// tokens keep their own curve parameters and creator fees.
    pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        ctx.accounts.config.apply(&params);
        emit!(ConfigUpdated { authority: ctx.accounts.authority.key() });
        Ok(())
    }

    /// Emergency switch: stops new launches and buys. Sells, unstaking and
    /// claims always keep working so nobody can be trapped.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_authority = new_authority;
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require_keys_eq!(c.pending_authority, ctx.accounts.new_authority.key(), LaunchpadError::Unauthorized);
        c.authority = c.pending_authority;
        c.pending_authority = Pubkey::default();
        Ok(())
    }

    // ------------------------------------------------------------- launch

    pub fn create_token(ctx: Context<CreateToken>, name: String, symbol: String, uri: String, fees: TokenFees) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, LaunchpadError::Paused);
        require!(!name.is_empty() && name.len() <= 32, LaunchpadError::BadMetadata);
        require!(!symbol.is_empty() && symbol.len() <= 10, LaunchpadError::BadMetadata);
        require!(uri.len() <= 200, LaunchpadError::BadMetadata);
        require!(fees.buy_fee_bps <= config.max_token_fee_bps && fees.sell_fee_bps <= config.max_token_fee_bps, LaunchpadError::FeeTooHigh);
        require!(fees.holder_share_bps <= 10_000, LaunchpadError::FeeTooHigh);

        let mint_key = ctx.accounts.mint.key();
        let curve = &mut ctx.accounts.curve;
        curve.mint = mint_key;
        curve.creator = ctx.accounts.creator.key();
        curve.virtual_sol = config.virtual_sol;
        curve.virtual_token = config.virtual_token;
        curve.real_sol = 0;
        curve.real_token = config.curve_supply;
        curve.creator_bought = 0;
        curve.launch_slot = Clock::get()?.slot;
        curve.graduated = false;
        curve.amm_sol = 0;
        curve.amm_token = 0;
        curve.fees = fees;
        curve.total_staked = 0;
        curve.acc_reward_per_share = 0;
        curve.pending_rewards = 0;
        curve.holder_rewards_total = 0;
        curve.creator_fees_total = 0;
        curve.volume_sol = 0;
        curve.bump = ctx.bumps.curve;
        curve.name = name.clone();
        curve.symbol = symbol.clone();
        curve.uri = uri.clone();

        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve.bump]];
        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    mint_authority: curve.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    update_authority: curve.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                &[seeds],
            ),
            DataV2 { name: name.clone(), symbol: symbol.clone(), uri: uri.clone(), seller_fee_basis_points: 0, creators: None, collection: None, uses: None },
            false,
            true,
            None,
        )?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo { mint: ctx.accounts.mint.to_account_info(), to: ctx.accounts.curve_token_vault.to_account_info(), authority: curve.to_account_info() },
                &[seeds],
            ),
            config.total_supply,
        )?;
        set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority { current_authority: curve.to_account_info(), account_or_mint: ctx.accounts.mint.to_account_info() },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        let rent = Rent::get()?.minimum_balance(0);
        let sys = &ctx.accounts.system_program;
        let payer = ctx.accounts.payer.to_account_info();
        pay(sys, &payer, &ctx.accounts.sol_vault.to_account_info(), rent, None)?;
        pay(sys, &payer, &ctx.accounts.rewards.to_account_info(), rent, None)?;
        if config.launch_fee > 0 {
            pay(sys, &payer, &ctx.accounts.fee_recipient.to_account_info(), config.launch_fee, None)?;
        }

        emit!(TokenCreated { mint: mint_key, creator: curve.creator, name, symbol, uri, fees, slot: curve.launch_slot });
        Ok(())
    }

    // ------------------------------------------------------------- trading

    pub fn buy(ctx: Context<Buy>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, LaunchpadError::Paused);
        require!(sol_in > 0, LaunchpadError::ZeroAmount);
        let q = quote_buy(&ctx.accounts.curve, &ctx.accounts.config, sol_in)?;
        require!(q.tokens >= min_tokens_out, LaunchpadError::Slippage);
        execute_buy(ctx, q)
    }

    /// Buy exactly `tokens_out`, paying at most `max_sol_in` (fees included).
    pub fn buy_exact_out(ctx: Context<Buy>, tokens_out: u64, max_sol_in: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, LaunchpadError::Paused);
        let q = quote_buy_exact_out(&ctx.accounts.curve, &ctx.accounts.config, tokens_out)?;
        require!(q.gross <= max_sol_in, LaunchpadError::Slippage);
        execute_buy(ctx, q)
    }

    /// Always available, even while paused.
    pub fn sell(ctx: Context<Sell>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(tokens_in > 0, LaunchpadError::ZeroAmount);
        let q = quote_sell(&ctx.accounts.curve, &ctx.accounts.config, tokens_in)?;
        require!(q.net >= min_sol_out && q.net > 0, LaunchpadError::Slippage);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.seller_token.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        let mint_key = ctx.accounts.curve.mint;
        let seeds: &[&[u8]] = &[b"sol_vault", mint_key.as_ref(), &[ctx.bumps.sol_vault]];
        let sys = &ctx.accounts.system_program;
        let vault = ctx.accounts.sol_vault.to_account_info();
        pay(sys, &vault, &ctx.accounts.seller.to_account_info(), q.net, Some(seeds))?;
        pay(sys, &vault, &ctx.accounts.fee_recipient.to_account_info(), q.split.platform, Some(seeds))?;
        pay(sys, &vault, &ctx.accounts.creator.to_account_info(), q.split.creator, Some(seeds))?;
        pay(sys, &vault, &ctx.accounts.rewards.to_account_info(), q.split.holders, Some(seeds))?;

        let curve = &mut ctx.accounts.curve;
        apply_reserves(curve, q.new_x, q.new_y);
        if !curve.graduated {
            curve.real_sol -= q.gross;
            curve.real_token = curve.real_token.checked_add(tokens_in).ok_or(LaunchpadError::MathOverflow)?;
        }
        record_fees(curve, &q.split, q.gross);
        emit_trade(curve, ctx.accounts.seller.key(), false, q.net, tokens_in, &q.split)?;
        Ok(())
    }

    // ------------------------------------------------------------- staking (holders fee)

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, LaunchpadError::ZeroAmount);
        let pos = &mut ctx.accounts.position;
        require!(pos.amount.checked_add(amount).ok_or(LaunchpadError::MathOverflow)? >= MIN_STAKE, LaunchpadError::StakeTooSmall);
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.owner.key();
            pos.mint = ctx.accounts.mint.key();
            pos.bump = ctx.bumps.position;
        }
        let curve = &mut ctx.accounts.curve;
        let owed = settle(curve, pos);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer { from: ctx.accounts.owner_token.to_account_info(), to: ctx.accounts.stake_vault.to_account_info(), authority: ctx.accounts.owner.to_account_info() },
            ),
            amount,
        )?;
        pos.amount += amount;
        curve.total_staked += amount;
        pos.reward_debt = pos.amount as u128 * curve.acc_reward_per_share / ACC_SCALE;
        payout(&ctx.accounts.system_program, &ctx.accounts.rewards, &ctx.accounts.owner.to_account_info(), owed, curve.mint, ctx.bumps.rewards)?;
        emit!(Staked { mint: curve.mint, owner: pos.owner, amount, total_staked: curve.total_staked });
        Ok(())
    }

    pub fn unstake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(amount > 0 && amount <= pos.amount, LaunchpadError::ZeroAmount);
        let left = pos.amount - amount;
        require!(left == 0 || left >= MIN_STAKE, LaunchpadError::StakeTooSmall);
        let curve = &mut ctx.accounts.curve;
        let owed = settle(curve, pos);
        let mint_key = curve.mint;
        let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer { from: ctx.accounts.stake_vault.to_account_info(), to: ctx.accounts.owner_token.to_account_info(), authority: curve.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
        pos.amount = left;
        curve.total_staked -= amount;
        pos.reward_debt = pos.amount as u128 * curve.acc_reward_per_share / ACC_SCALE;
        payout(&ctx.accounts.system_program, &ctx.accounts.rewards, &ctx.accounts.owner.to_account_info(), owed, mint_key, ctx.bumps.rewards)?;
        emit!(Unstaked { mint: mint_key, owner: pos.owner, amount, total_staked: curve.total_staked });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        let pos = &mut ctx.accounts.position;
        let owed = settle(curve, pos);
        pos.reward_debt = pos.amount as u128 * curve.acc_reward_per_share / ACC_SCALE;
        payout(&ctx.accounts.system_program, &ctx.accounts.rewards, &ctx.accounts.owner.to_account_info(), owed, curve.mint, ctx.bumps.rewards)?;
        emit!(Claimed { mint: curve.mint, owner: pos.owner, amount: owed });
        Ok(())
    }
}

// ------------------------------------------------------------------ trading internals

fn execute_buy(ctx: Context<Buy>, q: Quote) -> Result<()> {
    let tokens_out = q.tokens;
    require!(tokens_out > 0, LaunchpadError::ZeroAmount);
    {
        let config = &ctx.accounts.config;
        let curve = &mut ctx.accounts.curve;
        let slot = Clock::get()?.slot;
        if slot < curve.launch_slot.saturating_add(config.sniper_slots) {
            let cap = (config.total_supply as u128 * config.sniper_max_bps as u128 / BPS) as u64;
            require!(tokens_out <= cap, LaunchpadError::SniperCap);
        }
        if ctx.accounts.buyer.key() == curve.creator {
            let cap = (config.total_supply as u128 * config.max_creator_buy_bps as u128 / BPS) as u64;
            let total = curve.creator_bought.checked_add(tokens_out).ok_or(LaunchpadError::MathOverflow)?;
            require!(total <= cap, LaunchpadError::CreatorCap);
            curve.creator_bought = total;
        }
    }

    let sys = &ctx.accounts.system_program;
    let buyer = ctx.accounts.buyer.to_account_info();
    pay(sys, &buyer, &ctx.accounts.sol_vault.to_account_info(), q.net, None)?;
    pay(sys, &buyer, &ctx.accounts.fee_recipient.to_account_info(), q.split.platform, None)?;
    pay(sys, &buyer, &ctx.accounts.creator.to_account_info(), q.split.creator, None)?;
    pay(sys, &buyer, &ctx.accounts.rewards.to_account_info(), q.split.holders, None)?;

    // vault balance as loaded at instruction start (before the transfer below)
    let vault_before = ctx.accounts.curve_token_vault.amount;
    let curve = &mut ctx.accounts.curve;
    let mint_key = curve.mint;
    let seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[curve.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer { from: ctx.accounts.curve_token_vault.to_account_info(), to: ctx.accounts.buyer_token.to_account_info(), authority: curve.to_account_info() },
            &[seeds],
        ),
        tokens_out,
    )?;

    apply_reserves(curve, q.new_x, q.new_y);
    if !curve.graduated {
        curve.real_sol = curve.real_sol.checked_add(q.net).ok_or(LaunchpadError::MathOverflow)?;
        curve.real_token -= tokens_out;
    }
    record_fees(curve, &q.split, q.gross);
    emit_trade(curve, ctx.accounts.buyer.key(), true, q.gross, tokens_out, &q.split)?;

    if !curve.graduated && curve.real_token == 0 {
        // Graduate: the raised SOL and the reserved tokens left in the vault
        // become a constant-product pool whose liquidity is locked forever.
        curve.graduated = true;
        curve.amm_sol = curve.real_sol;
        curve.amm_token = vault_before - tokens_out;
        emit!(Graduated { mint: curve.mint, sol: curve.amm_sol, tokens: curve.amm_token, slot: Clock::get()?.slot });
    }
    Ok(())
}

fn apply_reserves(curve: &mut Curve, x: u64, y: u64) {
    if curve.graduated {
        curve.amm_sol = x;
        curve.amm_token = y;
    } else {
        curve.virtual_sol = x;
        curve.virtual_token = y;
    }
}

/// Book fees and push the holders share into the reward accumulator. While
/// nobody is staked it waits in `pending_rewards`.
pub fn record_fees(curve: &mut Curve, s: &FeeSplit, gross: u64) {
    curve.creator_fees_total = curve.creator_fees_total.saturating_add(s.creator);
    curve.holder_rewards_total = curve.holder_rewards_total.saturating_add(s.holders);
    curve.volume_sol = curve.volume_sol.saturating_add(gross);
    curve.pending_rewards = curve.pending_rewards.saturating_add(s.holders);
    if curve.total_staked > 0 && curve.pending_rewards > 0 {
        let inc = curve.pending_rewards as u128 * ACC_SCALE / curve.total_staked as u128;
        let distributed = (inc * curve.total_staked as u128 / ACC_SCALE) as u64;
        curve.acc_reward_per_share += inc;
        curve.pending_rewards -= distributed;
    }
}

pub fn settle(curve: &Curve, pos: &StakePosition) -> u64 {
    let accrued = pos.amount as u128 * curve.acc_reward_per_share / ACC_SCALE;
    accrued.saturating_sub(pos.reward_debt) as u64
}

fn payout<'info>(sys: &Program<'info, System>, rewards: &SystemAccount<'info>, to: &AccountInfo<'info>, amount: u64, mint: Pubkey, bump: u8) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[b"rewards", mint.as_ref(), &[bump]];
    pay(sys, &rewards.to_account_info(), to, amount, Some(seeds))
}

// ------------------------------------------------------------------ math

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug)]
pub struct FeeSplit {
    pub platform: u64,
    pub creator: u64,
    pub holders: u64,
}

pub struct Quote {
    /// tokens out (buy) or in (sell)
    pub tokens: u64,
    /// buy: SOL into the curve vault; sell: SOL to the seller
    pub net: u64,
    /// buy: total paid by the buyer; sell: SOL leaving the vault before fees
    pub gross: u64,
    pub split: FeeSplit,
    pub new_x: u64,
    pub new_y: u64,
}

fn div_ceil(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

/// (SOL reserve, token reserve, max tokens purchasable)
fn reserves(curve: &Curve) -> (u128, u128, u128) {
    if curve.graduated {
        (curve.amm_sol as u128, curve.amm_token as u128, curve.amm_token.saturating_sub(1) as u128)
    } else {
        (curve.virtual_sol as u128, curve.virtual_token as u128, curve.real_token as u128)
    }
}

fn split(curve: &Curve, config: &Config, fee_total: u128, side_bps: u16) -> FeeSplit {
    let total_bps = config.platform_fee_bps as u128 + side_bps as u128;
    if total_bps == 0 || fee_total == 0 {
        return FeeSplit::default();
    }
    let platform = fee_total * config.platform_fee_bps as u128 / total_bps;
    let token_fee = fee_total - platform;
    let holders = token_fee * curve.fees.holder_share_bps as u128 / BPS;
    FeeSplit { platform: platform as u64, creator: (token_fee - holders) as u64, holders: holders as u64 }
}

pub fn quote_buy(curve: &Curve, config: &Config, sol_in: u64) -> Result<Quote> {
    let side = curve.fees.buy_fee_bps;
    let total_bps = config.platform_fee_bps as u128 + side as u128;
    let (x, y, cap) = reserves(curve);
    let k = x * y;
    let mut fee = sol_in as u128 * total_bps / BPS;
    let mut net = sol_in as u128 - fee;
    let mut new_x = x + net;
    let mut new_y = div_ceil(k, new_x);
    let mut out = y - new_y;
    if out > cap {
        out = cap;
        new_y = y - out;
        new_x = div_ceil(k, new_y);
        net = new_x - x;
        fee = div_ceil(net * total_bps, BPS - total_bps);
    }
    let s = split(curve, config, fee, side);
    Ok(Quote { tokens: out as u64, net: net as u64, gross: (net + fee) as u64, split: s, new_x: new_x as u64, new_y: new_y as u64 })
}

pub fn quote_buy_exact_out(curve: &Curve, config: &Config, tokens_out: u64) -> Result<Quote> {
    let side = curve.fees.buy_fee_bps;
    let total_bps = config.platform_fee_bps as u128 + side as u128;
    let (x, y, cap) = reserves(curve);
    require!(tokens_out > 0 && tokens_out as u128 <= cap, LaunchpadError::InsufficientLiquidity);
    let k = x * y;
    let new_y = y - tokens_out as u128;
    let new_x = div_ceil(k, new_y);
    let net = new_x - x;
    let fee = div_ceil(net * total_bps, BPS - total_bps);
    let s = split(curve, config, fee, side);
    Ok(Quote { tokens: tokens_out, net: net as u64, gross: (net + fee) as u64, split: s, new_x: new_x as u64, new_y: new_y as u64 })
}

pub fn quote_sell(curve: &Curve, config: &Config, tokens_in: u64) -> Result<Quote> {
    let side = curve.fees.sell_fee_bps;
    let total_bps = config.platform_fee_bps as u128 + side as u128;
    let (x, y, _) = reserves(curve);
    let k = x * y;
    let new_y = y + tokens_in as u128;
    let new_x = div_ceil(k, new_y);
    let gross = x - new_x;
    if !curve.graduated {
        require!(gross <= curve.real_sol as u128, LaunchpadError::InsufficientLiquidity);
    }
    let fee = gross * total_bps / BPS;
    let s = split(curve, config, fee, side);
    Ok(Quote { tokens: tokens_in, net: (gross - fee) as u64, gross: gross as u64, split: s, new_x: new_x as u64, new_y: new_y as u64 })
}

// ------------------------------------------------------------------ helpers

fn pay<'info>(sys: &Program<'info, System>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64, seeds: Option<&[&[u8]]>) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = Transfer { from: from.clone(), to: to.clone() };
    match seeds {
        Some(s) => transfer(CpiContext::new_with_signer(sys.to_account_info(), accounts, &[s]), amount),
        None => transfer(CpiContext::new(sys.to_account_info(), accounts), amount),
    }
}

fn emit_trade(curve: &Curve, trader: Pubkey, is_buy: bool, sol: u64, tokens: u64, s: &FeeSplit) -> Result<()> {
    let (x, y) = if curve.graduated { (curve.amm_sol, curve.amm_token) } else { (curve.virtual_sol, curve.virtual_token) };
    emit!(Trade {
        mint: curve.mint, trader, is_buy, sol, tokens,
        virtual_sol: x, virtual_token: y, real_sol: curve.real_sol,
        platform_fee: s.platform, creator_fee: s.creator, holder_fee: s.holders,
        graduated: curve.graduated,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

// ------------------------------------------------------------------ state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub platform_fee_bps: u16,
    pub max_token_fee_bps: u16,
    pub launch_fee: u64,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub total_supply: u64,
    pub max_creator_buy_bps: u16,
    pub sniper_slots: u64,
    pub sniper_max_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    fn apply(&mut self, p: &ConfigParams) {
        self.fee_recipient = p.fee_recipient;
        self.platform_fee_bps = p.platform_fee_bps;
        self.max_token_fee_bps = p.max_token_fee_bps;
        self.launch_fee = p.launch_fee;
        self.virtual_sol = p.virtual_sol;
        self.virtual_token = p.virtual_token;
        self.curve_supply = p.curve_supply;
        self.total_supply = p.total_supply;
        self.max_creator_buy_bps = p.max_creator_buy_bps;
        self.sniper_slots = p.sniper_slots;
        self.sniper_max_bps = p.sniper_max_bps;
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub fee_recipient: Pubkey,
    pub platform_fee_bps: u16,
    pub max_token_fee_bps: u16,
    pub launch_fee: u64,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub total_supply: u64,
    pub max_creator_buy_bps: u16,
    pub sniper_slots: u64,
    pub sniper_max_bps: u16,
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        require!(self.platform_fee_bps <= MAX_PLATFORM_FEE_BPS, LaunchpadError::FeeTooHigh);
        require!(self.max_token_fee_bps <= MAX_TOKEN_FEE_BPS, LaunchpadError::FeeTooHigh);
        require!(self.curve_supply > 0 && self.curve_supply < self.total_supply, LaunchpadError::BadConfig);
        require!(self.virtual_token > self.curve_supply && self.virtual_sol > 0, LaunchpadError::BadConfig);
        require!(self.max_creator_buy_bps <= 2_000 && self.sniper_max_bps <= 10_000, LaunchpadError::BadConfig);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default, Debug)]
pub struct TokenFees {
    /// creator-chosen fee on buys, on top of the platform fee
    pub buy_fee_bps: u16,
    /// creator-chosen fee on sells, on top of the platform fee
    pub sell_fee_bps: u16,
    /// share of the creator-chosen fees paid to stakers (the rest goes to the creator)
    pub holder_share_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub real_token: u64,
    pub creator_bought: u64,
    pub launch_slot: u64,
    pub graduated: bool,
    pub amm_sol: u64,
    pub amm_token: u64,
    pub fees: TokenFees,
    pub total_staked: u64,
    pub acc_reward_per_share: u128,
    pub pending_rewards: u64,
    pub holder_rewards_total: u64,
    pub creator_fees_total: u64,
    pub volume_sol: u64,
    pub bump: u8,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
}

#[account]
#[derive(InitSpace)]
pub struct StakePosition {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub reward_debt: u128,
    pub bump: u8,
}

// ------------------------------------------------------------------ contexts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority @ LaunchpadError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateToken<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// Pays rent and the launch fee: the creator in public mode, a relayer in private mode.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Recorded as creator and receives creator fees. Signs so a launch cannot be attributed to someone else.
    pub creator: Signer<'info>,
    #[account(init, payer = payer, mint::decimals = DECIMALS, mint::authority = curve)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = payer, space = 8 + Curve::INIT_SPACE, seeds = [b"curve", mint.key().as_ref()], bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(init, payer = payer, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = payer, seeds = [b"stake_vault", mint.key().as_ref()], bump, token::mint = mint, token::authority = curve)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"sol_vault", mint.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"rewards", mint.key().as_ref()], bump)]
    pub rewards: SystemAccount<'info>,
    /// CHECK: checked against config
    #[account(mut, address = config.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: Metaplex metadata PDA, created and validated by the metadata program
    #[account(mut, seeds = [b"metadata", token_metadata_program.key().as_ref(), mint.key().as_ref()], bump, seeds::program = token_metadata_program.key())]
    pub metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"sol_vault", mint.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"rewards", mint.key().as_ref()], bump)]
    pub rewards: SystemAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(init_if_needed, payer = buyer, associated_token::mint = mint, associated_token::authority = buyer)]
    pub buyer_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against config
    #[account(mut, address = config.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against curve
    #[account(mut, address = curve.creator)]
    pub creator: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"sol_vault", mint.key().as_ref()], bump)]
    pub sol_vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"rewards", mint.key().as_ref()], bump)]
    pub rewards: SystemAccount<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = seller)]
    pub seller_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against config
    #[account(mut, address = config.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against curve
    #[account(mut, address = curve.creator)]
    pub creator: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(init_if_needed, payer = owner, space = 8 + StakePosition::INIT_SPACE, seeds = [b"stake", mint.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Box<Account<'info, StakePosition>>,
    #[account(mut, seeds = [b"stake_vault", mint.key().as_ref()], bump)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = owner)]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"rewards", mint.key().as_ref()], bump)]
    pub rewards: SystemAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"curve", mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"stake", mint.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner)]
    pub position: Box<Account<'info, StakePosition>>,
    #[account(mut, seeds = [b"rewards", mint.key().as_ref()], bump)]
    pub rewards: SystemAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------ events & errors

#[event]
pub struct TokenCreated { pub mint: Pubkey, pub creator: Pubkey, pub name: String, pub symbol: String, pub uri: String, pub fees: TokenFees, pub slot: u64 }

#[event]
pub struct Trade {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub sol: u64,
    pub tokens: u64,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub platform_fee: u64,
    pub creator_fee: u64,
    pub holder_fee: u64,
    pub graduated: bool,
    pub timestamp: i64,
}

#[event]
pub struct Graduated { pub mint: Pubkey, pub sol: u64, pub tokens: u64, pub slot: u64 }
#[event]
pub struct Staked { pub mint: Pubkey, pub owner: Pubkey, pub amount: u64, pub total_staked: u64 }
#[event]
pub struct Unstaked { pub mint: Pubkey, pub owner: Pubkey, pub amount: u64, pub total_staked: u64 }
#[event]
pub struct Claimed { pub mint: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event]
pub struct ConfigUpdated { pub authority: Pubkey }
#[event]
pub struct PausedSet { pub paused: bool }

#[error_code]
pub enum LaunchpadError {
    #[msg("Invalid config")]
    BadConfig,
    #[msg("Name 1-32, symbol 1-10, uri up to 200 characters")]
    BadMetadata,
    #[msg("Fee above the allowed cap")]
    FeeTooHigh,
    #[msg("Launches and buys are paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Price moved beyond your slippage limit")]
    Slippage,
    #[msg("Anti-sniper window: trade too large")]
    SniperCap,
    #[msg("Creator buy cap reached")]
    CreatorCap,
    #[msg("Not enough liquidity")]
    InsufficientLiquidity,
    #[msg("Stake at least 1 token (or unstake everything)")]
    StakeTooSmall,
    #[msg("Not authorised")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            authority: Pubkey::default(), pending_authority: Pubkey::default(), fee_recipient: Pubkey::default(),
            platform_fee_bps: 50, max_token_fee_bps: 1000, launch_fee: 0,
            virtual_sol: 25_000_000_000, virtual_token: 1_050_000_000_000_000, curve_supply: 800_000_000_000_000,
            total_supply: 1_000_000_000_000_000, max_creator_buy_bps: 500, sniper_slots: 0, sniper_max_bps: 100,
            paused: false, bump: 0,
        }
    }
    fn curve(c: &Config, fees: TokenFees) -> Curve {
        Curve {
            mint: Pubkey::default(), creator: Pubkey::default(), virtual_sol: c.virtual_sol, virtual_token: c.virtual_token,
            real_sol: 0, real_token: c.curve_supply, creator_bought: 0, launch_slot: 0, graduated: false, amm_sol: 0, amm_token: 0,
            fees, total_staked: 0, acc_reward_per_share: 0, pending_rewards: 0, holder_rewards_total: 0, creator_fees_total: 0,
            volume_sol: 0, bump: 0, name: String::new(), symbol: String::new(), uri: String::new(),
        }
    }
    const FEES: TokenFees = TokenFees { buy_fee_bps: 200, sell_fee_bps: 300, holder_share_bps: 5_000 };

    #[test]
    fn fees_split_and_sum() {
        let c = cfg();
        let cv = curve(&c, FEES);
        let q = quote_buy(&cv, &c, 1_000_000_000).unwrap();
        // 0.5% platform + 2% buy fee = 2.5% of 1 SOL, creator fee split 50/50 with holders
        assert_eq!(q.split.platform, 5_000_000);
        assert_eq!(q.split.creator, 10_000_000);
        assert_eq!(q.split.holders, 10_000_000);
        assert_eq!(q.gross, 1_000_000_000);
    }

    #[test]
    fn round_trip_never_profits() {
        let c = cfg();
        let mut cv = curve(&c, FEES);
        let b = quote_buy(&cv, &c, 1_000_000_000).unwrap();
        cv.virtual_sol = b.new_x;
        cv.virtual_token = b.new_y;
        cv.real_sol = b.net;
        let s = quote_sell(&cv, &c, b.tokens).unwrap();
        assert!(s.net < 1_000_000_000);
    }

    #[test]
    fn last_buy_clamps_and_pool_price_is_continuous() {
        let c = cfg();
        let cv = curve(&c, TokenFees::default());
        let b = quote_buy(&cv, &c, 1_000_000_000_000).unwrap();
        assert_eq!(b.tokens, c.curve_supply);
        assert_eq!(b.net, 80_000_000_000);
        let curve_px = b.new_x as f64 / b.new_y as f64;
        let pool_px = b.net as f64 / (c.total_supply - c.curve_supply) as f64;
        assert!((curve_px / pool_px - 1.0).abs() < 0.06, "{} vs {}", curve_px, pool_px);
    }

    #[test]
    fn graduated_pool_trades_and_conserves_k() {
        let c = cfg();
        let mut cv = curve(&c, FEES);
        cv.graduated = true;
        cv.amm_sol = 80_000_000_000;
        cv.amm_token = 200_000_000_000_000;
        let k = cv.amm_sol as u128 * cv.amm_token as u128;
        let b = quote_buy(&cv, &c, 1_000_000_000).unwrap();
        assert!(b.tokens > 0);
        assert!(b.new_x as u128 * b.new_y as u128 >= k);
    }

    #[test]
    fn rewards_accumulate_without_loss() {
        let c = cfg();
        let mut cv = curve(&c, FEES);
        cv.total_staked = 3_000_000;
        record_fees(&mut cv, &FeeSplit { platform: 0, creator: 0, holders: 10 }, 0);
        let pos = StakePosition { owner: Pubkey::default(), mint: Pubkey::default(), amount: 3_000_000, reward_debt: 0, bump: 0 };
        assert_eq!(settle(&cv, &pos) + cv.pending_rewards, 10);
    }
}
