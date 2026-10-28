import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { chantierBCClos } from "@/lib/bons-de-commande/regle";
import { chantierPaiementClos, etatDeLOrdre, type PieceDeReglement } from "@/lib/payments/reglement";
import { executionDuDossier, verdictDuChantierPromo, type ExecutionDevis } from "@/lib/queries/promo-execution";
import { PROMO_TRACKS, type PromoTrack } from "@/lib/promo-material/circuit";
import { lignesAReceptionner, resteAFacturer } from "@/lib/promo-material/achats";
import { commandesSoldees } from "@/lib/promo-material/fiche";
import { sansBloquer } from "@/lib/journal";

/**
 * LA CLÔTURE D'UN DOSSIER DE MATÉRIEL PROMOTIONNEL — les vérifications de chaque chantier, et la clôture AUTOMATIQUE.
 *
 * Maquette validée (Direction, 10/2026, étape 4) : « le dossier se clôt seul quand tout est payé et visé ». Les
 * vérifications sont CELLES de `completePromoTrack` (sorties ici, sans changer d'un mot) : un geste manuel et la clôture
 * automatique qui jugeraient différemment finiraient par terminer un dossier que le geste aurait refusé (§118.5).
 *
 * La clôture automatique part des événements qui peuvent achever un dossier : le règlement d'un ordre de dépense
 * (`settleExpenseOrder`), la demande de paiement et la demande à l'information médicale (`promo-execution-actions`).
 * Elle ne lève jamais : l'argent prime, l'affichage se rattrape (et « Clore le dossier » reste offert aux pilotes).
 */

/**
 * LES RÈGLEMENTS RATTACHÉS À UN DOSSIER — tout ce qui peut porter son paiement (§118.148).
 *
 * Trois chemins mènent à un ordre de dépense, et un dossier peut les avoir empruntés tous :
 *   • l'ordre né du dossier lui-même (ancien parcours : bordereau, règlement final) ;
 *   • la FACTURE enregistrée depuis le dossier — ou qui découle d'un de ses bons de commande —,
 *     envoyée au règlement : son ordre ; ou, sans ordre, la date qu'elle porte si elle a été
 *     ENREGISTRÉE comme déjà réglée (le chemin que le registre des paiements nomme, §PAYMENT_PATHS) ;
 *   • le dossier de paiement ouvert sur le dossier.
 * Un même ordre peut être atteint par deux chemins (le dossier compagnon d'un ordre) : on compte
 * par ORDRE, jamais par chemin, sans quoi un paiement réglé compterait double et un paiement en
 * attente pourrait se cacher derrière son jumeau réglé.
 */
export async function reglementsDuDossierPromo(id: string): Promise<PieceDeReglement[]> {
  const [ordresDirects, bcs, demandes] = await Promise.all([
    prisma.expenseOrder.findMany({
      where: { sourceType: "PROMO_MATERIAL", sourceId: id },
      select: { id: true, reference: true, status: true, centralStatus: true },
    }),
    prisma.legalDocument.findMany({
      where: { sourceType: "PROMO_MATERIAL", sourceId: id, kind: "PURCHASE_ORDER" },
      select: { id: true },
    }),
    prisma.paymentRequest.findMany({
      where: { entityType: "PROMO_MATERIAL", entityId: id, status: { notIn: ["CANCELLED", "REJECTED"] } },
      select: { reference: true, expenseOrderId: true },
    }),
  ]);
  const factures = await prisma.legalDocument.findMany({
    where: {
      kind: "INVOICE", status: { not: "CANCELLED" },
      OR: [
        { sourceType: "PROMO_MATERIAL", sourceId: id },
        ...(bcs.length ? [{ chainFromId: { in: bcs.map((b) => b.id) } }] : []),
      ],
    },
    select: { reference: true, title: true, expenseOrderId: true, paidDate: true },
  });

  const ordresIds = [
    ...factures.map((f) => f.expenseOrderId), ...demandes.map((d) => d.expenseOrderId),
  ].filter((x): x is string => Boolean(x));
  const ordresLies = ordresIds.length
    ? await prisma.expenseOrder.findMany({
        where: { id: { in: ordresIds } },
        select: { id: true, reference: true, status: true, centralStatus: true },
      })
    : [];

  const parOrdre = new Map<string, PieceDeReglement>();
  for (const o of [...ordresDirects, ...ordresLies]) {
    parOrdre.set(o.id, { libelle: `ordre ${o.reference}`, etat: etatDeLOrdre(o) });
  }
  const sansOrdre: PieceDeReglement[] = [];
  for (const f of factures) {
    if (f.expenseOrderId) continue; // compté par son ordre
    sansOrdre.push({
      libelle: `facture ${f.reference?.trim() || `« ${f.title} »`}`,
      etat: f.paidDate ? "REGLE" : "NON_ENVOYE",
    });
  }
  for (const d of demandes) {
    if (d.expenseOrderId) continue;
    sansOrdre.push({ libelle: `demande de paiement ${d.reference}`, etat: "NON_ENVOYE" });
  }
  return [...parOrdre.values(), ...sansOrdre];
}

/**
 * CE QUI EMPÊCHE DE CLORE UN CHANTIER — `null` : il peut l'être. Au circuit 2, chaque chantier se constate sur ses
 * pièces (§118.152) ; puis les gardes communes : un BC validé par son centre ET signé (§118.148/149), un paiement
 * RÉGLÉ par le centre de paiement (§118.148).
 */
export async function refusDuChantierPromo(id: string, track: PromoTrack, version: 1 | 2, execution?: ExecutionDevis[]): Promise<string | null> {
  if (version === 2) {
    const verdict = await verdictDuChantierPromo(id, track, execution);
    if (!verdict.ok) return verdict.raison;
  }
  if (track === "PURCHASE_ORDER") {
    const bcs = await prisma.legalDocument.findMany({
      where: { sourceType: "PROMO_MATERIAL", sourceId: id, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } },
      select: { id: true, reference: true },
    });
    const etats = await etatsDesBC(bcs.map((b) => b.id));
    const verdict = chantierBCClos(bcs.map((b) => {
      const e = etats.get(b.id);
      return { reference: b.reference, porte: e?.porte ?? null, ...(e ? { etape: e.etape } : {}) };
    }));
    if (!verdict.ok) return verdict.raison;
  }
  if (track === "PAYMENT") {
    const verdict = chantierPaiementClos(await reglementsDuDossierPromo(id));
    if (!verdict.ok) return verdict.raison;
  }
  return null;
}

/** Les faits d'exécution, dans la forme que lit la condition pure de clôture (`commandesSoldees`). */
function faitsDeCloture(execution: readonly ExecutionDevis[]) {
  return execution.filter((e) => e.lignesRetenues > 0).map((e) => ({
    etape: e.bc?.etape ?? null,
    resteAFacturer: !e.bc || e.lignesBC.some((l) => resteAFacturer(l) > 0),
    factures: e.factures.map((f) => ({
      enAttente: f.detail ? lignesAReceptionner(f.detail.lignes).length : 0,
      // « VISÉ » VEUT DIRE VALIDÉ (audit 10/2026), pas « demandé » : le dossier ne se clôt « payé et visé »
      // que quand la déclaration d'information médicale de chaque paiement est VALIDÉE.
      paiementDemande: f.paiementDemande, reglee: f.reglee, demandeIM: Boolean(f.demandeInfoMedicale?.validee),
    })),
  }));
}

/**
 * CLÔT LE DOSSIER s'il est soldé — chaque BC reçu, facturé, payé et visé — et le dit (journal, demandeur). Rend `true`
 * s'il vient d'être clos. Écriture CONDITIONNELLE sur l'étape lue : un dossier annulé ou déjà clos entre-temps n'est
 * pas touché. Ne lève jamais.
 */
export async function cloreLeDossierPromoSiSolde(promoId: string, acteurId: string | null): Promise<boolean> {
  try {
    const pm = await prisma.promoMaterial.findUnique({
      where: { id: promoId },
      select: { id: true, reference: true, title: true, status: true, circuitVersion: true, circuitState: true, requesterId: true },
    });
    if (!pm || pm.circuitVersion !== 2 || pm.circuitState !== "IN_EXECUTION" || pm.status === "CANCELLED") return false;
    const execution = await executionDuDossier(pm.id);
    if (!commandesSoldees(faitsDeCloture(execution))) return false;
    for (const t of PROMO_TRACKS) {
      if (await refusDuChantierPromo(pm.id, t, 2, execution)) return false;
    }
    const ecrit = await prisma.promoMaterial.updateMany({
      where: { id: pm.id, circuitState: "IN_EXECUTION", status: { not: "CANCELLED" } },
      data: { tracksDone: PROMO_TRACKS.join(","), circuitState: "COMPLETED", ...(acteurId ? { updatedById: acteurId } : {}) },
    });
    if (ecrit.count === 0) return false;
    await recordAudit({
      actorId: acteurId, action: "UPDATE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: pm.id,
      summary: "Dossier TERMINÉ automatiquement — chaque bon de commande reçu, facturé, payé et visé",
    });
    if (pm.requesterId && pm.requesterId !== acteurId) {
      await notifyUser({
        userId: pm.requesterId, type: "GENERIC", title: "Matériel promotionnel terminé",
        body: `${pm.reference} — ${pm.title} : tout est reçu, payé et visé.`, link: `/promo-material/${pm.id}`,
      }).catch(sansBloquer("promo-cloture.cloreLeDossierPromoSiSolde.notifyUser"));
    }
    return true;
  } catch (e) {
    console.error("[promo] clôture automatique non faite — « Clore le dossier » reste offert", e);
    return false;
  }
}

/** Le dossier de matériel promotionnel d'une FACTURE (pièce Legal chaînée à un BC né du dossier) — `null` sinon. */
export async function dossierPromoDeLaFacture(legalDocumentId: string): Promise<string | null> {
  const facture = await prisma.legalDocument.findUnique({
    where: { id: legalDocumentId },
    select: { kind: true, chainFrom: { select: { sourceType: true, sourceId: true } } },
  });
  if (!facture || facture.kind !== "INVOICE") return null;
  const bc = facture.chainFrom;
  return bc?.sourceType === "PROMO_MATERIAL" && bc.sourceId ? bc.sourceId : null;
}
