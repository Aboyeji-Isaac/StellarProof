jest.mock("../services/ipfs.service", () => ({
  __esModule: true,
  ipfsService: { upload: jest.fn() },
}));

import mongoose from "mongoose";
import Manifest, { buildManifestHashPayload } from "../models/Manifest.model";
import { manifestService } from "../services/manifest.service";
import { ipfsService } from "../services/ipfs.service";
import { canonicalStringify, generateDeterministicHash } from "../utils/crypto";

const CID_V1 = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const GATEWAY_URL = `https://gateway.pinata.cloud/ipfs/${CID_V1}`;

function buildManifest(metadata: Record<string, unknown> = { device: "Pixel 8", custom: { z: 1, a: 2 } }) {
  return new Manifest({
    contentHash: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    creator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    creatorId: new mongoose.Types.ObjectId(),
    timestamp: new Date("2026-09-01T10:00:00.000Z"),
    metadata,
  });
}

describe("ManifestService.uploadManifestToPinata", () => {
  let saveSpy: jest.SpyInstance;
  let findByIdSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (ipfsService.upload as jest.Mock).mockResolvedValue({
      cid: CID_V1,
      size: 256,
      name: "manifest.json",
      timestamp: "2026-09-26T12:00:00.000Z",
      gatewayUrl: GATEWAY_URL,
    });
    saveSpy = jest.spyOn(Manifest.prototype, "save").mockImplementation(async function (this: unknown) {
      return this;
    });
    findByIdSpy = jest.spyOn(Manifest, "findById");
  });

  afterEach(() => {
    saveSpy.mockRestore();
    findByIdSpy.mockRestore();
  });

  it("pins sorted-key JSON including manifestHash and persists ipfsCid/ipfsUrl", async () => {
    const manifest = buildManifest();
    findByIdSpy.mockResolvedValue(manifest);

    const result = await manifestService.uploadManifestToPinata(manifest);

    const expectedHash = generateDeterministicHash(buildManifestHashPayload(manifest));
    const call = (ipfsService.upload as jest.Mock).mock.calls[0][0];

    // The pinned document serializes to the canonical sorted-key JSON.
    expect(JSON.stringify(call.content)).toBe(
      canonicalStringify({ ...buildManifestHashPayload(manifest), manifestHash: expectedHash })
    );
    expect(Object.keys(call.content)).toEqual([
      "contentHash",
      "creator",
      "creatorId",
      "manifestHash",
      "metadata",
      "timestamp",
    ]);
    expect(Object.keys(call.content.metadata.custom)).toEqual(["a", "z"]);
    expect(call.name).toBe(`manifest-${manifest._id}`);
    expect(call.metadata).toEqual({ manifestId: String(manifest._id), manifestHash: expectedHash });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(manifest.ipfsCid).toBe(CID_V1);
    expect(manifest.ipfsUrl).toBe(GATEWAY_URL);
    expect(manifest.ipfsUploadedAt).toEqual(new Date("2026-09-26T12:00:00.000Z"));

    expect(findByIdSpy).toHaveBeenCalledWith(String(manifest._id));
    expect(result).toEqual({
      manifestId: String(manifest._id),
      manifestHash: expectedHash,
      manifestCid: CID_V1,
      ipfsUrl: GATEWAY_URL,
      ipfsUploadedAt: new Date("2026-09-26T12:00:00.000Z"),
      newlyPinned: true,
    });
  });

  it("produces identical pinned bytes regardless of metadata key order", async () => {
    const creatorId = new mongoose.Types.ObjectId();
    const a = buildManifest({ device: "cam", custom: { x: 1, y: 2 } });
    const b = buildManifest({ custom: { y: 2, x: 1 }, device: "cam" });
    a.creatorId = creatorId;
    b.creatorId = creatorId;
    findByIdSpy.mockImplementation(async () => a);

    await manifestService.uploadManifestToPinata(a);
    await manifestService.uploadManifestToPinata(b);

    const [first, second] = (ipfsService.upload as jest.Mock).mock.calls.map((c) => JSON.stringify(c[0].content));
    expect(first).toBe(second);
  });

  it("returns the stored reference without re-pinning when already uploaded", async () => {
    const manifest = buildManifest();
    manifest.manifestHash = generateDeterministicHash(buildManifestHashPayload(manifest));
    manifest.ipfsCid = CID_V1;
    manifest.ipfsUrl = GATEWAY_URL;
    manifest.ipfsUploadedAt = new Date("2026-09-20T00:00:00.000Z");

    const result = await manifestService.uploadManifestToPinata(manifest);

    expect(ipfsService.upload).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(result.newlyPinned).toBe(false);
    expect(result.manifestCid).toBe(CID_V1);
  });

  it("refuses to pin when the stored manifestHash does not match the content", async () => {
    const manifest = buildManifest();
    manifest.manifestHash = "0".repeat(64);

    await expect(manifestService.uploadManifestToPinata(manifest)).rejects.toMatchObject({
      statusCode: 409,
      code: "MANIFEST_HASH_MISMATCH",
    });
    expect(ipfsService.upload).not.toHaveBeenCalled();
  });

  it("does not persist anything when the Pinata upload fails", async () => {
    const manifest = buildManifest();
    (ipfsService.upload as jest.Mock).mockRejectedValue(new Error("pinata down"));

    await expect(manifestService.uploadManifestToPinata(manifest)).rejects.toThrow("pinata down");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(manifest.ipfsCid).toBeUndefined();
  });
});

describe("ManifestService.publishManifestById", () => {
  let findByIdSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    findByIdSpy = jest.spyOn(Manifest, "findById");
  });

  afterEach(() => findByIdSpy.mockRestore());

  it("rejects an invalid manifest id", async () => {
    await expect(manifestService.publishManifestById("not-an-id")).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_MANIFEST_ID",
    });
  });

  it("returns 404 when the manifest does not exist", async () => {
    findByIdSpy.mockResolvedValue(null);

    await expect(
      manifestService.publishManifestById(new mongoose.Types.ObjectId().toString())
    ).rejects.toMatchObject({ statusCode: 404, code: "MANIFEST_NOT_FOUND" });
  });

  it("forbids publishing a manifest owned by another user", async () => {
    const manifest = buildManifest();
    findByIdSpy.mockResolvedValue(manifest);

    await expect(
      manifestService.publishManifestById(String(manifest._id), new mongoose.Types.ObjectId().toString())
    ).rejects.toMatchObject({ statusCode: 403, code: "MANIFEST_FORBIDDEN" });
    expect(ipfsService.upload).not.toHaveBeenCalled();
  });
});
