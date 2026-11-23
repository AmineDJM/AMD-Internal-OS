import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { toNumber } from "@/lib/utils";
import { sansBloquer } from "@/lib/journal";
import { getAppSettings } from "@/lib/settings";
import { validationRequiseBC, motifSousLeSeuil } from "@/lib/bons-de-commande/regle";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { PARENTS, parentOf, revalidate } from "./postes/commun";

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

/**
 * LA DEMANDE DE BC D'UN POSTE ATTEND-ELLE ENCORE LE CENTRE ? — la règle de la marche, relue au seuil EN VIGUEUR (recette du
 * 23/11/2026) : strictement au-dessus du seuil, sans seuil (0), ou montant inconnu → oui. Le centre la lit pour ne jamais
 * montrer au DG une demande que le seuil du jour ne lui envoie plus.
 */
export const posteAttendLeCentreBC = (montantAccorde: number | null, seuilBC: number): boolean => validationRequiseBC(montantAccorde, seuilBC);

/** Au-delà, un réglage deviendrait une migration : on borne, et on le dit (comme `reaiguillerSurChangementDeSeuil`). */
const LOT_RELACHE = 500;

export interface BilanRelache {
  /** Les demandes de BC de poste rendues aux Finances. */
  postes: number;
  /** Les BC déjà établis de ces postes — l'appelant prévient leurs signataires (`signalerSiASigner`). */
  bcIds: string[];
  tronque: boolean;
}

/**
 * LE SEUIL DES BC A CHANGÉ — les demandes de BC de poste qui attendaient le DG et que la règle n'y envoie plus (recette du
 * 23/11/2026).
 *
 * `reaiguillerSurChangementDeSeuil` ne relit que les pièces du registre : la porte d'un BC de poste EST la demande du poste
 * (`orderStage`, `PorteBC.source = "POSTE"`), que l'aiguillage ne touche jamais. Relever le seuil laissait donc au centre des
 * postes que la règle n'y envoie plus — le DG les avait à viser, et les Finances ne pouvaient pas signer leurs BC.
 *
 * Chaque demande prend l'état que la marche lui donne sous le seuil (`lireLaMarcheDuBC`) : `DIRECTION_OK`, le motif « Sous le
 * seuil… », `orderDirectionAt` NUL — la fiche ne dit pas « validé par le centre ». L'écriture est CONDITIONNELLE sur l'étape et le
 * montant lus : un visa ou un retrait passé entre-temps l'emporte. Seule une demande EN ATTENTE est rendue ; ce que le centre a
 * décidé ne se rejuge pas.
 *
 * L'écriture vit ici et non dans l'action, à l'inverse des gestes sur un poste (§118.137) : c'est la conséquence d'un RÉGLAGE,
 * comme le réaiguillage des pièces, et le module reste seul à écrire l'état de ses postes. Prévenir les Finances revient à
 * l'appelant, qui lit l'état des BC.
 */
export async function relacherLesPostesSousLeSeuil(seuilBC: number, acteurId: string): Promise<BilanRelache> {
  const bilan: BilanRelache = { postes: 0, bcIds: [], tronque: false };
  // Sans seuil (0), tout BC exige un centre : aucune demande n'est à rendre.
  if (!(Number.isFinite(seuilBC) && seuilBC > 0)) return bilan;
  const candidats = await prisma.adProItem.findMany({
    where: { orderStage: "REQUESTED", amountGranted: { gt: 0, lte: seuilBC } },
    select: {
      id: true, label: true, amountGranted: true,
      sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
    },
    orderBy: { orderRequestedAt: "asc" },
    take: LOT_RELACHE + 1,
  });
  bilan.tronque = candidats.length > LOT_RELACHE;
  const rendus: string[] = [];
  for (const p of candidats.slice(0, LOT_RELACHE)) {
    const montant = p.amountGranted == null ? null : toNumber(p.amountGranted);
    if (montant == null || posteAttendLeCentreBC(montant, seuilBC)) continue;
    const fait = await prisma.adProItem.updateMany({
      where: { id: p.id, orderStage: "REQUESTED", amountGranted: p.amountGranted },
      data: {
        orderStage: "DIRECTION_OK", orderDecisionNote: motifSousLeSeuil(seuilBC), orderDirectionAt: null, orderDirectionById: null,
        orderVisaAmount: null, orderVisaSupplier: null, updatedById: acteurId,
      },
    });
    if (fait.count === 0) continue;
    rendus.push(p.id);
    const owner = parentOf(p);
    if (!owner) continue;
    await recordAudit({
      actorId: acteurId, module: PARENTS[owner.parent].module, entityType: owner.parent, entityId: owner.id, action: "UPDATE",
      summary: `Seuil des bons de commande fixé à ${seuilBC.toLocaleString("fr-FR")} DZD : la demande de BC du poste « ${p.label} » (${montant.toLocaleString("fr-FR")} DZD) quitte le centre de validation Ad & Pro — ${motifSousLeSeuil(seuilBC)}`,
    }).catch(sansBloquer("marche-bc.relacherLesPostesSousLeSeuil.recordAudit"));
    revalidate(owner.parent, owner.id);
  }
  bilan.postes = rendus.length;
  if (rendus.length > 0) {
    const pieces = await prisma.adProItemPiece.findMany({
      where: { itemId: { in: rendus }, nature: "BON_DE_COMMANDE" }, select: { legalDocumentId: true },
    }).catch(sansBloquer("marche-bc.relacherLesPostesSousLeSeuil.adProItemPiece", []));
    bilan.bcIds = [...new Set(pieces.map((x) => x.legalDocumentId).filter((x): x is string => Boolean(x)))];
  }
  return bilan;
}

/** TOUT BC NÉ D'AD & PRO AU-DESSUS DU SEUIL PASSE PAR LE CENTRE DE VALIDATION AD & PRO (§118.148) : ce que le centre lit. */
export function notificationDuCentreBC(i: { id?: string; ref: string; label: string; montantAccorde: number }) {
  return {
    type: "VALIDATION_REQUIRED" as const, title: "Bon de commande à valider",
    // La ligne du poste dans le centre (`?ligne=<id du poste>`) : la notification arrive sur CE bon de commande.
    body: `${i.ref} — « ${i.label} » (${i.montantAccorde.toLocaleString("fr-FR")} DZD)`, link: lienLigneCentreAdPro(i.id),
  };
}
