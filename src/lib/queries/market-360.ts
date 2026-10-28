import { prisma } from "@/lib/prisma";
import { linksOfMany } from "@/lib/links/store";
import { invoiceSettlementState } from "@/lib/labels";
import { toNumber } from "@/lib/utils";
import { deriverNiveau, etapeCourante, quantitesContractuelles, restantACommander, unitesAttribuees, uniteSoumises, valeurAttribuee, valeurContractuelleCourante, valeurSoumise, type LigneContractuelleFaits, type NiveauMarche } from "@/lib/pch/market-math";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MARCHÉ 360° — une seule lecture compose le dossier entier.
 *
 * La fiche `/pch/[id]`, la vue « Marchés » d'un produit Regulatory et les ops d'Adam lisent
 * CETTE composition : les montants sortent tous de `lib/pch/market-math.ts` (module pur,
 * testé), jamais recalculés à la main dans un écran. Un chiffre affiché à deux endroits est
 * le même calcul exécuté deux fois — pas deux formules qui divergent.
 *
 * Ce qui MANQUE se dit : `manques` liste ce que le dossier devrait porter et ne porte pas
 * (contrat absent sur un marché gagné, BC sans ligne, facture sans règlement) — la même
 * honnêteté que la frise (`storyMarche`), qui reste la vue chronologique du même graphe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const num = (v: unknown): number | null => (v === null || v === undefined ? null : toNumber(v as never));
const n0 = (v: unknown): number => num(v) ?? 0;

export interface Market360 {
  tender: {
    id: string; reference: string; internalReference: string | null; title: string | null;
    client: string; status: string; companyId: string | null; companyName: string | null;
    publishedAt: Date | null; submissionDeadline: Date | null; submittedAt: Date | null;
    awardDate: Date | null; responsible: { id: string; name: string } | null;
    businessUnit: { id: string; name: string } | null; notes: string | null;
    cautionAmount: number | null; cautionDeposited: boolean; cautionEnd: Date | null;
  };
  niveau: { niveau: NiveauMarche; raison: string; etape: number };
  lignes: Array<{
    id: string; designation: string; dci: string | null; status: string;
    produit: { id: string; code: string; nom: string } | null;
    quantiteDemandee: number; quantiteSoumise: number; quantiteAttribuee: number;
    prixSoumis: number | null; prixAttribue: number | null;
    valeurSoumise: number; valeurAttribuee: number;
    quantiteContractuelle: number; quantiteCommandee: number; quantiteLivree: number;
    restantACommander: number;
    snapshotFige: boolean;
  }>;
  soumissions: Array<{
    id: string; version: number; label: string | null; status: string;
    submittedAt: Date | null; lockedAt: Date | null;
    checklist: Array<{ key: string; label: string; done: boolean; doneAt: string | null }>;
    notes: string | null;
  }>;
  contrats: Array<{
    id: string; reference: string | null; title: string; status: string;
    startDate: Date | null; endDate: Date | null; signedAt: Date | null;
    montantInitial: number | null; valeurCourante: number | null;
    avenants: Array<{
      id: string; reference: string | null; title: string; status: string;
      amountDelta: number | null; signedAt: Date | null; effectiveAt: Date | null; effectif: boolean;
    }>;
    lignes: Array<{
      id: string; documentId: string; surAvenant: boolean; designation: string;
      quantityUnits: number; unitPriceDzd: number | null;
      produit: { id: string; code: string; nom: string } | null;
      tenderLineId: string | null;
    }>;
  }>;
  bons: Array<{
    id: string; reference: string | null; status: string; contractId: string | null;
    receivedDate: Date | null; expectedArrival: Date | null; arrivedDate: Date | null;
    paymentDate: Date | null; valeur: number | null; quantiteHeritee: number;
    lignes: Array<{
      id: string; designation: string; quantityUnits: number; unitPriceDzd: number | null;
      /** Conditionnement et prix À LA BOÎTE du bon — le nombre de boîtes s'en déduit. */
      unitsPerBox: number | null; boxPriceDzd: number | null;
      contractLineId: string | null; quantiteLivree: number;
    }>;
    livraisons: Array<{
      id: string; reference: string | null; expectedAt: Date | null; deliveredAt: Date | null;
      reserves: string | null;
      lignes: Array<{ id: string; designation: string; quantityUnits: number; batchNumber: string | null; expiryDate: Date | null }>;
    }>;
    factures: Array<{
      id: string; number: string | null; title: string; status: string;
      amount: number | null; issueDate: Date | null; dueDate: Date | null; paidDate: Date | null;
      /** Les courriers reliés à CETTE facture (recouvrement : relance, mise en demeure…). */
      courriers: Array<{ id: string; reference: string | null; title: string; direction: string }>;
    }>;
    /** Les courriers reliés à CE bon (« Relier à… » → Bon de commande PCH). */
    courriers: Array<{ id: string; reference: string | null; title: string; direction: string }>;
  }>;
  finances: {
    valeurAnnoncee: number | null;
    soumis: number; attribue: number;
    contratInitial: number | null; contratCourant: number | null;
    commande: number; livre: number; facture: number; encaisse: number;
    resteAEncaisser: number; resteAFacturer: number;
  };
  courriers: Array<{ id: string; reference: string | null; title: string; direction: string; date: Date | null }>;
  /** Les TROUS du dossier — dits, jamais tus. */
  manques: string[];
}

export async function loadMarket360(tenderId: string): Promise<Market360 | null> {
  const t = await prisma.pchTender.findUnique({
    where: { id: tenderId },
    select: {
      id: true, reference: true, internalReference: true, title: true, client: true, status: true,
      companyId: true, publishedAt: true, submissionDeadline: true, submittedAt: true,
      awardDate: true, notes: true, cautionAmount: true, cautionDeposited: true, cautionEnd: true,
      company: { select: { shortName: true, name: true } },
      responsible: { select: { id: true, name: true } },
      businessUnit: { select: { id: true, name: true } },
      lines: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, designation: true, dci: true, status: true, quantityUnits: true,
          submittedQuantityUnits: true, awardedQuantityUnits: true, unitPriceDzd: true,
          awardedUnitPriceDzd: true, submissionSnapshot: true,
          product: { select: { id: true, code: true, canonicalName: true } },
        },
      },
      submissions: {
        orderBy: { version: "desc" },
        select: { id: true, version: true, label: true, status: true, submittedAt: true, lockedAt: true, checklist: true, notes: true },
      },
      contracts: {
        where: { kind: { in: ["CONTRACT", "AGREEMENT"] } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, reference: true, title: true, status: true, startDate: true, endDate: true,
          signedAt: true, amount: true,
          amendments: {
            orderBy: { createdAt: "asc" },
            select: { id: true, reference: true, title: true, status: true, amountDelta: true, signedAt: true, effectiveAt: true },
          },
          rootContractLines: {
            select: {
              id: true, documentId: true, designation: true, quantityUnits: true, unitPriceDzd: true,
              tenderLineId: true,
              product: { select: { id: true, code: true, canonicalName: true } },
              document: { select: { kind: true, status: true, effectiveAt: true } },
            },
          },
        },
      },
      orders: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, reference: true, status: true, contractId: true, receivedDate: true,
          expectedArrival: true, arrivedDate: true, paymentDate: true, value: true, quantity: true,
          orderLines: {
            select: {
              id: true, designation: true, quantityUnits: true, unitPriceDzd: true, contractLineId: true,
              unitsPerBox: true, boxPriceDzd: true,
              deliveryLines: { select: { quantityUnits: true, delivery: { select: { deliveredAt: true } } } },
            },
          },
          deliveries: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true, reference: true, expectedAt: true, deliveredAt: true, reserves: true,
              lines: { select: { id: true, designation: true, quantityUnits: true, batchNumber: true, expiryDate: true } },
            },
          },
        },
      },
    },
  });
  if (!t) return null;

  const maintenant = new Date();

  // ── LES FACTURES du marché : rattachées à ses bons (sourceType = PCH_ORDER). ────────────
  const orderIds = t.orders.map((o) => o.id);
  // Une facture est un DOCUMENT LÉGAL de nature « facture » : son n° est sa `reference`, son
  // émission son `startDate`, son échéance son `endDate`. `etat` porte le règlement (réglée /
  // partie au règlement / à régler) — le statut du document, lui, dit sa vie (annulée).
  const factures = orderIds.length
    ? (await prisma.legalDocument.findMany({
        where: { kind: "INVOICE", sourceType: "PCH_ORDER", sourceId: { in: orderIds } },
        select: {
          id: true, reference: true, title: true, status: true, amount: true, kind: true,
          startDate: true, endDate: true, paidDate: true, expenseOrderId: true, sourceId: true,
        },
        orderBy: { startDate: "asc" },
      })).map((f) => ({
        id: f.id, number: f.reference, title: f.title, amount: f.amount, sourceId: f.sourceId,
        issueDate: f.startDate, dueDate: f.endDate, paidDate: f.paidDate,
        // ANNULÉE l'emporte : une facture annulée ne se règle plus, et ne compte nulle part.
        status: f.status === "CANCELLED" ? "CANCELLED" : invoiceSettlementState(f),
      }))
    : [];
  const facturesParBon = new Map<string, typeof factures>();
  for (const f of factures) {
    if (!f.sourceId) continue;
    const list = facturesParBon.get(f.sourceId) ?? [];
    list.push(f);
    facturesParBon.set(f.sourceId, list);
  }

  // ── LES COURRIERS : la relation de naissance OU un lien « Relier à… » — au niveau du
  //    MARCHÉ, mais aussi de CHAQUE BON et de CHAQUE FACTURE (le recouvrement écrit des
  //    courriers par facture ; un même pli peut en porter plusieurs). ──────────────────────
  const factureIds = factures.map((f) => f.id);
  // Le registre range chaque paire dans l'ordre du flux : un courrier a le rang le plus élevé,
  // il est donc toujours le SECOND membre. On lit néanmoins par `linksOfMany`, qui regarde les
  // deux côtés — la fiche du marché n'a pas à connaître l'ordre de rangement.
  const [courriersSource, liensMarche, liensBons, liensFactures] = await Promise.all([
    prisma.mailEntry.findMany({
      where: { sourceType: "PCH_TENDER", sourceId: t.id },
      select: { id: true, reference: true, title: true, direction: true, sentAt: true, receivedAt: true },
    }),
    linksOfMany("PCH_TENDER", [t.id]),
    linksOfMany("PCH_ORDER", orderIds),
    linksOfMany("INVOICE", factureIds),
  ]);

  // Les plis cités par ces liens, chargés EN UNE FOIS : le registre ne porte que le libellé
  // photographié, et la fiche veut le sens du pli et ses dates.
  const plisCites = new Set<string>();
  for (const l of [...liensMarche, ...liensBons, ...liensFactures]) {
    if (l.fromType === "MAIL_ENTRY") plisCites.add(l.fromId);
    if (l.toType === "MAIL_ENTRY") plisCites.add(l.toId);
  }
  const plis = plisCites.size
    ? await prisma.mailEntry.findMany({
        where: { id: { in: [...plisCites] } },
        select: { id: true, reference: true, title: true, direction: true, sentAt: true, receivedAt: true },
      })
    : [];
  const pliParId = new Map(plis.map((p) => [p.id, p]));

  /** Le pli d'un lien, et l'objet de CE côté-ci — le registre est lisible des deux sens. */
  const plisParObjet = (
    liens: { fromType: string; fromId: string; toType: string; toId: string }[],
  ): Map<string, { id: string; reference: string | null; title: string; direction: string }[]> => {
    const par = new Map<string, { id: string; reference: string | null; title: string; direction: string }[]>();
    for (const l of liens) {
      const pliId = l.fromType === "MAIL_ENTRY" ? l.fromId : l.toType === "MAIL_ENTRY" ? l.toId : null;
      if (!pliId) continue;
      const objetId = l.fromType === "MAIL_ENTRY" ? l.toId : l.fromId;
      const pli = pliParId.get(pliId);
      if (!pli) continue;
      const list = par.get(objetId) ?? [];
      list.push({ id: pli.id, reference: pli.reference, title: pli.title, direction: String(pli.direction) });
      par.set(objetId, list);
    }
    return par;
  };
  const courriersParBon = plisParObjet(liensBons);
  const courriersParFacture = plisParObjet(liensFactures);

  const courriersMap = new Map(courriersSource.map((c) => [c.id, c]));
  for (const l of liensMarche) {
    const pliId = l.fromType === "MAIL_ENTRY" ? l.fromId : l.toType === "MAIL_ENTRY" ? l.toId : null;
    const pli = pliId ? pliParId.get(pliId) : null;
    if (pli) courriersMap.set(pli.id, pli);
  }
  const courriers = [...courriersMap.values()]
    .map((c) => ({ id: c.id, reference: c.reference, title: c.title, direction: String(c.direction), date: c.sentAt ?? c.receivedAt }))
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));

  // ── LES CONTRATS, leurs avenants effectifs, leurs lignes. ───────────────────────────────
  const estEffectif = (doc: { kind: string; status: string; effectiveAt: Date | null }): boolean =>
    doc.status !== "CANCELLED" && (doc.kind !== "AMENDMENT" || (doc.effectiveAt !== null && doc.effectiveAt <= maintenant));

  const contrats: Market360["contrats"] = t.contracts.map((c) => ({
    id: c.id, reference: c.reference, title: c.title, status: String(c.status),
    startDate: c.startDate, endDate: c.endDate, signedAt: c.signedAt,
    montantInitial: num(c.amount),
    valeurCourante: valeurContractuelleCourante(
      num(c.amount),
      c.amendments.map((a) => ({ amountDelta: num(a.amountDelta), effectiveAt: a.effectiveAt, status: String(a.status) })),
      maintenant,
    ),
    avenants: c.amendments.map((a) => ({
      id: a.id, reference: a.reference, title: a.title, status: String(a.status),
      amountDelta: num(a.amountDelta), signedAt: a.signedAt, effectiveAt: a.effectiveAt,
      effectif: estEffectif({ kind: "AMENDMENT", status: String(a.status), effectiveAt: a.effectiveAt }),
    })),
    lignes: c.rootContractLines.map((l) => ({
      id: l.id, documentId: l.documentId, surAvenant: l.documentId !== c.id,
      designation: l.designation, quantityUnits: l.quantityUnits, unitPriceDzd: num(l.unitPriceDzd),
      produit: l.product ? { id: l.product.id, code: l.product.code, nom: l.product.canonicalName } : null,
      tenderLineId: l.tenderLineId,
    })),
  }));

  // ── QUANTITÉS CONTRACTUELLES par produit (tous contrats du marché confondus). ────────────
  const cleProduit = (productId: string | null | undefined, designation: string): string =>
    productId ?? `libelle:${designation.trim().toLowerCase()}`;
  const lignesContractuellesFaits: LigneContractuelleFaits[] = t.contracts.flatMap((c) =>
    c.rootContractLines.map((l) => ({
      quantityUnits: l.quantityUnits,
      unitPriceDzd: num(l.unitPriceDzd),
      effective: estEffectif({ kind: String(l.document.kind), status: String(l.document.status), effectiveAt: l.document.effectiveAt }),
      produitCle: cleProduit(l.product?.id, l.designation),
    })),
  );
  const contractuelParProduit = quantitesContractuelles(lignesContractuellesFaits);
  // La correspondance ligne contractuelle → produit, pour router les lignes de BC.
  const produitDeLigneContractuelle = new Map<string, string>();
  for (const c of t.contracts) {
    for (const l of c.rootContractLines) {
      produitDeLigneContractuelle.set(l.id, cleProduit(l.product?.id, l.designation));
    }
  }

  // ── COMMANDÉ et LIVRÉ par produit, depuis les lignes de bons non annulés. ────────────────
  const commandeParProduit = new Map<string, number>();
  const livreParProduit = new Map<string, number>();
  const ligneAoDesLignesBc = new Map<string, string>(); // orderLineId → cle produit (via ligne AO en repli)
  for (const o of t.orders) {
    if (o.status === "CANCELLED") continue;
    for (const ol of o.orderLines) {
      const cle = ol.contractLineId
        ? produitDeLigneContractuelle.get(ol.contractLineId) ?? cleProduit(null, ol.designation)
        : cleProduit(null, ol.designation);
      ligneAoDesLignesBc.set(ol.id, cle);
      commandeParProduit.set(cle, (commandeParProduit.get(cle) ?? 0) + ol.quantityUnits);
      const livre = ol.deliveryLines.reduce((s, dl) => s + (dl.delivery.deliveredAt ? dl.quantityUnits : 0), 0);
      livreParProduit.set(cle, (livreParProduit.get(cle) ?? 0) + livre);
    }
  }

  // ── LES LIGNES DE L'AO, enrichies de leur exécution. ─────────────────────────────────────
  const lignes: Market360["lignes"] = t.lines.map((l) => {
    const faits = {
      quantityUnits: l.quantityUnits,
      submittedQuantityUnits: l.submittedQuantityUnits,
      awardedQuantityUnits: l.awardedQuantityUnits,
      unitPriceDzd: num(l.unitPriceDzd),
      awardedUnitPriceDzd: num(l.awardedUnitPriceDzd),
      status: String(l.status),
    };
    const cle = cleProduit(l.product?.id, l.designation);
    const contractuel = contractuelParProduit.get(cle) ?? 0;
    const commande = commandeParProduit.get(cle) ?? 0;
    return {
      id: l.id, designation: l.designation, dci: l.dci, status: String(l.status),
      produit: l.product ? { id: l.product.id, code: l.product.code, nom: l.product.canonicalName } : null,
      quantiteDemandee: l.quantityUnits,
      quantiteSoumise: uniteSoumises(faits),
      quantiteAttribuee: unitesAttribuees(faits),
      prixSoumis: faits.unitPriceDzd,
      prixAttribue: faits.awardedUnitPriceDzd,
      valeurSoumise: valeurSoumise(faits),
      valeurAttribuee: valeurAttribuee(faits),
      quantiteContractuelle: contractuel,
      quantiteCommandee: commande,
      quantiteLivree: livreParProduit.get(cle) ?? 0,
      restantACommander: restantACommander(contractuel, commande),
      snapshotFige: l.submissionSnapshot !== null,
    };
  });

  // ── LES BONS, leurs lignes, livraisons et factures. ──────────────────────────────────────
  const bons: Market360["bons"] = t.orders.map((o) => ({
    id: o.id, reference: o.reference, status: String(o.status), contractId: o.contractId,
    receivedDate: o.receivedDate, expectedArrival: o.expectedArrival, arrivedDate: o.arrivedDate,
    paymentDate: o.paymentDate, valeur: num(o.value), quantiteHeritee: o.quantity,
    lignes: o.orderLines.map((ol) => ({
      id: ol.id, designation: ol.designation, quantityUnits: ol.quantityUnits,
      unitPriceDzd: num(ol.unitPriceDzd), contractLineId: ol.contractLineId,
      unitsPerBox: ol.unitsPerBox, boxPriceDzd: num(ol.boxPriceDzd),
      quantiteLivree: ol.deliveryLines.reduce((s, dl) => s + (dl.delivery.deliveredAt ? dl.quantityUnits : 0), 0),
    })),
    livraisons: o.deliveries.map((d) => ({
      id: d.id, reference: d.reference, expectedAt: d.expectedAt, deliveredAt: d.deliveredAt,
      reserves: d.reserves,
      lignes: d.lines.map((dl) => ({ id: dl.id, designation: dl.designation, quantityUnits: dl.quantityUnits, batchNumber: dl.batchNumber, expiryDate: dl.expiryDate })),
    })),
    factures: (facturesParBon.get(o.id) ?? []).map((f) => ({
      id: f.id, number: f.number, title: f.title, status: String(f.status),
      amount: num(f.amount), issueDate: f.issueDate, dueDate: f.dueDate, paidDate: f.paidDate,
      courriers: courriersParFacture.get(f.id) ?? [],
    })),
    courriers: courriersParBon.get(o.id) ?? [],
  }));

  // ── LES FINANCES — chaque chiffre vient du module pur ou d'une somme de pièces réelles. ──
  const soumis = t.lines.reduce((s, l) => s + valeurSoumise({
    quantityUnits: l.quantityUnits, submittedQuantityUnits: l.submittedQuantityUnits,
    awardedQuantityUnits: l.awardedQuantityUnits, unitPriceDzd: num(l.unitPriceDzd),
    awardedUnitPriceDzd: num(l.awardedUnitPriceDzd), status: String(l.status),
  }), 0);
  const attribue = lignes.reduce((s, l) => s + l.valeurAttribuee, 0);
  const contratInitial = contrats.length ? contrats.reduce((s, c) => s + (c.montantInitial ?? 0), 0) : null;
  const contratCourant = contrats.length ? contrats.reduce((s, c) => s + (c.valeurCourante ?? c.montantInitial ?? 0), 0) : null;
  const bonsActifs = t.orders.filter((o) => o.status !== "CANCELLED");
  const commande = bonsActifs.reduce((s, o) => s + n0(o.value), 0);
  const livre = bonsActifs.reduce((s, o) => {
    const livree = o.status === "DELIVERED" || o.status === "PAID" || o.arrivedDate !== null
      || o.deliveries.some((d) => d.deliveredAt !== null);
    return s + (livree ? n0(o.value) : 0);
  }, 0);
  const facture = factures.filter((f) => f.status !== "CANCELLED").reduce((s, f) => s + n0(f.amount), 0);
  // ENCAISSÉ : les factures réglées quand il y en a ; à défaut, les bons marqués payés — la
  // réalité historique du module, dite telle quelle plutôt que zéro.
  const encaisseFactures = factures.filter((f) => f.status === "PAID").reduce((s, f) => s + n0(f.amount), 0);
  const encaisseBons = bonsActifs.filter((o) => o.status === "PAID" || o.paymentDate !== null).reduce((s, o) => s + n0(o.value), 0);
  const encaisse = Math.max(encaisseFactures, encaisseBons);

  // ── LES MANQUES — le dossier dit ce qui lui manque. ──────────────────────────────────────
  const manques: string[] = [];
  const aDesGagnes = t.lines.some((l) => String(l.status) === "WON");
  if (aDesGagnes && contrats.length === 0) manques.push("Marché gagné sans contrat rattaché — enregistrer ou rattacher la pièce.");
  if (t.submittedAt === null && t.lines.some((l) => l.unitPriceDzd !== null)) {
    manques.push("Lignes chiffrées sans dépôt officiel horodaté — verrouiller la soumission quand elle part.");
  }
  const bcSansLigne = bonsActifs.filter((o) => o.orderLines.length === 0).length;
  if (bcSansLigne > 0) manques.push(`${bcSansLigne} bon(s) de commande sans ligne détaillée.`);
  const bcSansFacture = bonsActifs.filter((o) => (o.status === "DELIVERED" || o.status === "PAID") && (facturesParBon.get(o.id) ?? []).length === 0).length;
  if (bcSansFacture > 0) manques.push(`${bcSansFacture} bon(s) livré(s) sans facture enregistrée dans Finances.`);
  const facturesEchues = factures.filter((f) => (f.status === "UNPAID" || f.status === "IN_CIRCUIT") && f.dueDate && f.dueDate < maintenant).length;
  if (facturesEchues > 0) manques.push(`${facturesEchues} facture(s) échue(s) non réglée(s).`);
  if (t.cautionEnd && t.cautionEnd < maintenant && !["COMPLETED", "CANCELLED"].includes(String(t.status))) {
    manques.push("Caution expirée sur un marché encore ouvert.");
  }

  const niveau = deriverNiveau({
    status: String(t.status),
    submittedAt: t.submittedAt,
    awardDate: t.awardDate,
    lignes: t.lines.map((l) => ({ status: String(l.status), unitPriceDzd: num(l.unitPriceDzd) })),
    aContratActif: contrats.some((c) => c.status === "ACTIVE"),
    aBonDeCommande: bonsActifs.length > 0,
  });

  return {
    tender: {
      id: t.id, reference: t.reference, internalReference: t.internalReference, title: t.title,
      client: t.client, status: String(t.status), companyId: t.companyId,
      companyName: t.company?.shortName ?? t.company?.name ?? null,
      publishedAt: t.publishedAt, submissionDeadline: t.submissionDeadline, submittedAt: t.submittedAt,
      awardDate: t.awardDate, responsible: t.responsible, businessUnit: t.businessUnit,
      notes: t.notes, cautionAmount: num(t.cautionAmount), cautionDeposited: t.cautionDeposited,
      cautionEnd: t.cautionEnd,
    },
    niveau: { ...niveau, etape: etapeCourante(niveau.niveau) },
    lignes,
    soumissions: t.submissions.map((s) => ({
      id: s.id, version: s.version, label: s.label, status: s.status,
      submittedAt: s.submittedAt, lockedAt: s.lockedAt,
      checklist: Array.isArray(s.checklist)
        ? (s.checklist as Array<Record<string, unknown>>).map((it) => ({
            key: String(it.key ?? ""), label: String(it.label ?? ""), done: Boolean(it.done),
            doneAt: typeof it.doneAt === "string" ? it.doneAt : null,
          }))
        : [],
      notes: s.notes,
    })),
    contrats,
    bons,
    finances: {
      valeurAnnoncee: null, // la valeur annoncée du tender vit sur la ligne d'en-tête, pas ici
      soumis, attribue, contratInitial, contratCourant, commande, livre, facture, encaisse,
      resteAEncaisser: Math.max(0, (contratCourant ?? commande) > 0 ? commande - encaisse : 0),
      resteAFacturer: Math.max(0, commande - facture),
    },
    courriers,
    manques,
  };
}

/**
 * LES MARCHÉS D'UN PRODUIT — la vue inverse (§30) : depuis la fiche Regulatory, tout
 * l'historique marchés du produit canonique, AO par AO, avec quantités et restants.
 */
export interface ProductMarketRow {
  tenderId: string; reference: string; title: string | null; client: string;
  annee: number | null; statutLigne: string; niveauMarche: string;
  quantiteSoumise: number; quantiteAttribuee: number; prixAttribue: number | null;
  valeurAttribuee: number; quantiteContractuelle: number; quantiteCommandee: number;
  restantACommander: number;
}

export async function loadProductMarkets(productId: string): Promise<ProductMarketRow[]> {
  const lines = await prisma.pchTenderLine.findMany({
    where: { productId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, status: true, quantityUnits: true, submittedQuantityUnits: true,
      awardedQuantityUnits: true, unitPriceDzd: true, awardedUnitPriceDzd: true, designation: true,
      tender: { select: { id: true, reference: true, title: true, client: true, status: true, submittedAt: true, awardDate: true, publishedAt: true, createdAt: true } },
      contractLines: {
        select: {
          quantityUnits: true,
          document: { select: { kind: true, status: true, effectiveAt: true } },
          orderLines: { select: { id: true, quantityUnits: true, order: { select: { status: true } } } },
        },
      },
      orderLines: { select: { id: true, quantityUnits: true, order: { select: { status: true } } } },
    },
  });
  const maintenant = new Date();
  return lines.map((l) => {
    const faits = {
      quantityUnits: l.quantityUnits, submittedQuantityUnits: l.submittedQuantityUnits,
      awardedQuantityUnits: l.awardedQuantityUnits, unitPriceDzd: num(l.unitPriceDzd),
      awardedUnitPriceDzd: num(l.awardedUnitPriceDzd), status: String(l.status),
    };
    const contractuel = Math.max(0, l.contractLines.reduce((s, cl) => {
      const eff = String(cl.document.status) !== "CANCELLED"
        && (String(cl.document.kind) !== "AMENDMENT" || (cl.document.effectiveAt !== null && cl.document.effectiveAt <= maintenant));
      return s + (eff ? cl.quantityUnits : 0);
    }, 0));
    // Le commandé remonte par DEUX chemins — ligne d'AO directe, ou ligne contractuelle —
    // dédupliqués par identifiant : une ligne de BC reliée aux deux ne compte qu'une fois.
    const lignesBc = new Map<string, { quantityUnits: number; statut: string }>();
    for (const ol of l.orderLines) lignesBc.set(ol.id, { quantityUnits: ol.quantityUnits, statut: String(ol.order.status) });
    for (const cl of l.contractLines) for (const ol of cl.orderLines) lignesBc.set(ol.id, { quantityUnits: ol.quantityUnits, statut: String(ol.order.status) });
    const commande = [...lignesBc.values()].reduce((s, ol) => s + (ol.statut !== "CANCELLED" ? ol.quantityUnits : 0), 0);
    return {
      tenderId: l.tender.id, reference: l.tender.reference, title: l.tender.title,
      client: l.tender.client,
      annee: (l.tender.publishedAt ?? l.tender.submittedAt ?? l.tender.awardDate ?? l.tender.createdAt)?.getFullYear() ?? null,
      statutLigne: String(l.status),
      niveauMarche: String(l.tender.status),
      quantiteSoumise: uniteSoumises(faits),
      quantiteAttribuee: unitesAttribuees(faits),
      prixAttribue: faits.awardedUnitPriceDzd ?? (String(l.status) === "WON" ? faits.unitPriceDzd : null),
      valeurAttribuee: valeurAttribuee(faits),
      quantiteContractuelle: contractuel,
      quantiteCommandee: commande,
      restantACommander: restantACommander(contractuel, commande),
    };
  });
}
