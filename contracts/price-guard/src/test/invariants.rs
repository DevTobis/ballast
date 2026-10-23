use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::Ledger;
use std::collections::BTreeMap;
use std::vec::Vec;

const SOURCE_NAMES: [&str; 4] = ["redston", "redemp", "band3", "band4"];

#[derive(Clone, Debug)]
pub enum Operation {
    PublishNav {
        value: i128,
        time_skew: i64,
    },
    PublishSource {
        source_idx: usize,
        value: i128,
        time_skew: i64,
    },
    AdvanceTime {
        seconds: u64,
    },
    ConfirmHaltCleared,
}

#[derive(Clone, Debug)]
struct ModelSource {
    value: i128,
    observed_at: u64,
}

#[derive(Clone, Debug)]
struct PriceGuardModel {
    band_bps: u32,
    daily_move_band_bps: u32,
    max_staleness_s: u64,
    current_time: u64,
    sources: BTreeMap<String, ModelSource>,
    last_good: Option<i128>,
    halted: bool,
    pending_halt_value: Option<i128>,
}

impl PriceGuardModel {
    fn new(band_bps: u32, daily_move_band_bps: u32, max_staleness_s: u64, start_time: u64) -> Self {
        Self {
            band_bps,
            daily_move_band_bps,
            max_staleness_s,
            current_time: start_time,
            sources: BTreeMap::new(),
            last_good: None,
            halted: false,
            pending_halt_value: None,
        }
    }

    fn publish_nav(&mut self, value: i128, ts: u64) {
        self.sources
            .insert("issuer".to_string(), ModelSource { value, observed_at: ts });
        self.evaluate();
    }

    fn publish_source(&mut self, name: &str, value: i128, ts: u64) {
        self.sources
            .insert(name.to_string(), ModelSource { value, observed_at: ts });
        self.evaluate();
    }

    fn advance_time(&mut self, seconds: u64) {
        self.current_time = self.current_time.saturating_add(seconds);
    }

    fn confirm_halt_cleared(&mut self) {
        if let Some(pending) = self.pending_halt_value.take() {
            self.last_good = Some(pending);
        }
        self.halted = false;
    }

    fn is_fresh(&self, s: &ModelSource) -> bool {
        s.observed_at <= self.current_time.saturating_add(MAX_FUTURE_SKEW_S)
            && self.current_time.saturating_sub(s.observed_at) <= self.max_staleness_s
    }

    fn evaluate(&mut self) -> (PriceStatus, i128, usize) {
        let mut fresh_values: Vec<i128> = Vec::new();
        for s in self.sources.values() {
            if self.is_fresh(s) {
                fresh_values.push(s.value);
            }
        }
        let fresh_count = fresh_values.len();

        if self.halted {
            return (PriceStatus::Halted, self.last_good.unwrap_or(0), fresh_count);
        }

        if fresh_values.len() < 2 {
            return (PriceStatus::Degraded, self.last_good.unwrap_or(0), fresh_count);
        }

        fresh_values.sort();
        let median = fresh_values[fresh_values.len() / 2];
        let min = *fresh_values.first().unwrap();
        let max = *fresh_values.last().unwrap();

        let within_band = if min <= 0 {
            false
        } else {
            let deviation_bps = ((max - min) * 10_000) / min;
            deviation_bps <= self.band_bps as i128
        };

        if !within_band {
            return (PriceStatus::Degraded, self.last_good.unwrap_or(0), fresh_count);
        }

        if let Some(last) = self.last_good {
            if last > 0 {
                let move_bps = ((median - last).abs() * 10_000) / last;
                if move_bps > self.daily_move_band_bps as i128 {
                    self.halted = true;
                    self.pending_halt_value = Some(median);
                    return (PriceStatus::Halted, last, fresh_count);
                }
            }
        }

        self.last_good = Some(median);
        (PriceStatus::Ok, median, fresh_count)
    }
}

fn operation_strategy(max_staleness_s: u64) -> impl Strategy<Value = Operation> {
    prop_oneof![
        // 40% PublishSource
        4 => (
            0..4usize,
            1i128..=(SCALE * 5),
            -(max_staleness_s as i64 * 2)..=(MAX_FUTURE_SKEW_S as i64)
        ).prop_map(|(source_idx, value, time_skew)| Operation::PublishSource {
            source_idx,
            value,
            time_skew,
        }),
        // 35% PublishNav
        4 => (
            1i128..=(SCALE * 5),
            -(max_staleness_s as i64 * 2)..=(MAX_FUTURE_SKEW_S as i64)
        ).prop_map(|(value, time_skew)| Operation::PublishNav {
            value,
            time_skew,
        }),
        // 15% AdvanceTime
        2 => (0u64..=(max_staleness_s * 2)).prop_map(|seconds| Operation::AdvanceTime { seconds }),
        // 10% ConfirmHaltCleared
        1 => Just(Operation::ConfirmHaltCleared),
    ]
}

fn execute_and_assert_invariants(
    operations: &[Operation],
    band_bps: u32,
    daily_move_band_bps: u32,
    max_staleness_s: u64,
) {
    // The reference model has no rolling window, so the window band is disabled here (u32::MAX);
    // the window check has its own scenario tests.
    let (env, client, _admin, publisher, risk, asset) = setup_with_admin_and_window(
        band_bps,
        daily_move_band_bps,
        DEFAULT_WINDOW_SECONDS,
        u32::MAX,
        max_staleness_s,
    );
    let start_time = 10_000u64;
    env.ledger().with_mut(|l| l.timestamp = start_time);

    let mut model = PriceGuardModel::new(band_bps, daily_move_band_bps, max_staleness_s, start_time);
    let code = asset_code(&env);
    let sig = BytesN::from_array(&env, &[0u8; 64]);

    let mut prev_status: Option<PriceStatus> = None;

    for (step_idx, op) in operations.iter().enumerate() {
        let was_halted = prev_status == Some(PriceStatus::Halted);

        // Invariant 5: the contract never panics for valid inputs
        match op {
            Operation::PublishNav { value, time_skew } => {
                let now = env.ledger().timestamp();
                let ts = ((now as i64) + time_skew).clamp(1, (now + MAX_FUTURE_SKEW_S) as i64) as u64;
                client.publish_nav(&publisher, &asset, &code, value, &ts, &sig);
                model.publish_nav(*value, ts);
            }
            Operation::PublishSource { source_idx, value, time_skew } => {
                let now = env.ledger().timestamp();
                let ts = ((now as i64) + time_skew).clamp(1, (now + MAX_FUTURE_SKEW_S) as i64) as u64;
                let name_str = SOURCE_NAMES[*source_idx % SOURCE_NAMES.len()];
                let sym = Symbol::new(&env, name_str);
                client.publish_source(&publisher, &asset, &sym, value, &ts);
                model.publish_source(name_str, *value, ts);
            }
            Operation::AdvanceTime { seconds } => {
                let now = env.ledger().timestamp();
                env.ledger().with_mut(|l| l.timestamp = now.saturating_add(*seconds));
                model.advance_time(*seconds);
            }
            Operation::ConfirmHaltCleared => {
                client.confirm_halt_cleared(&risk, &asset);
                model.confirm_halt_cleared();
            }
        }

        let guarded = client.guarded_price(&asset);
        let (expected_status, expected_value, expected_fresh_count) = model.evaluate();

        // Cross-check against the plain-Rust reference model
        assert_eq!(
            guarded.status, expected_status,
            "Step {}: status mismatch with reference model", step_idx
        );
        assert_eq!(
            guarded.value, expected_value,
            "Step {}: value mismatch with reference model", step_idx
        );
        assert_eq!(
            guarded.sources.len() as usize, expected_fresh_count,
            "Step {}: fresh sources count mismatch with reference model", step_idx
        );

        // Invariant 1: status Ok implies at least two fresh sources
        if guarded.status == PriceStatus::Ok {
            assert!(
                guarded.sources.len() >= 2,
                "Invariant 1 violated at step {}: status is Ok with {} fresh sources (< 2)",
                step_idx,
                guarded.sources.len()
            );
        }

        // Invariant 2: Ok implies the fresh sources are within band_bps
        if guarded.status == PriceStatus::Ok {
            assert!(
                guarded.sources.len() >= 2,
                "Invariant 2 violated at step {}: Ok status must have >= 2 sources",
                step_idx
            );
            let mut vals: Vec<i128> = Vec::new();
            for s in guarded.sources.iter() {
                vals.push(s.value);
            }
            let min_val = *vals.iter().min().unwrap();
            let max_val = *vals.iter().max().unwrap();
            assert!(
                min_val > 0,
                "Invariant 2 violated at step {}: min fresh source value <= 0",
                step_idx
            );
            let dev_bps = ((max_val - min_val) * 10_000) / min_val;
            assert!(
                dev_bps <= band_bps as i128,
                "Invariant 2 violated at step {}: deviation {} bps exceeds band_bps {}",
                step_idx,
                dev_bps,
                band_bps
            );
        }

        // Invariant 3: once Halted, status stays Halted until confirm_halt_cleared
        if was_halted && !matches!(op, Operation::ConfirmHaltCleared) {
            assert_eq!(
                guarded.status,
                PriceStatus::Halted,
                "Invariant 3 violated at step {}: contract escaped Halted without confirm_halt_cleared (saw {:?})",
                step_idx,
                guarded.status
            );
        }

        // Invariant 4: value under Degraded or Halted equals the last Ok/good value
        if guarded.status == PriceStatus::Degraded || guarded.status == PriceStatus::Halted {
            assert_eq!(
                guarded.value,
                model.last_good.unwrap_or(0),
                "Invariant 4 violated at step {}: value under {:?} ({}) does not equal expected last good value ({})",
                step_idx,
                guarded.status,
                guarded.value,
                model.last_good.unwrap_or(0)
            );
        }

        prev_status = Some(guarded.status);
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        // Each case replays up to 30 operations on a fresh contract; 10 cases per config keeps the
        // three properties under the 30s CI budget (50 took about 65s once events and TTL calls landed).
        cases: 10,
        max_shrink_iters: 1000,
        ..ProptestConfig::default()
    })]

    #[test]
    fn test_price_guard_invariants_fuzz_standard_config(
        ops in proptest::collection::vec(operation_strategy(3600), 1..=30)
    ) {
        execute_and_assert_invariants(&ops, 50, 100, 3600);
    }

    #[test]
    fn test_price_guard_invariants_fuzz_wide_bands(
        ops in proptest::collection::vec(operation_strategy(1800), 1..=30)
    ) {
        execute_and_assert_invariants(&ops, 200, 500, 1800);
    }

    #[test]
    fn test_price_guard_invariants_fuzz_tight_bands(
        ops in proptest::collection::vec(operation_strategy(600), 1..=30)
    ) {
        execute_and_assert_invariants(&ops, 10, 20, 600);
    }
}

// -----------------------------------------------------------------------------
// Named regression tests covering specific counterexample and boundary patterns
// -----------------------------------------------------------------------------

#[test]
fn regression_invariant_1_single_source_cannot_be_ok() {
    let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
    let code = asset_code(&env);
    let sig = BytesN::from_array(&env, &[0u8; 64]);
    let now = env.ledger().timestamp();

    client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    let price = client.guarded_price(&asset);
    assert_ne!(price.status, PriceStatus::Ok);
    assert_eq!(price.status, PriceStatus::Degraded);
}

#[test]
fn regression_invariant_2_out_of_band_sources_cannot_be_ok() {
    let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
    let code = asset_code(&env);
    let sig = BytesN::from_array(&env, &[0u8; 64]);
    let now = env.ledger().timestamp();

    client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    let redstone = Symbol::new(&env, "redston");
    // 60 bps deviation > 50 bps band
    let out_of_band = SCALE + (SCALE * 60 / 10_000);
    client.publish_source(&publisher, &asset, &redstone, &out_of_band, &now);

    let price = client.guarded_price(&asset);
    assert_eq!(price.status, PriceStatus::Degraded);
}

#[test]
fn regression_invariant_3_halt_persists_across_valid_and_time_updates() {
    let (env, client, publisher, risk, asset) = setup(50, 100, 3600);
    let code = asset_code(&env);
    let sig = BytesN::from_array(&env, &[0u8; 64]);
    let now = env.ledger().timestamp();
    let redstone = Symbol::new(&env, "redston");

    // Establish initial Ok
    client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    client.publish_source(&publisher, &asset, &redstone, &SCALE, &now);
    assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

    // Trigger halt with +5% move
    let jumped = SCALE * 105 / 100;
    client.publish_nav(&publisher, &asset, &code, &jumped, &now, &sig);
    client.publish_source(&publisher, &asset, &redstone, &jumped, &now);
    assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);

    // Advancing time and publishing fresh matching values at the jumped price: must still remain Halted
    env.ledger().with_mut(|l| l.timestamp = now + 500);
    let later = env.ledger().timestamp();
    client.publish_nav(&publisher, &asset, &code, &jumped, &later, &sig);
    client.publish_source(&publisher, &asset, &redstone, &jumped, &later);
    assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);

    // Only confirm_halt_cleared unlatches the halt; promoting jumped to LastGood
    client.confirm_halt_cleared(&risk, &asset);
    let cleared = client.guarded_price(&asset);
    assert_eq!(cleared.status, PriceStatus::Ok);
    assert_eq!(cleared.value, jumped);
}


#[test]
fn regression_invariant_4_degraded_and_halted_preserve_last_ok_value() {
    let (env, client, publisher, _risk, asset) = setup(50, 100, 3600);
    let code = asset_code(&env);
    let sig = BytesN::from_array(&env, &[0u8; 64]);
    let now = env.ledger().timestamp();
    let redstone = Symbol::new(&env, "redston");

    // Initial state: no Ok value yet -> value must be 0
    let initial = client.guarded_price(&asset);
    assert_eq!(initial.status, PriceStatus::Degraded);
    assert_eq!(initial.value, 0);

    // Establish first Ok value
    client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    client.publish_source(&publisher, &asset, &redstone, &SCALE, &now);
    let ok_price = client.guarded_price(&asset);
    assert_eq!(ok_price.status, PriceStatus::Ok);
    assert_eq!(ok_price.value, SCALE);

    // Disagreeing source causes Degraded -> value must stay at SCALE
    client.publish_source(&publisher, &asset, &redstone, &(SCALE * 2), &now);
    let degraded = client.guarded_price(&asset);
    assert_eq!(degraded.status, PriceStatus::Degraded);
    assert_eq!(degraded.value, SCALE);

    // Agreeing huge jump causes Halted -> value must stay at SCALE
    let jumped = SCALE * 120 / 100;
    client.publish_nav(&publisher, &asset, &code, &jumped, &now, &sig);
    client.publish_source(&publisher, &asset, &redstone, &jumped, &now);
    let halted = client.guarded_price(&asset);
    assert_eq!(halted.status, PriceStatus::Halted);
    assert_eq!(halted.value, SCALE);
}

#[test]
fn regression_invariant_5_rapid_publish_and_time_advance_sequence() {
    // 30 operations sequence exercising random alternating publishes, staleness, and halts
    let ops = vec![
        Operation::PublishNav { value: SCALE, time_skew: 0 },
        Operation::PublishSource { source_idx: 0, value: SCALE, time_skew: 0 },
        Operation::AdvanceTime { seconds: 100 },
        Operation::PublishSource { source_idx: 1, value: SCALE + 10, time_skew: 0 },
        Operation::PublishNav { value: SCALE + 20, time_skew: 0 },
        Operation::AdvanceTime { seconds: 3500 }, // approaches staleness
        Operation::PublishSource { source_idx: 0, value: SCALE + 25, time_skew: 0 },
        Operation::PublishNav { value: SCALE * 2, time_skew: 0 }, // huge jump
        Operation::PublishSource { source_idx: 0, value: SCALE * 2, time_skew: 0 }, // halt
        Operation::AdvanceTime { seconds: 100 },
        Operation::PublishSource { source_idx: 2, value: SCALE * 2, time_skew: 0 },
        Operation::ConfirmHaltCleared,
        Operation::AdvanceTime { seconds: 50 },
        Operation::PublishNav { value: SCALE * 2, time_skew: 0 },
        Operation::PublishSource { source_idx: 0, value: SCALE * 2, time_skew: 0 },
    ];
    execute_and_assert_invariants(&ops, 50, 100, 3600);
}

#[test]
fn regression_halt_clear_with_divergent_sources_rehalts() {
    let (env, client, publisher, risk, asset) = setup(50, 100, 3600);
    let code = asset_code(&env);
    let sig = BytesN::from_array(&env, &[0u8; 64]);
    let now = env.ledger().timestamp();
    let redstone = Symbol::new(&env, "redston");

    // Initial Ok
    client.publish_nav(&publisher, &asset, &code, &SCALE, &now, &sig);
    client.publish_source(&publisher, &asset, &redstone, &SCALE, &now);
    assert_eq!(client.guarded_price(&asset).status, PriceStatus::Ok);

    // Jump by +5% triggers halt, storing jumped as PendingHaltValue
    let jumped = SCALE * 105 / 100;
    client.publish_nav(&publisher, &asset, &code, &jumped, &now, &sig);
    client.publish_source(&publisher, &asset, &redstone, &jumped, &now);
    assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);

    // While halted, sources are republished at original SCALE
    env.ledger().with_mut(|l| l.timestamp = now + 100);
    let later = env.ledger().timestamp();
    client.publish_nav(&publisher, &asset, &code, &SCALE, &later, &sig);
    client.publish_source(&publisher, &asset, &redstone, &SCALE, &later);
    assert_eq!(client.guarded_price(&asset).status, PriceStatus::Halted);

    // Human clears the halt, promoting `jumped` to LastGood.
    // The current sources at `SCALE` move 5% away from new LastGood `jumped`, immediately re-halting.
    client.confirm_halt_cleared(&risk, &asset);
    let price = client.guarded_price(&asset);
    assert_eq!(price.status, PriceStatus::Halted);
    assert_eq!(price.value, jumped);
}

