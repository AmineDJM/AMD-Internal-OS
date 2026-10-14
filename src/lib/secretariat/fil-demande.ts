/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DISCUSSION ou HISTORIQUE — séparer ce que les PERSONNES se sont dit de ce que le SYSTÈME a noté.
 *
 * La table `Comment` d'une demande mêle les deux : à côté des messages écrits à la main, sept
 * gestes y déposent une trace — signée de la personne qui a fait le geste, donc indiscernable par
 * l'auteur. Ils écrivent tous une phrase FIXE en tête ; c'est elle qui les reconnaît. La liste
 * ci-dessous est la seule source : un écrivain de trace ajouté au fil d'une demande doit y ajouter
 * sa tête de phrase, et le banc (`fil-demande.test.ts`) rejoue chacune.
 *
 *   « Demande rouverte — … »                          `rouvrirDemande`, `rouvrirDemandeAuSecretariat` (matériel promotionnel)
 *   « Demande bloquée — … »                           `updateRequestStatus` (blocage avec motif)
 *   « Demande corrigée par son demandeur : … »        `editOwnRequest` (hors fenêtre discrète)
 *   « Demande annulée par … : … »                     `annulerDemandeSecretariat` (secrétariat, demandeur, poste)
 *   « Correction de la retranscription demandée … »  `rouvrirDemandeAuSecretariat` (matériel promotionnel)
 *   « Statut : … »                                    `updateRequestStatus` (ancien menu libre)
 *
 * Un commentaire SANS auteur (compte supprimé, écriture d'un automate) est lui aussi une trace.
 *
 * L'Historique réunit ces traces et le journal d'audit (`AuditLog`) de la demande et de ses pièces,
 * dans l'ordre du temps ; la Discussion ne garde que les messages humains.
 *
 * Module PUR (aucun import).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TETES_DE_TRACE: readonly string[] = [
  "Demande rouverte",
  "Demande bloquée — ",
  "Demande corrigée par son demandeur : ",
  "Demande annulée ",
  "Correction de la retranscription demandée",
  "Statut : ",
];

/** Ce message est-il une trace du système (et non un message d'une personne) ? */
export function estTraceSysteme(c: { body: string; authorId: string | null }): boolean {
  if (!c.authorId) return true;
  const t = c.body.trimStart();
  return TETES_DE_TRACE.some((p) => t.startsWith(p));
}

export interface EntreeHistorique { id: string; le: string; texte: string; par: string | null; source: "TRACE" | "JOURNAL" }

/**
 * SÉPARER LE FIL. `commentaires` : les commentaires de la demande ; `journal` : les lignes d'audit
 * (de la demande et de ses pièces), déjà mises en phrase par l'appelant. L'historique sort dans
 * l'ordre CHRONOLOGIQUE (le plus ancien d'abord), la discussion garde l'ordre reçu.
 */
export function separerLeFil<C extends { id: string; body: string; authorId: string | null; createdAt: string; auteur?: string | null }>(
  commentaires: readonly C[],
  journal: readonly { id: string; le: string; texte: string; par: string | null }[],
): { discussion: C[]; historique: EntreeHistorique[] } {
  const discussion: C[] = [];
  const historique: EntreeHistorique[] = [];
  for (const c of commentaires) {
    if (estTraceSysteme(c)) historique.push({ id: `c:${c.id}`, le: c.createdAt, texte: c.body, par: c.auteur ?? null, source: "TRACE" });
    else discussion.push(c);
  }
  for (const j of journal) historique.push({ id: `j:${j.id}`, le: j.le, texte: j.texte, par: j.par, source: "JOURNAL" });
  historique.sort((a, b) => a.le.localeCompare(b.le));
  return { discussion, historique };
}
