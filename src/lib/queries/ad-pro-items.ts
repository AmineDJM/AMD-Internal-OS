import { ETAPE_DEMANDE_DEVIS } from "@/lib/ad-pro/demande-devis-lettre";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { getBudgetCategoryOptions } from "@/lib/queries/budget";
import type { SessionUser } from "@/lib/rbac";
import type { ItemRow } from "@/components/ad-pro/items-panel";
import type { LigneStockVue, ContexteMaterielStock } from "@/components/ad-pro/materiel-stock";
import { PARENT_COLONNE, type AdProParent } from "@/lib/ad-pro-items";
import { etatValidite, libelleArticleStock } from "@/lib/promo/stock";
import { familleQuantifiee, type PromoFamille } from "@/lib/promo/catalogue";
import { peutConfirmerMateriel } from "@/lib/promo/reservations";
import type { PostePourCloture } from "@/lib/ad-pro/cloture-sponsoring";
import { gestionnairesDuMagasin } from "@/lib/queries/promo-stock";
import { NATURES_PIECE_SECRETARIAT, PIECE_SECRETARIAT, estDemandeBcAEtablir, type NaturePieceSecretariat } from "@/lib/ad-pro/pieces-secretariat";
import { statutDuDossier } from "@/lib/promo-material/statut";
import { porteDesVoyageurs, refusRetraitReservation, lireEtapes } from "@/lib/ad-pro/voyageurs";
import { splitMulti } from "@/lib/ad-pro/pickers";
import { bcVivantsDesPostes, refusAnnulationBcDuPoste } from "@/lib/ad-pro/bc-etablis";
import type { VoyageurVue } from "@/components/ad-pro/voyageurs-bloc";
import type { HebergementVue } from "@/components/ad-pro/hebergements-bloc";
import { porteDesHebergements } from "@/lib/ad-pro/hebergements";
import { piecesDesPostes, demandesBCDesPostes, assistantesDeDirection } from "@/lib/ad-pro/pieces-poste";
import { peutValiderLeBrouillon } from "@/lib/bons-de-commande/brouillon";
import { pieceEmise, specRevisable, valeursComposables } from "@/lib/legal/piece-emise";
import { devisDesPostes } from "@/lib/queries/ad-pro-devis-poste";
import { droitsValidation, estDirectionMarketingPoste, type DroitsValidation } from "@/lib/ad-pro/validation-poste";

/**
 * CHARGEMENT DES POSTES D'UNE OPÉRATION AD & PRO — un seul endroit pour les quatre modules.
 *
 * Chaque page (sponsoring, prises en charge nationales et internationales, événements) recopiait
 * la même vingtaine de lignes : requête, résolution des libellés du matériel promo et de l'ordre
 * de dépense, conversion des décimaux. Une différence oubliée dans l'une d'elles — un champ du
 * cycle de validation non transmis — et l'écran ment sur l'état d'un poste. Ici, la vérité est
 * écrite une fois.
 *
 * Les libellés (matériel, ordre, budget, demande de devis) sont résolus **en lot** : une requête
 * par famille, jamais une par poste.
 */

export async function loadAdProItems(parent: AdProParent, parentId: string): Promise<ItemRow[]> {
  const rawItems = await prisma.adProItem.findMany({
    where: { [PARENT_COLONNE[parent]]: parentId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: {
      budgetCategory: { select: { name: true, envelope: { select: { name: true } } } },
      decisions: {
        orderBy: { at: "desc" },
        take: 12,
        select: { decision: true, note: true, amount: true, at: true, by: { select: { name: true } } },
      },
      // L'historique est borné à douze lignes : son TOTAL voyage avec lui, sinon « Historique (12) » se
      // lirait comme tout ce qui s'est passé (§118.60, audit 360° R24–R36).
      _count: { select: { decisions: true } },
    },
  });
  if (rawItems.length === 0) return [];

  const promoIds = rawItems.map((i) => i.promoMaterialId).filter((x): x is string => Boolean(x));
  const orderIds = rawItems.map((i) => i.expenseOrderId).filter((x): x is string => Boolean(x));
  const itemIds = rawItems.map((i) => i.id);
  // LA BILLETTERIE (§118.175) : ses voyageurs, leurs passeports, le sujet de réservation, et les
  // noms que la demande porte déjà — chargés seulement s'il y a un poste qui en a l'usage.
  const billetterie = rawItems.filter((i) => porteDesVoyageurs(i.kind)).map((i) => i.id);
  // L'HÔTELLERIE (Direction, 06/10) : une fiche par personne logée, ses documents par `stepKey`, comme un voyageur.
  const hotellerie = rawItems.filter((i) => porteDesHebergements(i.kind)).map((i) => i.id);
  const aFiches = [...billetterie, ...hotellerie];
  const sujetsIds = rawItems.map((i) => i.reservationDossierId).filter((x): x is string => Boolean(x));
  const [voyageurRows, passeportRows, sujetRows, nomsSuggeres, hebergementRows, sponsoringIndirect] = await Promise.all([
    billetterie.length
      ? prisma.adProVoyageur.findMany({ where: { itemId: { in: billetterie } }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] })
      : Promise.resolve([]),
    aFiches.length
      ? prisma.document.findMany({
          where: { entityType: "AD_PRO_ITEM", entityId: { in: aFiches }, stepKey: { not: null } },
          select: { id: true, name: true, stepKey: true, fileKey: true, category: true }, orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
    sujetsIds.length
      ? prisma.dossier.findMany({ where: { id: { in: sujetsIds } }, select: { id: true, reference: true, status: true } })
      : Promise.resolve([]),
    aFiches.length ? nomsDeLaDemande(parent, parentId) : Promise.resolve([] as string[]),
    hotellerie.length
      ? prisma.adProHebergement.findMany({ where: { itemId: { in: hotellerie } }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] })
      : Promise.resolve([]),
    // UN SPONSORING INDIRECT : les fiches par personne de ses postes sont facultatives (Direction, 06/10).
    parent === "SPONSORING" && aFiches.length
      ? prisma.sponsoringRequest.findUnique({ where: { id: parentId }, select: { nature: true } }).then((s) => s?.nature === "INDIRECT")
      : Promise.resolve(false),
  ]);
  // LES DOCUMENTS D'UN VOYAGEUR : le passeport (catégorie « pièce d'identité ») et tout autre document
  // (visa, assurance, justificatif…). Tous sont des pièces du poste désignées par le voyageur (`stepKey`).
  const passeportsDe = new Map<string, VoyageurVue["passeports"]>();
  const autresDocsDe = new Map<string, VoyageurVue["autresDocuments"]>();
  for (const d of passeportRows) {
    if (!d.stepKey) continue;
    const cible = String(d.category) === "ID_DOCUMENT" ? passeportsDe : autresDocsDe;
    const l = cible.get(d.stepKey) ?? [];
    l.push({ id: d.id, name: d.name, hasFile: Boolean(d.fileKey) });
    cible.set(d.stepKey, l);
  }
  // LE DEVIS DE CHAQUE VOYAGEUR (§118.205) : un devis du poste marqué pour lui, et son premier fichier.
  const liensDevis = voyageurRows.length
    ? await prisma.adProVoyageurDevis.findMany({
        where: { voyageurId: { in: voyageurRows.map((v) => v.id) } },
        orderBy: { createdAt: "asc" },
        select: {
          voyageurId: true, retenuLe: true,
          piece: { select: { legalDocument: { select: { id: true, title: true, reference: true, amount: true, status: true, cancelledAt: true } } } },
        },
      })
    : [];
  const fichiersDevis = liensDevis.length
    ? await prisma.document.findMany({
        where: { entityType: "LEGAL_DOCUMENT", entityId: { in: liensDevis.map((l) => l.piece.legalDocument.id) } },
        select: { id: true, name: true, entityId: true, fileKey: true }, orderBy: { createdAt: "asc" },
      })
    : [];
  const fichierDe = new Map<string, { id: string; name: string; hasFile: boolean }>();
  for (const f of fichiersDevis) if (!fichierDe.has(f.entityId)) fichierDe.set(f.entityId, { id: f.id, name: f.name, hasFile: Boolean(f.fileKey) });
  const devisDe = new Map<string, VoyageurVue["devis"]>();
  for (const l of liensDevis) {
    const d = l.piece.legalDocument;
    const liste = devisDe.get(l.voyageurId) ?? [];
    liste.push({
      id: d.id, titre: d.title, reference: d.reference, montant: d.amount != null ? toNumber(d.amount) : null,
      retenu: l.retenuLe != null, annule: d.status === "CANCELLED" || d.cancelledAt != null, fichier: fichierDe.get(d.id) ?? null,
    });
    devisDe.set(l.voyageurId, liste);
  }
  const etapesLues = (json: unknown) => { const l = lireEtapes(json); return l.ok ? l.etapes : []; };
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const voyageursDe = new Map<string, VoyageurVue[]>();
  for (const v of voyageurRows) {
    const l = voyageursDe.get(v.itemId) ?? [];
    l.push({
      id: v.id, nom: v.nom, prenom: v.prenom, villeDepart: v.villeDepart, villeArrivee: v.villeArrivee,
      dateDepart: iso(v.dateDepart), dateRetour: iso(v.dateRetour), notes: v.notes, passeports: passeportsDe.get(v.id) ?? [],
      autresDocuments: autresDocsDe.get(v.id) ?? [], segments: etapesLues(v.segments),
      trajet: v.trajet, transport: v.transport, devis: devisDe.get(v.id) ?? [],
    });
    voyageursDe.set(v.itemId, l);
  }
  const hebergementsDe = new Map<string, HebergementVue[]>();
  for (const h of hebergementRows) {
    const l = hebergementsDe.get(h.itemId) ?? [];
    l.push({
      id: h.id, nom: h.nom, prenom: h.prenom, hotel: h.hotel, ville: h.ville, dateArrivee: iso(h.dateArrivee), dateDepart: iso(h.dateDepart),
      typeChambre: h.typeChambre, notes: h.notes, piecesIdentite: passeportsDe.get(h.id) ?? [], autresDocuments: autresDocsDe.get(h.id) ?? [],
    });
    hebergementsDe.set(h.itemId, l);
  }
  const sujetDe = new Map(sujetRows.map((d) => [d.id, { id: d.id, reference: d.reference, statut: String(d.status) }]));

  const [promoRows, orderRows, demandeRows, docRows, lignesParPoste, bcLegalParPoste] = await Promise.all([
    promoIds.length
      ? prisma.promoMaterial.findMany({ where: { id: { in: promoIds } }, select: { id: true, reference: true, title: true, status: true, circuitState: true, circuitVersion: true, returnedAt: true } })
      : Promise.resolve([]),
    orderIds.length
      ? prisma.expenseOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, reference: true, status: true } })
      : Promise.resolve([]),
    // LES DEMANDES DE PIÈCE, par le lien CANONIQUE — devis ET facture. En lire une par poste
    // ferait N allers-retours sur un écran qu'on ouvre pour tout voir (§118.102b).
    prisma.administrativeRequest.findMany({
      where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: { in: itemIds }, deletedAt: null },
      select: { id: true, reference: true, type: true, title: true, status: true, linkedEntityId: true },
      orderBy: { createdAt: "asc" },
    }),
    // LES PIÈCES JOINTES d'un poste : on en rend le COMPTE, pas la liste — l'écran ne les
    // déplie qu'à la demande, et charger les métadonnées de toutes les pièces de tous les
    // postes pour afficher un chiffre coûterait une requête pour rien.
    prisma.document.groupBy({
      by: ["entityId"],
      where: { entityType: "AD_PRO_ITEM", entityId: { in: itemIds } },
      _count: { _all: true },
    }),
    // LE MATÉRIEL DU STOCK des postes qui en portent (§118.167) — en lot, comme le reste.
    lignesStockParPoste(itemIds),
    // LES BC DÉJÀ ÉTABLIS DANS LEGAL (§118.187) : la même lecture que les actions qui les refusent.
    bcVivantsDesPostes(itemIds),
  ]);
  // LA CHAÎNE D'ACHAT DE CHAQUE POSTE (§118.204) — devis, BC, factures — et la demande de BC chez
  // l'assistante. En lot, comme le reste.
  const [piecesParPoste, demandeBcParPoste, devisParPoste] = await Promise.all([piecesDesPostes(itemIds), demandesBCDesPostes(itemIds), devisDesPostes(itemIds)]);
  // « MODIFIER LE BC » (Direction, 06/10) : ce que l'éditeur natif reprend d'un BC de la fabrique, ni signé ni annulé. Lu
  // ICI, dans la façade : la lecture d'une pièce émise est du domaine Legal, et le domaine Ad & Pro n'en importe pas.
  const bcsRevisables = [...piecesParPoste.values()].flatMap((p) => p.bcs).filter((b) => !b.annulee && b.etape !== "SIGNE");
  if (bcsRevisables.length > 0) {
    const docs = await prisma.legalDocument.findMany({
      where: { id: { in: bcsRevisables.map((b) => b.id) }, signedAt: null }, select: { id: true, custom: true },
    });
    const parId = new Map(docs.map((d) => [d.id, d.custom]));
    for (const b of bcsRevisables) {
      const custom = parId.get(b.id);
      const emise = custom !== undefined ? pieceEmise(custom) : null;
      const spec = emise ? specRevisable(custom) : null;
      const valeurs = emise ? valeursComposables(custom) : null;
      b.revision = emise && spec && valeurs ? { version: emise.version, numero: emise.numero, spec, valeurs } : null;
    }
  }
  const natureDuType = new Map<string, NaturePieceSecretariat>(
    NATURES_PIECE_SECRETARIAT.map((n) => [String(PIECE_SECRETARIAT[n].type), n]),
  );
  const demandesParPoste = new Map<string, ItemRow["demandes"]>();
  const travauxBcParPoste = new Map<string, ItemRow["travauxBc"]>();
  for (const d of demandeRows) {
    // LE « BC À ÉTABLIR » DE L'ASSISTANTE se montre sur la carte (audit 360°, R24–R36) : c'est le geste
    // qui suit la demande de bon de commande, et le demandeur ne le trouvait nulle part.
    if (d.linkedEntityId && estDemandeBcAEtablir({ type: String(d.type), title: d.title })) {
      const l = travauxBcParPoste.get(d.linkedEntityId) ?? [];
      l.push({ id: d.id, reference: d.reference, status: String(d.status) });
      travauxBcParPoste.set(d.linkedEntityId, l);
      continue;
    }
    const nature = natureDuType.get(String(d.type));
    // Une demande d'une AUTRE nature rattachée au poste (un déplacement, une signature) n'est
    // pas une pièce commerciale : on ne la range pas de force dans une case qui n'est pas la
    // sienne — la montrer comme un devis ferait croire le devis demandé (§118.26).
    if (!nature || !d.linkedEntityId) continue;
    const liste = demandesParPoste.get(d.linkedEntityId) ?? [];
    liste.push({ id: d.id, reference: d.reference, nature, status: String(d.status) });
    demandesParPoste.set(d.linkedEntityId, liste);
  }
  const docsParPoste = new Map(docRows.map((d) => [d.entityId, d._count._all]));
  // LES LETTRES DE DEMANDE DE DEVIS (Direction, 07/10) — l'étape « Demande de devis » du poste, la plus récente d'abord.
  const lettres = await prisma.document.findMany({
    where: { entityType: "AD_PRO_ITEM", entityId: { in: itemIds }, stepKey: ETAPE_DEMANDE_DEVIS },
    select: { id: true, name: true, entityId: true, mimeType: true, createdAt: true }, orderBy: { createdAt: "desc" },
  });
  const lettresParPoste = new Map<string, { id: string; nom: string; pdf: boolean; le: string }[]>();
  for (const d of lettres) {
    lettresParPoste.set(d.entityId, [...(lettresParPoste.get(d.entityId) ?? []), { id: d.id, nom: d.name, pdf: d.mimeType === "application/pdf", le: d.createdAt.toISOString() }]);
  }
  const promoById = new Map(promoRows.map((p) => [p.id, { reference: p.reference, title: p.title, status: statutDuDossier(p).libelle }]));
  const orderById = new Map(orderRows.map((o) => [o.id, { reference: o.reference, status: String(o.status) }]));

  return rawItems.map((i) => ({
    id: i.id, kind: i.kind, label: i.label, notes: i.notes, supplier: i.supplier,
    amountEstimated: i.amountEstimated != null ? toNumber(i.amountEstimated) : null,
    amountGranted: i.amountGranted != null ? toNumber(i.amountGranted) : null,
    addedAfterDecision: i.addedAfterDecision,
    promoMaterialId: i.promoMaterialId,
    promoMaterial: i.promoMaterialId ? promoById.get(i.promoMaterialId) ?? null : null,
    expenseOrderId: i.expenseOrderId,
    expenseOrder: i.expenseOrderId ? orderById.get(i.expenseOrderId) ?? null : null,
    status: i.status,
    budgetKind: i.budgetKind,
    decisionNote: i.decisionNote,
    decidedAt: i.decidedAt?.toISOString() ?? null,
    budgetCategoryId: i.budgetCategoryId,
    budgetCategoryLabel: i.budgetCategory ? `${i.budgetCategory.envelope.name} › ${i.budgetCategory.name}` : null,
    demandes: demandesParPoste.get(i.id) ?? [],
    travauxBc: travauxBcParPoste.get(i.id) ?? [],
    bcEtablis: [...new Set((bcLegalParPoste.get(i.id) ?? []).map((b) => b.nom))],
    // CE QUI EMPÊCHE « Annuler la demande de BC » (constat 36) — la règle de l'action, lue ici pour que la
    // carte n'offre pas un geste que l'action refuserait (§118.83).
    refusAnnulationBc: refusAnnulationBcDuPoste(bcLegalParPoste.get(i.id) ?? []),
    documentCount: docsParPoste.get(i.id) ?? 0,
    demandesDevis: lettresParPoste.get(i.id) ?? [],
    lignesStock: lignesParPoste.get(i.id) ?? [],
    repartitionId: i.repartitionId,
    reservation: (() => {
      const sujet = i.reservationDossierId ? sujetDe.get(i.reservationDossierId) ?? null : null;
      // CE QUI EMPÊCHE DE RETIRER LA DEMANDE (constat 37) — la règle de l'action, pour que la carte
      // n'offre pas un geste qu'elle refuserait (§118.83).
      return sujet ? { id: sujet.id, reference: sujet.reference, refusRetrait: refusRetraitReservation({ sujet: sujet.statut, orderStage: String(i.orderStage) }) } : null;
    })(),
    voyageurs: voyageursDe.get(i.id) ?? [],
    hebergements: hebergementsDe.get(i.id) ?? [],
    priseEnChargeIndirecte: i.repartitionId != null || sponsoringIndirect,
    nomsSuggeres: porteDesVoyageurs(i.kind) || porteDesHebergements(i.kind) ? nomsSuggeres : [],
    orderStage: i.orderStage,
    opsDecidedAt: i.opsDecidedAt?.toISOString() ?? null,
    opsDecisionNote: i.opsDecisionNote,
    pieces: piecesParPoste.get(i.id) ?? { devis: [], bc: null, bcs: [], factures: [] },
    devisLignes: devisParPoste.get(i.id) ?? [],
    demandeBC: demandeBcParPoste.get(i.id) ?? null,
    // SOUS LE SEUIL (§118.149) : le BC est passé aux Finances sans qu'aucun centre le vise — seul
    // le visa du centre pose `orderDirectionAt`. La fiche ne doit pas dire « validé par le centre ».
    orderSansCentre: i.orderStage === "DIRECTION_OK" && i.orderDirectionAt === null,
    orderNote: i.orderNote,
    orderDecisionNote: i.orderDecisionNote,
    decisionsTotal: i._count.decisions,
    decisions: i.decisions.map((d) => ({
      decision: d.decision,
      note: d.note,
      amount: d.amount != null ? toNumber(d.amount) : null,
      at: d.at.toISOString(),
      by: d.by?.name ?? null,
    })),
  }));
}

/**
 * LES NOMS QUE LA DEMANDE PORTE DÉJÀ — proposés à la saisie d'un voyageur (§118.175).
 *
 * Les médecins concernés d'un sponsoring ou d'un événement (le texte de la demande, tel qu'écrit à
 * sa création), les personnes prises en charge d'un congrès. Une SUGGESTION : le nom saisi reste
 * libre, et rien n'est rattaché à une fiche d'après lui (§118.85).
 */
async function nomsDeLaDemande(parent: AdProParent, parentId: string): Promise<string[]> {
  if (parent === "SPONSORING" || parent === "EVENT") {
    const r = parent === "SPONSORING"
      ? await prisma.sponsoringRequest.findUnique({ where: { id: parentId }, select: { doctor: true } })
      : await prisma.event.findUnique({ where: { id: parentId }, select: { doctor: true } });
    return splitMulti(r?.doctor ?? null);
  }
  const colonne = parent === "CONGRESS_NATIONAL" ? "congressNationalId" : "congressInternationalId";
  const personnes = await prisma.careBeneficiary.findMany({
    where: { [colonne]: parentId }, orderBy: { position: "asc" },
    select: { doctorId: true, firstName: true, lastName: true },
  });
  const ids = personnes.map((p) => p.doctorId).filter((x): x is string => Boolean(x));
  const nomDe = new Map(
    (ids.length ? await prisma.medicalDoctor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [])
      .map((d) => [d.id, d.name]),
  );
  const noms = personnes.map((p) => (p.doctorId ? nomDe.get(p.doctorId) : [p.firstName, p.lastName].filter(Boolean).join(" ")) ?? "");
  return [...new Set(noms.map((n) => n.trim()).filter(Boolean))];
}

/**
 * (Sous-)catégories budgétaires proposées pour imputer un poste accordé. Restreintes aux
 * enveloppes couvrant la FAMILLE Ad & Pro et accessibles au décideur — imputer un poste de
 * congrès à une enveloppe Regulatory n'aurait aucun sens, et proposer une enveloppe fermée
 * ferait échouer le choix au dernier moment.
 */
export async function adProBudgetOptions(viewer: SessionUser): Promise<{ id: string; label: string }[]> {
  const opts = await getBudgetCategoryOptions(
    ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS", "PROMO_MATERIAL"],
    viewer,
  );
  return opts.map((o) => ({ id: o.id, label: o.label }));
}

// ─────────────────────────── Le matériel du stock d'un poste (§118.167) ───────────────────────────

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** Les lignes de matériel de ces postes, rangées par poste — une requête pour tous. */
export async function lignesStockParPoste(itemIds: readonly string[]): Promise<Map<string, LigneStockVue[]>> {
  const out = new Map<string, LigneStockVue[]>();
  if (itemIds.length === 0) return out;
  const lignes = await prisma.adProStockLine.findMany({
    where: { itemId: { in: [...itemIds] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, itemId: true, stockItemId: true, quantite: true, statut: true,
      utilisee: true, rendue: true, abimee: true, perdue: true, confirmeeLe: true, note: true,
      stockItem: {
        select: {
          catalogue: { select: { nom: true, famille: true, unite: true } },
          produits: { select: { product: { select: { canonicalName: true } } } },
        },
      },
    },
  });
  const opt = (v: unknown): number | null => (v == null ? null : num(v));
  for (const l of lignes) {
    const liste = out.get(l.itemId) ?? [];
    liste.push({
      id: l.id,
      stockItemId: l.stockItemId,
      libelle: libelleArticleStock(l.stockItem.catalogue.nom, l.stockItem.produits.map((p) => p.product.canonicalName)),
      famille: l.stockItem.catalogue.famille as PromoFamille,
      unite: l.stockItem.catalogue.unite,
      quantite: num(l.quantite),
      statut: l.statut,
      utilisee: opt(l.utilisee),
      rendue: opt(l.rendue),
      abimee: opt(l.abimee),
      perdue: opt(l.perdue),
      confirmeeLe: l.confirmeeLe?.toISOString() ?? null,
      note: l.note,
    });
    out.set(l.itemId, liste);
  }
  return out;
}

/**
 * LES POSTES D'UN SPONSORING, TELS QUE LA CLÔTURE LES JUGE — une seule lecture pour l'écran, l'action
 * et l'op d'Adam : la nature et le matériel réservé font partie du bilan (§118.167), et trois
 * lectures écrites à la main finiraient par oublier l'un des deux chez l'un des trois (§118.5).
 */
export async function postesPourCloture(sponsoringId: string): Promise<PostePourCloture[]> {
  const postes = await prisma.adProItem.findMany({
    where: { sponsoringId },
    select: { id: true, label: true, status: true, kind: true, amountGranted: true, budgetCategoryId: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  const lignes = await lignesStockParPoste(postes.filter((p) => p.kind === "STOCK_MATERIAL").map((p) => p.id));
  return postes.map((p) => ({
    label: p.label,
    status: p.status,
    kind: p.kind,
    amountGranted: p.amountGranted != null ? toNumber(p.amountGranted) : null,
    budgetCategoryId: p.budgetCategoryId,
    lignesStock: (lignes.get(p.id) ?? []).map((l) => ({ libelle: l.libelle, statut: l.statut })),
  }));
}

/** Le demandeur et la société d'une opération — ce que le matériel du stock en a besoin. */
async function auteurEtSociete(parent: AdProParent, parentId: string): Promise<{ requesterId: string | null; companyId: string | null } | null> {
  const select = { requesterId: true, companyId: true } as const;
  switch (parent) {
    case "SPONSORING": return prisma.sponsoringRequest.findUnique({ where: { id: parentId }, select });
    case "CONGRESS_NATIONAL": return prisma.congressNational.findUnique({ where: { id: parentId }, select });
    case "CONGRESS_INTERNATIONAL": return prisma.congressInternational.findUnique({ where: { id: parentId }, select });
    case "EVENT": return prisma.event.findUnique({ where: { id: parentId }, select });
  }
}

/**
 * CE QU'UN POSTE « MATÉRIEL DU STOCK » PEUT DEMANDER, ET QUI CONFIRME APRÈS (§118.167).
 *
 * Le MAGASIN de la société de l'opération — les articles qui se comptent, avec ce qui s'y distribue
 * aujourd'hui (lots non périmés) : c'est une INDICATION, l'accord du poste relit tout sous le verrou
 * de chaque article et refuse ce que le magasin n'a plus. Sans société lisible, le magasin des
 * articles sans société : on ne pioche pas dans celui d'une autre société.
 *
 * `decideLesPostes` vient de la page, qui le calcule déjà pour le panneau : le recalculer ici en
 * ferait une seconde règle de « qui décide des postes ».
 */
export async function contexteMaterielStock(
  user: SessionUser, parent: AdProParent, parentId: string, decideLesPostes: boolean, maintenant: Date = new Date(),
): Promise<ContexteMaterielStock> {
  const [op, gestionnaires] = await Promise.all([auteurEtSociete(parent, parentId), gestionnairesDuMagasin()]);
  const companyId = op?.companyId ?? null;
  const articles = await prisma.promoStockItem.findMany({
    where: { isActive: true, companyId },
    select: {
      id: true,
      catalogue: { select: { nom: true, famille: true, unite: true } },
      produits: { select: { product: { select: { canonicalName: true } } } },
    },
  });
  const quantifies = articles.filter((a) => familleQuantifiee(a.catalogue.famille as PromoFamille));
  const ids = quantifies.map((a) => a.id);
  const sommes = ids.length
    ? await prisma.promoStockMovement.groupBy({ by: ["itemId", "lotId"], where: { itemId: { in: ids }, holderId: null }, _sum: { delta: true } })
    : [];
  const positifs = sommes.filter((x) => num(x._sum.delta) > 0);
  const lots = positifs.length
    ? await prisma.promoStockLot.findMany({ where: { id: { in: positifs.map((x) => x.lotId) } }, select: { id: true, valableJusquau: true } })
    : [];
  const validite = new Map(lots.map((l) => [l.id, l.valableJusquau]));
  const distribuable = new Map<string, number>();
  for (const x of positifs) {
    // LA MÊME LECTURE QUE LA RÉSERVATION : un lot périmé ne se réserve pas (`allouer`).
    if (etatValidite(validite.get(x.lotId) ?? null, maintenant) === "PERIME") continue;
    distribuable.set(x.itemId, r3((distribuable.get(x.itemId) ?? 0) + num(x._sum.delta)));
  }
  const magasin = quantifies
    .map((a) => ({
      itemId: a.id,
      libelle: libelleArticleStock(a.catalogue.nom, a.produits.map((p) => p.product.canonicalName)),
      famille: a.catalogue.famille as PromoFamille,
      unite: a.catalogue.unite,
      distribuable: distribuable.get(a.id) ?? 0,
    }))
    .sort((a, b) => a.libelle.localeCompare(b.libelle, "fr"));
  return {
    magasin,
    peutConfirmer: peutConfirmerMateriel({
      superAdmin: user.role === "SUPER_ADMIN",
      estLeDemandeur: op?.requesterId === user.id,
      gereLeMagasin: gestionnaires.includes(user.id),
      decideLesPostes,
    }),
  };
}

/**
 * LE CONTEXTE DES POSTES POUR LA PERSONNE QUI REGARDE (§118.204) — ce qu'elle tranche (Direction des
 * opérations, puis Direction Marketing : la même règle que l'action, `droitsValidation`), et les
 * assistantes de direction à qui un bon de commande peut être demandé. Calculé au SERVEUR : l'écran ne
 * recompose jamais une règle de droit (§118.164c).
 */
export interface ContextePostes {
  validation: DroitsValidation;
  assistantes: { id: string; name: string }[];
  /** Pour savoir si c'est elle qui vérifie le BC déposé (`demandeBC.askedById`). */
  userId: string;
  /** La demande vient de la Direction Marketing : le second temps revient à la Direction des opérations. */
  secondTempsParOperations: boolean;
  /** Valider l'aperçu du bon de commande et l'envoyer aux Finances : le demandeur de la demande, ou le Super Admin (`peutValiderLeBrouillon`). */
  peutValiderBc: boolean;
}

const DEMANDEUR_DE: Record<AdProParent, (id: string) => Promise<string | null>> = {
  SPONSORING: async (id) => (await prisma.sponsoringRequest.findUnique({ where: { id }, select: { requesterId: true } }))?.requesterId ?? null,
  CONGRESS_NATIONAL: async (id) => (await prisma.congressNational.findUnique({ where: { id }, select: { requesterId: true } }))?.requesterId ?? null,
  CONGRESS_INTERNATIONAL: async (id) => (await prisma.congressInternational.findUnique({ where: { id }, select: { requesterId: true } }))?.requesterId ?? null,
  EVENT: async (id) => (await prisma.event.findUnique({ where: { id }, select: { requesterId: true } }))?.requesterId ?? null,
};

export async function contextePostes(user: SessionUser, parent: AdProParent, parentId: string): Promise<ContextePostes> {
  const requesterId = await DEMANDEUR_DE[parent](parentId);
  const demandeur = requesterId ? await prisma.user.findUnique({ where: { id: requesterId }, select: { role: true, secondaryRole: true } }) : null;
  const moi = await prisma.user.findUnique({ where: { id: user.id }, select: { role: true, secondaryRole: true } });
  return {
    validation: droitsValidation(moi ?? { role: user.role }, demandeur),
    assistantes: await assistantesDeDirection(),
    userId: user.id,
    secondTempsParOperations: estDirectionMarketingPoste(demandeur),
    peutValiderBc: peutValiderLeBrouillon({ userId: user.id, role: user.role, demandeurId: requesterId }),
  };
}
