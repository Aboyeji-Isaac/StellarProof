/**
 * Verification Worker - manifest re-hash and integrity comparison.
 *
 * Responsibilities:
 * - `verifyManifestForJob`: runs the manifest integrity check for a single
 *   VerificationJob (fetch manifest JSON from IPFS, recompute its
 *   deterministic hash, compare to the on-chain/stored `manifestHash`).
 *   Rejects (marks the job `failed`) on mismatch.
 * - `startManifestRehashWorker`: periodically scans `pending` jobs that have
 *   an associated manifest and runs the check on each, mirroring the
 *   scan-and-update pattern used by `verificationTimeout.job.ts`.
 */
import cron from "node-cron";
import { VerificationJobModel } from "../models/verificationJob.model";
import { verificationService } from "../services/verification.service";
import { VerificationStatus } from "../types/verification.types";
import type { IVerificationJob } from "../types/verification.types";

/**
 * Runs the manifest integrity check for a single job. Fetches the
 * manifest's stored JSON from IPFS, recomputes its deterministic hash, and
 * compares it to the manifest's recorded `manifestHash`. On mismatch, the
 * job is transitioned to `failed`.
 */
export async function verifyManifestForJob(
  jobId: string
): Promise<IVerificationJob> {
  return verificationService.verifyManifestIntegrity(jobId);
}

/**
 * Starts a scheduled scan of `pending` verification jobs that have an
 * associated manifest, running the manifest re-hash check on each.
 */
export function startManifestRehashWorker(): void {
  // Run every minute, alongside the existing timeout job.
  cron.schedule("* * * * *", async () => {
    try {
      const pendingJobs = await VerificationJobModel.find({
        status: VerificationStatus.PENDING,
        manifestId: { $exists: true, $ne: null },
      }).lean<IVerificationJob[]>();

      for (const job of pendingJobs) {
        try {
          await verifyManifestForJob(job._id as string);
        } catch (error) {
          console.error(
            `[ManifestRehashWorker] Failed to verify job '${job._id}':`,
            error
          );
        }
      }
    } catch (error) {
      console.error(
        "[ManifestRehashWorker] Failed to scan pending verification jobs:",
        error
      );
    }
  });
}