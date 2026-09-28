import { createHash } from "crypto";
import { PinataSDK } from "pinata";
import { StatusCodes } from "http-status-codes";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import { isCidV1 } from "../utils/cid";
import type {
  IpfsAvailability,
  IpfsPinStatus,
  IpfsUploadInput,
  IpfsUploadResult,
} from "../types/ipfs.types";
import type { GatewayFetchOptions, GatewayFetchResult } from "../types/storage.types";

/**
 * Every pin must be requested as CIDv1 so the returned IpfsHash is a
 * canonical base32 CID that is safe to reference from Soroban contracts.
 * Never rely on the provider default.
 */
const PINATA_CID_VERSION = "v1" as const;

/**
 * Bounded polling window used to observe Pinata's real pin state after an
 * upload. Pinata may return a CID before the pin has finished propagating, so
 * we poll (bounded) instead of assuming success. All values are overridable
 * via env; the defaults keep the worst-case extra latency under ~6s.
 */
const DEFAULT_PIN_POLL_INTERVAL_MS = 500;
const DEFAULT_PIN_POLL_TIMEOUT_MS = 6_000;
const DEFAULT_PIN_POLL_MAX_ATTEMPTS = 8;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 4_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class IpfsService {
  private readonly pinata: PinataSDK;
  private readonly pinPollIntervalMs: number;
  private readonly pinPollTimeoutMs: number;
  private readonly pinPollMaxAttempts: number;
  private readonly availabilityTimeoutMs: number;

  constructor() {
    this.pinata = new PinataSDK({
      pinataJwt: env.PINATA_JWT,
      pinataGateway: env.PINATA_GATEWAY_URL,
    });
    this.pinPollIntervalMs = env.IPFS_PIN_POLL_INTERVAL_MS ?? DEFAULT_PIN_POLL_INTERVAL_MS;
    this.pinPollTimeoutMs = env.IPFS_PIN_POLL_TIMEOUT_MS ?? DEFAULT_PIN_POLL_TIMEOUT_MS;
    this.pinPollMaxAttempts = env.IPFS_PIN_POLL_MAX_ATTEMPTS ?? DEFAULT_PIN_POLL_MAX_ATTEMPTS;
    this.availabilityTimeoutMs = env.IPFS_AVAILABILITY_TIMEOUT_MS ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;
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
      const gatewayUrl = this.getGatewayUrl(cid);
      const pinId = typeof response.id === "string" ? response.id : "";

      // Probe the gateway first: it doubles as the pin-state fallback for
      // responses that do not carry a Pinata file id.
      const availability = await this.probeGatewayAvailability(cid);
      const pinningStatus = await this.resolvePinStatus(pinId, availability);

      return {
        cid,
        cidVersion: 1,
        size,
        name: response.name ?? name,
        timestamp: new Date().toISOString(),
        gatewayUrl,
        pinId,
        pinningStatus,
        availability,
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
   * Derive the real pin state for a freshly uploaded file.
   *
   * Pinata reports `cid: "pending"` on a file record until the pin has
   * propagated; a concrete CID means the pin is complete. We poll within a
   * bounded window so the response reflects reality instead of assuming the
   * upload succeeded. When Pinata reports a pending CID for the whole window
   * (or is unreachable) the upload is reported as `pinning`, never `pinned`.
   *
   * When Pinata did not return a file id we fall back to the gateway probe:
   * a CID the gateway already serves is pinned, otherwise it is still pinning.
   */
  async resolvePinStatus(pinId: string, availability: IpfsAvailability): Promise<IpfsPinStatus> {
    if (!pinId) {
      return availability.available ? "pinned" : "pinning";
    }

    const deadline = Date.now() + this.pinPollTimeoutMs;

    for (let attempt = 0; attempt < this.pinPollMaxAttempts; attempt += 1) {
      let pinned = false;
      let reachable = true;

      try {
        const file = await this.pinata.files.public.get(pinId);
        pinned = typeof file.cid === "string" && file.cid.length > 0 && file.cid !== "pending";
      } catch {
        reachable = false;
      }

      if (pinned) return "pinned";

      if (Date.now() >= deadline) break;
      if (reachable && Date.now() + this.pinPollIntervalMs > deadline) break;

      await delay(this.pinPollIntervalMs);
    }

    // Pinata never confirmed the pin within the window: report the truth.
    return "pinning";
  }

  /**
   * Probe whether the configured gateway currently serves a CID.
   * Bounded by `IPFS_AVAILABILITY_TIMEOUT_MS` and never throws: a gateway
   * error, timeout or non-2xx status is reported as unavailable.
   */
  async probeGatewayAvailability(cid: string): Promise<IpfsAvailability> {
    const checkedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.availabilityTimeoutMs);

    try {
      const response = await fetch(this.getGatewayUrl(cid), {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });
      // Availability only needs the status line; drop the body immediately.
      await response.body?.cancel();

      return { available: response.ok, httpStatus: response.status, checkedAt };
    } catch {
      return { available: false, httpStatus: null, checkedAt };
    } finally {
      clearTimeout(timer);
    }
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
