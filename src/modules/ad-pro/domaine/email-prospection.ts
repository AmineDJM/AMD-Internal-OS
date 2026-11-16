/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'E-MAIL DE DEMANDE DE DEVIS AUX AGENCES (Direction, 16/11/2026) — « dans le cahier des charges, quand Radia commence
 * à chercher des agences, un bouton “Générer l'e-mail”, et cet e-mail doit être prêt à copier-coller ».
 *
 * Module PUR (aucun import) : la carte du poste l'appelle dans le navigateur. Le texte ne reprend que ce que l'ERP sait
 * — le poste, le cahier des charges écrit par la Direction Marketing, l'événement (nom, dates, lieu, ville) — et ne
 * promet rien d'autre (ni budget, ni délai inventé). L'assistante relit, ajuste, copie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EvenementDuPoste {
  nom: string;
  /** ISO ou `null`. */
  debut: string | null;
  fin: string | null;
  lieu: string | null;
  ville: string | null;
}

export interface EntreeEmailProspection {
  poste: string;
  cahierDesCharges: string;
  evenement: EvenementDuPoste | null;
  /** Qui signe — l'assistante qui prospecte. */
  signataire: string | null;
  societe?: string;
}

const jour = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Algiers" });
};

/** « le 12/12/2026 » ou « du 12/12/2026 au 13/12/2026 » — `null` sans date. */
export function periodeDeLEvenement(e: Pick<EvenementDuPoste, "debut" | "fin">): string | null {
  const d = jour(e.debut);
  const f = jour(e.fin);
  if (d && f && d !== f) return `du ${d} au ${f}`;
  return d ?? f ? `le ${d ?? f}` : null;
}

export function emailDeProspection(i: EntreeEmailProspection): { objet: string; corps: string } {
  const societe = i.societe?.trim() || "Adventum Pharma";
  const e = i.evenement;
  const poste = i.poste.trim();
  const objet = `Demande de devis — ${poste}${e?.nom ? ` — ${e.nom.trim()}` : ""}`;
  const contexte: string[] = [];
  if (e) {
    contexte.push(`Événement : ${e.nom.trim()}`);
    const periode = periodeDeLEvenement(e);
    if (periode) contexte.push(`Date : ${periode}`);
    const ou = [e.lieu?.trim(), e.ville?.trim()].filter(Boolean).join(", ");
    if (ou) contexte.push(`Lieu : ${ou}`);
  }
  const cahier = i.cahierDesCharges.trim();
  const corps = [
    "Madame, Monsieur,",
    "",
    `Dans le cadre de ${e?.nom ? `l'événement « ${e.nom.trim()} »` : "l'un de nos prochains événements"}, ${societe} souhaite recevoir votre meilleure offre pour la prestation suivante : ${poste}.`,
    "",
    ...(contexte.length ? [...contexte.map((l) => `• ${l}`), ""] : []),
    "Cahier des charges :",
    cahier,
    "",
    "Merci de nous faire parvenir un devis détaillé (désignation, quantités, prix unitaires HT, TVA et total TTC), en précisant sa durée de validité et vos délais de réalisation.",
    "",
    "Nous restons à votre disposition pour tout complément d'information.",
    "",
    "Cordialement,",
    ...(i.signataire?.trim() ? [i.signataire.trim()] : []),
    societe,
  ].join("\n");
  return { objet, corps };
}
