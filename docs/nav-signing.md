# NAV Signing Format & Operator Key Runbook

This guide specifies the exact canonical message grammar, Ed25519 key encodings, test vectors, and operational steps for `PriceGuard::publish_nav` and `services/price-guard`.

---

## 1. Who Actually Signs (`price_publisher` Is the Attestor, Not the Issuer)

As documented in `contracts/AUDIT_NOTES.md`:

> **NAV signatures are signed by the publisher, not the issuer.** Neither Etherfuse (Horizon `orderbook`) nor Spiko (`api.spiko.tech`) returns an Ed25519 signature over its NAV, so the off-chain publisher fetches the quote over HTTPS and signs `{asset_code}:{ts}:{value}` with its own key (`scripts/sign-nav.mjs`, `services/price-guard/src/navAttestor.ts`), and `configure-nav-key.sh` registers the publisher's public key on-chain. That proves the `price_publisher` key attested to those bytes and catches corrupted calldata; it does **not** give you a cryptographic chain back to the issuer. A compromised publisher key can sign any NAV within the move bands.

---

## 2. Canonical Message Grammar

`PriceGuard::build_nav_message` (`contracts/price-guard/src/lib.rs`) and `canonicalNavMessage` (`services/price-guard/src/navSignature.ts`) construct the exact UTF-8 byte sequence:

```text
<asset_code>:<ts>:<value>
```

- `<asset_code>`: Raw UTF-8 bytes of the asset ticker (e.g., `SPIKO`, `CETES28`, `RWA1`). Must be non-empty and must **not** contain `:`.
- `<ts>`: Unsigned base-10 ASCII decimal representation of the `u64` UNIX timestamp in seconds (no leading `+`, no leading zeroes except `0` itself, no decimal point).
- `<value>`: Signed base-10 ASCII decimal representation of the `i128` fixed-point price scaled by `1e7` (`PRICE_SCALE = 10_000_000`; e.g., `$1.0234567` is `10234567`).
- Separator: Single ASCII colon (`0x3a`, `:`) between `<asset_code>` and `<ts>`, and between `<ts>` and `<value>`. No trailing newline or null terminator.

The Ed25519 signature (`BytesN<64>`) is computed directly over these raw UTF-8 message bytes using standard RFC 8032 Ed25519 (`ed25519_verify` in Soroban, `crypto.sign(null, msg, key)` in Node.js).

---

## 3. Verified Test Vectors

Both Rust (`contracts/price-guard/src/lib.rs::test::build_nav_message_matches_golden_vectors`) and TypeScript (`services/price-guard/src/navSignature.test.ts` via `services/price-guard/src/__fixtures__/nav-message-vectors.json`) assert these two vectors against the deterministic test keypair derived from the 32-byte seed `[0x09; 32]`:

- **Seed (32-byte hex):** `0909090909090909090909090909090909090909090909090909090909090909`
- **Stellar Secret (`S...`):** `SAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTDMN`
- **Raw 32-byte Ed25519 Public Key (hex):** `fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618`
- **Raw 32-byte Ed25519 Public Key (base64):** `/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=`
- **Stellar Public Key (`G...`):** `GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL`

### Vector 1 — Standard NAV Reading (`SPIKO`)

| Field | Value |
|---|---|
| `asset_code` | `"SPIKO"` (`5350494b4f`) |
| `ts` | `1700000000` |
| `value` | `10234567` (`$1.0234567` at `1e7` scale) |
| Canonical UTF-8 string | `SPIKO:1700000000:10234567` |
| Message bytes (hex) | `5350494b4f3a313730303030303030303a3130323334353637` |
| Ed25519 signature (64-byte hex) | `234bd254088c736541fe363aa4d7163004ece797b6dfc6d58d3e796987cfc20501ae42a42e9db5d1a026294b755e3c98943fdce037cff1bacfd578e749a7ba0e` |

### Vector 2 — Upper-Bound `i128::MAX` Reading (`CETES28`)

| Field | Value |
|---|---|
| `asset_code` | `"CETES28"` (`43455445533238`) |
| `ts` | `4102444800` |
| `value` | `170141183460469231731687303715884105727` (`i128::MAX`) |
| Canonical UTF-8 string | `CETES28:4102444800:170141183460469231731687303715884105727` |
| Message bytes (hex) | `434554455332383a343130323434343830303a313730313431313833343630343639323331373331363837333033373135383834313035373237` |
| Ed25519 signature (64-byte hex) | `8d3d74080eedf829ec37883108d114c7430729a98d904561c05f1c09280c5ace0632377afafe85061421bee92cc6de6bf6e4cacf2b82aef39d4a2333d8294c0c` |

---

## 4. Deriving the 32-Byte Ed25519 Key from a Stellar `G...` Public Key

A Stellar `G...` account address is a base32-encoded 35-byte StrKey payload:
- Byte `0`: version byte (`0x30` = `6 << 3` for Ed25519 public key)
- Bytes `1..33`: the raw 32-byte Ed25519 public key (`BytesN<32>`)
- Bytes `33..35`: little-endian CRC16-XModem checksum

To extract the raw 32-byte hex or base64 key from any `G...` address (same conversion used in `scripts/configure-nav-key.sh`):

```bash
# Convert a Stellar G... address to 32-byte hex (for stellar contract invoke --issuer_pubkey)
python3 -c 'import base64, sys; raw = base64.b32decode(sys.argv[1])[1:33]; print(raw.hex())' \
  GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL
# -> fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618

# Convert a Stellar G... address to 32-byte base64 (for services/price-guard issuerPublicKeys config)
python3 -c 'import base64, sys; raw = base64.b32decode(sys.argv[1])[1:33]; print(base64.b64encode(raw).decode())' \
  GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL
# -> /RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=
```

---

## 5. Operational Runbook: Registering a Key and Enabling `configure_signature_requirement`

1. **Derive the publisher's raw 32-byte Ed25519 public key:**
   ```bash
   PUBLISHER_G=$(stellar keys address price_publisher)
   PUBLISHER_PUBKEY_HEX=$(python3 -c 'import base64, sys; print(base64.b32decode(sys.argv[1])[1:33].hex())' "$PUBLISHER_G")
   ```
2. **Register the key for each configured asset (`configure_issuer_key`):**
   - Initial registration for an asset applies immediately.
   - Rotating an already-registered key requires queuing `ConfigChange::IssuerPubKey(asset, new_key)` via `queue_config` and executing after the 48-hour timelock.
   ```bash
   stellar contract invoke --id "$PRICE_GUARD_CID" --source admin --network "$NETWORK" -- \
     configure_issuer_key --admin "$ADMIN" --asset "$RWA_SAC" --issuer_pubkey "$PUBLISHER_PUBKEY_HEX"
   ```
3. **Enable signature verification (`configure_signature_requirement`):**
   - Tightening (`--required true`) takes effect immediately with no timelock.
   - Loosening (`--required false`) requires the 48-hour `queue_config` timelock once `RequireNavSignature` has been set.
   ```bash
   stellar contract invoke --id "$PRICE_GUARD_CID" --source admin --network "$NETWORK" -- \
     configure_signature_requirement --admin "$ADMIN" --required true
   ```
   Or run `scripts/configure-nav-key.sh` after sourcing `scripts/.deployed.env`, which performs steps 1–3 and verifies with a live signed `publish_nav` call.
