/**
 * LE DÉMARRAGE DU SERVEUR — Next.js appelle `register()` une fois par processus.
 *
 * Le puits d'usage IA (`ModelCallLog`) se branchait par effet d'import, au premier module qui le chargeait : un appel
 * de modèle parti AVANT était perdu en silence (audit K8, trou E10). Il est branché ici, au démarrage, côté Node.
 *
 * LE BATTEMENT DES TÂCHES DE FOND, ARMÉ AU DÉMARRAGE (lot P1, décision 0047). Mesuré : il ne s'armait qu'au chargement de
 * `lib/scheduled.ts` — c'est-à-dire à la première requête qui l'importait (le badge des messages d'une page de l'ERP,
 * `/api/messaging/sync`). Après chaque déploiement, tant que personne n'ouvrait l'ERP, AUCUN processus web ne conduisait
 * les missions ; la Direction, qui travaille dans l'app Adventum IA (`TACHES_DE_FOND=worker` : elle ne bat jamais), voyait
 * ses missions « En cours · 0 % » pendant des heures quand le service worker n'était pas là. Le battement s'arme
 * maintenant dès le démarrage, là où l'interrupteur l'autorise (`battementWebArme` : web, les-deux ; jamais en test ni
 * pendant la compilation) — l'app, elle, n'importe rien de plus.
 */
export async function register(): Promise<void> {
  // La forme `if (NEXT_RUNTIME === "nodejs") { … }` est celle que la compilation élague pour l'edge : rien de Node n'y entre.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/platform/ia/telemetry/usage-sink");
    const { battementWebArme } = await import("@/lib/taches-de-fond/mode");
    if (battementWebArme()) await import("@/lib/scheduled");
  }
}
