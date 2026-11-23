use soroban_sdk::contracterror;

/// Shared error codes across Ballast smart contracts.
///
/// These numeric codes form part of the contract ABI and are returned
/// in trapped invocations so operators, client SDKs, and APIs can inspect
/// why an invocation failed without relying on string panic messages.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract or module has not been initialized.
    NotInitialized = 1,
    /// Contract or module has already been initialized.
    AlreadyInitialized = 2,
    /// Requested operation or scope is paused.
    Paused = 3,
    /// Required timelock delay has not elapsed.
    TimelockNotElapsed = 4,
    /// Requested entity, proposal, or entry was not found.
    NotFound = 5,
    /// Input parameters are invalid or out of allowed bounds.
    InvalidInput = 6,
    /// Caller is not authorized to perform this operation.
    Unauthorized = 7,
}
