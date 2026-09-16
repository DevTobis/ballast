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
