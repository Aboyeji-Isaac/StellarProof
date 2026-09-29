import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../../errors/AppError";
import { toBytesN32ScVal } from "../../utils/xdr";
import type {
  ContractTransactionClient,
  ContractTransactionResult,
} from "./ContractTransactionClient";

export class RegistryContract {
  constructor(
    private readonly contractId: string,
    private readonly signer: Keypair,
    private readonly client: ContractTransactionClient
  ) {
    if (!StrKey.isValidContract(contractId)) {
      throw new AppError(
        "STELLAR_REGISTRY_CONTRACT_ID must be a valid contract address",
        StatusCodes.INTERNAL_SERVER_ERROR,
        "REGISTRY_CONFIG_INVALID"
      );
    }
  }

  addTeeHash(hash: string): Promise<ContractTransactionResult> {
    return this.invoke("add_tee_hash", toBytesN32ScVal(hash, "hash"));
  }

  removeTeeHash(hash: string): Promise<ContractTransactionResult> {
    return this.invoke("remove_tee_hash", toBytesN32ScVal(hash, "hash"));
  }

  addProvider(providerPublicKey: string): Promise<ContractTransactionResult> {
    return this.invoke("add_provider", this.providerArg(providerPublicKey));
  }

  removeProvider(providerPublicKey: string): Promise<ContractTransactionResult> {
    return this.invoke("remove_provider", this.providerArg(providerPublicKey));
  }

  private providerArg(providerPublicKey: string) {
    if (!StrKey.isValidEd25519PublicKey(providerPublicKey)) {
      throw new AppError(
        "provider must be a valid Stellar public key",
        StatusCodes.BAD_REQUEST,
        "INVALID_PROVIDER"
      );
    }
    return toBytesN32ScVal(
      Buffer.from(StrKey.decodeEd25519PublicKey(providerPublicKey)).toString("hex"),
      "provider"
    );
  }

  private invoke(method: string, arg: ReturnType<typeof toBytesN32ScVal>) {
    return this.client.submit(
      { contractId: this.contractId, method, args: [arg] },
      this.signer
    );
  }
}
