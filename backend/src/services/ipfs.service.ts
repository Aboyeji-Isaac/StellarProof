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
const PINATA_CID_VERSION: "v0" | "v1" = "v1";

/** Typed error codes surfaced to callers (see `AppError`). */
export const IPFS_UPLOAD_TIMEOUT = "IPFS_UPLOAD_TIMEOUT";
export const IPFS_UPLOAD_FAILED = "IPFS_UPLOAD_FAILED";
export const IPFS_CID_VERSION_MISMATCH = "IPFS_CID_VERSION_MISMATCH";

/** Upper bound for the exponential backoff between upload attempts. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Delay before the retry that follows a failed attempt, growing
 * exponentially (`baseMs * 2 ** attempt`) and capped at `maxMs`.
 */
export function computeBackoffDelayMs(
  baseMs: number,
  attempt: number,
  maxMs: number = MAX_BACKOFF_MS,
): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

/**
 * A failed upload is retryable when it is a timeout, a transient/unknown
 * failure, or a 5xx from the provider. Client errors (4xx) and a CID-version
 * mismatch are deterministic and must not be retried.
 */
export function isRetryableUploadError(error: unknown): boolean {
  if (error instanceof AppError) {
    if (error.code === IPFS_CID_VERSION_MISMATCH) return false;
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return false;
    }
  }
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `operation` with a hard per-attempt timeout. An `AbortController` is
 * aborted when the deadline elapses and the attempt is rejected with a typed
 * `AppError(502, IPFS_UPLOAD_TIMEOUT)` so callers can handle it cleanly.
 */
async function withUploadTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new AppError(
          `IPFS upload timed out after ${timeoutMs}ms`,
          StatusCodes.BAD_GATEWAY,
          IPFS_UPLOAD_TIMEOUT,
        ),
      );
    }, timeoutMs);
  });

  const attempt = operation();
  // Avoid an unhandled rejection if the timeout wins the race and the attempt
  // later rejects.
  attempt.catch(() => undefined);

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    const file = this.toFile(content, name);

    return this.uploadWithRetry(file, name, metadata, content);
  }

  /**
   * Upload the file, retrying transient failures up to
   * `IPFS_UPLOAD_MAX_RETRIES` times with exponential backoff. Every attempt is
   * bounded by `IPFS_UPLOAD_TIMEOUT_MS`.
   */
  private async uploadWithRetry(
    file: File,
    name: string,
    metadata: Record<string, string>,
    content: IpfsUploadInput["content"],
  ): Promise<IpfsUploadResult> {
    const maxAttempts = env.IPFS_UPLOAD_MAX_RETRIES + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await withUploadTimeout(
          () => this.performUpload(file, name, metadata, content),
          env.IPFS_UPLOAD_TIMEOUT_MS,
        );
      } catch (err) {
        lastError = err;

        if (attempt === maxAttempts - 1 || !isRetryableUploadError(err)) {
          break;
        }

        await delay(computeBackoffDelayMs(env.IPFS_UPLOAD_BACKOFF_MS, attempt));
      }
    }

    throw this.toUploadError(lastError);
  }

  private async performUpload(
    file: File,
    name: string,
    metadata: Record<string, string>,
    content: IpfsUploadInput["content"],
  ): Promise<IpfsUploadResult> {
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
        IPFS_CID_VERSION_MISMATCH,
      );
    }

    const size: number =
      response.size ??
      (Buffer.isBuffer(content)
        ? content.byteLength
        : Buffer.byteLength(JSON.stringify(content)));

    return {
      cid,
      cidVersion: 1,
      size,
      name: response.name ?? name,
      timestamp: new Date().toISOString(),
      gatewayUrl: `${env.PINATA_GATEWAY_URL}/${cid}`,
    };
  }

  private toFile(content: IpfsUploadInput["content"], name: string): File {
    if (Buffer.isBuffer(content)) {
      // Use Uint8Array to satisfy BlobPart requirement and avoid SharedArrayBuffer issues
      return new File([new Uint8Array(content)], name, { type: "application/octet-stream" });
    }

    return new File([JSON.stringify(content)], `${name}.json`, { type: "application/json" });
  }

  /** Preserve typed AppErrors; wrap everything else as a 502 upload failure. */
  private toUploadError(error: unknown): AppError {
    if (error instanceof AppError) return error;

    const message = error instanceof Error ? error.message : "IPFS upload failed — unknown error";
    return new AppError(`IPFS upload failed: ${message}`, StatusCodes.BAD_GATEWAY, IPFS_UPLOAD_FAILED);
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
