# `credit-line`

`CreditLine` manages lender commitments, borrower draws, repayments, interest accrual, LTV checks, margin transitions, and liquidation booking for Ballast credit lines.

## Emitted Events

All contract events use `env.events().publish` with a `(symbol, id)` or `(symbol,)` topic tuple:

| Topic 0 | Remaining Topics | Data Payload | Emitted By |
| --- | --- | --- | --- |
| `liquidation_started` | `line: u64` | `(route: LiquidationRoute, units: i128, price: i128, debt: i128)` | `liquidate` |
| `line_closed` | `line: u64` | `(debt: i128, recovered: i128, surplus: i128, shortfall: i128)` | `close_liquidated` |
