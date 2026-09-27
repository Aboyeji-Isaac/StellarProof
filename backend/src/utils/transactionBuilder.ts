/**
 * Soroban transaction construction and signing for oracle-side contract calls.
 *
 * Every transaction built here:
 *   - pays `BASE_FEE` as its inclusion fee (simulation adds the resource fee),
 *   - expires `TX_TIMEOUT_SECONDS` after construction via `setTimeout`,
 *   - is simulated by the RPC and assembled before signing, so the footprint,
 *     resource fee and authorisation entries are part of what gets signed.
 *
 * Arguments are expected to be pre-serialized with `utils/xdr.ts`, which
 * enforces the contracts' parameter layouts.
 */
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { TransactionSimulationError } from "../errors/SorobanTransactionError";
import { XdrValidationError } from "./xdr";

/** Transactions are only valid for this many seconds after construction. */
export const TX_TIMEOUT_SECONDS = 30;

/** The subset of `rpc.Server` the builder depends on. */
export interface SorobanTransactionSource {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

export interface ContractCall {
  /** C-address of the target contract. */
  contractId: string;
  /** Contract function name, e.g. `mint`. */
  method: string;
  /** Ordered arguments produced by the `utils/xdr.ts` builders. */
  args: xdr.ScVal[];
}

export interface BuildSignedContractTransactionParams {
  client: SorobanTransactionSource;
  keypair: Keypair;
  networkPassphrase: string;
  call: ContractCall;
}

export interface SignedContractTransaction {
  /** Hex transaction hash, known before submission. */
  hash: string;
  /** Base64 signed transaction envelope XDR. */
  xdr: string;
  transaction: Transaction;
}

function assertContractCall(call: ContractCall): void {
  if (!StrKey.isValidContract(call.contractId)) {
    throw new XdrValidationError("contractId", "expected a valid Soroban C... contract address");
  }
  if (!call.method) {
    throw new XdrValidationError("method", "expected a non-empty contract function name");
  }
}

/**
 * Builds an unsigned, unprepared contract invocation. The source account's
 * sequence number is incremented by `TransactionBuilder.build()`.
 */
export function buildContractCallTransaction(
  source: Account,
  call: ContractCall,
  networkPassphrase: string
): Transaction {
  assertContractCall(call);

  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(call.contractId).call(call.method, ...call.args))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
}

/**
 * Loads the signer's account, builds the invocation, simulates and assembles
 * it, and signs it with the supplied keypair.
 *
 * @throws TransactionSimulationError when simulation rejects the invocation.
 */
export async function buildSignedContractTransaction(
  params: BuildSignedContractTransactionParams
): Promise<SignedContractTransaction> {
  const { client, keypair, networkPassphrase, call } = params;

  const source = await client.getAccount(keypair.publicKey());
  const unsigned = buildContractCallTransaction(source, call, networkPassphrase);
  const simulation = await client.simulateTransaction(unsigned);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new TransactionSimulationError(`Simulation of ${call.method} failed: ${simulation.error}`);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new TransactionSimulationError(
      `Simulation of ${call.method} requires restoring archived ledger entries first`
    );
  }

  const prepared = rpc.assembleTransaction(unsigned, simulation).build();

  prepared.sign(keypair);

  return {
    hash: prepared.hash().toString("hex"),
    xdr: prepared.toXDR(),
    transaction: prepared,
  };
}
