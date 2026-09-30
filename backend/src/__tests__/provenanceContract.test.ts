import crypto from "crypto";
import { Address, Keypair, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ProvenanceContract } from "../services/contracts/ProvenanceContract";
import { AppError } from "../errors/AppError";
import type { ContractCall } from "../utils/transactionBuilder";

const contractId = (): string => StrKey.encodeContract(crypto.randomBytes(32));
const OWNER = Keypair.random().publicKey();
const CID = "QmYwAPJzv5CZsnAzt8auVZRnGi7wR1hMrxYxwN1G8nWJ9Z";
const MANIFEST_HASH = "a".repeat(64);
const ATTESTATION_HASH = "b".repeat(64);
const TIMESTAMP = 1_800_000_000;

/** Encodes the on-chain `Certificate` contracttype as an ScMap. */
function certificateScVal(): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("storage_id"),
      val: xdr.ScVal.scvString(CID),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("manifest_hash"),
      val: xdr.ScVal.scvString(MANIFEST_HASH),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("attestation_hash"),
      val: xdr.ScVal.scvString(ATTESTATION_HASH),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("creator"),
      val: Address.fromString(OWNER).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("timestamp"),
      val: xdr.ScVal.scvU64(new xdr.Uint64(BigInt(TIMESTAMP))),
    }),
  ]);
}

describe("ProvenanceContract.getCertificate", () => {
  it("queries get_certificate with the u64 id and decodes the ledger record", async () => {
    const invoke = jest.fn(async (_call: ContractCall) => certificateScVal());
    const contract = new ProvenanceContract(contractId(), { invoke });

    const result = await contract.getCertificate("41");

    expect(invoke).toHaveBeenCalledTimes(1);
    const call = invoke.mock.calls[0][0];
    expect(call.method).toBe("get_certificate");
    expect(scValToNative(call.args[0]).toString()).toBe("41");
    expect(result).toEqual({
      storageId: CID,
      manifestHash: MANIFEST_HASH,
      attestationHash: ATTESTATION_HASH,
      creator: OWNER,
      timestamp: new Date(TIMESTAMP * 1_000),
    });
  });

  it("returns null when the contract reports no certificate", async () => {
    const invoke = jest.fn(async () => xdr.ScVal.scvVoid());
    const contract = new ProvenanceContract(contractId(), { invoke });

    await expect(contract.getCertificate("999")).resolves.toBeNull();
  });

  it("rejects a non-numeric certificate id", async () => {
    const contract = new ProvenanceContract(contractId(), { invoke: jest.fn() });

    await expect(contract.getCertificate("abc")).rejects.toMatchObject({
      code: "INVALID_CERTIFICATE_ID",
    });
  });

  it("rejects an unexpected contract response shape", async () => {
    const invoke = jest.fn(async () => xdr.ScVal.scvString("not-a-certificate"));
    const contract = new ProvenanceContract(contractId(), { invoke });

    await expect(contract.getCertificate("1")).rejects.toMatchObject({
      code: "PROVENANCE_INVALID_RESPONSE",
    });
  });

  it("throws when constructed without a query client", async () => {
    const fakeSoroban = {
      networkPassphrase: "Test SDF Network ; September 2015",
      loadAccount: jest.fn(),
      simulate: jest.fn(),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    };
    const contract = new ProvenanceContract(
      contractId(),
      Keypair.random(),
      fakeSoroban as never
    );

    await expect(contract.getCertificate("1")).rejects.toMatchObject({
      code: "PROVENANCE_QUERY_NOT_CONFIGURED",
    });
  });

  it("returns null when the contract simulation reports not-found", async () => {
    const invoke = jest.fn(async () => {
      throw new AppError(
        "Soroban simulation failed: CertificateNotFound",
        422,
        "SOROBAN_SIMULATION_FAILED"
      );
    });
    const contract = new ProvenanceContract(contractId(), { invoke });

    await expect(contract.getCertificate("999")).resolves.toBeNull();
  });

  it("propagates transport failures instead of treating them as not-found", async () => {
    const invoke = jest.fn(async () => {
      throw new AppError("Soroban RPC timed out", 504, "SOROBAN_RPC_TIMEOUT");
    });
    const contract = new ProvenanceContract(contractId(), { invoke });

    await expect(contract.getCertificate("1")).rejects.toMatchObject({
      code: "SOROBAN_RPC_TIMEOUT",
    });
  });
});
