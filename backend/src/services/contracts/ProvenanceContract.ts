import {
  Keypair,
  scValToNative,
  StrKey,
  type Transaction,
} from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../../errors/AppError";
import type { SorobanService } from "../soroban.service";
import { buildMintArgs, toU64ScVal, type MintArgs } from "../../utils/xdr";
import type { ContractQueryClient } from "./ContractReader";

export interface PreparedMint {
  transactionHash: string;
  transaction: Transaction;
}

export interface ProvenanceCertificate {
  storageId: string;
  manifestHash: string;
  attestationHash: string;
  creator: string;
  timestamp: string;
}

export interface MintConfirmation {
  transactionHash: string;
  certificateId: string;
  ledgerSequence: number;
  mintedAt: Date;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ProvenanceContract {
  private readonly soroban: Pick<
    SorobanService,
    | "loadAccount"
    | "simulate"
    | "sendTransaction"
    | "getTransaction"
    | "networkPassphrase"
  >;

  constructor(
    private readonly contractId: string,
    private readonly signer: Keypair,
    soroban?: Pick<
      SorobanService,
      | "loadAccount"
      | "simulate"
      | "sendTransaction"
      | "getTransaction"
      | "networkPassphrase"
    >,
    private readonly confirmationTimeoutMs = 120_000,
    private readonly pollIntervalMs = 1_000,
    private readonly queryClient?: ContractQueryClient
  ) {
    if (!StrKey.isValidContract(contractId)) {
      throw new AppError(
        "STELLAR_PROVENANCE_CONTRACT_ID must be a valid contract address",
        StatusCodes.INTERNAL_SERVER_ERROR,
        "PROVENANCE_CONFIG_INVALID"
      );
    }
    this.soroban = soroban ?? (require("../soroban.service") as typeof import("../soroban.service")).sorobanService;
  }

  async getCertificate(certificateId: bigint | number): Promise<ProvenanceCertificate> {
    if (!this.queryClient) {
      throw new AppError(
        "Provenance query client is not configured",
        StatusCodes.INTERNAL_SERVER_ERROR,
        "PROVENANCE_QUERY_NOT_CONFIGURED"
      );
    }

    const result = await this.queryClient.invoke({
      contractId: this.contractId,
      method: "get_certificate",
      args: [toU64ScVal(certificateId, "certificateId")],
    });
    const value = scValToNative(result) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AppError(
        "Provenance get_certificate returned an invalid response",
        StatusCodes.BAD_GATEWAY,
        "PROVENANCE_INVALID_RESPONSE"
      );
    }
    const record = value as Record<string, unknown>;
    const storageId = record.storage_id ?? record.storageId;
    const manifestHash = record.manifest_hash ?? record.manifestHash;
    const attestationHash = record.attestation_hash ?? record.attestationHash;
    const creator = record.creator;
    const timestamp = record.timestamp;

    if (
      typeof storageId !== "string" ||
      typeof manifestHash !== "string" ||
      typeof attestationHash !== "string" ||
      typeof creator !== "string" ||
      (typeof timestamp !== "bigint" && typeof timestamp !== "number")
    ) {
      throw new AppError(
        "Provenance get_certificate returned malformed certificate fields",
        StatusCodes.BAD_GATEWAY,
        "PROVENANCE_INVALID_RESPONSE"
      );
    }

    return {
      storageId,
      manifestHash,
      attestationHash,
      creator,
      timestamp: String(timestamp),
    };
  }

  async prepareMint(input: MintArgs): Promise<PreparedMint> {
    const { buildSignedContractTransaction } = require("../../utils/transactionBuilder") as typeof import("../../utils/transactionBuilder");
    const signed = await buildSignedContractTransaction({
      client: {
        getAccount: (address) => this.soroban.loadAccount(address),
        simulateTransaction: (transaction) => this.soroban.simulate(transaction),
      },
      keypair: this.signer,
      networkPassphrase: this.soroban.networkPassphrase,
      call: {
        contractId: this.contractId,
        method: "mint",
        args: buildMintArgs(input),
      },
    });
    return { transactionHash: signed.hash, transaction: signed.transaction };
  }

  async submit(prepared: PreparedMint): Promise<void> {
    await this.soroban.sendTransaction(prepared.transaction);
  }

  async confirm(transactionHash: string): Promise<MintConfirmation> {
    const deadline = Date.now() + this.confirmationTimeoutMs;
    while (Date.now() < deadline) {
      const result = await this.soroban.getTransaction(transactionHash);
      if (result.status === "SUCCESS") {
        if (!result.returnValue) {
          throw new AppError(
            "Provenance mint returned no certificate ID",
            StatusCodes.BAD_GATEWAY,
            "MINT_RESULT_MISSING"
          );
        }
        const certificateId = scValToNative(result.returnValue);
        if (typeof certificateId !== "bigint" && typeof certificateId !== "number") {
          throw new AppError(
            "Provenance mint returned an invalid certificate ID",
            StatusCodes.BAD_GATEWAY,
            "MINT_RESULT_INVALID"
          );
        }
        return {
          transactionHash,
          certificateId: String(certificateId),
          ledgerSequence: result.ledger,
          mintedAt: new Date(result.createdAt * 1_000),
        };
      }
      if (result.status === "FAILED") {
        throw new AppError(
          `Provenance mint transaction ${transactionHash} failed on-chain`,
          StatusCodes.UNPROCESSABLE_ENTITY,
          "MINT_TRANSACTION_FAILED"
        );
      }
      await wait(this.pollIntervalMs);
    }

    throw new AppError(
      `Timed out confirming mint transaction ${transactionHash}`,
      StatusCodes.GATEWAY_TIMEOUT,
      "MINT_CONFIRMATION_TIMEOUT"
    );
  }
}
