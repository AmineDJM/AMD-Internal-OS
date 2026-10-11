import { prisma } from "@/lib/prisma";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { LIBELLE_ETAPE_BC } from "@/lib/bons-de-commande/regle";
import { etatDeLOrdre, LIBELLE_ETAT_REGLEMENT, type EtatReglement } from "@/lib/payments/reglement";
import { DECLARATION_KIND_LABEL, isDeclarationKind } from "@/lib/medical-info/circuits";
import { devisDuDossier, devisLu } from "@/lib/queries/promo-circuit";
import { totauxRetenus, type Totaux } from "@/lib/promo-material/devis";
import { lignesAReceptionner, lignesDuBC, type LigneBC } from "@/lib/promo-material/achats";
import { detailsDesFactures, type DetailFacture } from "@/lib/queries/promo-achats";
import {
  verdictBonsDeCommande, verdictPaiements, verdictVisas,
  type BCDuDevis, type FactureDuBC, type Verdict,
} from "@/lib/promo-material/execution";
import type { PromoTrack } from "@/lib/promo-material/circuit";
import { fichiersEmis } from "@/lib/legal/fichiers-emis";

/**
 * L'EXÉCUTION D'UN DOSSIER DU CIRCUIT 2, lue en LOT (§118.152, §118.102b) — pour la fiche, pour
 * les chantiers, pour Adam.
 *
 * Un devis → son bon de commande (pièce Legal, émise par la fabrique) → ses factures (pièces
 * Legal chaînées au BC) → leur règlement (ordre de dépense, centre de paiement) → la demande de
 * visa ou de déclaration de chaque paiement (information médicale). Cinq tables, cinq lectures,
 * jamais une par ligne. Un BC ANNULÉ est lu comme absent : le devis est de nouveau « à générer ».
 */

export interface FactureLue extends FactureDuBC {
  date: Date | null;
  expenseOrderId: string | null;
  etat: EtatReglement;
  /** Le détail ligne à ligne et la réception (§118.165) — nul pour une facture d'avant. */
  detail: DetailFacture | null;
}

export interface ExecutionDevis extends BCDuDevis {
  supplierId: string | null;
  reference: string | null;
  retenu: Totaux;
  envoyeLe: Date | null;
  bcDetail: {
    id: string; reference: string | null; montant: number | null; libelleEtape: string;
    /** Le Word et le PDF émis existent-ils ? Ils s'ouvrent par `lienFichierEmis(bc.id, …)`. */
    docx: boolean; pdf: boolean;
  } | null;
  factures: FactureLue[];
  /**
   * LES LIGNES DU BC (les lignes retenues), avec ce que les factures actives en ont déjà facturé —
   * ce que le dépôt d'une facture pré-remplit (§118.165).
   */
  lignesBC: LigneBC[];
  /** Les taxes du devis — celles du BC, que la facture reprend (corrigeables). */
  taxes: { tvaRate: number | null; extraTaxLabel: string | null; extraTaxRate: number | null };
}

export async function executionDuDossier(promoId: string): Promise<ExecutionDevis[]> {
  const devis = await devisDuDossier(promoId);
  const bcIds = devis.map((d) => d.purchaseOrderId).filter((x): x is string => Boolean(x));
  const [etats, docs] = await Promise.all([
    etatsDesBC(bcIds),
    bcIds.length ? prisma.legalDocument.findMany({ where: { id: { in: bcIds } }, select: { id: true, custom: true } }) : Promise.resolve([]),
  ]);
  // Les fichiers que la FABRIQUE a produits — ils s'ouvrent sous la porte de la pièce
  // (`/api/legal/<id>/fichier`), pas du Drive personnel de celui qui les a émis.
  const fichiers = new Map(docs.map((d) => [d.id, fichiersEmis(d.custom)]));
  const actifs = bcIds.filter((id) => { const e = etats.get(id); return e && !e.annule; });

  const factures = actifs.length
    ? await prisma.legalDocument.findMany({
        where: { kind: "INVOICE", status: { not: "CANCELLED" }, chainFromId: { in: actifs } },
        orderBy: { createdAt: "asc" },
        select: { id: true, reference: true, amount: true, chainFromId: true, expenseOrderId: true, paidDate: true, startDate: true },
      })
    : [];
  const ordreIds = factures.map((f) => f.expenseOrderId).filter((x): x is string => Boolean(x));
  const [ordres, declarations, details] = await Promise.all([
    ordreIds.length ? prisma.expenseOrder.findMany({ where: { id: { in: ordreIds } }, select: { id: true, status: true, centralStatus: true } }) : Promise.resolve([]),
    factures.length
      ? prisma.medicalInfoDeclaration.findMany({
          where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: factures.map((f) => f.id) } },
          select: { sourceId: true, reference: true, declarationKind: true },
        })
      : Promise.resolve([]),
    detailsDesFactures(factures.map((f) => f.id)),
  ]);
  const ordreParId = new Map(ordres.map((o) => [o.id, o]));
  const declParFacture = new Map(declarations.map((d) => [d.sourceId, d]));

  return devis.map((brut) => {
    const d = devisLu(brut);
    const etat = brut.purchaseOrderId ? etats.get(brut.purchaseOrderId) : undefined;
    const bcActif = etat && !etat.annule ? etat : null;
    const sesFactures: FactureLue[] = bcActif
      ? factures.filter((f) => f.chainFromId === bcActif.id).map((f) => {
          const o = f.expenseOrderId ? ordreParId.get(f.expenseOrderId) : undefined;
          const e: EtatReglement = o ? etatDeLOrdre(o) : f.paidDate ? "REGLE" : "NON_ENVOYE";
          const decl = declParFacture.get(f.id);
          const detail = details.get(f.id) ?? null;
          return {
            id: f.id, reference: f.reference, montant: f.amount != null ? Number(f.amount) : null,
            date: f.startDate, expenseOrderId: f.expenseOrderId, etat: e, detail,
            receptionAttendue: detail ? lignesAReceptionner(detail.lignes).length : 0,
            reglee: e === "REGLE", etatReglement: LIBELLE_ETAT_REGLEMENT[e],
            paiementDemande: Boolean(f.expenseOrderId) || Boolean(f.paidDate),
            demandeInfoMedicale: decl
              ? { reference: decl.reference, nature: isDeclarationKind(decl.declarationKind) ? DECLARATION_KIND_LABEL[decl.declarationKind] : "Information médicale", formalite: decl.declarationKind }
              : null,
          };
        })
      : [];
    const retenu = totauxRetenus(d);
    const f = bcActif ? fichiers.get(bcActif.id) : undefined;
    return {
      quoteId: d.id, supplierId: d.supplierId, fournisseur: d.supplierName, reference: d.reference,
      lignesRetenues: retenu.lignes, retenu,
      envoyeLe: bcActif ? brut.purchaseOrderSentAt : null,
      bc: bcActif ? { id: bcActif.id, reference: bcActif.reference, etape: bcActif.etape, montant: bcActif.montant } : null,
      bcDetail: bcActif
        ? { id: bcActif.id, reference: bcActif.reference, montant: bcActif.montant, libelleEtape: LIBELLE_ETAPE_BC[bcActif.etape], docx: Boolean(f?.docx), pdf: Boolean(f?.pdf) }
        : null,
      factures: sesFactures,
      lignesBC: bcActif ? lignesDuBC(d, sesFactures.flatMap((x) => x.detail?.lignes ?? [])) : [],
      taxes: { tvaRate: d.tvaRate, extraTaxLabel: d.extraTaxLabel, extraTaxRate: d.extraTaxRate },
    };
  });
}

/** LE VERDICT D'UN CHANTIER du circuit 2 — la règle pure, sur les faits lus ici. */
export async function verdictDuChantierPromo(promoId: string, track: PromoTrack, execution?: ExecutionDevis[]): Promise<Verdict> {
  const devis = execution ?? (await executionDuDossier(promoId));
  if (track === "PURCHASE_ORDER") return verdictBonsDeCommande(devis);
  if (track === "PAYMENT") return verdictPaiements(devis);
  return verdictVisas(devis);
}
