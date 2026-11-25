export interface AnchorCallArgs {
  signer: string;
  chainId: string;
  layerId: string;
  layerHeight: string;
  stateRoot: string;
  validatorSetHash: string;
  txCount: string;
}

export const EVM_RPC: string;
export function encodeIsAnchorRecorded(call: AnchorCallArgs): string;
export function withOneDigitChanged(call: AnchorCallArgs): AnchorCallArgs;
export function askContract(
  contract: string,
  call: AnchorCallArgs,
  fetchImpl?: typeof fetch,
): Promise<boolean>;
