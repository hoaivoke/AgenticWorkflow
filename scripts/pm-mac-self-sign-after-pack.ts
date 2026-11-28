// @effect-diagnostics nodeBuiltinImport:off
// pipelines: signs the fork's macOS app with one stable self-signed identity, so Squirrel.Mac
// accepts each update as coming from the same signer. Runs in afterSign (after @electron/fuses
// flips fuses and before the zip and DMG are made).
import * as NodePath from "node:path";

import { sign } from "@electron/osx-sign";

interface AfterSignContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

export default async function afterSign(context: AfterSignContext): Promise<void> {
  const { PM_MAC_SIGN_IDENTITY: identity, PM_MAC_SIGN_KEYCHAIN: keychain } = process.env;
  if (context.electronPlatformName !== "darwin" || !identity) return;
  await sign({
    app: NodePath.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    identity,
    // A self-signed certificate is never a "valid" identity to security find-identity.
    identityValidation: false,
    ...(keychain ? { keychain } : {}),
    platform: "darwin",
    preAutoEntitlements: false,
    // Hardened runtime only matters for notarization, which a self-signed app cannot get.
    optionsForFile: () => ({ hardenedRuntime: false }),
    batchCodesignCalls: true,
  });
}
