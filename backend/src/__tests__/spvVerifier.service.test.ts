import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

jest.mock("../config/env", () => ({
  env: {
    PINATA_GATEWAY_URL: "https://gateway.invalid/ipfs",
    SPV_FETCH_TIMEOUT_MS: 30_000,
    SPV_MAX_MEDIA_BYTES: 1_000_000,
    SPV_MAX_MANIFEST_BYTES: 100_000,
  },
}));

import { SpvFetchError, SpvVerifierService } from "../services/spvVerifier.service";
import { XdrValidationError } from "../utils/xdr";

const MEDIA_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const MANIFEST_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const GATEWAY = "https://gateway.invalid/ipfs/";
const sha256 = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");

const media = Buffer.from("original media bytes");
const requester = Keypair.random().publicKey();

/** Gateway stand-in serving fixed bodies (or statuses) per CID via real `Response` objects. */
function gateway(routes: Record<string, Buffer | string | number>): jest.Mock {
  return jest.fn(async (url: string) => {
    const cid = url.slice(url.lastIndexOf("/") + 1);
    const body = routes[cid];
    if (typeof body === "number") return new Response(null, { status: body });
    return new Response(typeof body === "string" ? body : new Uint8Array(body));
  });
}

function verifier(fetchFn: jest.Mock, limits: Partial<{ maxMediaBytes: number; maxManifestBytes: number }> = {}) {
  return new SpvVerifierService(
    {
      gatewayUrl: GATEWAY,
      fetchTimeoutMs: 1_000,
      maxMediaBytes: limits.maxMediaBytes ?? 1_000_000,
      maxManifestBytes: limits.maxManifestBytes ?? 100_000,
    },
    fetchFn as unknown as typeof fetch
  );
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ contentHash: `sha256:${sha256(media)}`, creator: requester, ...overrides });
}

const request = { mediaCid: MEDIA_CID, manifestCid: MANIFEST_CID, requester };

describe("SpvVerifierService.verify", () => {
  it("verifies media matching the manifest and requester", async () => {
    const manifest = manifestJson();
    const fetchFn = gateway({ [MEDIA_CID]: media, [MANIFEST_CID]: manifest });

    await expect(verifier(fetchFn).verify(request)).resolves.toEqual({
      verified: true,
      contentHash: sha256(media),
      manifestHash: sha256(manifest),
    });
    expect(fetchFn).toHaveBeenCalledWith(`https://gateway.invalid/ipfs/${MEDIA_CID}`, expect.anything());
  });

  it("accepts a bare hex contentHash", async () => {
    const fetchFn = gateway({ [MEDIA_CID]: media, [MANIFEST_CID]: manifestJson({ contentHash: sha256(media) }) });
    await expect(verifier(fetchFn).verify(request)).resolves.toMatchObject({ verified: true });
  });

  it.each([
    ["tampered media", { [MEDIA_CID]: Buffer.from("tampered"), [MANIFEST_CID]: manifestJson() }, /does not match the manifest/],
    ["different creator", { [MEDIA_CID]: media, [MANIFEST_CID]: manifestJson({ creator: Keypair.random().publicKey() }) }, /creator/],
    ["non-JSON manifest", { [MEDIA_CID]: media, [MANIFEST_CID]: "not json" }, /not valid JSON/],
    ["manifest missing fields", { [MEDIA_CID]: media, [MANIFEST_CID]: JSON.stringify({ creator: requester }) }, /missing/],
    ["malformed contentHash", { [MEDIA_CID]: media, [MANIFEST_CID]: manifestJson({ contentHash: "sha256:xyz" }) }, /not a SHA-256/],
  ])("rejects %s with a verdict, not an error", async (_label, routes, reason) => {
    const result = await verifier(gateway(routes)).verify(request);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(reason);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed CIDs and requesters before fetching", async () => {
    const fetchFn = gateway({});
    await expect(verifier(fetchFn).verify({ ...request, mediaCid: "nope" })).rejects.toThrow(XdrValidationError);
    await expect(verifier(fetchFn).verify({ ...request, requester: "GBAD" })).rejects.toThrow(XdrValidationError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [404, true],
    [503, true],
    [429, true],
    [400, false],
  ])("maps gateway HTTP %i to SpvFetchError(retryable=%s)", async (status, retryable) => {
    const err = await verifier(gateway({ [MANIFEST_CID]: status }))
      .verify(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpvFetchError);
    expect((err as SpvFetchError).retryable).toBe(retryable);
  });

  it("treats network failures as retryable", async () => {
    const fetchFn = jest.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = await verifier(fetchFn).verify(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpvFetchError);
    expect((err as SpvFetchError).retryable).toBe(true);
  });

  it("refuses media over the configured byte limit", async () => {
    const fetchFn = gateway({ [MEDIA_CID]: media, [MANIFEST_CID]: manifestJson() });
    const err = await verifier(fetchFn, { maxMediaBytes: media.length - 1 })
      .verify(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpvFetchError);
    expect((err as SpvFetchError).retryable).toBe(false);
  });
});
