# NAV Signing Format & Operator Key Encoding

This document describes the canonical message grammar, key derivation, test vectors, and operational procedures for NAV signature verification in `PriceGuard`.

## Who Signs the NAV

> [!IMPORTANT]
> NAV is signed by the **price publisher's** key (`configure_issuer_key` registers it), because issuers publish unsigned data.
>
> As documented in [contracts/AUDIT_NOTES.md](../contracts/AUDIT_NOTES.md), the attestor key is the same key that is authorised to publish. On-chain the signature adds no protection against a compromised publisher: it records who relayed the value. **Do not describe it as issuer attestation.**

---

## Canonical Message Grammar

The canonical NAV message is constructed identically on-chain (`contracts/price-guard/src/lib.rs:build_nav_message`) and off-chain (`services/price-guard/src/navSignature.ts:canonicalNavMessage`):

```text
{asset_code}:{ts}:{value}
```

- `{asset_code}`: The asset ticker symbol (raw UTF-8 bytes, e.g. `"SPIKO"` or `"CETES28"`).
- `:`: ASCII colon delimiter (`0x3a`).
- `{ts}`: The Unix epoch timestamp in seconds, represented as an unsigned integer in decimal ASCII (e.g. `1700000000`).
- `:`: ASCII colon delimiter (`0x3a`).
- `{value}`: The NAV price in 7 decimal fixed-point units ($10^7$ scale), represented as a signed integer in decimal ASCII with no decimal point (e.g. `10234567` for $1.0234567$, or `170141183460469231731687303715884105727` for $2^{127} - 1$).

---

## Key Encoding & Conversion Command

Stellar account addresses (`G...`) are base32-encoded StrKey strings (RFC 4648) comprising:
- 1 version byte (`0x30`, denoting an Ed25519 public key)
- 32 bytes of raw Ed25519 public key
- 2 bytes of CRC16 checksum

`PriceGuard.configure_issuer_key` takes a `BytesN<32>` containing the raw 32-byte public key. To convert a Stellar `G...` address into the 64-character hex string expected by the contract CLI:

```bash
PUBLISHER_KEY_HEX=$(python3 -c 'import base64,sys; print(base64.b32decode(sys.argv[1])[1:33].hex())' "$PRICE_PUBLISHER")
```

This slices bytes `1..33` from the decoded base32 buffer, discarding the version byte and checksum.

---

## Verified Golden Test Vectors

The following vectors are verified against both the Rust contract crypto (`env.crypto().ed25519_verify`) and the TypeScript verifier (`services/price-guard/src/navSignature.ts:verifyNavSignature`).

### Test Keypair
- **Deterministic Seed**: `0x09` repeated 32 times (`[9u8; 32]`)
- **Stellar Address (`G...`)**: `GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL`
- **Raw Public Key (Hex)**: `fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618`
- **Raw Public Key (Base64)**: `/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=`

### Vector 1: SPIKO Standard NAV
- **Asset Code**: `SPIKO`
- **Timestamp (`ts`)**: `1700000000`
- **Value**: `10234567` ($1.0234567$)
- **Canonical Message**: `SPIKO:1700000000:10234567`
- **Message Bytes (Hex)**: `5350494b4f3a313730303030303030303a3130323334353637`
- **Detached Signature (Hex)**:
  ```text
  234bd254088c736541fe363aa4d7163004ece797b6dfc6d58d3e796987cfc20501ae42a42e9db5d1a026294b755e3c98943fdce037cff1bacfd578e749a7ba0e
  ```

### Vector 2: CETES28 High-Value NAV
- **Asset Code**: `CETES28`
- **Timestamp (`ts`)**: `4102444800`
- **Value**: `170141183460469231731687303715884105727` (`i128::MAX`)
- **Canonical Message**: `CETES28:4102444800:170141183460469231731687303715884105727`
- **Message Bytes (Hex)**: `434554455332383a343130323434343830303a313730313431313833343630343639323331373331363837333033373135383834313035373237`
- **Detached Signature (Hex)**:
  ```text
  8d3d74080eedf829ec37883108d114c7430729a98d904561c05f1c09280c5ace0632377afafe85061421bee92cc6de6bf6e4cacf2b82aef39d4a2333d8294c0c
  ```

---

## Operational Steps: Register Key & Enforce Signatures

To bring a new deployment or asset online with signature checking:

### 1. Derive the Hex Key
```bash
PUBLISHER_KEY_HEX=$(python3 -c 'import base64,sys; print(base64.b32decode(sys.argv[1])[1:33].hex())' "$PRICE_PUBLISHER")
```

### 2. Register the Attestor Key (Admin only)
```bash
stellar contract invoke \
  --id "$PRICE_GUARD_CID" \
  --source admin \
  --network "$NETWORK" \
  -- configure_issuer_key \
  --admin "$ADMIN" \
  --asset "$RWA_SAC" \
  --issuer_pubkey "$PUBLISHER_KEY_HEX"
```

### 3. Require NAV Signatures (Admin only)
The requirement is per asset (#95) and defaults to `true` for an asset that was never configured.
Enabling it takes effect immediately; turning it off once the asset has accepted a reading goes
through `queue_config` and the 48h timelock:
```bash
stellar contract invoke \
  --id "$PRICE_GUARD_CID" \
  --source admin \
  --network "$NETWORK" \
  -- configure_signature_requirement \
  --admin "$ADMIN" \
  --asset "$RWA_SAC" \
  --required true
```

### 4. Publishing NAV
The publisher signs the canonical message using `scripts/sign-nav.mjs` and submits.

`asset_code` is a `Bytes` argument. The stellar CLI takes `Bytes` (and `BytesN`) arguments as a hex
string, not as text, so encode the ticker first. `sign-nav.mjs` takes the plain ticker, because the
signed message contains its raw UTF-8 bytes:

```bash
ASSET_CODE=SPIKO
ASSET_CODE_HEX=$(printf %s "$ASSET_CODE" | od -An -tx1 | tr -d ' \n')   # "SPIKO" -> 5350494b4f

NAV_SIG=$(node scripts/sign-nav.mjs "$(stellar keys secret price_publisher)" "$ASSET_CODE" "$TS" "$VALUE")

stellar contract invoke \
  --id "$PRICE_GUARD_CID" \
  --source price_publisher \
  --network "$NETWORK" \
  -- publish_nav \
  --publisher "$PRICE_PUBLISHER" \
  --asset "$RWA_SAC" \
  --asset_code "$ASSET_CODE_HEX" \
  --value "$VALUE" \
  --ts "$TS" \
  --sig "$NAV_SIG"
```
