/**
 * Pin propagation state for an uploaded CID as reported by Pinata.
 * - `pinning`: the upload was accepted but the pin has not finished
 *   propagating, so clients must keep the upload in a pending state.
 * - `pinned`:  Pinata reports a concrete CID, i.e. the pin is complete.
 */
export type IpfsPinStatus = "pinning" | "pinned";

/**
 * Availability of an uploaded CID on the configured gateway at response time.
 * Never assume availability — it is probed after the pin is requested.
 */
export interface IpfsAvailability {
  /** True when the gateway served the CID within the probe timeout. */
  available: boolean;
  /** HTTP status returned by the gateway, or null when no response was received. */
  httpStatus: number | null;
  /** ISO-8601 timestamp of the availability probe. */
  checkedAt: string;
}

export interface IpfsUploadResult {
  /** Canonical CIDv1 (base32) returned by Pinata as the IpfsHash. */
  cid: string;
  /** CID version the content was pinned with. Always 1. */
  cidVersion: 1;
  size: number;
  name: string;
  timestamp: string;
  gatewayUrl: string;
  /** Pinata pin record id, used to re-check pin state after the upload. */
  pinId: string;
  /**
   * Pinata pin state at response time. Derived by polling Pinata (not assumed),
   * so the frontend progression UI can reflect whether the CID is still pending.
   */
  pinningStatus: IpfsPinStatus;
  /** Gateway reachability for the CID, probed before the response is returned. */
  availability: IpfsAvailability;
}

export interface IpfsUploadInput {
  content: Buffer | Record<string, unknown>;
  name?: string;
  metadata?: Record<string, string>;
}
