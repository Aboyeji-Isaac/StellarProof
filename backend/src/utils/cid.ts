/**
 * Content Identifier (CID) helpers.
 *
 * StellarProof stores CIDs on-chain and hands them to the verification
 * pipeline, so every CID we persist must be a CIDv1 in its canonical
 * base32 (multibase prefix "b") string form, e.g. "bafybei...".
 *
 * A CIDv0 is a bare base58btc multihash that always starts with "Qm" and is
 * 46 characters long. It is not case-insensitive and is rejected by
 * subdomain gateways, which is why we refuse to store it.
 */

/** Lowercase RFC 4648 base32 alphabet, prefixed with the multibase code "b". */
const CID_V1_BASE32_REGEX = /^b[a-z2-7]{58,}$/;

/** base58btc sha2-256 multihash (the only valid CIDv0 shape). */
const CID_V0_REGEX = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

export function isCidV1(cid: string): boolean {
  return CID_V1_BASE32_REGEX.test(cid);
}

export function isCidV0(cid: string): boolean {
  return CID_V0_REGEX.test(cid);
}
