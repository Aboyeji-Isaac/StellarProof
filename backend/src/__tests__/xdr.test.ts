import crypto from "crypto";
import { Address, Keypair, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  XdrValidationError,
  assertCid,
  assertHex32,
  buildMintArgs,
  buildSubmitRequestArgs,
  toAddressScVal,
  toBytesN32ScVal,
  toCertificateDetailsScVal,
  toSha256StringScVal,
  toStringScVal,
  toU64ScVal,
} from "../utils/xdr";

const sha256 = (input: string): string =>
  crypto.createHash("sha256").update(input).digest("hex");

// Well-known public CIDs (IPFS docs) used purely as format fixtures.
const CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("assertHex32", () => {
  it("accepts exactly 64 hex characters and lower-cases them", () => {
    const upper = sha256("content").toUpperCase();
    expect(assertHex32(upper, "hash")).toBe(upper.toLowerCase());
  });

  it.each([
    ["63 chars", "a".repeat(63)],
    ["65 chars", "a".repeat(65)],
    ["empty", ""],
  ])("rejects invalid length (%s)", (_label, value) => {
    expect(() => assertHex32(value, "hash")).toThrow(/exactly 64 hex characters/);
  });

  it.each([
    ["non-hex letter", "g".repeat(64)],
    ["0x prefix", `0x${"a".repeat(62)}`],
    ["sha256: prefix", `sha256:${"a".repeat(57)}`],
    ["embedded whitespace", `${"a".repeat(32)} ${"a".repeat(31)}`],
  ])("rejects malformed hex (%s)", (_label, value) => {
    expect(() => assertHex32(value, "hash")).toThrow(/non-hexadecimal/);
  });

  it("rejects non-string input with a typed error", () => {
    expect(() => assertHex32(1234, "hash")).toThrow(XdrValidationError);
  });

  it("reports the offending field on the error", () => {
    try {
      assertHex32("abc", "contentHash");
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(XdrValidationError);
      expect((err as XdrValidationError).field).toBe("contentHash");
      expect((err as XdrValidationError).code).toBe("INVALID_XDR_ARGUMENT");
    }
  });
});

describe("toBytesN32ScVal", () => {
  it("encodes a SHA-256 hex digest as 32 raw bytes", () => {
    const hash = sha256("media");
    const scVal = toBytesN32ScVal(hash, "hash");

    expect(scVal.switch()).toBe(xdr.ScValType.scvBytes());
    expect(scVal.bytes()).toHaveLength(32);
    expect(Buffer.from(scVal.bytes()).toString("hex")).toBe(hash);
  });

  it("accepts the all-zero and all-ones boundary values", () => {
    expect(toBytesN32ScVal("0".repeat(64), "h").bytes()).toEqual(Buffer.alloc(32, 0));
    expect(toBytesN32ScVal("f".repeat(64), "h").bytes()).toEqual(Buffer.alloc(32, 0xff));
  });

  it("rejects a 31-byte value", () => {
    expect(() => toBytesN32ScVal("ab".repeat(31), "h")).toThrow(XdrValidationError);
  });
});

describe("toStringScVal / toSha256StringScVal", () => {
  it("encodes a Soroban String", () => {
    const scVal = toStringScVal("hello", "field");
    expect(scVal.switch()).toBe(xdr.ScValType.scvString());
    expect(scValToNative(scVal)).toBe("hello");
  });

  it("rejects empty and non-string values", () => {
    expect(() => toStringScVal("", "field")).toThrow(XdrValidationError);
    expect(() => toStringScVal(undefined, "field")).toThrow(XdrValidationError);
  });

  it("encodes a validated hash as a lower-case String", () => {
    const hash = sha256("manifest").toUpperCase();
    expect(scValToNative(toSha256StringScVal(hash, "manifestHash"))).toBe(hash.toLowerCase());
  });
});

describe("assertCid", () => {
  it("accepts CIDv0 and base32 CIDv1", () => {
    expect(assertCid(CID_V0, "mediaCid")).toBe(CID_V0);
    expect(assertCid(CID_V1, "mediaCid")).toBe(CID_V1);
  });

  it.each([
    ["empty", ""],
    ["truncated v0", CID_V0.slice(0, -1)],
    ["v0 with invalid base58 char", `${CID_V0.slice(0, -1)}0`],
    ["uppercase v1", CID_V1.toUpperCase()],
    ["arbitrary text", "not-a-cid"],
  ])("rejects %s", (_label, value) => {
    expect(() => assertCid(value, "mediaCid")).toThrow(XdrValidationError);
  });
});

describe("toAddressScVal", () => {
  it("encodes a G-account address", () => {
    const pk = Keypair.random().publicKey();
    const scVal = toAddressScVal(pk, "to");
    expect(scVal.switch()).toBe(xdr.ScValType.scvAddress());
    expect(Address.fromScVal(scVal).toString()).toBe(pk);
  });

  it("encodes a C-contract address", () => {
    const contractId = StrKey.encodeContract(crypto.randomBytes(32));
    expect(Address.fromScVal(toAddressScVal(contractId, "to")).toString()).toBe(contractId);
  });

  it("rejects secrets and malformed addresses", () => {
    expect(() => toAddressScVal(Keypair.random().secret(), "to")).toThrow(XdrValidationError);
    expect(() => toAddressScVal("GABC", "to")).toThrow(XdrValidationError);
  });
});

describe("toU64ScVal", () => {
  it("encodes 0 and u64::MAX boundaries", () => {
    expect(scValToNative(toU64ScVal(0, "n"))).toBe(BigInt(0));
    const max = (BigInt(1) << BigInt(64)) - BigInt(1);
    expect(scValToNative(toU64ScVal(max, "n"))).toBe(max);
  });

  it("rejects negative, overflowing, and non-integer values", () => {
    expect(() => toU64ScVal(-1, "n")).toThrow(XdrValidationError);
    expect(() => toU64ScVal(BigInt(1) << BigInt(64), "n")).toThrow(XdrValidationError);
    expect(() => toU64ScVal(1.5, "n")).toThrow(XdrValidationError);
  });
});

describe("buildSubmitRequestArgs", () => {
  it("matches submit_request(content_hash: BytesN<32>)", () => {
    const contentHash = sha256("content");
    const args = buildSubmitRequestArgs({ contentHash });

    expect(args).toHaveLength(1);
    expect(args[0].switch()).toBe(xdr.ScValType.scvBytes());
    expect(Buffer.from(args[0].bytes()).toString("hex")).toBe(contentHash);
  });
});

describe("toCertificateDetailsScVal", () => {
  it("encodes CertificateDetails as a symbol-keyed map sorted by field name", () => {
    const scVal = toCertificateDetailsScVal({
      mediaCid: CID_V1,
      manifestHash: sha256("manifest"),
      attestationHash: sha256("attestation"),
    });

    expect(scVal.switch()).toBe(xdr.ScValType.scvMap());
    const entries = scVal.map() ?? [];
    const keys = entries.map((e) => e.key().sym().toString());
    expect(keys).toEqual(["attestation_hash", "manifest_hash", "storage_id"]);
    entries.forEach((e) => expect(e.val().switch()).toBe(xdr.ScValType.scvString()));
  });
});

describe("buildMintArgs", () => {
  it("matches mint(to: Address, details: CertificateDetails) argument order", () => {
    const to = Keypair.random().publicKey();
    const manifestHash = sha256("manifest");
    const attestationHash = sha256("attestation");

    const args = buildMintArgs({ to, mediaCid: CID_V0, manifestHash, attestationHash });

    expect(args).toHaveLength(2);
    expect(Address.fromScVal(args[0]).toString()).toBe(to);
    expect(scValToNative(args[1])).toEqual({
      attestation_hash: attestationHash,
      manifest_hash: manifestHash,
      storage_id: CID_V0,
    });
  });

  it("rejects an invalid hash inside the details struct", () => {
    expect(() =>
      buildMintArgs({
        to: Keypair.random().publicKey(),
        mediaCid: CID_V0,
        manifestHash: "z".repeat(64),
        attestationHash: sha256("attestation"),
      })
    ).toThrow(/manifestHash/);
  });
});
