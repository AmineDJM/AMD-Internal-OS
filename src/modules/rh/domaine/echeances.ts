/**
 * LES ÉCHÉANCES D'UNE FICHE SALARIÉ (Super Admin, 24/11/2026 — échéances intégrées aux modules) — règles PURES.
 *
 * Trois dates que la fiche porte déjà (ou désormais) et qu'on ne doit pas laisser passer :
 *   · la FIN DE CONTRAT (CDD, stage, intérim…) — dépassée alors que la fiche est active, elle reste en rouge :
 *     la personne travaille sans contrat, ou le renouvellement n'a pas été saisi ;
 *   · la FIN DE PÉRIODE D'ESSAI — la renouvelée prime ; une fois passée, il n'y a plus rien à décider
 *     (l'essai est acquis), elle ne s'affiche donc plus ;
 *   · la PROCHAINE VISITE MÉDICALE DU TRAVAIL — dépassée, elle reste en rouge jusqu'à ce qu'une nouvelle date soit saisie.
 * Le CDI n'a pas de fin : une date saisie par erreur sur un CDI ne produit rien.
 */

export type GenreEcheanceRh = "contrat" | "essai" | "visite";

export interface FicheEcheances {
  fullName: string;
  contractType: string | null;
  contractEnd: Date | null;
  trialEnd: Date | null;
  trialRenewed: boolean;
  trialRenewalEnd: Date | null;
  prochaineVisiteMedicale: Date | null;
}

export interface EcheanceRh {
  genre: GenreEcheanceRh;
  libelle: string;
  date: Date;
}

const LIBELLE_FIN: Record<string, string> = {
  CDD: "Fin de CDD", STAGE: "Fin de stage", INTERIM: "Fin d'intérim", FREELANCE: "Fin de prestation", CONSULTING: "Fin de mission",
};

/** Le terme effectif de la période d'essai : la seconde période, quand elle a été renouvelée. */
export function finDEssai(f: Pick<FicheEcheances, "trialEnd" | "trialRenewed" | "trialRenewalEnd">): Date | null {
  return (f.trialRenewed ? f.trialRenewalEnd ?? f.trialEnd : f.trialEnd) ?? null;
}

/**
 * Les échéances de la fiche, au plus tard `jusquau`. `debutDuJour` : minuit du jour (Alger) — une période d'essai
 * finie avant ne compte plus.
 */
export function echeancesDeLaFiche(f: FicheEcheances, debutDuJour: Date, jusquau: Date): EcheanceRh[] {
  const out: EcheanceRh[] = [];
  const avantHorizon = (d: Date | null): d is Date => d !== null && d.getTime() <= jusquau.getTime();
  if (f.contractType !== "CDI" && avantHorizon(f.contractEnd)) {
    out.push({ genre: "contrat", libelle: `${LIBELLE_FIN[f.contractType ?? ""] ?? "Fin de contrat"} — ${f.fullName}`, date: f.contractEnd });
  }
  const essai = finDEssai(f);
  if (avantHorizon(essai) && essai.getTime() >= debutDuJour.getTime()) {
    out.push({ genre: "essai", libelle: `Fin de période d'essai — ${f.fullName}`, date: essai });
  }
  if (avantHorizon(f.prochaineVisiteMedicale)) {
    out.push({ genre: "visite", libelle: `Visite médicale du travail — ${f.fullName}`, date: f.prochaineVisiteMedicale });
  }
  return out;
}
