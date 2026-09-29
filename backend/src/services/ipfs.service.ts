import { createHash } from "crypto";
import { PinataSDK } from "pinata";
import { StatusCodes } from "http-status-codes";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import { isCidV1 } from "../utils/cid";
import type { IpfsUploadInput, IpfsUploadResult } from "../types/ipfs.types";
import type { GatewayFetchOptions, GatewayFetchResult } from "../types/storage.types";

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

      // The Pinata SDK upload builder takes metadata through chained
      // name()/keyvalues() calls; it has no addMetadata() method.
      let builder = this.pinata.upload.public.file(file).name(name);
      if (Object.keys(metadata).length > 0) {
        builder = builder.keyvalues(metadata);
      }
      const response = await builder;

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

  /** Public gateway URL for a CID. */
  getGatewayUrl(cid: string): string {
    return `${env.PINATA_GATEWAY_URL.replace(/\/+$/, "")}/${cid}`;
  }

  /**
   * Stream a CID from the Pinata gateway and compute its SHA-256.
   * The whole request (headers + body) is bounded by `timeoutMs`, and the
   * download is aborted as soon as it exceeds `maxBytes`, so a slow gateway
   * or an oversized object can never stall or exhaust the API process.
   * Gateway-side failures are reported as a status rather than thrown.
   */
  async fetchFromGateway(cid: string, options: GatewayFetchOptions): Promise<GatewayFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(this.getGatewayUrl(cid), {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });

      if (response.status === StatusCodes.NOT_FOUND || response.status === StatusCodes.GONE) {
        await response.body?.cancel();
        return { status: "not_found", httpStatus: response.status };
      }

      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return { status: "unreachable", httpStatus: response.status };
      }

      const lengthHeader = response.headers.get("content-length");
      const declaredSize = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;

      if (declaredSize !== null && declaredSize > options.maxBytes) {
        await response.body.cancel();
        return { status: "too_large", declaredSize };
      }

      const hash = createHash("sha256");
      const reader = response.body.getReader();
      let received = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        received += value.byteLength;
        if (received > options.maxBytes) {
          await reader.cancel();
          return { status: "too_large", declaredSize };
        }
        hash.update(value);
      }

      return { status: "ok", size: received, sha256: hash.digest("hex") };
    } catch {
      if (controller.signal.aborted) {
        return { status: "timeout" };
      }
      return { status: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const ipfsService = new IpfsService();
