/**
 * Strictly validated SCVal serializers for StellarProof contract arguments.
 *
 * Layouts mirror the deployed contracts exactly:
 *
 *   oracle.submit_request(content_hash: BytesN<32>) -> u64
 *   provenance.mint(to: Address, details: CertificateDetails) -> u64
 *
 *   #[contracttype] struct CertificateDetails {
 *     storage_id: String, manifest_hash: String, attestation_hash: String,
 *   }
 *
 * A `#[contracttype]` struct is encoded as an `ScMap` keyed by `ScSymbol`
 * field names, and Soroban requires map entries sorted by key.
 */
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../errors/AppError";

const HEX_32_BYTES_REGEX = /^[0-9a-fA-F]{64}$/;
/** CIDv0: base58btc multihash, always 46 chars starting with "Qm". */
const CID_V0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
/** CIDv1: lowercase base32 multibase (prefix "b"), the IPFS default encoding. */
const CID_V1_BASE32_REGEX = /^b[a-z2-7]{58,}$/;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/** Thrown when a value cannot be serialized into the SCVal a contract expects. */
export class XdrValidationError extends AppError {
  public readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`, StatusCodes.BAD_REQUEST, "INVALID_XDR_ARGUMENT");
    this.name = "XdrValidationError";
    this.field = field;
    Object.setPrototypeOf(this, XdrValidationError.prototype);
  }
}

/**
 * Validates a 32-byte hex string (e.g. a SHA-256 digest) and returns it
 * lower-cased. Exactly 64 hex characters are required: no `0x` prefix, no
 * `sha256:` prefix, no whitespace.
 */
export function assertHex32(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new XdrValidationError(field, "expected a 64-character hex string");
  }
  if (value.length !== 64) {
    throw new XdrValidationError(
      field,
      `expected exactly 64 hex characters, received ${value.length}`
    );
  }
  if (!HEX_32_BYTES_REGEX.test(value)) {
    throw new XdrValidationError(field, "contains non-hexadecimal characters");
  }
  return value.toLowerCase();
}

/** Validates an IPFS CID (v0 or base32 v1) and returns it unchanged. */
export function assertCid(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new XdrValidationError(field, "expected a non-empty IPFS CID");
  }
  if (!CID_V0_REGEX.test(value) && !CID_V1_BASE32_REGEX.test(value)) {
    throw new XdrValidationError(field, "is not a valid CIDv0 or base32 CIDv1");
  }
  return value;
}

/** `BytesN<32>` SCVal from a 64-character hex string. */
export function toBytesN32ScVal(hex: unknown, field: string): xdr.ScVal {
  const normalized = assertHex32(hex, field);
  return xdr.ScVal.scvBytes(Buffer.from(normalized, "hex"));
}

/** Soroban `String` SCVal from a non-empty string. */
export function toStringScVal(value: unknown, field: string): xdr.ScVal {
  if (typeof value !== "string" || value.length === 0) {
    throw new XdrValidationError(field, "expected a non-empty string");
  }
  return xdr.ScVal.scvString(value);
}

/** `String` SCVal holding a lower-cased 64-char SHA-256 hex digest. */
export function toSha256StringScVal(hex: unknown, field: string): xdr.ScVal {
  return xdr.ScVal.scvString(assertHex32(hex, field));
}

/** `String` SCVal holding a validated IPFS CID. */
export function toCidScVal(cid: unknown, field: string): xdr.ScVal {
  return xdr.ScVal.scvString(assertCid(cid, field));
}

/** `Address` SCVal from a G-account or C-contract strkey. */
export function toAddressScVal(address: unknown, field: string): xdr.ScVal {
  if (
    typeof address !== "string" ||
    (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address))
  ) {
    throw new XdrValidationError(field, "expected a valid Stellar G... or C... address");
  }
  return Address.fromString(address).toScVal();
}

/** `u64` SCVal from a non-negative integer. */
export function toU64ScVal(value: bigint | number, field: string): xdr.ScVal {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new XdrValidationError(field, "expected a safe integer");
  }
  const big = BigInt(value);
  if (big < BigInt(0) || big > U64_MAX) {
    throw new XdrValidationError(field, "is out of range for u64");
  }
  return xdr.ScVal.scvU64(new xdr.Uint64(big));
}

// ---------------------------------------------------------------------------
// Contract argument layouts
// ---------------------------------------------------------------------------

export interface SubmitRequestArgs {
  /** SHA-256 hex digest of the content under verification. */
  contentHash: string;
}

/** Ordered arguments for `oracle.submit_request(content_hash: BytesN<32>)`. */
export function buildSubmitRequestArgs(args: SubmitRequestArgs): xdr.ScVal[] {
  return [toBytesN32ScVal(args.contentHash, "contentHash")];
}

export interface CertificateDetailsInput {
  /** IPFS CID of the verified media (`CertificateDetails.storage_id`). */
  mediaCid: string;
  /** SHA-256 hex digest of the manifest document (`manifest_hash`). */
  manifestHash: string;
  /** SHA-256 hex digest of the oracle attestation (`attestation_hash`). */
  attestationHash: string;
}

/** `CertificateDetails` struct SCVal, with map entries in the required key order. */
export function toCertificateDetailsScVal(details: CertificateDetailsInput): xdr.ScVal {
  const fields: Array<[string, xdr.ScVal]> = [
    ["storage_id", toCidScVal(details.mediaCid, "mediaCid")],
    ["manifest_hash", toSha256StringScVal(details.manifestHash, "manifestHash")],
    ["attestation_hash", toSha256StringScVal(details.attestationHash, "attestationHash")],
  ];

  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return xdr.ScVal.scvMap(
    fields.map(
      ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
    )
  );
}

export interface MintArgs extends CertificateDetailsInput {
  /** G-address of the certificate owner (the verification requester). */
  to: string;
}

/** Ordered arguments for `provenance.mint(to: Address, details: CertificateDetails)`. */
export function buildMintArgs(args: MintArgs): xdr.ScVal[] {
  return [
    toAddressScVal(args.to, "to"),
    toCertificateDetailsScVal({
      mediaCid: args.mediaCid,
      manifestHash: args.manifestHash,
      attestationHash: args.attestationHash,
    }),
  ];
}
