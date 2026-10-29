import type { AdProItemOrderStage } from "@prisma/client";
import { motifSousLeSeuil, validationRequiseBC } from "@/lib/bons-de-commande/regle";
import { montantDzd } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE VISA D'UN BON DE COMMANDE DE POSTE NE COUVRE QUE CE QU'IL A VU (§118.187 — audit 360°, R05).
 *
 * Mesuré par l'audit : la Direction accorde un poste à 100 000 DZD, le centre de validation Ad & Pro
 * vise la demande de BC, puis le montant passe à 900 000 DZD et le prestataire change — et les
 * Finances émettent un ordre de 900 000 DZD au NOUVEAU fournisseur, sous le visa donné pour l'ancien.
 * L'émission lisait les valeurs du jour ; rien ne comparait ce qui part à ce qui avait été validé.
 * L'empreinte réelle d'un engagement ne dépasse jamais l'empreinte validée (§118.16).
 *
 * D'où une EMPREINTE posée au visa du centre (`orderVisaAmount`, `orderVisaSupplier` : ce qu'il a VU —
 * et rien sous le seuil, où aucun centre n'a rien vu et où cette règle ne la lirait pas), et cette
 * règle, lue par chaque écrivain du montant et du prestataire ET par l'émission elle-même — le dernier
 * rempart, qui ne dépend pas du chemin qui a changé le chiffre :
 *
 *   • BC VISÉ par le centre, montant RELEVÉ au-delà de l'empreinte, ou prestataire CHANGÉ → le visa
 *     ROUVRE : le centre revoit la demande. Baisser ne rouvre rien — c'est un geste qui RÉDUIT ;
 *   • BC passé SOUS LE SEUIL, montant porté AU-DESSUS → il ROUVRE aussi : aucun centre ne l'avait vu ;
 *   • BC EN ATTENTE au centre que le montant fait passer SOUS le seuil → la validation qui attendait
 *     n'a plus d'objet : il passe aux Finances (la même règle que les BC du registre Legal) ;
 *   • tout le reste → RIEN : le centre lit le poste en direct tant qu'il n'a pas tranché, et un refus
 *     ne se contourne pas en retouchant le montant.
 *
 * Le PRESTATAIRE compte autant que le montant : c'est à lui que l'argent part. Un prestataire d'abord
 * vide qu'on renseigne CHANGE le bénéficiaire (vide, l'ordre part au bénéficiaire de l'opération) —
 * il rouvre donc, à l'inverse d'un montant d'abord inconnu.
 *
 * Une empreinte ABSENTE (visa d'avant cette règle) se lit sur la valeur d'avant la modification :
 * c'est la meilleure connaissance de ce qui a été vu, et le geste reste le plus prudent qu'on sache
 * justifier. À l'émission d'un tel BC, rien n'est comparé — on ne refuse pas ce qu'on ne sait pas
 * lire (§118.16).
 *
 * Module PUR : l'écran, les actions et leurs bancs en ont besoin sans avoir le droit de se parler.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que le poste porte de son bon de commande au moment où l'on décide. */
export interface EtatBcPoste {
  etape: AdProItemOrderStage;
  /** Le centre a-t-il VISÉ (`orderDirectionAt` posé) ? Sinon `DIRECTION_OK` veut dire « sous le seuil ». */
  viseParLeCentre: boolean;
  /** L'empreinte du visa — `null` pour un visa d'avant cette règle. */
  montantVise: number | null;
  fournisseurVise: string | null;
  /** Les valeurs AVANT la modification : le repli d'une empreinte absente. */
  montantAvant: number | null;
  fournisseurAvant: string | null;
}

export type GesteVisaPoste =
  | { geste: "RIEN" }
  /** `DIRECTION_OK` → `REQUESTED` : le centre revoit la demande. */
  | { geste: "ROUVRIR"; motif: string }
  /** `REQUESTED` → `DIRECTION_OK` sans centre : la validation qui attendait n'a plus d'objet. */
  | { geste: "SOUS_LE_SEUIL"; motif: string };

/** Deux libellés de prestataire désignent-ils le même ? Casse, accents et espaces mis à part. */
export function memePrestataire(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) =>
    (s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  return n(a) === n(b);
}

/**
 * À QUI PART LE PAIEMENT D'UN POSTE À BON DE COMMANDE (audit Ad & Pro, 14/10) — au fournisseur que ses factures nomment
 * (la pièce du registre porte celui du BC signé), quand elles en nomment UN, le même partout. Sinon le prestataire saisi
 * sur le poste, sinon le bénéficiaire de l'opération. Le « prestataire » du poste est un texte libre, souvent vide : il
 * ne doit pas l'emporter sur le fournisseur qui a émis la facture qu'on paie.
 */
export function beneficiaireDuPaiement(
  fournisseursDesFactures: readonly (string | null | undefined)[],
  prestatairePoste: string | null | undefined,
  beneficiaireOperation: string,
): string {
  const noms = fournisseursDesFactures.map((s) => (s ?? "").trim());
  if (noms.length > 0 && noms.every((n) => n !== "") && noms.every((n) => memePrestataire(n, noms[0]))) return noms[0];
  return prestatairePoste?.trim() || beneficiaireOperation;
}

const libellePrestataire = (s: string | null) => (s && s.trim() ? `« ${s.trim()} »` : "le bénéficiaire de l'opération");

export function gesteVisaPoste(
  e: EtatBcPoste,
  apres: { montant: number | null; fournisseur: string | null },
  seuil: number | null,
): GesteVisaPoste {
  const requise = validationRequiseBC(apres.montant, seuil);
  if (e.etape === "REQUESTED") {
    return requise ? { geste: "RIEN" } : { geste: "SOUS_LE_SEUIL", motif: motifSousLeSeuil(seuil ?? 0) };
  }
  if (e.etape !== "DIRECTION_OK") return { geste: "RIEN" };
  // Validé, ou passé sous le seuil, et toujours sous le seuil : aucun centre n'a à le revoir.
  if (!requise) return { geste: "RIEN" };
  if (!e.viseParLeCentre) {
    return {
      geste: "ROUVRIR",
      motif: `Montant porté à ${apres.montant != null ? montantDzd(apres.montant) : "un montant inconnu"}, au-dessus du seuil de validation des bons de commande${typeof seuil === "number" && seuil > 0 ? ` (${montantDzd(seuil)})` : ""} : le centre de validation Ad & Pro doit le viser.`,
    };
  }
  const montantRef = e.montantVise ?? e.montantAvant;
  if (montantRef != null && apres.montant != null && apres.montant > montantRef) {
    return { geste: "ROUVRIR", motif: `Montant relevé de ${montantDzd(montantRef)} à ${montantDzd(apres.montant)} après la validation du centre.` };
  }
  const fournisseurRef = e.montantVise != null || e.fournisseurVise != null ? e.fournisseurVise : e.fournisseurAvant;
  if (!memePrestataire(fournisseurRef, apres.fournisseur)) {
    return {
      geste: "ROUVRIR",
      motif: `Prestataire changé après la validation du centre : ${libellePrestataire(fournisseurRef)} → ${libellePrestataire(apres.fournisseur)}.`,
    };
  }
  return { geste: "RIEN" };
}
