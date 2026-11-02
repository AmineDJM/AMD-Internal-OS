import { getAppSettings } from "@/lib/settings";
import { validationRequiseBC, motifSousLeSeuil } from "@/lib/bons-de-commande/regle";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MARCHE DU BC D'UN POSTE (§118.149, §118.206) — la demande part au centre Ad & Pro au-dessus du seuil,
 * directement aux Finances en deçà.
 *
 * Une SEULE lecture de « où le poste passe-t-il quand on ouvre son BC ? », partagée par les deux chemins qui l'ouvrent :
 * la demande à l'assistante (`requestAdProItemOrder`) et la génération d'après les lignes validées d'un devis
 * (`genererBonDeCommandePoste`). Deux copies de « le poste passe à REQUESTED ou DIRECTION_OK » finiraient par ne plus
 * s'accorder sur le seuil (§118.5).
 *
 * ON PARTAGE LA RÈGLE, PAS L'ÉCRITURE (§118.137) : ce module rend la CONDITION et les DONNÉES de l'écriture ; chaque
 * action fait elle-même son `updateMany` et sa notification, dans son corps. Si l'écriture vivait ici, la dérivation
 * des contrats ne la verrait pas (elle ne suit qu'un niveau de délégation) : la carte de confirmation cesserait de dire
 * que le poste est écrit et qu'une personne est prévenue, et le chemin générique d'Adam ne saurait plus traduire « le
 * poste » en identifiant.
 *
 * `orderDirectionAt` reste NUL sous le seuil : c'est ce qui distingue, sur la fiche, « validé par le centre » de
 * « sous le seuil ». L'écriture est CONDITIONNELLE (§118.187) : deux clics ne font pas deux demandes.
 * `assistantId` : celle qui établira le BC quand on le lui demande ; nul quand la plateforme le génère.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const REFUS_MARCHE_PRISE = "Une demande de bon de commande vient d'être envoyée pour ce poste, ou sa décision a changé : rouvrez la fiche.";

export interface MarcheDuBC {
  sousLeSeuil: boolean;
  seuilBC: number;
  /** La condition de l'écriture : le poste est accordé et son BC n'a pas encore pris la marche. */
  where: { id: string; status: "APPROVED"; orderStage: { in: ("NONE" | "REFUSED")[] } };
  /** Les données de l'écriture. */
  data: {
    orderStage: "DIRECTION_OK" | "REQUESTED"; orderRequestedAt: Date; orderRequestedById: string; orderNote: string | null;
    orderDecisionNote: string | null; orderDirectionAt: null; orderDirectionById: null; orderVisaAmount: null; orderVisaSupplier: null;
    bcAssistantId?: string; updatedById: string;
  };
}

export async function lireLaMarcheDuBC(i: {
  itemId: string; montantAccorde: number; userId: string; note: string | null; assistantId: string | null;
}): Promise<MarcheDuBC> {
  const seuilBC = (await getAppSettings()).bcValidationThreshold;
  const sousLeSeuil = !validationRequiseBC(i.montantAccorde, seuilBC);
  return {
    sousLeSeuil, seuilBC,
    where: { id: i.itemId, status: "APPROVED", orderStage: { in: ["NONE", "REFUSED"] } },
    data: {
      orderStage: sousLeSeuil ? "DIRECTION_OK" : "REQUESTED", orderRequestedAt: new Date(), orderRequestedById: i.userId, orderNote: i.note,
      orderDecisionNote: sousLeSeuil ? motifSousLeSeuil(seuilBC) : null, orderDirectionAt: null, orderDirectionById: null,
      orderVisaAmount: null, orderVisaSupplier: null, ...(i.assistantId ? { bcAssistantId: i.assistantId } : {}), updatedById: i.userId,
    },
  };
}

/** TOUT BC NÉ D'AD & PRO AU-DESSUS DU SEUIL PASSE PAR LE CENTRE DE VALIDATION AD & PRO (§118.148) : ce que le centre lit. */
export function notificationDuCentreBC(i: { id?: string; ref: string; label: string; montantAccorde: number }) {
  return {
    type: "VALIDATION_REQUIRED" as const, title: "Bon de commande à valider",
    // La ligne du poste dans le centre (`?ligne=<id du poste>`) : la notification arrive sur CE bon de commande.
    body: `${i.ref} — « ${i.label} » (${i.montantAccorde.toLocaleString("fr-FR")} DZD)`, link: lienLigneCentreAdPro(i.id),
  };
}
