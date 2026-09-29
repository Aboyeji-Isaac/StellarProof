jest.mock("../../config/env", () => ({
  __esModule: true,
  env: {
    MONGODB_URI: "mongodb://localhost:27017/test",
    JWT_SECRET: "test-secret",
    PINATA_JWT: "test-pinata-jwt",
    PINATA_GATEWAY_URL: "https://gateway.pinata.cloud/ipfs",
  },
}));

/**
 * Pinata SDK mock.
 * The upload builder mirrors the real SDK surface (name/keyvalues/then) and
 * nothing else, so a call to a method the SDK does not expose fails the test.
 */
const mockUploadOutcome = jest.fn();
const mockBuilder = {
  name: jest.fn(),
  keyvalues: jest.fn(),
  then: (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve().then(() => mockUploadOutcome()).then(onFulfilled, onRejected),
};
const mockPublicFile = jest.fn();

jest.mock("pinata", () => ({
  __esModule: true,
  PinataSDK: jest.fn().mockImplementation(() => ({
    upload: { public: { file: mockPublicFile } },
  })),
}));

import { PinataSDK } from "pinata";
import { ipfsService } from "../ipfs.service";
import { AppError } from "../../errors/AppError";
import type { IpfsUploadResult } from "../../types/ipfs.types";

const GATEWAY = "https://gateway.pinata.cloud/ipfs";
const CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";

/** Shape of a successful Pinata v3 public upload response. */
const pinataResponse = (overrides: Record<string, unknown> = {}) => ({
  id: "0195f8f2-8e2f-7c5b-9d3a-1f2e3d4c5b6a",
  name: "photo.png",
  cid: CID,
  size: 2048,
  created_at: "2026-09-26T10:00:00.000Z",
  number_of_files: 1,
  mime_type: "application/octet-stream",
  group_id: null,
  keyvalues: {},
  vectorized: false,
  network: "public",
  ...overrides,
});

const uploadedFile = (): File => mockPublicFile.mock.calls[0][0] as File;

describe("IpfsService", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    mockUploadOutcome.mockReset();
    mockPublicFile.mockReset().mockReturnValue(mockBuilder);
    mockBuilder.name.mockReset().mockReturnValue(mockBuilder);
    mockBuilder.keyvalues.mockReset().mockReturnValue(mockBuilder);
    // Guard: the SDK is mocked, so any real HTTP call is a test failure.
    fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected network call during IPFS unit test");
    });
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("constructs the Pinata SDK with the configured JWT and gateway", () => {
    expect(PinataSDK).toHaveBeenCalledWith({
      pinataJwt: "test-pinata-jwt",
      pinataGateway: GATEWAY,
    });
  });

  describe("upload() success", () => {
    it("returns a complete IpfsUploadResult for a buffer upload", async () => {
      mockUploadOutcome.mockReturnValue(pinataResponse());

      const result = await ipfsService.upload({
        content: Buffer.from("binary-media"),
        name: "photo.png",
      });

      expect(result).toEqual<IpfsUploadResult>({
        cid: CID,
        size: 2048,
        name: "photo.png",
        timestamp: expect.any(String),
        gatewayUrl: `${GATEWAY}/${CID}`,
      });
      expect(Object.keys(result).sort()).toEqual(["cid", "gatewayUrl", "name", "size", "timestamp"]);
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    it("wraps a buffer in an octet-stream File carrying the exact bytes", async () => {
      mockUploadOutcome.mockReturnValue(pinataResponse());
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

      await ipfsService.upload({ content: bytes, name: "image.png" });

      const file = uploadedFile();
      expect(file.name).toBe("image.png");
      expect(file.type).toBe("application/octet-stream");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    });

    it("serialises object content to a .json File", async () => {
      mockUploadOutcome.mockReturnValue(pinataResponse({ name: "manifest" }));
      const manifest = { contentHash: "abc123", creator: "GABC" };

      await ipfsService.upload({ content: manifest, name: "manifest" });

      const file = uploadedFile();
      expect(file.name).toBe("manifest.json");
      expect(file.type).toBe("application/json");
      expect(JSON.parse(await file.text())).toEqual(manifest);
    });

    it("injects name and keyvalues metadata through the SDK builder", async () => {
      mockUploadOutcome.mockReturnValue(pinataResponse());
      const metadata = { manifestId: "66f5a0c2e4b0a1b2c3d4e5f6", mimetype: "image/png" };

      await ipfsService.upload({ content: Buffer.from("x"), name: "photo.png", metadata });

      expect(mockBuilder.name).toHaveBeenCalledWith("photo.png");
      expect(mockBuilder.keyvalues).toHaveBeenCalledTimes(1);
      expect(mockBuilder.keyvalues).toHaveBeenCalledWith(metadata);
    });

    it("omits keyvalues when no metadata is supplied and defaults the name", async () => {
      mockUploadOutcome.mockReturnValue(pinataResponse({ name: undefined }));

      const result = await ipfsService.upload({ content: Buffer.from("x") });

      expect(mockBuilder.name).toHaveBeenCalledWith("upload");
      expect(mockBuilder.keyvalues).not.toHaveBeenCalled();
      expect(uploadedFile().name).toBe("upload");
      expect(result.name).toBe("upload");
    });

    it("falls back to the local byte length when Pinata omits size", async () => {
      mockUploadOutcome.mockReturnValue(pinataResponse({ size: undefined }));
      const content = { hello: "world" };

      const bufferResult = await ipfsService.upload({ content: Buffer.alloc(37) });
      const jsonResult = await ipfsService.upload({ content });

      expect(bufferResult.size).toBe(37);
      expect(jsonResult.size).toBe(Buffer.byteLength(JSON.stringify(content)));
    });
  });

  describe("upload() failures", () => {
    const expectIpfsAppError = async (promise: Promise<unknown>, message: string) => {
      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 502,
        code: "IPFS_UPLOAD_FAILED",
        message,
      });
    };

    it("maps a Pinata API error to a 502 IPFS_UPLOAD_FAILED AppError", async () => {
      const pinataError = Object.assign(new Error("HTTP error: 401 Unauthorized"), {
        name: "AuthenticationError",
        statusCode: 401,
      });
      mockUploadOutcome.mockImplementation(() => {
        throw pinataError;
      });

      await expectIpfsAppError(
        ipfsService.upload({ content: Buffer.from("x"), name: "photo.png" }),
        "IPFS upload failed: HTTP error: 401 Unauthorized",
      );
    });

    it("maps a network failure to a 502 IPFS_UPLOAD_FAILED AppError", async () => {
      mockUploadOutcome.mockImplementation(() => {
        throw new TypeError("fetch failed");
      });

      await expectIpfsAppError(
        ipfsService.upload({ content: Buffer.from("x") }),
        "IPFS upload failed: fetch failed",
      );
    });

    it("maps a synchronous SDK throw to a 502 IPFS_UPLOAD_FAILED AppError", async () => {
      mockPublicFile.mockImplementation(() => {
        throw new Error("Pinata JWT missing");
      });

      await expectIpfsAppError(
        ipfsService.upload({ content: Buffer.from("x") }),
        "IPFS upload failed: Pinata JWT missing",
      );
    });

    it("uses a generic message when a non-Error value is thrown", async () => {
      mockUploadOutcome.mockImplementation(() => {
        throw "rate limited";
      });

      await expectIpfsAppError(
        ipfsService.upload({ content: Buffer.from("x") }),
        "IPFS upload failed: IPFS upload failed — unknown error",
      );
    });

    it("re-throws an existing AppError unchanged", async () => {
      const original = new AppError("Quota exceeded", 429, "IPFS_QUOTA_EXCEEDED");
      mockUploadOutcome.mockImplementation(() => {
        throw original;
      });

      await expect(ipfsService.upload({ content: Buffer.from("x") })).rejects.toBe(original);
    });
  });
});
