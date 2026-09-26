import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { attestationService } from "../services/attestation.service";
import { XdrValidationError } from "../utils/xdr";

const hex32 = (): string => crypto.randomBytes(32).toString("hex");

function input() {
  return {
    eventId: "evt-1",
    requester: Keypair.random().publicKey(),
    mediaCid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    manifestCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    contentHash: hex32(),
    manifestHash: hex32(),
  };
}

describe("attestationService.createAttestation", () => {
  it("produces a deterministic hash signed by the oracle key", () => {
    const keypair = Keypair.random();
    const measurement = hex32();
    const data = input();

    const first = attestationService.createAttestation(data, keypair, measurement);
    const second = attestationService.createAttestation(data, keypair, measurement);

    expect(first.attestationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.attestationHash).toBe(first.attestationHash);
    expect(first.codeMeasurementHash).toBe(measurement);
    expect(
      keypair.verify(Buffer.from(first.attestationHash, "hex"), Buffer.from(first.signature, "hex"))
    ).toBe(true);
  });

  it("binds the hash to the verified facts", () => {
    const keypair = Keypair.random();
    const measurement = hex32();
    const data = input();

    const original = attestationService.createAttestation(data, keypair, measurement);
    const changed = attestationService.createAttestation({ ...data, contentHash: hex32() }, keypair, measurement);

    expect(changed.attestationHash).not.toBe(original.attestationHash);
  });

  it("rejects malformed hashes", () => {
    expect(() =>
      attestationService.createAttestation({ ...input(), manifestHash: "abc" }, Keypair.random(), hex32())
    ).toThrow(XdrValidationError);
  });
});
