export interface IpfsUploadResult {
  /** Canonical CIDv1 (base32) returned by Pinata as the IpfsHash. */
  cid: string;
  /** CID version the content was pinned with. Always 1. */
  cidVersion: 1;
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
