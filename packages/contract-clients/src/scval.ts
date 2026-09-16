// TODO(integration): verify ScVal encoding against deployed contract ABI once contracts/*.wasm
// are built. The mappings below (structs as lexicographically-sorted Symbol-keyed ScMap, unit/
// tuple enum variants as ScVec([Symbol(variant), ...fields])) match soroban-sdk's conventional
// wire format across recent versions, but have not been checked against a live Ballast binary.
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export const scAddress = (address: string): xdr.ScVal => Address.fromString(address).toScVal();
export const scI128 = (value: bigint | number | string): xdr.ScVal =>
  nativeToScVal(value, { type: "i128" });
export const scU32 = (value: number): xdr.ScVal => nativeToScVal(value, { type: "u32" });
export const scU64 = (value: bigint | number): xdr.ScVal => nativeToScVal(value, { type: "u64" });
export const scSymbol = (value: string): xdr.ScVal => nativeToScVal(value, { type: "symbol" });
export const scBool = (value: boolean): xdr.ScVal => nativeToScVal(value, { type: "bool" });
export const scBytes = (value: Buffer | Uint8Array): xdr.ScVal =>
  nativeToScVal(Buffer.from(value), { type: "bytes" });

/**
 * Encodes a `#[contracttype] enum` variant the way soroban-sdk represents it on the wire:
 * `Vec([Symbol(variantName), ...fields])`. A unit variant (e.g. `PauseScope::Draws`) omits the
 * trailing fields and encodes as `Vec([Symbol("Draws")])`; a tuple variant like
 * `ParamChange::HaircutBaseBps(u32)` adds the field ScVal(s) after the symbol.
 */
export function enumToScVal(variantName: string, ...fields: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([scSymbol(variantName), ...fields]);
}

/** @deprecated use {@link enumToScVal} */
export const scEnumVariant = enumToScVal;

const snakeToCamel = (key: string): string => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const PASCAL_VARIANT = /^[A-Z][A-Za-z0-9]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    !(value instanceof Uint8Array) &&
    (value as object).constructor === Object
  );
}

/**
 * Recursively normalizes a `scValToNative`-decoded contract value into the shape Ballast's TS
 * types expect:
 *  - struct map keys converted from the contract's snake_case field names (e.g. `ltv_bps`) to
 *    camelCase (`ltvBps`);
 *  - a fieldless `#[contracttype] enum` variant, which soroban-sdk encodes as `Vec([Symbol(name)])`
 *    and therefore decodes as a one-element array (e.g. `["Ok"]`), unwrapped to the bare variant
 *    string (`"Ok"`) — matching how `enumToScVal` above encodes it.
 *
 * This is a convention-based normalizer, not a full XDR-spec-aware decoder — it assumes Ballast
 * never has a *genuine* array field whose sole element is a bare PascalCase string, which holds
 * for every current on-chain read. A tuple-variant enum (fields after the tag) is left as an
 * array (`["HaircutBaseBps", 700]`) since no current read result needs one. A future pass should
 * replace this with codegen'd bindings (`stellar contract bindings typescript`) once available,
 * rather than hand-extending this further.
 */
export function normalizeContractValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === "string" && PASCAL_VARIANT.test(value[0])) {
      return value[0];
    }
    return value.map(normalizeContractValue);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[snakeToCamel(key)] = normalizeContractValue(val);
    }
    return out;
  }
  return value;
}

/**
 * Encodes a `#[contracttype] struct` the way soroban-sdk represents it on the wire: an `ScMap`
 * with `Symbol` keys sorted lexicographically by field name.
 */
export function scStruct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map((key) => new xdr.ScMapEntry({ key: scSymbol(key), val: fields[key] }));
  return xdr.ScVal.scvMap(entries);
}
