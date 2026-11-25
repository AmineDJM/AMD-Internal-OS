import type { SessionUser } from "@/lib/rbac";
import { trierLignesBureau, type LigneBureau } from "@/lib/secretariat/ligne-bureau";
import { journal } from "@/lib/journal";
import { lignesDemandesSecretariat, lignesDevisPriseEnCharge, lignesFichesVoyage, lignesMaterielPromo } from "@/lib/queries/bureau-familles";
import { lignesBureauPecAchat, lignesBureauPecChiffrage } from "@/modules/ad-pro/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BUREAU DU SECRÉTARIAT, UN SEUL TABLEAU (Super Admin, 24/11/2026) — l'assemblage des familles.
 *
 * Chaque famille est UNE fonction `(user) => Promise<LigneBureau[]>` qui lit sa source existante
 * (`bureau-familles.ts`). Elles se lisent ENSEMBLE (`Promise.all`) ; une famille en échec n'éteint pas les
 * autres : ses lignes manquent, et la page DIT laquelle (`pannes`) au lieu de montrer un tableau
 * silencieusement incomplet. Deux familles qui désignent le même objet (`cleMetier`) n'en montrent qu'une
 * ligne : la première de la liste l'emporte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface FamilleBureau {
  cle: string;
  /** Ce que la page dit quand la famille n'a pas pu être lue (« les fiches billet et hôtel »). */
  libelle: string;
  lignes: (user: SessionUser) => Promise<LigneBureau[]>;
}

/**
 * LA PLACE DES PRISES EN CHARGE — « Chiffrage » et « Achat » (circuit d'achat v2, validé le 24/11/2026). Le lot qui les
 * implémente ajoute ici ses deux familles (`pec-chiffrage`, `pec-achat`) ; rien d'autre à brancher.
 */
export const FAMILLES_PRISE_EN_CHARGE: FamilleBureau[] = [
  { cle: "pec-chiffrage", libelle: "les chiffrages de prise en charge", lignes: lignesBureauPecChiffrage },
  { cle: "pec-achat", libelle: "les achats de prise en charge", lignes: lignesBureauPecAchat },
];

/**
 * L'ORDRE COMPTE pour les doublons : la première famille qui montre un objet le garde.
 *
 * NI LES POSTES AGENCE NI LES BC DE POSTE (Super Admin, 25/11/2026) : « Prospection d'agences » redevient un module à part,
 * la page de l'assistante (`/agences`) — ses postes et ses BC de poste n'y figurent qu'une fois, pas aussi ici.
 */
export const FAMILLES_BUREAU: FamilleBureau[] = [
  { cle: "demande", libelle: "les demandes du secrétariat", lignes: lignesDemandesSecretariat },
  { cle: "fiche-voyage", libelle: "les fiches billet et hôtel", lignes: lignesFichesVoyage },
  { cle: "promo", libelle: "le matériel promotionnel", lignes: lignesMaterielPromo },
  { cle: "devis-pec", libelle: "les devis de prise en charge", lignes: lignesDevisPriseEnCharge },
  ...FAMILLES_PRISE_EN_CHARGE,
];

/** Une ligne par objet métier : la première famille qui le montre le garde. */
export function sansDoublon(lignes: readonly LigneBureau[]): LigneBureau[] {
  const vus = new Set<string>();
  const out: LigneBureau[] = [];
  for (const l of lignes) {
    if (l.cleMetier) {
      if (vus.has(l.cleMetier)) continue;
      vus.add(l.cleMetier);
    }
    out.push(l);
  }
  return out;
}

export interface Bureau {
  lignes: LigneBureau[];
  /** Les familles qui n'ont pas pu être lues — la page le dit. */
  pannes: string[];
}

/** TOUTES LES LIGNES DU BUREAU pour cette personne — triées (`trierLignesBureau`), sans doublon. */
export async function lignesDuBureau(user: SessionUser, familles: readonly FamilleBureau[] = FAMILLES_BUREAU): Promise<Bureau> {
  const lus = await Promise.all(familles.map(async (f) => {
    try {
      return { f, lignes: await f.lignes(user) };
    } catch (e) {
      journal.erreur("bureau.famille-illisible", { famille: f.cle }, e);
      return { f, lignes: null };
    }
  }));
  return {
    lignes: trierLignesBureau(sansDoublon(lus.flatMap((x) => x.lignes ?? []))),
    pannes: lus.filter((x) => x.lignes === null).map((x) => x.f.libelle),
  };
}
