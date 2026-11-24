/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « OÙ EN EST MA DEMANDE ? » — les étapes d'une demande du délégué, lues de son état (interface du délégué, maquette
 * VALIDÉE le 24/11/2026). L'entrée et le SUIVI sont dans la Visite médicale ; le TRAITEMENT reste dans les modules
 * d'origine (Mon dossier RH, Ad & Pro) — ce module ne décide rien, il traduit un état déjà écrit en une ligne d'étapes.
 *
 * Les circuits sont ceux d'aujourd'hui :
 *   • ordre de mission : le N+1 (`managerGate`), puis les RH émettent l'ordre ;
 *   • note de frais : le N+1, les ORIGINAUX accusés au secrétariat, puis les RH (DECISIONS : « elles vont aux RH en
 *     passant par le supérieur hiérarchique ») ;
 *   • prise en charge : National Sales (approbation préliminaire), DG / Direction des opérations, Direction Marketing
 *     (les libellés de `CONGRESS_REQUEST_STATUS`).
 *
 * Module PUR — aucune importation : le navigateur, le serveur et les tests le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatEtape = "FAITE" | "EN_COURS" | "A_VENIR" | "REFUSEE";

export interface Etape {
  libelle: string;
  etat: EtatEtape;
  /** ISO, quand la base date l'étape. */
  le: string | null;
}

/** Ce qu'on lit d'une demande RH (ordre de mission, note de frais). */
export interface DemandeRhLue {
  type: "MISSION_ORDER" | "EXPENSE_REPORT";
  status: string;
  createdAt: string;
  managerGate: "PENDING" | "APPROVED" | "REJECTED" | null;
  managerDecidedAt: string | null;
  originalsAckAt: string | null;
  handledAt: string | null;
}

const FINIS_RH = new Set(["READY", "DELIVERED", "APPROVED"]);

/** Les étapes d'une demande RH, dans l'ordre du circuit. Une étape refusée arrête la ligne : la suite n'aura pas lieu. */
export function etapesDemandeRh(d: DemandeRhLue): Etape[] {
  const etapes: Etape[] = [{ libelle: "Envoyée", etat: "FAITE", le: d.createdAt }];
  const refusRh = d.status === "REJECTED";
  const annulee = d.status === "CANCELLED";
  if (d.managerGate) {
    etapes.push({
      libelle: "Accord du N+1",
      etat: d.managerGate === "APPROVED" ? "FAITE" : d.managerGate === "REJECTED" ? "REFUSEE" : annulee ? "A_VENIR" : "EN_COURS",
      le: d.managerGate === "PENDING" ? null : d.managerDecidedAt,
    });
  }
  const accordAcquis = !d.managerGate || d.managerGate === "APPROVED";
  if (d.type === "EXPENSE_REPORT") {
    etapes.push({
      libelle: "Originaux déposés au secrétariat",
      etat: d.originalsAckAt ? "FAITE" : accordAcquis && !refusRh && !annulee ? "EN_COURS" : "A_VENIR",
      le: d.originalsAckAt,
    });
  }
  const pretePourRh = accordAcquis && (d.type !== "EXPENSE_REPORT" || Boolean(d.originalsAckAt));
  etapes.push({
    libelle: d.type === "MISSION_ORDER" ? "RH : émission de l'ordre" : "Traitement RH",
    etat: refusRh ? "REFUSEE" : FINIS_RH.has(d.status) ? "FAITE" : pretePourRh && !annulee && d.managerGate !== "REJECTED" ? "EN_COURS" : "A_VENIR",
    le: FINIS_RH.has(d.status) || refusRh ? d.handledAt : null,
  });
  return etapes;
}

/** Les étapes d'une prise en charge (congrès national ou international), de l'état de la demande. */
export function etapesPriseEnCharge(statut: string, creeLe: string): Etape[] {
  const ordre = ["AWAITING_PRELIMINARY", "PRELIMINARY_APPROVED", "AWAITING_FINAL", "APPROVED"] as const;
  const rang = statut === "COMPLETED" ? ordre.length : (ordre as readonly string[]).indexOf(statut);
  const libelles = ["Approbation préliminaire — National Sales", "Validation DG / Direction des opérations", "Décision de la Direction Marketing"];
  const etapes: Etape[] = [{ libelle: "Envoyée", etat: "FAITE", le: creeLe }];
  libelles.forEach((libelle, i) => {
    // Refusée, annulée, renvoyée au demandeur : l'état le dit (sa pastille) ; on ne devine pas à quelle étape.
    const etat: EtatEtape = rang < 0 ? "A_VENIR" : i < rang ? "FAITE" : i === rang ? "EN_COURS" : "A_VENIR";
    etapes.push({ libelle, etat, le: null });
  });
  etapes.push({ libelle: "Pris en charge", etat: rang >= 3 ? "FAITE" : "A_VENIR", le: null });
  return etapes;
}

/** Une demande est-elle close (rien n'attend plus personne) ? */
export function demandeClose(etapes: readonly Etape[], statut: string): boolean {
  if (["CANCELLED", "REJECTED", "COMPLETED"].includes(statut)) return true;
  return etapes.some((e) => e.etat === "REFUSEE") || etapes.every((e) => e.etat === "FAITE");
}
