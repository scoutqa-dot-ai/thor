export function formatThorDisclaimerFooter(triggerUrl: string): string {
  return [
    "",
    "---",
    `Created by Thor, an AI assistant. This content may be wrong; review carefully and do not trust it blindly. [View Thor trigger](${triggerUrl})`,
  ].join("\n");
}
