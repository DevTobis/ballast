//! Shared numeric error codes (`#[contracterror]`) for Ballast Soroban contracts.

use soroban_sdk::contracterror;

/// Shared contract error codes across Ballast Soroban contracts.
///
/// Using `#[contracterror]` with `panic_with_error!(env, Error::...)` ensures callers,
/// off-chain services (`services/margin-monitor`, `services/indexer`), and `try_*` test
/// clients receive a stable, typed XDR error code (`ScErrorType::Contract`) rather than
/// a generic host trap on stripped mainnet builds.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Contract roles or state have not been initialized yet (`initialize` not called).
    NotInitialized = 1,
    /// Contract has already been initialized (`initialize` called more than once).
    AlreadyInitialized = 2,
    /// The requested operation is blocked because its `PauseScope` (or `PauseScope::All`) is paused.
    Paused = 3,
    /// A queued timelocked change or unpause was invoked before its `executes_at` timestamp.
    TimelockNotElapsed = 4,
    /// The requested asset, position, trade, or pending timelock entry does not exist.
    NotFound = 5,
    /// An input argument failed validation (e.g., non-positive amount, out-of-range bps, or invalid status).
    InvalidInput = 6,
    /// The caller is not authorized to perform this action (e.g., neither admin nor keeper).
    Unauthorized = 7,
    /// Arithmetic overflow occurred while computing interest, collateral value, or LTV.
    Overflow = 8,
}
