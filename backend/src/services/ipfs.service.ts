import { PinataSDK, type CidVersion } from "pinata";
import { StatusCodes } from "http-status-codes";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import { isCidV1 } from "../utils/cid";
import type { IpfsUploadInput, IpfsUploadResult } from "../types/ipfs.types";

/**
 * Every pin must be requested as CIDv1 so the returned IpfsHash is a
 * canonical base32 CID that is safe to reference from Soroban contracts.
 * Never rely on the provider default.
 */
const PINATA_CID_VERSION: CidVersion = "v1";

class IpfsService {
  private readonly pinata: PinataSDK;

  constructor() {
    this.pinata = new PinataSDK({
      pinataJwt: env.PINATA_JWT,
      pinataGateway: env.PINATA_GATEWAY_URL,
    });
  }

  async upload(input: IpfsUploadInput): Promise<IpfsUploadResult> {
    const { content, name = "upload", metadata = {} } = input;

    try {
      let file: File;

      if (Buffer.isBuffer(content)) {
        // Use Uint8Array to satisfy BlobPart requirement and avoid SharedArrayBuffer issues
        file = new File([new Uint8Array(content)], name, { type: "application/octet-stream" });
      } else {
        const json = JSON.stringify(content);
        file = new File([json], `${name}.json`, { type: "application/json" });
      }

      let builder = this.pinata.upload.public
        .file(file)
        .name(name)
        .cidVersion(PINATA_CID_VERSION);

      if (Object.keys(metadata).length > 0) {
        builder = builder.keyvalues(metadata);
      }

      const response = await builder;
      const cid = response.cid;

      if (typeof cid !== "string" || !isCidV1(cid)) {
        throw new AppError(
          `IPFS upload returned a non-CIDv1 content identifier: ${String(cid)}`,
          StatusCodes.BAD_GATEWAY,
          "IPFS_CID_VERSION_MISMATCH"
        );
      }

      const size: number = response.size ?? (Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(JSON.stringify(content)));

      return {
        cid,
        cidVersion: 1,
        size,
        name: response.name ?? name,
        timestamp: new Date().toISOString(),
        gatewayUrl: `${env.PINATA_GATEWAY_URL}/${cid}`,
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;

      const message =
        err instanceof Error
          ? err.message
          : "IPFS upload failed — unknown error";

      throw new AppError(
        `IPFS upload failed: ${message}`,
        StatusCodes.BAD_GATEWAY,
        "IPFS_UPLOAD_FAILED"
      );
    }
  }
}

export const ipfsService = new IpfsService();
