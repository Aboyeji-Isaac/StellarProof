import { scValToNative, StrKey } from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../../errors/AppError";
import { toBytesN32ScVal } from "../../utils/xdr";
import type { ContractQueryClient } from "./ContractReader";

export class RegistryContract {
  constructor(
    private readonly contractId: string,
    private readonly client: ContractQueryClient
  ) {
    if (!StrKey.isValidContract(contractId)) {
      throw new AppError(
        "STELLAR_REGISTRY_CONTRACT_ID must be a valid contract address",
        StatusCodes.INTERNAL_SERVER_ERROR,
        "REGISTRY_CONFIG_INVALID"
      );
    }
  }

  async isVerified(teeHash: string, providerPublicKey: string): Promise<boolean> {
    if (!StrKey.isValidEd25519PublicKey(providerPublicKey)) {
      throw new AppError(
        "Provider must be a valid Stellar public key",
        StatusCodes.BAD_REQUEST,
        "INVALID_PROVIDER"
      );
    }

    const providerHex = Buffer.from(
      StrKey.decodeEd25519PublicKey(providerPublicKey)
    ).toString("hex");
    const result = await this.client.invoke({
      contractId: this.contractId,
      method: "is_verified",
      args: [
        toBytesN32ScVal(teeHash, "teeHash"),
        toBytesN32ScVal(providerHex, "provider"),
      ],
    });

    const value: unknown = scValToNative(result);
    if (typeof value !== "boolean") {
      throw new AppError(
        "Registry is_verified returned an invalid response",
        StatusCodes.BAD_GATEWAY,
        "REGISTRY_INVALID_RESPONSE"
      );
    }
    return value;
  }
}
