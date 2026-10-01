import mongoose from "mongoose";
import { CertificateService, certificateService } from "../services/certificate.service";
import Certificate from "../models/Certificate.model";
import type { ListCertificatesQuery } from "../types/certificate.types";
import type { ProvenanceContract } from "../services/contracts/ProvenanceContract";

jest.mock("../models/Certificate.model");

const CertificateMock = Certificate as unknown as {
  find: jest.Mock;
  findOne: jest.Mock;
  countDocuments: jest.Mock;
};

/** Wire the Mongoose query chain used by CertificateService.listCertificates. */
function mockQueryChain(docs: unknown[], total: number) {
  const lean = jest.fn().mockResolvedValue(docs);
  const limit = jest.fn().mockReturnValue({ lean });
  const skip = jest.fn().mockReturnValue({ limit });
  const sort = jest.fn().mockReturnValue({ skip });
  const populateManifest = jest.fn().mockReturnValue({ sort });
  const populateAsset = jest.fn().mockReturnValue({ populate: populateManifest });
  CertificateMock.find.mockReturnValue({ populate: populateAsset });
  CertificateMock.countDocuments.mockResolvedValue(total);
}

function baseQuery(partial: Partial<ListCertificatesQuery>): ListCertificatesQuery {
  return { limit: 20, skip: 0, ...partial };
}

describe("CertificateService.listCertificates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("queries the global index when creatorId is omitted", async () => {
    mockQueryChain([{ certificateId: "cert-1" }], 1);

    const result = await certificateService.listCertificates(baseQuery({}));

    expect(CertificateMock.find).toHaveBeenCalledWith({});
    expect(result.total).toBe(1);
    expect(result.certificates).toHaveLength(1);
  });

  it("filters by creatorId when supplied", async () => {
    mockQueryChain([], 0);
    const creatorId = new mongoose.Types.ObjectId().toHexString();

    await certificateService.listCertificates(baseQuery({ creatorId }));

    const filter = CertificateMock.find.mock.calls[0][0];
    expect(filter.$and).toHaveLength(1);
    expect(String(filter.$and[0].creatorId)).toBe(creatorId);
  });

  it("builds a case-insensitive $or search across on-chain identifiers", async () => {
    mockQueryChain([], 0);

    await certificateService.listCertificates(baseQuery({ search: "cert-ABC" }));

    const filter = CertificateMock.find.mock.calls[0][0];
    const searchCondition = filter.$and.find(
      (c: Record<string, unknown>) => "$or" in c,
    ) as { $or: Record<string, { $regex: string; $options: string }>[] };

    expect(searchCondition.$or.map((entry) => Object.keys(entry)[0])).toEqual([
      "certificateId",
      "transactionHash",
      "contractAddress",
    ]);
    expect(searchCondition.$or[0].certificateId.$regex).toBe("cert-ABC");
    expect(searchCondition.$or[0].certificateId.$options).toBe("i");
  });

  it("escapes regex metacharacters in the search term", async () => {
    mockQueryChain([], 0);

    await certificateService.listCertificates(baseQuery({ search: "cert.*(1)" }));

    const filter = CertificateMock.find.mock.calls[0][0];
    const searchCondition = filter.$and.find(
      (c: Record<string, unknown>) => "$or" in c,
    ) as { $or: Record<string, { $regex: string }>[] };

    expect(searchCondition.$or[0].certificateId.$regex).toBe(
      "cert\\.\\*\\(1\\)",
    );
  });

  it("combines creatorId and search under $and", async () => {
    mockQueryChain([{ certificateId: "cert-9" }], 1);
    const creatorId = new mongoose.Types.ObjectId().toHexString();

    await certificateService.listCertificates(
      baseQuery({ creatorId, search: "cert-9" }),
    );

    const filter = CertificateMock.find.mock.calls[0][0];
    expect(filter.$and).toHaveLength(2);
    expect(CertificateMock.countDocuments).toHaveBeenCalledWith(filter);
  });

  it("rejects an invalid creatorId", async () => {
    await expect(
      certificateService.listCertificates(baseQuery({ creatorId: "not-an-id" })),
    ).rejects.toMatchObject({ code: "INVALID_CREATOR_ID" });
  });

  it("rejects out-of-range pagination", async () => {
    await expect(
      certificateService.listCertificates(baseQuery({ limit: 0 })),
    ).rejects.toMatchObject({ code: "INVALID_PAGINATION" });
    await expect(
      certificateService.listCertificates(baseQuery({ skip: -1 })),
    ).rejects.toMatchObject({ code: "INVALID_PAGINATION" });
  });

  it("populates asset and manifest relations for the frontend", async () => {
    mockQueryChain([], 0);

    await certificateService.listCertificates(baseQuery({}));

    const findResult = CertificateMock.find.mock.results[0].value;
    expect(findResult.populate).toHaveBeenCalledWith(
      "assetId",
      "fileName mimeType storageReferenceId",
    );
  });
});

const OWNER = "GBVBK2TX7QHEQNIMUPBVPZ7EONL52TWKQ7OXFDJPAJPYGNZFACUQBXP";
const CID = "QmYwAPJzv5CZsnAzt8auVZRnGi7wR1hMrxYxwN1G8nWJ9Z";
const MANIFEST_HASH = "a".repeat(64);
const ATTESTATION_HASH = "b".repeat(64);
const MINTED_AT = new Date("2026-09-29T00:00:00.000Z");

const cachedCertificate = {
  certificateId: "41",
  contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  stellarNetwork: "testnet" as const,
  mintedAt: MINTED_AT,
  assetId: { storageReferenceId: CID },
  manifestId: { manifestHash: MANIFEST_HASH, creator: OWNER },
  creatorId: { stellarPublicKey: OWNER },
  verificationJobId: { ownerPublicKey: OWNER, teeAttestationHash: ATTESTATION_HASH },
};

const onChainCertificate = {
  storageId: CID,
  manifestHash: MANIFEST_HASH,
  attestationHash: ATTESTATION_HASH,
  creator: OWNER,
  timestamp: MINTED_AT,
};

/** findOne(...).populate(...)....lean() returns the given document. */
function mockFindOneChain(doc: unknown): void {
  const chain: { populate: jest.Mock; lean: jest.Mock } = {
    populate: jest.fn(),
    lean: jest.fn().mockResolvedValue(doc),
  };
  chain.populate.mockReturnValue(chain);
  CertificateMock.findOne.mockReturnValue(chain);
}

function fakeProvenance(
  getCertificate: jest.Mock,
): () => Pick<ProvenanceContract, "getCertificate"> {
  return () => ({ getCertificate });
}

describe("CertificateService.verifyCertificate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns valid=true when the cache matches the ledger record", async () => {
    mockFindOneChain(cachedCertificate);
    const getCertificate = jest.fn().mockResolvedValue(onChainCertificate);
    const service = new CertificateService(fakeProvenance(getCertificate));

    const result = await service.verifyCertificate("41");

    expect(getCertificate).toHaveBeenCalledWith("41");
    expect(result.valid).toBe(true);
    expect(result.details.onChain).not.toBeNull();
    expect(result.details.checks).toEqual({
      storageId: true,
      manifestHash: true,
      attestationHash: true,
      creator: true,
      timestamp: true,
    });
    expect(result.details.mismatches).toEqual([]);
    expect(result.details.contractAddress).toBe(
      cachedCertificate.contractAddress,
    );
  });

  it("compares hashes case-insensitively and ignores sub-second drift", async () => {
    mockFindOneChain({
      ...cachedCertificate,
      manifestId: { manifestHash: MANIFEST_HASH.toUpperCase(), creator: OWNER },
    });
    const getCertificate = jest.fn().mockResolvedValue({
      ...onChainCertificate,
      timestamp: new Date(MINTED_AT.getTime() + 500),
    });
    const service = new CertificateService(fakeProvenance(getCertificate));

    const result = await service.verifyCertificate("41");

    expect(result.valid).toBe(true);
  });

  it("flags mismatched fields and returns valid=false", async () => {
    mockFindOneChain(cachedCertificate);
    const getCertificate = jest.fn().mockResolvedValue({
      ...onChainCertificate,
      manifestHash: "c".repeat(64),
      timestamp: new Date("2020-01-01T00:00:00.000Z"),
    });
    const service = new CertificateService(fakeProvenance(getCertificate));

    const result = await service.verifyCertificate("41");

    expect(result.valid).toBe(false);
    expect(result.details.checks.manifestHash).toBe(false);
    expect(result.details.checks.timestamp).toBe(false);
    expect(result.details.checks.storageId).toBe(true);
    expect(result.details.mismatches).toEqual(["manifestHash", "timestamp"]);
  });

  it("returns valid=false when the certificate is missing on-chain", async () => {
    mockFindOneChain(cachedCertificate);
    const getCertificate = jest.fn().mockResolvedValue(null);
    const service = new CertificateService(fakeProvenance(getCertificate));

    const result = await service.verifyCertificate("41");

    expect(result.valid).toBe(false);
    expect(result.details.onChain).toBeNull();
    expect(result.details.mismatches).toHaveLength(5);
    expect(result.details.checks).toEqual({
      storageId: false,
      manifestHash: false,
      attestationHash: false,
      creator: false,
      timestamp: false,
    });
  });

  it("throws 404 when the certificate is not in the off-chain cache", async () => {
    mockFindOneChain(null);
    const service = new CertificateService(fakeProvenance(jest.fn()));

    await expect(service.verifyCertificate("999")).rejects.toMatchObject({
      code: "CERTIFICATE_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("rejects an empty certificate id", async () => {
    const service = new CertificateService(fakeProvenance(jest.fn()));

    await expect(service.verifyCertificate("   ")).rejects.toMatchObject({
      code: "MISSING_CERTIFICATE_ID",
      statusCode: 400,
    });
  });
});
