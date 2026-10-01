/**
 * Domain types for the Certificate list endpoint.
 * The canonical ICertificate shape is defined in models/Certificate.model.ts.
 */
import mongoose from "mongoose";

/** Validated query parameters for GET /api/v1/certificates */
export interface ListCertificatesQuery {
  /**
   * Optional MongoDB ObjectId of the certificate owner.
   * When omitted, the endpoint returns the public global certificate index
   * across all creators (used by the frontend Global Certificate Search).
   */
  creatorId?: string;
  /**
   * Optional full-text-ish search term. Matched (case-insensitively) against
   * the on-chain `certificateId`, `transactionHash` and `contractAddress`.
   */
  search?: string;
  /** Maximum number of records to return (1–100, default 20). */
  limit: number;
  /** Number of records to skip for offset-based pagination (default 0). */
  skip: number;
}

/** Paginated response envelope for the certificate list endpoint. */
export interface CertificateListResult {
  certificates: Record<string, unknown>[];
  total: number;
  limit: number;
  skip: number;
}

/**
 * Normalized certificate payload shared by the off-chain cache and the
 * on-chain provenance record. `null` marks data that could not be resolved
 * on either side.
 */
export interface CertificateVerificationData {
  certificateId: string;
  storageId: string | null;
  manifestHash: string | null;
  attestationHash: string | null;
  creator: string | null;
  /** ISO-8601 timestamp. */
  timestamp: string | null;
}

/** Field-by-field equality between the cache and the ledger record. */
export interface CertificateVerificationChecks {
  storageId: boolean;
  manifestHash: boolean;
  attestationHash: boolean;
  creator: boolean;
  timestamp: boolean;
}

/** Full verification payload returned by GET /api/v1/certificates/verify/:id. */
export interface CertificateVerificationDetails {
  certificateId: string;
  network: 'testnet' | 'mainnet';
  contractAddress: string;
  offChain: CertificateVerificationData;
  onChain: CertificateVerificationData | null;
  checks: CertificateVerificationChecks;
  /** Human-readable list of fields that failed verification. */
  mismatches: string[];
}

/** Result envelope: `valid` is true only when every field matches. */
export interface CertificateVerificationResult {
  valid: boolean;
  details: CertificateVerificationDetails;
}

/** Standard JSON envelope returned by every endpoint. */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
