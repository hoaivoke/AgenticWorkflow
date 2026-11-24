// t3code-pm: `t3-pm` help and CLI errors name PM3code where upstream's descriptions say T3 Code.
import { pmBundleAppName } from "@t3tools/pm/identity";
import * as CliOutput from "effect/cli/CliOutput";

const upstream = CliOutput.defaultFormatter();

export const layerPmCliOutput = CliOutput.layer({
  formatHelpDoc: (doc) => pmBundleAppName(upstream.formatHelpDoc(doc)),
  formatCliError: (error) => pmBundleAppName(upstream.formatCliError(error)),
  formatError: (error) => pmBundleAppName(upstream.formatError(error)),
  formatVersion: (name, version) => pmBundleAppName(upstream.formatVersion(name, version)),
  formatErrors: (errors) => pmBundleAppName(upstream.formatErrors(errors)),
});
