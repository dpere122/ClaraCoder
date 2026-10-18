/**
 * Payload of the retired copy confirmation card. Copies now run without approval; this type stays
 * only so `copy_confirm` messages saved in older conversations still load and show in the trail.
 */
export interface CopyConfirmItem {
  sourcePath: string;
  destinationPath: string;
}

export interface CopyConfirmPayload {
  version: 1;
  requestId: string;
  copies: CopyConfirmItem[];
  overwrite: boolean;
}
