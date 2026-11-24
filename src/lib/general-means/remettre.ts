/**
 * L'ORDRE D'UNE REMISE DE CAISSE D'AVANCE — une seule rédaction (§118.176, §118.202).
 *
 * La remise mensuelle ET la rallonge accordée quittent la banque de la même façon : elles naissent
 * avec leur ORDRE DE DÉPENSE, en attente du centre de paiement, et rejoignent le fond une fois
 * autorisées puis versées. Ce module ne porte que la RÉDACTION de l'ordre (libellé, bénéficiaire,
 * entité, notes) ; les écritures restent dans le corps de chaque action, où la dérivation des
 * contrats les lit (§118.137 : partager la rédaction, jamais l'écriture). Module PUR.
 */
export interface DemandeRemise {
  departement: { name: string; companyId: string | null };
  periode: string;
  amount: number;
  holderName: string | null;
  createdById: string;
  nature: "REMISE" | "RALLONGE";
  /**
   * LE BON DE REMISE — le justificatif de la remise (justificatif obligatoire, 24/11/2026). Joint au geste, il part avec
   * l'ordre ; absent, l'ordre attend la pièce avant le centre, et les Moyens généraux la joignent au dossier de paiement.
   */
  bonDeRemise?: File | null;
}

export function ordreDeRemise(d: DemandeRemise) {
  const libelle = d.nature === "RALLONGE" ? "Rallonge de caisse d'avance" : "Caisse d'avance";
  return {
    label: `${libelle} — ${d.departement.name} (${d.periode})`,
    amount: d.amount,
    category: "AUTRE" as const,
    beneficiary: d.holderName ?? "Caisse d'avance",
    requestedById: d.createdById,
    companyId: d.departement.companyId,
    justificatif: d.bonDeRemise && d.bonDeRemise.size > 0 ? { fichier: d.bonDeRemise, nature: "CASH_VOUCHER" as const } : undefined,
    notes: `${d.nature === "RALLONGE" ? "Rallonge" : "Remise"} en caisse d'avance${d.holderName ? ` à ${d.holderName}` : ""} — ${d.departement.name}, ${d.periode}. Un achat payé sur la caisse s'impute ensuite à son budget : la remise elle-même ne se classe pas.`,
  };
}
