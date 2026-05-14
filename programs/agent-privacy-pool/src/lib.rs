use anchor_lang::prelude::*;
use anchor_lang::system_program;
#[cfg(feature = "demo")]
use anchor_lang::solana_program::hash::hash;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

mod poseidon;
mod verifying_key_10;
mod verifying_key_20;

use poseidon::{hashv, Endianness, Parameters};
use verifying_key_10::{
    VK_ALPHA_G1 as VK10_ALPHA_G1, VK_BETA_G2 as VK10_BETA_G2,
    VK_DELTA_G2 as VK10_DELTA_G2, VK_GAMMA_G2 as VK10_GAMMA_G2, VK_IC as VK10_IC,
};
use verifying_key_20::{
    VK_ALPHA_G1 as VK20_ALPHA_G1, VK_BETA_G2 as VK20_BETA_G2,
    VK_DELTA_G2 as VK20_DELTA_G2, VK_GAMMA_G2 as VK20_GAMMA_G2, VK_IC as VK20_IC,
};

declare_id!("9uePoqdgaXpqFLQM2ED1GGQrwSEiqe3r6tW1AfsnrrbS");

const LEGACY_TREE_DEPTH: usize = 10;
const MAX_TREE_DEPTH: usize = 20;
const COMMITMENT_PAGE_CAPACITY: usize = 48;
const ROOT_HISTORY_SIZE: usize = 30;
const MAX_CLIENT_DEPOSIT_AMOUNT: u64 = 9_007_199_254_740_991;
const MAX_PROTOCOL_FEE_BPS: u16 = 500;
const NULLIFIER_VERSION_LEGACY: u8 = 0;
const NULLIFIER_VERSION_PDA: u8 = 1;

fn poseidon_hash(inputs: &[&[u8]]) -> Result<[u8; 32]> {
    Ok(hashv(Parameters::Bn254X5, Endianness::BigEndian, inputs)
        .map(|hash| hash.to_bytes())
        .map_err(|_| PoolError::PoseidonError)?)
}

fn validate_tree_depth(tree_depth: u8) -> Result<()> {
    require!(matches!(tree_depth, 10 | 20), PoolError::InvalidTreeDepth);
    Ok(())
}

fn validate_deposit_amount(deposit_amount: u64) -> Result<()> {
    require!(
        deposit_amount > 0 && deposit_amount <= MAX_CLIENT_DEPOSIT_AMOUNT,
        PoolError::InvalidDepositAmount
    );
    Ok(())
}

fn validate_protocol_fee_bps(protocol_fee_bps: u16) -> Result<()> {
    require!(
        protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
        PoolError::ProtocolFeeBpsTooHigh
    );
    Ok(())
}

fn ensure_nonzero_commitment(commitment: [u8; 32]) -> Result<()> {
    require!(commitment != [0u8; 32], PoolError::InvalidCommitment);
    Ok(())
}

fn ensure_nonzero_public_nullifier_hash(nullifier_hash: [u8; 32]) -> Result<()> {
    let zero = [0u8; 32];
    let zero_nullifier_hash = poseidon_hash(&[&zero])?;
    require!(
        nullifier_hash != zero_nullifier_hash,
        PoolError::ZeroNullifierNote
    );
    Ok(())
}

fn compute_zero_hashes(depth: usize) -> Result<Vec<[u8; 32]>> {
    let mut zeros = Vec::with_capacity(depth);
    let mut current = [0u8; 32];

    for _ in 0..depth {
        zeros.push(current);
        current = poseidon_hash(&[&current, &current])?;
    }

    Ok(zeros)
}

fn compute_legacy_zero_subtrees() -> Result<[[u8; 32]; LEGACY_TREE_DEPTH]> {
    let zeros = compute_zero_hashes(LEGACY_TREE_DEPTH)?;
    let mut filled_subtrees = [[0u8; 32]; LEGACY_TREE_DEPTH];
    filled_subtrees.copy_from_slice(&zeros);
    Ok(filled_subtrees)
}

fn compute_v2_zero_subtrees(tree_depth: usize) -> Result<[[u8; 32]; MAX_TREE_DEPTH]> {
    let zeros = compute_zero_hashes(tree_depth)?;
    let mut filled_subtrees = [[0u8; 32]; MAX_TREE_DEPTH];

    for (index, zero) in zeros.into_iter().enumerate() {
        filled_subtrees[index] = zero;
    }

    Ok(filled_subtrees)
}

fn ensure_root_known(roots: &[[u8; 32]], root_count: u32, root: [u8; 32]) -> Result<()> {
    let num_roots = std::cmp::min(root_count as usize, ROOT_HISTORY_SIZE);
    let root_found = roots[..num_roots]
        .iter()
        .any(|known_root| *known_root == root);
    require!(root_found, PoolError::InvalidRoot);
    Ok(())
}

fn ensure_nullifier_unused(used_nullifiers: &[[u8; 32]], nullifier_hash: [u8; 32]) -> Result<()> {
    let already_used = used_nullifiers
        .iter()
        .any(|used| *used == nullifier_hash);
    require!(!already_used, PoolError::AlreadyWithdrawn);
    Ok(())
}

fn expected_commitment_page_index(next_index: u32) -> u32 {
    next_index / COMMITMENT_PAGE_CAPACITY as u32
}

fn expected_commitment_page_offset(next_index: u32) -> u16 {
    (next_index as usize % COMMITMENT_PAGE_CAPACITY) as u16
}

fn append_commitment_page(
    page: &mut CommitmentPage,
    pool: Pubkey,
    page_index: u32,
    page_offset: u16,
    commitment: [u8; 32],
) -> Result<()> {
    if page.pool == Pubkey::default() {
        page.pool = pool;
        page.page_index = page_index;
        page.start_offset = page_offset;
        page.commitment_count = 0;
        page.commitments = [[0u8; 32]; COMMITMENT_PAGE_CAPACITY];
    }

    require_keys_eq!(page.pool, pool, PoolError::InvalidCommitmentPage);
    require!(
        page.page_index == page_index,
        PoolError::InvalidCommitmentPage
    );
    require!(
        page_offset >= page.start_offset,
        PoolError::InvalidCommitmentPage
    );

    let local_index = (page_offset - page.start_offset) as usize;
    require!(
        local_index == page.commitment_count as usize,
        PoolError::InvalidCommitmentPage
    );
    require!(
        local_index < COMMITMENT_PAGE_CAPACITY,
        PoolError::InvalidCommitmentPage
    );

    page.commitments[local_index] = commitment;
    page.commitment_count += 1;
    Ok(())
}

fn recipient_to_public_input(recipient: Pubkey) -> [u8; 32] {
    let recipient_bytes = recipient.to_bytes();
    let mut recipient_field = [0u8; 32];
    recipient_field[1..32].copy_from_slice(&recipient_bytes[..31]);
    recipient_field
}

fn verify_zk_proof_depth(
    tree_depth: u8,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; 3],
) -> Result<()> {
    let verifying_key = match tree_depth {
        10 => groth16_solana::groth16::Groth16Verifyingkey {
            nr_pubinputs: 3,
            vk_alpha_g1: VK10_ALPHA_G1,
            vk_beta_g2: VK10_BETA_G2,
            vk_gamme_g2: VK10_GAMMA_G2,
            vk_delta_g2: VK10_DELTA_G2,
            vk_ic: &VK10_IC,
        },
        20 => groth16_solana::groth16::Groth16Verifyingkey {
            nr_pubinputs: 3,
            vk_alpha_g1: VK20_ALPHA_G1,
            vk_beta_g2: VK20_BETA_G2,
            vk_gamme_g2: VK20_GAMMA_G2,
            vk_delta_g2: VK20_DELTA_G2,
            vk_ic: &VK20_IC,
        },
        _ => return err!(PoolError::InvalidTreeDepth),
    };

    let mut verifier = groth16_solana::groth16::Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &verifying_key,
    )
    .map_err(|_| PoolError::InvalidProof)?;

    verifier.verify().map_err(|_| PoolError::InvalidProof)?;
    Ok(())
}

fn transfer_from_sol_vault<'info>(
    pool_key: Pubkey,
    pool_bump: u8,
    pool_vault: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    system_program_account: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"vault", pool_key.as_ref(), &[pool_bump]];
    let signer_seeds = &[seeds];

    system_program::transfer(
        CpiContext::new_with_signer(
            system_program_account,
            system_program::Transfer {
                from: pool_vault,
                to: destination,
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}

fn transfer_from_token_vault<'info>(
    pool_key: Pubkey,
    pool_bump: u8,
    pool_vault: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    token_program_account: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[b"vault", pool_key.as_ref(), &[pool_bump]];
    let signer_seeds = &[seeds];
    let authority = pool_vault.clone();

    token::transfer(
        CpiContext::new_with_signer(
            token_program_account,
            Transfer {
                from: pool_vault,
                to: destination,
                authority,
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}

fn append_legacy_commitment(pool: &mut Pool, commitment: [u8; 32]) -> Result<()> {
    require!(
        (pool.next_index as usize) < (1 << LEGACY_TREE_DEPTH),
        PoolError::PoolFull
    );

    pool.commitments.push(commitment);

    let zeros = compute_zero_hashes(LEGACY_TREE_DEPTH)?;
    let mut current_hash = commitment;
    let mut current_index = pool.next_index;

    for (level, zero) in zeros.iter().enumerate() {
        if current_index % 2 == 0 {
            pool.filled_subtrees[level] = current_hash;
            current_hash = poseidon_hash(&[&current_hash, zero])?;
        } else {
            current_hash = poseidon_hash(&[&pool.filled_subtrees[level], &current_hash])?;
        }
        current_index /= 2;
    }

    let root_idx = (pool.root_count % ROOT_HISTORY_SIZE as u32) as usize;
    pool.roots[root_idx] = current_hash;
    pool.root_count += 1;
    pool.next_index += 1;
    Ok(())
}

fn append_v2_commitment(
    pool_key: Pubkey,
    pool: &mut PoolV2,
    page: &mut CommitmentPage,
    commitment_page_index: u32,
    commitment: [u8; 32],
) -> Result<()> {
    validate_tree_depth(pool.tree_depth)?;
    let tree_depth = pool.tree_depth as usize;

    require!(
        (pool.next_index as usize) < (1usize << tree_depth),
        PoolError::PoolFull
    );
    let expected_page_index = expected_commitment_page_index(pool.next_index);
    let page_offset = expected_commitment_page_offset(pool.next_index);
    require!(
        commitment_page_index == expected_page_index,
        PoolError::InvalidCommitmentPage
    );

    append_commitment_page(page, pool_key, commitment_page_index, page_offset, commitment)?;

    let zeros = compute_zero_hashes(tree_depth)?;
    let mut current_hash = commitment;
    let mut current_index = pool.next_index;

    for (level, zero) in zeros.iter().enumerate() {
        if current_index % 2 == 0 {
            pool.filled_subtrees[level] = current_hash;
            current_hash = poseidon_hash(&[&current_hash, zero])?;
        } else {
            current_hash = poseidon_hash(&[&pool.filled_subtrees[level], &current_hash])?;
        }
        current_index /= 2;
    }

    let root_idx = (pool.root_count % ROOT_HISTORY_SIZE as u32) as usize;
    pool.roots[root_idx] = current_hash;
    pool.root_count += 1;
    pool.next_index += 1;
    Ok(())
}

fn append_fee_v2_commitment(
    pool_key: Pubkey,
    pool: &mut PoolFeeV2,
    page: &mut CommitmentPage,
    commitment_page_index: u32,
    commitment: [u8; 32],
) -> Result<()> {
    validate_tree_depth(pool.tree_depth)?;
    let tree_depth = pool.tree_depth as usize;

    require!(
        (pool.next_index as usize) < (1usize << tree_depth),
        PoolError::PoolFull
    );
    let expected_page_index = expected_commitment_page_index(pool.next_index);
    let page_offset = expected_commitment_page_offset(pool.next_index);
    require!(
        commitment_page_index == expected_page_index,
        PoolError::InvalidCommitmentPage
    );

    append_commitment_page(page, pool_key, commitment_page_index, page_offset, commitment)?;

    let zeros = compute_zero_hashes(tree_depth)?;
    let mut current_hash = commitment;
    let mut current_index = pool.next_index;

    for (level, zero) in zeros.iter().enumerate() {
        if current_index % 2 == 0 {
            pool.filled_subtrees[level] = current_hash;
            current_hash = poseidon_hash(&[&current_hash, zero])?;
        } else {
            current_hash = poseidon_hash(&[&pool.filled_subtrees[level], &current_hash])?;
        }
        current_index /= 2;
    }

    let root_idx = (pool.root_count % ROOT_HISTORY_SIZE as u32) as usize;
    pool.roots[root_idx] = current_hash;
    pool.root_count += 1;
    pool.next_index += 1;
    Ok(())
}

fn verify_zk_withdraw_common(
    nullifier_version: u8,
    tree_depth: u8,
    roots: &[[u8; 32]; ROOT_HISTORY_SIZE],
    root_count: u32,
    recipient: Pubkey,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
) -> Result<()> {
    require!(
        nullifier_version == NULLIFIER_VERSION_PDA,
        PoolError::UnsupportedNullifierVersion
    );
    ensure_nonzero_public_nullifier_hash(nullifier_hash)?;
    ensure_root_known(roots, root_count, root)?;

    let public_inputs = [
        root,
        nullifier_hash,
        recipient_to_public_input(recipient),
    ];
    verify_zk_proof_depth(tree_depth, proof_a, proof_b, proof_c, public_inputs)?;
    Ok(())
}

fn verify_v2_withdraw(
    pool: &PoolV2,
    recipient: Pubkey,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
) -> Result<()> {
    verify_zk_withdraw_common(
        pool.nullifier_version,
        pool.tree_depth,
        &pool.roots,
        pool.root_count,
        recipient,
        proof_a,
        proof_b,
        proof_c,
        root,
        nullifier_hash,
    )
}

fn verify_fee_v2_withdraw(
    pool: &PoolFeeV2,
    recipient: Pubkey,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
) -> Result<()> {
    verify_zk_withdraw_common(
        pool.nullifier_version,
        pool.tree_depth,
        &pool.roots,
        pool.root_count,
        recipient,
        proof_a,
        proof_b,
        proof_c,
        root,
        nullifier_hash,
    )
}

fn compute_protocol_fee(deposit_amount: u64, protocol_fee_bps: u16) -> Result<u64> {
    deposit_amount
        .checked_mul(protocol_fee_bps as u64)
        .ok_or(error!(PoolError::FeeMathOverflow))?
        .checked_div(10_000)
        .ok_or(error!(PoolError::FeeMathOverflow))
}

fn compute_recipient_amount(
    deposit_amount: u64,
    protocol_fee: u64,
    relayer_fee: u64,
) -> Result<u64> {
    let total_fee = protocol_fee
        .checked_add(relayer_fee)
        .ok_or(error!(PoolError::FeeMathOverflow))?;
    require!(total_fee < deposit_amount, PoolError::CombinedFeeTooHigh);
    deposit_amount
        .checked_sub(total_fee)
        .ok_or(error!(PoolError::FeeMathOverflow))
}

fn record_nullifier(
    nullifier_record: &mut Account<NullifierRecord>,
    pool: Pubkey,
    nullifier_hash: [u8; 32],
) -> Result<()> {
    nullifier_record.pool = pool;
    nullifier_record.nullifier = nullifier_hash;
    nullifier_record.slot = Clock::get()?.slot;
    Ok(())
}

#[program]
pub mod agent_privacy_pool {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, deposit_amount: u64) -> Result<()> {
        validate_deposit_amount(deposit_amount)?;
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.deposit_amount = deposit_amount;
        pool.next_index = 0;
        pool.nullifier_count = 0;
        pool.bump = ctx.bumps.pool_vault;
        pool.root_count = 0;
        pool.roots = [[0u8; 32]; ROOT_HISTORY_SIZE];
        pool.commitments = Vec::new();
        pool.used_nullifiers = Vec::new();
        pool.filled_subtrees = compute_legacy_zero_subtrees()?;

        Ok(())
    }

    pub fn initialize_v2(
        ctx: Context<InitializeV2>,
        deposit_amount: u64,
        tree_depth: u8,
    ) -> Result<()> {
        validate_tree_depth(tree_depth)?;
        validate_deposit_amount(deposit_amount)?;

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.deposit_amount = deposit_amount;
        pool.next_index = 0;
        pool.nullifier_count = 0;
        pool.bump = ctx.bumps.pool_vault;
        pool.nullifier_version = NULLIFIER_VERSION_PDA;
        pool.tree_depth = tree_depth;
        pool.token_mint = None;
        pool.root_count = 0;
        pool.roots = [[0u8; 32]; ROOT_HISTORY_SIZE];
        pool.filled_subtrees = compute_v2_zero_subtrees(tree_depth as usize)?;
        pool.commitments = Vec::new();
        pool.used_nullifiers = Vec::new();

        Ok(())
    }

    pub fn initialize_spl(
        ctx: Context<InitializeSpl>,
        deposit_amount: u64,
        token_mint: Pubkey,
    ) -> Result<()> {
        validate_deposit_amount(deposit_amount)?;
        require_keys_eq!(
            ctx.accounts.token_mint_account.key(),
            token_mint,
            PoolError::InvalidTokenMint
        );

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.deposit_amount = deposit_amount;
        pool.next_index = 0;
        pool.nullifier_count = 0;
        pool.bump = ctx.bumps.pool_vault;
        pool.nullifier_version = NULLIFIER_VERSION_PDA;
        pool.tree_depth = MAX_TREE_DEPTH as u8;
        pool.token_mint = Some(token_mint);
        pool.root_count = 0;
        pool.roots = [[0u8; 32]; ROOT_HISTORY_SIZE];
        pool.filled_subtrees = compute_v2_zero_subtrees(MAX_TREE_DEPTH)?;
        pool.commitments = Vec::new();
        pool.used_nullifiers = Vec::new();

        Ok(())
    }

    pub fn initialize_fee_v2(
        ctx: Context<InitializeFeeV2>,
        deposit_amount: u64,
        tree_depth: u8,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        validate_tree_depth(tree_depth)?;
        validate_deposit_amount(deposit_amount)?;
        validate_protocol_fee_bps(protocol_fee_bps)?;

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.treasury = ctx.accounts.treasury.key();
        pool.deposit_amount = deposit_amount;
        pool.protocol_fee_bps = protocol_fee_bps;
        pool.next_index = 0;
        pool.nullifier_count = 0;
        pool.bump = ctx.bumps.pool_vault;
        pool.nullifier_version = NULLIFIER_VERSION_PDA;
        pool.tree_depth = tree_depth;
        pool.token_mint = None;
        pool.root_count = 0;
        pool.roots = [[0u8; 32]; ROOT_HISTORY_SIZE];
        pool.filled_subtrees = compute_v2_zero_subtrees(tree_depth as usize)?;
        pool.commitments = Vec::new();
        pool.used_nullifiers = Vec::new();

        Ok(())
    }

    pub fn initialize_fee_spl(
        ctx: Context<InitializeFeeSpl>,
        deposit_amount: u64,
        token_mint: Pubkey,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        validate_deposit_amount(deposit_amount)?;
        validate_protocol_fee_bps(protocol_fee_bps)?;
        require_keys_eq!(
            ctx.accounts.token_mint_account.key(),
            token_mint,
            PoolError::InvalidTokenMint
        );

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.treasury = ctx.accounts.treasury_token_account.key();
        pool.deposit_amount = deposit_amount;
        pool.protocol_fee_bps = protocol_fee_bps;
        pool.next_index = 0;
        pool.nullifier_count = 0;
        pool.bump = ctx.bumps.pool_vault;
        pool.nullifier_version = NULLIFIER_VERSION_PDA;
        pool.tree_depth = MAX_TREE_DEPTH as u8;
        pool.token_mint = Some(token_mint);
        pool.root_count = 0;
        pool.roots = [[0u8; 32]; ROOT_HISTORY_SIZE];
        pool.filled_subtrees = compute_v2_zero_subtrees(MAX_TREE_DEPTH)?;
        pool.commitments = Vec::new();
        pool.used_nullifiers = Vec::new();

        Ok(())
    }

    pub fn update_treasury(
        ctx: Context<UpdateTreasury>,
        new_treasury: Pubkey,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let old_treasury = pool.treasury;
        pool.treasury = new_treasury;

        emit!(TreasuryUpdated {
            pool: pool.key(),
            old_treasury,
            new_treasury,
        });

        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, commitment: [u8; 32]) -> Result<()> {
        ensure_nonzero_commitment(commitment)?;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        let pool = &mut ctx.accounts.pool;
        append_legacy_commitment(pool, commitment)?;

        msg!("Deposit #{} accepted", pool.next_index);
        Ok(())
    }

    pub fn deposit_v2(
        ctx: Context<DepositV2>,
        commitment: [u8; 32],
        commitment_page_index: u32,
    ) -> Result<()> {
        ensure_nonzero_commitment(commitment)?;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(pool.token_mint.is_none(), PoolError::InvalidPoolAsset);
        append_v2_commitment(
            pool_key,
            pool,
            &mut ctx.accounts.commitment_page,
            commitment_page_index,
            commitment,
        )?;

        msg!("V2 SOL deposit #{} accepted", pool.next_index);
        Ok(())
    }

    pub fn deposit_spl(
        ctx: Context<DepositSpl>,
        commitment: [u8; 32],
        commitment_page_index: u32,
    ) -> Result<()> {
        ensure_nonzero_commitment(commitment)?;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token_account.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(pool.token_mint.is_some(), PoolError::InvalidPoolAsset);
        append_v2_commitment(
            pool_key,
            pool,
            &mut ctx.accounts.commitment_page,
            commitment_page_index,
            commitment,
        )?;

        msg!("SPL deposit #{} accepted", pool.next_index);
        Ok(())
    }

    pub fn deposit_fee_v2(
        ctx: Context<DepositFeeV2>,
        commitment: [u8; 32],
        commitment_page_index: u32,
    ) -> Result<()> {
        ensure_nonzero_commitment(commitment)?;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(pool.token_mint.is_none(), PoolError::InvalidPoolAsset);
        append_fee_v2_commitment(
            pool_key,
            pool,
            &mut ctx.accounts.commitment_page,
            commitment_page_index,
            commitment,
        )?;

        msg!("Fee-capable SOL deposit #{} accepted", pool.next_index);
        Ok(())
    }

    pub fn deposit_fee_spl(
        ctx: Context<DepositFeeSpl>,
        commitment: [u8; 32],
        commitment_page_index: u32,
    ) -> Result<()> {
        ensure_nonzero_commitment(commitment)?;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token_account.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(pool.token_mint.is_some(), PoolError::InvalidPoolAsset);
        append_fee_v2_commitment(
            pool_key,
            pool,
            &mut ctx.accounts.commitment_page,
            commitment_page_index,
            commitment,
        )?;

        msg!("Fee-capable SPL deposit #{} accepted", pool.next_index);
        Ok(())
    }

    /// DEPRECATED: Path A withdraw reveals the secret on-chain.
    /// Use withdraw_zk for privacy-preserving withdrawals.
    /// Only available when compiled with --features demo
    #[cfg(feature = "demo")]
    pub fn withdraw(
        ctx: Context<Withdraw>,
        secret: [u8; 32],
        nullifier: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        let mut preimage = [0u8; 64];
        preimage[..32].copy_from_slice(&secret);
        preimage[32..].copy_from_slice(&nullifier);
        let computed_commitment = hash(&preimage).to_bytes();

        let found = pool.commitments.iter().any(|c| *c == computed_commitment);
        require!(found, PoolError::CommitmentNotFound);

        let computed_nullifier_hash = hash(&nullifier).to_bytes();
        require!(
            nullifier_hash == computed_nullifier_hash,
            PoolError::InvalidNullifierHash
        );

        let already_used = pool.used_nullifiers.iter().any(|n| *n == nullifier_hash);
        require!(!already_used, PoolError::AlreadyWithdrawn);

        pool.used_nullifiers.push(nullifier_hash);
        pool.nullifier_count += 1;

        transfer_from_sol_vault(
            pool.key(),
            pool.bump,
            ctx.accounts.pool_vault.to_account_info(),
            ctx.accounts.recipient.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            pool.deposit_amount,
        )?;

        msg!("Withdrawal #{} processed (Path A)", pool.nullifier_count);
        Ok(())
    }

    pub fn withdraw_zk(
        ctx: Context<Withdraw>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        ensure_nonzero_public_nullifier_hash(nullifier_hash)?;
        ensure_root_known(&pool.roots, pool.root_count, root)?;
        ensure_nullifier_unused(&pool.used_nullifiers, nullifier_hash)?;

        let public_inputs: [[u8; 32]; 3] = [
            root,
            nullifier_hash,
            recipient_to_public_input(ctx.accounts.recipient.key()),
        ];
        verify_zk_proof_depth(LEGACY_TREE_DEPTH as u8, proof_a, proof_b, proof_c, public_inputs)?;

        pool.used_nullifiers.push(nullifier_hash);
        pool.nullifier_count += 1;

        transfer_from_sol_vault(
            pool.key(),
            pool.bump,
            ctx.accounts.pool_vault.to_account_info(),
            ctx.accounts.recipient.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            pool.deposit_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (Path B - legacy depth-10)",
            pool.nullifier_count
        );
        Ok(())
    }

    pub fn withdraw_zk_relayed(
        ctx: Context<WithdrawZkRelayed>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; 3],
        fee_lamports: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let root = public_inputs[0];
        let nullifier_hash = public_inputs[1];
        let recipient_input = public_inputs[2];

        ensure_nonzero_public_nullifier_hash(nullifier_hash)?;
        ensure_root_known(&pool.roots, pool.root_count, root)?;
        ensure_nullifier_unused(&pool.used_nullifiers, nullifier_hash)?;
        require!(
            recipient_input == recipient_to_public_input(ctx.accounts.recipient.key()),
            PoolError::InvalidProof
        );
        verify_zk_proof_depth(LEGACY_TREE_DEPTH as u8, proof_a, proof_b, proof_c, public_inputs)?;

        require!(fee_lamports < pool.deposit_amount, PoolError::FeeTooHigh);
        let recipient_amount = pool.deposit_amount - fee_lamports;

        pool.used_nullifiers.push(nullifier_hash);
        pool.nullifier_count += 1;

        let pool_key = pool.key();
        let pool_bump = pool.bump;
        let system_program_account = ctx.accounts.system_program.to_account_info();
        let pool_vault = ctx.accounts.pool_vault.to_account_info();

        transfer_from_sol_vault(
            pool_key,
            pool_bump,
            pool_vault.clone(),
            ctx.accounts.recipient.to_account_info(),
            system_program_account.clone(),
            recipient_amount,
        )?;

        transfer_from_sol_vault(
            pool_key,
            pool_bump,
            pool_vault,
            ctx.accounts.relayer.to_account_info(),
            system_program_account,
            fee_lamports,
        )?;

        msg!(
            "Withdrawal #{} processed (legacy relayed, fee {} lamports)",
            pool.nullifier_count,
            fee_lamports
        );
        Ok(())
    }

    pub fn withdraw_zk_v2(
        ctx: Context<WithdrawZkV2>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        verify_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        transfer_from_sol_vault(
            pool_key,
            pool_bump,
            ctx.accounts.pool_vault.to_account_info(),
            ctx.accounts.recipient.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            deposit_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (v2 SOL depth {})",
            ctx.accounts.pool.nullifier_count,
            ctx.accounts.pool.tree_depth
        );
        Ok(())
    }

    pub fn withdraw_zk_relayed_v2(
        ctx: Context<WithdrawZkRelayedV2>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        fee_lamports: u64,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        verify_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        require!(fee_lamports < deposit_amount, PoolError::FeeTooHigh);
        let recipient_amount = deposit_amount - fee_lamports;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        let system_program_account = ctx.accounts.system_program.to_account_info();
        let pool_vault = ctx.accounts.pool_vault.to_account_info();

        transfer_from_sol_vault(
            pool_key,
            pool_bump,
            pool_vault.clone(),
            ctx.accounts.recipient.to_account_info(),
            system_program_account.clone(),
            recipient_amount,
        )?;

        transfer_from_sol_vault(
            pool_key,
            pool_bump,
            pool_vault,
            ctx.accounts.relayer.to_account_info(),
            system_program_account,
            fee_lamports,
        )?;

        msg!(
            "Withdrawal #{} processed (v2 relayed SOL, fee {} lamports)",
            ctx.accounts.pool.nullifier_count,
            fee_lamports
        );
        Ok(())
    }

    pub fn withdraw_zk_spl(
        ctx: Context<WithdrawZkSpl>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        verify_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        transfer_from_token_vault(
            pool_key,
            pool_bump,
            ctx.accounts.pool_vault.to_account_info(),
            ctx.accounts.recipient_token_account.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            deposit_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (SPL depth {})",
            ctx.accounts.pool.nullifier_count,
            ctx.accounts.pool.tree_depth
        );
        Ok(())
    }

    pub fn withdraw_zk_relayed_spl(
        ctx: Context<WithdrawZkRelayedSpl>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        fee_amount: u64,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;

        verify_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        require!(fee_amount < deposit_amount, PoolError::FeeTooHigh);
        let recipient_amount = deposit_amount - fee_amount;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        let token_program = ctx.accounts.token_program.to_account_info();
        let pool_vault = ctx.accounts.pool_vault.to_account_info();

        transfer_from_token_vault(
            pool_key,
            pool_bump,
            pool_vault.clone(),
            ctx.accounts.recipient_token_account.to_account_info(),
            token_program.clone(),
            recipient_amount,
        )?;

        transfer_from_token_vault(
            pool_key,
            pool_bump,
            pool_vault,
            ctx.accounts.relayer_token_account.to_account_info(),
            token_program,
            fee_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (relayed SPL, fee {} units)",
            ctx.accounts.pool.nullifier_count,
            fee_amount
        );
        Ok(())
    }

    pub fn withdraw_zk_fee_v2(
        ctx: Context<WithdrawZkFeeV2>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;
        let protocol_fee = compute_protocol_fee(
            deposit_amount,
            ctx.accounts.pool.protocol_fee_bps,
        )?;
        let recipient_amount = compute_recipient_amount(deposit_amount, protocol_fee, 0)?;

        verify_fee_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        let system_program_account = ctx.accounts.system_program.to_account_info();
        let pool_vault = ctx.accounts.pool_vault.to_account_info();

        if protocol_fee > 0 {
            transfer_from_sol_vault(
                pool_key,
                pool_bump,
                pool_vault.clone(),
                ctx.accounts.treasury.to_account_info(),
                system_program_account.clone(),
                protocol_fee,
            )?;
        }

        transfer_from_sol_vault(
            pool_key,
            pool_bump,
            pool_vault,
            ctx.accounts.recipient.to_account_info(),
            system_program_account,
            recipient_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (fee-capable SOL, protocol fee {} lamports)",
            ctx.accounts.pool.nullifier_count,
            protocol_fee
        );
        Ok(())
    }

    pub fn withdraw_zk_relayed_fee_v2(
        ctx: Context<WithdrawZkRelayedFeeV2>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        fee_lamports: u64,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;
        let protocol_fee = compute_protocol_fee(
            deposit_amount,
            ctx.accounts.pool.protocol_fee_bps,
        )?;
        let recipient_amount =
            compute_recipient_amount(deposit_amount, protocol_fee, fee_lamports)?;

        verify_fee_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        let system_program_account = ctx.accounts.system_program.to_account_info();
        let pool_vault = ctx.accounts.pool_vault.to_account_info();

        if protocol_fee > 0 {
            transfer_from_sol_vault(
                pool_key,
                pool_bump,
                pool_vault.clone(),
                ctx.accounts.treasury.to_account_info(),
                system_program_account.clone(),
                protocol_fee,
            )?;
        }

        if fee_lamports > 0 {
            transfer_from_sol_vault(
                pool_key,
                pool_bump,
                pool_vault.clone(),
                ctx.accounts.relayer.to_account_info(),
                system_program_account.clone(),
                fee_lamports,
            )?;
        }

        transfer_from_sol_vault(
            pool_key,
            pool_bump,
            pool_vault,
            ctx.accounts.recipient.to_account_info(),
            system_program_account,
            recipient_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (fee-capable relayed SOL, protocol fee {} lamports, relayer fee {} lamports)",
            ctx.accounts.pool.nullifier_count,
            protocol_fee,
            fee_lamports
        );
        Ok(())
    }

    pub fn withdraw_zk_fee_spl(
        ctx: Context<WithdrawZkFeeSpl>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;
        let protocol_fee = compute_protocol_fee(
            deposit_amount,
            ctx.accounts.pool.protocol_fee_bps,
        )?;
        let recipient_amount = compute_recipient_amount(deposit_amount, protocol_fee, 0)?;

        verify_fee_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        let token_program = ctx.accounts.token_program.to_account_info();
        let pool_vault = ctx.accounts.pool_vault.to_account_info();

        if protocol_fee > 0 {
            transfer_from_token_vault(
                pool_key,
                pool_bump,
                pool_vault.clone(),
                ctx.accounts.treasury_token_account.to_account_info(),
                token_program.clone(),
                protocol_fee,
            )?;
        }

        transfer_from_token_vault(
            pool_key,
            pool_bump,
            pool_vault,
            ctx.accounts.recipient_token_account.to_account_info(),
            token_program,
            recipient_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (fee-capable SPL, protocol fee {} units)",
            ctx.accounts.pool.nullifier_count,
            protocol_fee
        );
        Ok(())
    }

    pub fn withdraw_zk_relayed_fee_spl(
        ctx: Context<WithdrawZkRelayedFeeSpl>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        nullifier_hash: [u8; 32],
        fee_amount: u64,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let deposit_amount = ctx.accounts.pool.deposit_amount;
        let protocol_fee = compute_protocol_fee(
            deposit_amount,
            ctx.accounts.pool.protocol_fee_bps,
        )?;
        let recipient_amount = compute_recipient_amount(deposit_amount, protocol_fee, fee_amount)?;

        verify_fee_v2_withdraw(
            &ctx.accounts.pool,
            ctx.accounts.recipient.key(),
            proof_a,
            proof_b,
            proof_c,
            root,
            nullifier_hash,
        )?;

        record_nullifier(&mut ctx.accounts.nullifier_record, pool_key, nullifier_hash)?;
        ctx.accounts.pool.nullifier_count += 1;

        let token_program = ctx.accounts.token_program.to_account_info();
        let pool_vault = ctx.accounts.pool_vault.to_account_info();

        if protocol_fee > 0 {
            transfer_from_token_vault(
                pool_key,
                pool_bump,
                pool_vault.clone(),
                ctx.accounts.treasury_token_account.to_account_info(),
                token_program.clone(),
                protocol_fee,
            )?;
        }

        if fee_amount > 0 {
            transfer_from_token_vault(
                pool_key,
                pool_bump,
                pool_vault.clone(),
                ctx.accounts.relayer_token_account.to_account_info(),
                token_program.clone(),
                fee_amount,
            )?;
        }

        transfer_from_token_vault(
            pool_key,
            pool_bump,
            pool_vault,
            ctx.accounts.recipient_token_account.to_account_info(),
            token_program,
            recipient_amount,
        )?;

        msg!(
            "Withdrawal #{} processed (fee-capable relayed SPL, protocol fee {} units, relayer fee {} units)",
            ctx.accounts.pool.nullifier_count,
            protocol_fee,
            fee_amount
        );
        Ok(())
    }
}

#[account]
pub struct Pool {
    pub authority: Pubkey,
    pub deposit_amount: u64,
    pub next_index: u32,
    pub nullifier_count: u32,
    pub bump: u8,
    pub root_count: u32,
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub filled_subtrees: [[u8; 32]; LEGACY_TREE_DEPTH],
    pub commitments: Vec<[u8; 32]>,
    pub used_nullifiers: Vec<[u8; 32]>,
}

impl Pool {
    pub fn space(num_commitments: usize, num_nullifiers: usize) -> usize {
        8 + // discriminator
        32 + // authority
        8 + // deposit_amount
        4 + // next_index
        4 + // nullifier_count
        1 + // bump
        4 + // root_count
        (ROOT_HISTORY_SIZE * 32) + // roots
        (LEGACY_TREE_DEPTH * 32) + // filled_subtrees
        4 + (num_commitments * 32) + // commitments vec
        4 + (num_nullifiers * 32) // used_nullifiers vec
    }
}

#[account]
pub struct PoolV2 {
    pub authority: Pubkey,
    pub deposit_amount: u64,
    pub next_index: u32,
    pub nullifier_count: u32,
    pub bump: u8,
    pub nullifier_version: u8,
    pub tree_depth: u8,
    pub token_mint: Option<Pubkey>,
    pub root_count: u32,
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub filled_subtrees: [[u8; 32]; MAX_TREE_DEPTH],
    pub commitments: Vec<[u8; 32]>,
    pub used_nullifiers: Vec<[u8; 32]>,
}

impl PoolV2 {
    pub fn space(num_commitments: usize, num_nullifiers: usize) -> usize {
        8 + // discriminator
        32 + // authority
        8 + // deposit_amount
        4 + // next_index
        4 + // nullifier_count
        1 + // bump
        1 + // nullifier_version
        1 + // tree_depth
        1 + 32 + // token_mint option
        4 + // root_count
        (ROOT_HISTORY_SIZE * 32) + // roots
        (MAX_TREE_DEPTH * 32) + // filled_subtrees
        4 + (num_commitments * 32) + // commitments vec
        4 + (num_nullifiers * 32) // used_nullifiers vec
    }
}

#[account]
pub struct PoolFeeV2 {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub deposit_amount: u64,
    pub protocol_fee_bps: u16,
    pub next_index: u32,
    pub nullifier_count: u32,
    pub bump: u8,
    pub nullifier_version: u8,
    pub tree_depth: u8,
    pub token_mint: Option<Pubkey>,
    pub root_count: u32,
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub filled_subtrees: [[u8; 32]; MAX_TREE_DEPTH],
    pub commitments: Vec<[u8; 32]>,
    pub used_nullifiers: Vec<[u8; 32]>,
}

impl PoolFeeV2 {
    pub fn space(num_commitments: usize, num_nullifiers: usize) -> usize {
        8 + // discriminator
        32 + // authority
        32 + // treasury
        8 + // deposit_amount
        2 + // protocol_fee_bps
        4 + // next_index
        4 + // nullifier_count
        1 + // bump
        1 + // nullifier_version
        1 + // tree_depth
        1 + 32 + // token_mint option
        4 + // root_count
        (ROOT_HISTORY_SIZE * 32) + // roots
        (MAX_TREE_DEPTH * 32) + // filled_subtrees
        4 + (num_commitments * 32) + // commitments vec
        4 + (num_nullifiers * 32) // used_nullifiers vec
    }
}

#[account]
pub struct CommitmentPage {
    pub pool: Pubkey,
    pub page_index: u32,
    pub start_offset: u16,
    pub commitment_count: u16,
    pub commitments: [[u8; 32]; COMMITMENT_PAGE_CAPACITY],
}

impl CommitmentPage {
    pub fn space() -> usize {
        8 + // discriminator
        32 + // pool
        4 + // page_index
        2 + // start_offset
        2 + // commitment_count
        (COMMITMENT_PAGE_CAPACITY * 32) // commitments
    }
}

#[account]
pub struct NullifierRecord {
    pub pool: Pubkey,
    pub nullifier: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct TreasuryUpdated {
    pub pool: Pubkey,
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = Pool::space(0, 0),
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeV2<'info> {
    #[account(
        init,
        payer = authority,
        space = PoolV2::space(0, 0),
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeSpl<'info> {
    #[account(
        init,
        payer = authority,
        space = PoolV2::space(0, 0),
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint_account,
        token::authority = pool_vault,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    pub token_mint_account: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeFeeV2<'info> {
    #[account(
        init,
        payer = authority,
        space = PoolFeeV2::space(0, 0),
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub treasury: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeFeeSpl<'info> {
    #[account(
        init,
        payer = authority,
        space = PoolFeeV2::space(0, 0),
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint_account,
        token::authority = pool_vault,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    pub token_mint_account: Box<Account<'info, Mint>>,

    #[account(
        constraint = treasury_token_account.mint == token_mint_account.key() @ PoolError::InvalidTokenMint,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        realloc = Pool::space(pool.commitments.len() + 1, pool.used_nullifiers.len()),
        realloc::payer = depositor,
        realloc::zero = false,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], commitment_page_index: u32)]
pub struct DepositV2<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_none() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = CommitmentPage::space(),
        seeds = [
            b"commitment_page",
            pool.key().as_ref(),
            &commitment_page_index.to_le_bytes(),
        ],
        bump,
    )]
    pub commitment_page: Box<Account<'info, CommitmentPage>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], commitment_page_index: u32)]
pub struct DepositSpl<'info> {
    #[account(
        mut,
        constraint = pool.token_mint == Some(depositor_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(depositor_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub depositor_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
        constraint = pool_vault.mint == depositor_token_account.mint @ PoolError::InvalidTokenMint,
        constraint = pool_vault.owner == pool_vault.key() @ PoolError::InvalidVaultAuthority,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = CommitmentPage::space(),
        seeds = [
            b"commitment_page",
            pool.key().as_ref(),
            &commitment_page_index.to_le_bytes(),
        ],
        bump,
    )]
    pub commitment_page: Box<Account<'info, CommitmentPage>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], commitment_page_index: u32)]
pub struct DepositFeeV2<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_none() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = CommitmentPage::space(),
        seeds = [
            b"commitment_page",
            pool.key().as_ref(),
            &commitment_page_index.to_le_bytes(),
        ],
        bump,
    )]
    pub commitment_page: Box<Account<'info, CommitmentPage>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], commitment_page_index: u32)]
pub struct DepositFeeSpl<'info> {
    #[account(
        mut,
        constraint = pool.token_mint == Some(depositor_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(depositor_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub depositor_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
        constraint = pool_vault.mint == depositor_token_account.mint @ PoolError::InvalidTokenMint,
        constraint = pool_vault.owner == pool_vault.key() @ PoolError::InvalidVaultAuthority,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = CommitmentPage::space(),
        seeds = [
            b"commitment_page",
            pool.key().as_ref(),
            &commitment_page_index.to_le_bytes(),
        ],
        bump,
    )]
    pub commitment_page: Box<Account<'info, CommitmentPage>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        realloc = Pool::space(pool.commitments.len(), pool.used_nullifiers.len() + 1),
        realloc::payer = payer,
        realloc::zero = false,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    /// CHECK: recipient of withdrawn SOL.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawZkRelayed<'info> {
    #[account(
        mut,
        realloc = Pool::space(pool.commitments.len(), pool.used_nullifiers.len() + 1),
        realloc::payer = relayer,
        realloc::zero = false,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    /// CHECK: Recipient is validated against the proof public input.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
)]
pub struct WithdrawZkV2<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_none() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    /// CHECK: recipient of withdrawn SOL and recipient public input target.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    fee_lamports: u64,
)]
pub struct WithdrawZkRelayedV2<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_none() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    /// CHECK: Recipient is validated against the proof public input.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init,
        payer = relayer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
)]
pub struct WithdrawZkSpl<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_some() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
        constraint = pool.token_mint == Some(pool_vault.mint) @ PoolError::InvalidTokenMint,
        constraint = pool_vault.owner == pool_vault.key() @ PoolError::InvalidVaultAuthority,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Recipient public key validated against the proof.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(recipient_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    fee_amount: u64,
)]
pub struct WithdrawZkRelayedSpl<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_some() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolV2>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
        constraint = pool.token_mint == Some(pool_vault.mint) @ PoolError::InvalidTokenMint,
        constraint = pool_vault.owner == pool_vault.key() @ PoolError::InvalidVaultAuthority,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    /// CHECK: Recipient public key validated against the proof.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(recipient_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = relayer_token_account.owner == relayer.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(relayer_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub relayer_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = relayer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
)]
pub struct WithdrawZkFeeV2<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_none() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = treasury.key() == pool.treasury @ PoolError::InvalidTreasury,
    )]
    pub treasury: SystemAccount<'info>,

    /// CHECK: recipient of withdrawn SOL and recipient public input target.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    fee_lamports: u64,
)]
pub struct WithdrawZkRelayedFeeV2<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_none() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    /// CHECK: PDA vault that holds SOL.
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        constraint = treasury.key() == pool.treasury @ PoolError::InvalidTreasury,
    )]
    pub treasury: SystemAccount<'info>,

    /// CHECK: Recipient is validated against the proof public input.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init,
        payer = relayer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
)]
pub struct WithdrawZkFeeSpl<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_some() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
        constraint = pool.token_mint == Some(pool_vault.mint) @ PoolError::InvalidTokenMint,
        constraint = pool_vault.owner == pool_vault.key() @ PoolError::InvalidVaultAuthority,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Recipient public key validated against the proof.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = treasury_token_account.key() == pool.treasury @ PoolError::InvalidTreasury,
        constraint = pool.token_mint == Some(treasury_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(recipient_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    fee_amount: u64,
)]
pub struct WithdrawZkRelayedFeeSpl<'info> {
    #[account(
        mut,
        constraint = pool.token_mint.is_some() @ PoolError::InvalidPoolAsset,
    )]
    pub pool: Box<Account<'info, PoolFeeV2>>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.bump,
        constraint = pool.token_mint == Some(pool_vault.mint) @ PoolError::InvalidTokenMint,
        constraint = pool_vault.owner == pool_vault.key() @ PoolError::InvalidVaultAuthority,
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    /// CHECK: Recipient public key validated against the proof.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = treasury_token_account.key() == pool.treasury @ PoolError::InvalidTreasury,
        constraint = pool.token_mint == Some(treasury_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(recipient_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub recipient_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = relayer_token_account.owner == relayer.key() @ PoolError::InvalidTokenOwner,
        constraint = pool.token_mint == Some(relayer_token_account.mint) @ PoolError::InvalidTokenMint,
    )]
    pub relayer_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = relayer,
        space = 8 + 32 + 32 + 8,
        seeds = [b"nullifier", pool.key().as_ref(), nullifier_hash.as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum PoolError {
    #[msg("Pool is full")]
    PoolFull,
    #[msg("Commitment not found in pool")]
    CommitmentNotFound,
    #[msg("Invalid nullifier hash")]
    InvalidNullifierHash,
    #[msg("This nullifier has already been used (double-spend attempt)")]
    AlreadyWithdrawn,
    #[msg("Insufficient funds in vault")]
    InsufficientFunds,
    #[msg("Invalid ZK proof")]
    InvalidProof,
    #[msg("Root not found in history")]
    InvalidRoot,
    #[msg("Poseidon hash computation failed")]
    PoseidonError,
    #[msg("Relayer fee must be less than the pool denomination")]
    FeeTooHigh,
    #[msg("tree_depth must be 10 or 20")]
    InvalidTreeDepth,
    #[msg("This instruction does not match the pool's asset type")]
    InvalidPoolAsset,
    #[msg("The provided SPL token mint does not match the pool")]
    InvalidTokenMint,
    #[msg("This pool uses an unsupported nullifier storage version")]
    UnsupportedNullifierVersion,
    #[msg("The provided token account owner does not match the expected authority")]
    InvalidTokenOwner,
    #[msg("The SPL vault authority must be the vault PDA itself")]
    InvalidVaultAuthority,
    #[msg("Legacy nullifier vector mode is deprecated")]
    LegacyNullifierVersion,
    #[msg("The provided commitment page does not match the next deposit slot")]
    InvalidCommitmentPage,
    #[msg("deposit_amount must be greater than zero and within the supported client range")]
    InvalidDepositAmount,
    #[msg("Commitment cannot be all zeros")]
    InvalidCommitment,
    #[msg("Notes with nullifier = 0 are not allowed")]
    ZeroNullifierNote,
    #[msg("protocol_fee_bps must be less than or equal to 500")]
    ProtocolFeeBpsTooHigh,
    #[msg("The provided treasury account does not match the pool")]
    InvalidTreasury,
    #[msg("Protocol fee plus relayer fee must be less than the pool denomination")]
    CombinedFeeTooHigh,
    #[msg("Fee calculation overflowed")]
    FeeMathOverflow,
}
