/**
 * CRÉER UN DOCUMENT OFFICE — le côté écran, sans aucun import (composants client).
 *
 * « Quand quelqu'un crée un document Office depuis le Drive, ça tourne et ça ne crée rien. » Les trois
 * portes (bouton « Nouveau document », clic droit du Drive, lanceur /office) faisaient
 * `setBusy(true); const r = await createOfficeNode(fd); setBusy(false)` : si l'appel REJETTE (erreur
 * serveur non rattrapée, action introuvable après un déploiement, connexion coupée, délai du proxy),
 * la ligne `setBusy(false)` n'est jamais atteinte — la roue tourne pour toujours, sans un mot.
 *
 * Ici, une seule règle pour les trois : l'appel finit TOUJOURS, par un identifiant ou par une phrase
 * en français qui dit quoi faire. Un délai borne l'attente : passé ce délai, on rend la main en
 * prévenant que le document a PEUT-ÊTRE été créé (l'appel serveur, lui, n'est pas annulable).
 */

/** Au-delà, on rend la main : une création normale prend moins d'une seconde. */
export const DELAI_CREATION_OFFICE_MS = 45_000;

/** Délai de chargement du script de l'éditeur (api.js du Document Server) avant de le dire. */
export const DELAI_EDITEUR_OFFICE_MS = 30_000;

export const MESSAGE_DELAI_CREATION =
  "La création du document prend trop de temps. Il a peut-être été créé malgré tout : "
  + "actualisez le Drive avant de réessayer. Si cela se reproduit, signalez-le à l'administrateur.";

const MESSAGE_GENERIQUE =
  "Le document n'a pas pu être créé. Réessayez ; si cela persiste, signalez-le à l'administrateur.";

class DelaiDepasse extends Error {}

/** Rejette avec `message` si `p` ne s'est pas réglée au bout de `ms` millisecondes. */
export function avecDelai<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<never>((_, rejeter) => {
    minuterie = setTimeout(() => rejeter(new DelaiDepasse(message)), ms);
  });
  return Promise.race([p, delai]).finally(() => clearTimeout(minuterie));
}

/** La phrase à afficher quand l'appel a levé au lieu de répondre. */
export function messageEchecCreation(err: unknown): string {
  if (err instanceof DelaiDepasse) return err.message;
  const brut = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // Onglet ouvert avant une mise en production : l'identifiant de l'action n'existe plus côté serveur.
  if (/server action/i.test(brut) && /(find|not found|introuvable)/i.test(brut)) {
    return "L'application a été mise à jour depuis l'ouverture de cette page : rechargez-la (F5) puis recommencez.";
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(brut)) {
    return "La connexion au serveur a été interrompue. Vérifiez votre connexion puis réessayez.";
  }
  return MESSAGE_GENERIQUE;
}

export type IssueCreation = { ok: true; id: string } | { ok: false; error: string };

/**
 * Exécute l'appel de création et rend TOUJOURS une issue : l'identifiant du document, ou une erreur
 * lisible. Ne lève jamais — l'appelant peut donc remettre son indicateur à zéro sans `finally`.
 */
export async function executerCreationOffice(
  appel: () => Promise<{ ok: boolean; id?: string; error?: string }>,
  ms: number = DELAI_CREATION_OFFICE_MS,
): Promise<IssueCreation> {
  try {
    const r = await avecDelai(appel(), ms, MESSAGE_DELAI_CREATION);
    if (r && r.ok && r.id) return { ok: true, id: r.id };
    return { ok: false, error: r?.error || MESSAGE_GENERIQUE };
  } catch (err) {
    return { ok: false, error: messageEchecCreation(err) };
  }
}
