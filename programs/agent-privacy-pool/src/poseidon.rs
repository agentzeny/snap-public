#[cfg(not(target_os = "solana"))]
use ark_bn254::Fr;
#[cfg(not(target_os = "solana"))]
use light_poseidon::{Poseidon, PoseidonBytesHasher, PoseidonError as LightPoseidonError};

pub const HASH_BYTES: usize = 32;

#[derive(Clone, Copy)]
#[repr(u64)]
pub enum Parameters {
    Bn254X5 = 0,
}

#[derive(Clone, Copy)]
#[repr(u64)]
pub enum Endianness {
    BigEndian = 0,
    LittleEndian = 1,
}

#[derive(Debug)]
pub enum PoseidonError {
    Unexpected,
    InvalidNumberOfInputs,
    EmptyInput,
    InvalidInputLength,
    BytesToPrimeFieldElement,
    InputLargerThanModulus,
    VecToArray,
    U64Tou8,
    BytesToBigInt,
    InvalidWidthCircom,
}

#[repr(transparent)]
pub struct PoseidonHash([u8; HASH_BYTES]);

impl PoseidonHash {
    pub fn to_bytes(&self) -> [u8; HASH_BYTES] {
        self.0
    }
}

#[cfg(not(target_os = "solana"))]
pub fn hashv(
    _parameters: Parameters,
    endianness: Endianness,
    vals: &[&[u8]],
) -> Result<PoseidonHash, PoseidonError> {
    let mut hasher = Poseidon::<Fr>::new_circom(vals.len()).map_err(map_poseidon_error)?;
    let result = match endianness {
        Endianness::BigEndian => hasher.hash_bytes_be(vals),
        Endianness::LittleEndian => hasher.hash_bytes_le(vals),
    }
    .map_err(map_poseidon_error)?;

    Ok(PoseidonHash(result))
}

#[cfg(target_os = "solana")]
pub fn hashv(
    parameters: Parameters,
    endianness: Endianness,
    vals: &[&[u8]],
) -> Result<PoseidonHash, PoseidonError> {
    let mut hash_result = [0u8; HASH_BYTES];
    let result = unsafe {
        sol_poseidon(
            parameters as u64,
            endianness as u64,
            vals as *const _ as *const u8,
            vals.len() as u64,
            hash_result.as_mut_ptr(),
        )
    };

    match result {
        0 => Ok(PoseidonHash(hash_result)),
        _ => Err(PoseidonError::Unexpected),
    }
}

#[cfg(not(target_feature = "static-syscalls"))]
#[cfg(target_os = "solana")]
extern "C" {
    fn sol_poseidon(
        parameters: u64,
        endianness: u64,
        vals: *const u8,
        val_len: u64,
        hash_result: *mut u8,
    ) -> u64;
}

#[cfg(target_feature = "static-syscalls")]
#[cfg(target_os = "solana")]
#[inline]
unsafe fn sol_poseidon(
    parameters: u64,
    endianness: u64,
    vals: *const u8,
    val_len: u64,
    hash_result: *mut u8,
) -> u64 {
    #[repr(usize)]
    enum Syscall {
        Code = sys_hash("sol_poseidon"),
    }

    let syscall: extern "C" fn(u64, u64, *const u8, u64, *mut u8) -> u64 =
        core::mem::transmute(Syscall::Code);
    syscall(parameters, endianness, vals, val_len, hash_result)
}

#[cfg(target_feature = "static-syscalls")]
#[cfg(target_os = "solana")]
const fn sys_hash(name: &str) -> usize {
    murmur3_32(name.as_bytes(), 0) as usize
}

#[cfg(target_feature = "static-syscalls")]
#[cfg(target_os = "solana")]
const fn murmur3_32(buf: &[u8], seed: u32) -> u32 {
    const fn pre_mix(buf: [u8; 4]) -> u32 {
        u32::from_le_bytes(buf)
            .wrapping_mul(0xcc9e2d51)
            .rotate_left(15)
            .wrapping_mul(0x1b873593)
    }

    let mut hash = seed;
    let mut i = 0;

    while i < buf.len() / 4 {
        let block = [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]];
        hash ^= pre_mix(block);
        hash = hash.rotate_left(13);
        hash = hash.wrapping_mul(5).wrapping_add(0xe6546b64);
        i += 1;
    }

    match buf.len() % 4 {
        0 => {}
        1 => hash ^= pre_mix([buf[i * 4], 0, 0, 0]),
        2 => hash ^= pre_mix([buf[i * 4], buf[i * 4 + 1], 0, 0]),
        3 => hash ^= pre_mix([buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], 0]),
        _ => {}
    }

    hash ^= buf.len() as u32;
    hash ^= hash.wrapping_shr(16);
    hash = hash.wrapping_mul(0x85ebca6b);
    hash ^= hash.wrapping_shr(13);
    hash = hash.wrapping_mul(0xc2b2ae35);
    hash ^= hash.wrapping_shr(16);
    hash
}

#[cfg(not(target_os = "solana"))]
fn map_poseidon_error(error: LightPoseidonError) -> PoseidonError {
    match error {
        LightPoseidonError::InvalidNumberOfInputs { .. } => PoseidonError::InvalidNumberOfInputs,
        LightPoseidonError::EmptyInput => PoseidonError::EmptyInput,
        LightPoseidonError::InvalidInputLength { .. } => PoseidonError::InvalidInputLength,
        LightPoseidonError::BytesToPrimeFieldElement { .. } => {
            PoseidonError::BytesToPrimeFieldElement
        }
        LightPoseidonError::InputLargerThanModulus => PoseidonError::InputLargerThanModulus,
        LightPoseidonError::VecToArray => PoseidonError::VecToArray,
        LightPoseidonError::U64Tou8 => PoseidonError::U64Tou8,
        LightPoseidonError::BytesToBigInt => PoseidonError::BytesToBigInt,
        LightPoseidonError::InvalidWidthCircom { .. } => PoseidonError::InvalidWidthCircom,
    }
}
