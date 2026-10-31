/**
 * LE DÉMARRAGE DU SERVEUR — Next.js appelle `register()` une fois par processus.
 *
 * Le puits d'usage IA (`ModelCallLog`) se branchait par effet d'import, au premier module qui le chargeait : un appel
 * de modèle parti AVANT était perdu en silence (audit K8, trou E10). Il est branché ici, au démarrage, côté Node.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("@/platform/ia/telemetry/usage-sink");
}
