export interface IpfsUploadResult {
  cid: string;
  size: number;
  name: string;
  timestamp: string;
  gatewayUrl: string;
}

export interface IpfsUploadInput {
  content: Buffer | Record<string, unknown>;
  name?: string;
  metadata?: Record<string, string>;
}

export interface IpfsPinInput {
  cid: string;
  name?: string;
  metadata?: Record<string, string>;
}

/** A pin-by-CID request queued with Pinata. */
export interface IpfsPinResult {
  id: string;
  cid: string;
  name: string;
  status: string;
  queuedAt: string;
}

export interface IpfsUnpinResult {
  cid: string;
  /** False when Pinata held no pin for the CID (already released). */
  unpinned: boolean;
  /** Pinata file ids that were deleted. */
  fileIds: string[];
}

export interface IpfsPinListQuery {
  limit?: number;
  pageToken?: string;
  cid?: string;
}

export interface IpfsPin {
  id: string;
  cid: string;
  name: string | null;
  size: number;
  mimeType: string;
  keyvalues: Record<string, string>;
  createdAt: string;
}

export interface IpfsPinListResult {
  pins: IpfsPin[];
  nextPageToken: string | null;
}

/** A Pinata pin annotated with the StellarProof records that reference it. */
export interface TrackedIpfsPin extends IpfsPin {
  tracked: boolean;
  trackedAssetIds: string[];
  trackedManifestIds: string[];
}

export interface TrackedIpfsPinListResult {
  pins: TrackedIpfsPin[];
  nextPageToken: string | null;
}

export type PinReleaseSkipReason = "referenced" | "invalid_cid";

export interface PinReleaseOutcome {
  cid: string;
  released: boolean;
  /** Pinata file ids that were deleted. */
  fileIds: string[];
  /** Why the pin was intentionally kept. */
  skippedReason?: PinReleaseSkipReason;
}
