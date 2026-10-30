import { prisma } from "@/lib/prisma";
import { intentFor } from "@/platform/ia/workspace/direct-intents";
import { toNumber } from "@/lib/utils";
import { valeurContractuelleCourante } from "@/lib/pch/market-math";
import { invoiceSettlementState } from "@/lib/labels";
import type { StoryEvent, StoryThread, WorkspaceMetric } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GÉNÉRATEUR DE BUSINESS STORY — la frise est CONSTRUITE, jamais racontée.
 *
 * ── LA RÈGLE FONDATRICE ──────────────────────────────────────────────────────────────────
 *
 * Le modèle de langage NE FABRIQUE PAS cette frise. Il peut la commenter (« où a-t-on perdu du
 * temps ? »), en tirer une conclusion, désigner un risque — il ne l'invente pas. Une frise
 * hallucinée serait la pire sortie possible de ce produit : elle a exactement l'apparence d'une
 * preuve, avec des dates, des montants et des références qui n'existent pas.
 *
 * Chaque jalon ci-dessous vient donc d'une LIGNE EN BASE, et porte sa `provenance`.
 *
 * ── CE QUI FAIT LA DIFFÉRENCE AVEC UNE LISTE D'ÉVÉNEMENTS ────────────────────────────────
 *
 * Trois choses, et ce sont elles qui rendent la lecture possible :
 *
 *   1. LA HIÉRARCHIE (`parent`) — un bon de commande CONTIENT sa livraison, sa facture et son
 *      paiement. À plat, un marché à quatre BC produit seize lignes indistinctes ; en arbre, il
 *      produit quatre jalons qu'on ouvre.
 *   2. LES FILS (`fils`) — le lot Nivolumab traverse toute l'histoire. Filtrer dessus ne doit
 *      pas reconstruire la frise, seulement la lire autrement.
 *   3. LES TROUS (`etat: "manque"`) — une facture jamais émise, un paiement jamais reçu. C'est
 *      précisément ce qu'on cherche en retraçant une affaire, et une frise qui n'affiche que ce
 *      qui a eu lieu raconte l'histoire sans son trou.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const num = (v: unknown): number => (v === null || v === undefined ? 0 : toNumber(v));
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const DAY = 86_400_000;

/** Montant lisible en DZD, sans centimes — le modèle et le lecteur s'en passent également. */
function dzd(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(".", ",")} Md DZD`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)} M DZD`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k DZD`;
  return `${Math.round(n)} DZD`;
}

/** L'écart en jours entre deux dates — positif quand la seconde est en retard sur la première. */
function ecartJours(attendu: Date | null, reel: Date | null): number | null {
  if (!attendu || !reel) return null;
  return Math.round((reel.getTime() - attendu.getTime()) / DAY);
}

export interface BusinessStory {
  ancre: { type: string; id: string; label: string };
  titre: string;
  sousTitre: string | null;
  kpis: WorkspaceMetric[];
  events: StoryEvent[];
  threads: StoryThread[];
  /** Ce que la reconstitution n'a pas vu. Une story sans limites dites se croit complète. */
  limites: string[];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'HISTOIRE D'UN MARCHÉ PCH — « retrace-moi l'AONIO 2023 ».
 *
 * L'ordre des jalons suit le CIRCUIT RÉEL, pas la date : publication → soumission → attribution
 * → contrat → bons de commande (chacun avec sa livraison, sa facture, son paiement) → clôture.
 * Trier par date mélangerait le BC #3 de janvier et la facture du BC #1 de février, ce qui est
 * exact chronologiquement et illisible métier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function storyMarche(idOuReference: string): Promise<BusinessStory | null> {
  const clef = (idOuReference ?? "").trim();
  if (!clef) return null;

  const t = await prisma.pchTender.findFirst({
    where: { OR: [{ id: clef }, { reference: { equals: clef, mode: "insensitive" } }] },
    select: {
      id: true, reference: true, title: true, status: true, client: true, supplier: true,
      awardDate: true, value: true, quantity: true, createdAt: true, notes: true,
      publishedAt: true, submissionDeadline: true, submittedAt: true,
      cautionAmount: true, cautionDeposited: true, cautionStart: true, cautionEnd: true,
      company: { select: { shortName: true, name: true } },
      submissions: {
        orderBy: { version: "desc" },
        select: { id: true, version: true, submittedAt: true, lockedAt: true, status: true },
        take: 5,
      },
      lines: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, designation: true, status: true, quantityUnits: true,
          submittedQuantityUnits: true, awardedQuantityUnits: true,
          unitPriceDzd: true, awardedUnitPriceDzd: true, ourProduct: true,
          product: { select: { id: true, code: true, canonicalName: true } },
        },
      },
      orders: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, lineId: true, reference: true, quantity: true, value: true, status: true,
          receivedDate: true, paymentDate: true, expectedArrival: true, arrivedDate: true,
          createdAt: true, notes: true,
          deliveries: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true, reference: true, deliveredAt: true, expectedAt: true,
              lines: { select: { quantityUnits: true, batchNumber: true } },
            },
          },
        },
      },
    },
  });
  if (!t) return null;

  const events: StoryEvent[] = [];
  const limites: string[] = [];
  const nom = t.title ? `${t.reference} — ${t.title}` : t.reference;

  // ── LES FILS. Un par produit canonique nommé dans le marché, plus les familles ────────
  const filsProduit = new Map<string, { label: string; count: number }>();
  const filDe = (l: (typeof t.lines)[number]): string | null =>
    l.product ? `produit:${l.product.id}` : null;

  // ═══════════════ 1. LA PUBLICATION ═══════════════
  events.push({
    id: "publication",
    date: iso(t.publishedAt ?? t.createdAt),
    kind: "publication",
    titre: "Appel d'offres ouvert",
    detail: [
      t.client ? `Client : ${t.client}` : null,
      t.publishedAt ? null : "date d'enregistrement (publication non saisie)",
      t.submissionDeadline ? `dépôt avant le ${iso(t.submissionDeadline)}` : null,
    ].filter(Boolean).join(" · ") || null,
    etat: "fait",
    entityRef: { type: "PCH_TENDER", id: t.id, label: t.reference },
    metriques: [
      { valeur: String(t.lines.length), label: "lots" },
      ...(num(t.value) > 0 ? [{ valeur: dzd(num(t.value)), label: "valeur annoncée" }] : []),
    ],
    provenance: "PchTender",
    certitude: "fait",
  });

  // ═══════════════ 2. LA SOUMISSION ═══════════════
  //
  // LE DÉPÔT OFFICIEL D'ABORD (`submittedAt`, posé par la soumission verrouillée) : c'est un
  // FAIT daté, plus une déduction. Le repli par lignes chiffrées reste pour l'HISTORIQUE saisi
  // avant que la date existe — et il se dit DÉDUIT, comme avant.
  const soumises = t.lines.filter((l) => l.unitPriceDzd !== null || l.status !== "PENDING");
  const valeurSoumise = t.lines.reduce(
    (n, l) => n + (l.unitPriceDzd !== null ? (l.submittedQuantityUnits ?? l.quantityUnits) * num(l.unitPriceDzd) : 0), 0,
  );
  const versionDeposee = t.submissions.find((sub) => sub.lockedAt !== null) ?? null;
  if (t.submittedAt) {
    const retardDepot = ecartJours(t.submissionDeadline, t.submittedAt);
    events.push({
      id: "soumission",
      date: iso(t.submittedAt),
      kind: "soumission",
      titre: "Soumission déposée",
      detail: [
        versionDeposee ? `V${versionDeposee.version} verrouillée` : null,
        `${soumises.length} lot(s) chiffré(s) sur ${t.lines.length}`,
      ].filter(Boolean).join(" · "),
      etat: "fait",
      ...(retardDepot !== null && retardDepot > 0 ? { retardJours: retardDepot } : {}),
      metriques: [
        { valeur: `${soumises.length}/${t.lines.length}`, label: "lots soumis" },
        ...(valeurSoumise > 0 ? [{ valeur: dzd(valeurSoumise), label: "valeur soumise" }] : []),
      ],
      provenance: "PchTender.submittedAt — dépôt verrouillé",
      certitude: "fait",
    });
  } else if (soumises.length > 0) {
    events.push({
      id: "soumission",
      date: null,
      kind: "soumission",
      titre: "Soumission",
      detail: `${soumises.length} lot(s) chiffré(s) sur ${t.lines.length}`,
      etat: "fait",
      metriques: [
        { valeur: `${soumises.length}/${t.lines.length}`, label: "lots soumis" },
        ...(valeurSoumise > 0 ? [{ valeur: dzd(valeurSoumise), label: "valeur soumise" }] : []),
      ],
      provenance: "PchTenderLine — lignes chiffrées",
      // DÉDUIT, et le dire compte : aucun dépôt officiel n'a été enregistré sur ce marché.
      certitude: "deduit",
    });
    limites.push("aucun dépôt officiel enregistré : le jalon de soumission est déduit des lignes chiffrées");
  }

  // ═══════════════ 3. L'ATTRIBUTION, ET SES LOTS ═══════════════
  const gagnees = t.lines.filter((l) => l.status === "WON");
  const perdues = t.lines.filter((l) => l.status === "LOST");
  const infructueux = t.lines.filter((l) => l.status === "UNSUCCESSFUL").length;
  const lotsAnnules = t.lines.filter((l) => l.status === "CANCELLED").length;
  // La quantité ATTRIBUÉE d'un lot gagné : la quantité d'attribution si elle est saisie
  // (attribution PARTIELLE possible, §14), sinon la quantité soumise.
  const qteAttribuee = (l: (typeof t.lines)[number]): number =>
    l.awardedQuantityUnits ?? l.submittedQuantityUnits ?? l.quantityUnits;
  let attribue = 0;
  let gagneesSansPrix = 0;
  for (const l of gagnees) {
    if (l.awardedUnitPriceDzd === null) { gagneesSansPrix++; continue; }
    attribue += Math.round(qteAttribuee(l) * num(l.awardedUnitPriceDzd));
  }
  if (gagneesSansPrix > 0) {
    limites.push(`${gagneesSansPrix} lot(s) gagné(s) sans prix d'attribution saisi : exclus de la valeur attribuée`);
  }

  if (gagnees.length > 0 || perdues.length > 0 || infructueux > 0 || lotsAnnules > 0 || t.awardDate) {
    events.push({
      id: "attribution",
      date: iso(t.awardDate),
      kind: "attribution",
      titre: "Attribution",
      detail: [
        `${gagnees.length} lot(s) gagné(s)`,
        perdues.length ? `${perdues.length} perdu(s)` : null,
        infructueux ? `${infructueux} infructueux` : null,
        lotsAnnules ? `${lotsAnnules} annulé(s)` : null,
      ].filter(Boolean).join(" · "),
      etat: t.awardDate ? "fait" : "en-cours",
      metriques: [
        { valeur: `${gagnees.length}/${t.lines.length}`, label: "lots gagnés", ton: gagnees.length > 0 ? "succes" : "neutre" },
        ...(attribue > 0 ? [{ valeur: dzd(attribue), label: "valeur attribuée" }] : []),
      ],
      provenance: "PchTender.awardDate + statut des lignes",
      certitude: "fait",
    });

    // CHAQUE LOT est un sous-jalon de l'attribution : c'est le zoom demandé (« zoom sur
    // l'attribution » ouvre les lots, pas une autre requête).
    for (const l of t.lines) {
      const fil = filDe(l);
      if (fil && l.product) {
        const cur = filsProduit.get(fil) ?? { label: l.product.canonicalName, count: 0 };
        cur.count += 1;
        filsProduit.set(fil, cur);
      }
      const pa = l.awardedUnitPriceDzd !== null ? num(l.awardedUnitPriceDzd) : null;
      const soumisL = l.submittedQuantityUnits ?? l.quantityUnits;
      const partielle = l.status === "WON" && l.awardedQuantityUnits !== null && l.awardedQuantityUnits < soumisL;
      events.push({
        id: `lot:${l.id}`,
        date: iso(t.awardDate),
        kind: "attribution",
        titre: l.designation,
        detail: [
          l.product ? `${l.product.code} — ${l.product.canonicalName}` : (l.ourProduct ?? null),
          partielle ? `attribution PARTIELLE : ${l.awardedQuantityUnits}/${soumisL} u.` : null,
          l.status === "UNSUCCESSFUL" ? "lot infructueux" : l.status === "CANCELLED" ? "lot annulé" : null,
        ].filter(Boolean).join(" · ") || null,
        etat: l.status === "WON" ? "fait" : l.status === "LOST" || l.status === "UNSUCCESSFUL" || l.status === "CANCELLED" ? "echec" : "en-cours",
        parent: "attribution",
        entityRef: { type: "PCH_TENDER_LINE", id: l.id, label: l.designation },
        metriques: [
          { valeur: String(l.status === "WON" ? qteAttribuee(l) : l.quantityUnits), label: "unités" },
          ...(pa !== null && l.status === "WON" ? [{ valeur: dzd(qteAttribuee(l) * pa), label: "attribué" }] : []),
        ],
        ...(fil ? { fils: [fil, l.status === "WON" ? "famille:gagnes" : "famille:perdus"] } : { fils: [l.status === "WON" ? "famille:gagnes" : "famille:perdus"] }),
        provenance: "PchTenderLine",
        certitude: "fait",
        // ZOOM SANS MODÈLE (§23) : le produit du lot est identifié par clé étrangère. Faire
        // redécouvrir « quel produit » par un modèle serait payer un aller-retour pour une
        // information qu'on tient déjà.
        ...(l.product ? {
          actions: [{
            libelle: "Économie",
            phrase: `Économie du produit ${l.product.code}`,
            icone: "voir" as const,
            ...(intentFor("product.economics", { produit: l.product.code })
              ? { intent: intentFor("product.economics", { produit: l.product.code })! }
              : {}),
          }],
        } : {}),
      });
    }
  }

  // ═══════════════ 4. LE CONTRAT ═══════════════
  //
  // LE LIEN FORT D'ABORD : les contrats portent désormais le `tenderId` du marché — plus de
  // rapprochement par texte pour eux. Le repli par référence/source subsiste UNIQUEMENT pour
  // l'historique saisi avant la FK, et il est dit DÉDUIT.
  const contratsFk = await prisma.legalDocument.findMany({
    where: { tenderId: t.id, kind: { in: ["CONTRACT", "AGREEMENT"] } },
    orderBy: { startDate: "asc" },
    select: {
      id: true, reference: true, title: true, kind: true, startDate: true, endDate: true,
      amount: true, status: true, signedAt: true,
      amendments: {
        orderBy: { createdAt: "asc" },
        select: { id: true, reference: true, title: true, startDate: true, amountDelta: true, effectiveAt: true, signedAt: true, status: true },
      },
    },
  });
  const contratsTexte = contratsFk.length > 0 ? [] : await prisma.legalDocument.findMany({
    where: {
      tenderId: null,
      OR: [
        { reference: { contains: t.reference, mode: "insensitive" } },
        { title: { contains: t.reference, mode: "insensitive" } },
        { sourceType: "PCH_TENDER", sourceId: t.id },
      ],
    },
    orderBy: { startDate: "asc" },
    select: { id: true, reference: true, title: true, kind: true, startDate: true, endDate: true, amount: true, status: true },
    take: 12,
  });

  let nbAvenants = 0;
  if (contratsFk.length > 0) {
    for (const c of contratsFk) {
      const initial = num(c.amount) > 0 ? num(c.amount) : null;
      // LA VALEUR COURANTE : initial + deltas des avenants EFFECTIFS — le même calcul que la
      // fiche marché et la fiche Legal, jamais un montant réécrit.
      const courante = valeurContractuelleCourante(
        initial,
        c.amendments.map((a) => ({
          amountDelta: a.amountDelta !== null ? num(a.amountDelta) : null,
          status: String(a.status), effectiveAt: a.effectiveAt,
        })),
      );
      events.push({
        id: `contrat:${c.id}`,
        date: iso(c.signedAt ?? c.startDate),
        kind: "contrat",
        titre: c.title,
        detail: c.reference,
        etat: c.status === "CANCELLED" ? "echec" : "fait",
        entityRef: { type: "LEGAL_DOCUMENT", id: c.id, label: c.title },
        metriques: [
          ...(initial !== null ? [{ valeur: dzd(initial), label: "montant initial" }] : []),
          ...(courante !== null && courante !== initial ? [{ valeur: dzd(courante), label: "valeur courante" }] : []),
        ],
        fils: ["famille:contractuel"],
        provenance: "LegalDocument.tenderId",
        certitude: "fait",
      });
      for (const a of c.amendments) {
        nbAvenants += 1;
        const delta = a.amountDelta !== null ? num(a.amountDelta) : null;
        const effectif = a.status !== "CANCELLED" && a.effectiveAt !== null && a.effectiveAt <= new Date();
        events.push({
          id: `avenant:${a.id}`,
          date: iso(a.effectiveAt ?? a.signedAt ?? a.startDate),
          kind: "avenant",
          titre: a.title,
          detail: a.status === "CANCELLED" ? "annulé"
            : effectif ? `effectif${a.effectiveAt ? ` au ${iso(a.effectiveAt)}` : ""}`
              : a.signedAt ? "signé, pas encore effectif — ses deltas ne comptent pas" : "en préparation",
          etat: a.status === "CANCELLED" ? "echec" : effectif ? "fait" : "a-venir",
          parent: `contrat:${c.id}`,
          entityRef: { type: "LEGAL_DOCUMENT", id: a.id, label: a.title },
          metriques: delta !== null ? [{ valeur: `${delta >= 0 ? "+" : "−"}${dzd(Math.abs(delta))}`, label: "impact", ton: delta >= 0 ? "succes" : "attention" }] : [],
          fils: ["famille:contractuel"],
          provenance: "LegalDocument kind AMENDMENT (amendsId)",
          certitude: "fait",
        });
      }
    }
  } else if (contratsTexte.length > 0) {
    const contratPrincipal = contratsTexte.find((c) => c.kind === "CONTRACT") ?? contratsTexte[0];
    events.push({
      id: `contrat:${contratPrincipal.id}`,
      date: iso(contratPrincipal.startDate),
      kind: "contrat",
      titre: contratPrincipal.title,
      detail: contratPrincipal.reference,
      etat: contratPrincipal.status === "CANCELLED" ? "echec" : "fait",
      entityRef: { type: "LEGAL_DOCUMENT", id: contratPrincipal.id, label: contratPrincipal.title },
      metriques: num(contratPrincipal.amount) > 0 ? [{ valeur: dzd(num(contratPrincipal.amount)), label: "montant" }] : [],
      fils: ["famille:contractuel"],
      provenance: "recherche Legal par référence (pièce non rattachée par FK)",
      certitude: "deduit",
    });
    for (const c of contratsTexte.filter((x) => x.id !== contratPrincipal.id)) {
      nbAvenants += 1;
      events.push({
        id: `avenant:${c.id}`,
        date: iso(c.startDate),
        kind: "avenant",
        titre: c.title,
        detail: c.reference,
        etat: c.status === "CANCELLED" ? "echec" : "fait",
        parent: `contrat:${contratPrincipal.id}`,
        entityRef: { type: "LEGAL_DOCUMENT", id: c.id, label: c.title },
        metriques: num(c.amount) > 0 ? [{ valeur: dzd(num(c.amount)), label: "montant" }] : [],
        fils: ["famille:contractuel"],
        provenance: "recherche Legal par référence",
        certitude: "deduit",
      });
    }
    limites.push("contrat retrouvé par TEXTE, non rattaché au marché : le rattacher depuis la fiche fiabilisera la frise");
  } else if (gagnees.length > 0) {
    events.push({
      id: "contrat:manquant",
      date: null,
      kind: "contrat",
      titre: "Contrat",
      detail: `Aucune pièce Legal rattachée au marché ${t.reference}`,
      // LE TROU, AFFICHÉ. Un marché gagné sans contrat rattaché est soit une pièce non
      // enregistrée, soit un contrat qui n'a jamais été signé — deux situations à traiter.
      etat: "manque",
      fils: ["famille:contractuel", "famille:risques"],
      provenance: "LegalDocument.tenderId + recherche par référence",
      certitude: "attente",
    });
    limites.push(`aucun contrat rattaché : recherche par tenderId, puis par la référence « ${t.reference} » et la source PCH_TENDER`);
  }

  // ═══════════════ 5. LES BONS DE COMMANDE, ET LEUR CHAÎNE ═══════════════
  const ligneParId = new Map(t.lines.map((l) => [l.id, l]));
  // LES FACTURES RÉELLES, rattachées aux bons (§22-23 : pas de mécanisme financier parallèle —
  // on LIT les factures, on n'en fabrique pas). Une facture est un document légal de nature
  // « facture » : son n° est sa `reference`, son émission son `startDate`, son échéance son
  // `endDate`, et son règlement se lit sur `paidDate` — jamais sur un statut qui pourrait le
  // contredire.
  const facturesRows = t.orders.length
    ? await prisma.legalDocument.findMany({
        where: { kind: "INVOICE", sourceType: "PCH_ORDER", sourceId: { in: t.orders.map((o) => o.id) } },
        select: {
          id: true, reference: true, amount: true, status: true, startDate: true, endDate: true,
          paidDate: true, expenseOrderId: true, kind: true, sourceId: true,
        },
        orderBy: { startDate: "asc" },
      })
    : [];
  const facturesParBon = new Map<string, typeof facturesRows>();
  for (const f of facturesRows) {
    if (!f.sourceId) continue;
    const list = facturesParBon.get(f.sourceId) ?? [];
    list.push(f);
    facturesParBon.set(f.sourceId, list);
  }
  let facture: number | null = null;
  let commande = 0, livre = 0, encaisse = 0;
  const delaisPaiement: number[] = [];
  let bcSansLigne = 0;
  let n = 0;

  for (const o of t.orders) {
    n += 1;
    const annule = o.status === "CANCELLED";
    const v = num(o.value);
    if (!annule) commande += v;

    const ligne = o.lineId ? ligneParId.get(o.lineId) : null;
    if (!o.lineId && !annule) bcSansLigne += 1;
    const fil = ligne ? filDe(ligne) : null;
    const filsBc = [...(fil ? [fil] : []), "famille:commandes"];

    const bcId = `bc:${o.id}`;
    events.push({
      id: bcId,
      date: iso(o.receivedDate ?? o.createdAt),
      kind: "commande",
      titre: `Bon de commande ${o.reference ?? `#${String(n).padStart(3, "0")}`}`,
      detail: ligne ? ligne.designation : "non rattaché à une ligne du marché",
      etat: annule ? "echec" : "fait",
      entityRef: { type: "PCH_ORDER", id: o.id, label: o.reference ?? bcId },
      metriques: [
        { valeur: String(o.quantity), label: "unités" },
        ...(v > 0 ? [{ valeur: dzd(v), label: "montant" }] : []),
      ],
      fils: filsBc,
      provenance: "PchOrder",
      certitude: "fait",
    });

    if (annule) continue;

    // ── LA LIVRAISON, sous le bon ──────────────────────────────────────────────────────
    //
    // LES LIVRAISONS RÉELLES D'ABORD : chaque BL enregistré (`PchDelivery`) est un jalon daté,
    // avec ses unités et ses lots pharma. Le statut du bon reste le repli de l'historique.
    const livreeStatut = o.status === "DELIVERED" || o.status === "PAID"
      || o.deliveries.some((d) => d.deliveredAt !== null);
    if (o.deliveries.length > 0) {
      for (const d of o.deliveries) {
        const unites = d.lines.reduce((a, dl) => a + dl.quantityUnits, 0);
        const lots = [...new Set(d.lines.map((dl) => dl.batchNumber).filter(Boolean))];
        const retardBl = ecartJours(d.expectedAt, d.deliveredAt);
        events.push({
          id: `livraison:${d.id}`,
          date: iso(d.deliveredAt ?? d.expectedAt),
          kind: "livraison",
          titre: d.reference ? `Livraison BL ${d.reference}` : "Livraison",
          detail: lots.length ? `lot(s) ${lots.join(", ")}` : null,
          etat: d.deliveredAt ? "fait" : "a-venir",
          parent: bcId,
          ...(retardBl !== null && retardBl > 0 ? { retardJours: retardBl } : {}),
          metriques: unites > 0 ? [{ valeur: String(unites), label: "unités livrées" }] : [],
          fils: [...filsBc, ...(retardBl !== null && retardBl > 0 ? ["famille:retards"] : [])],
          provenance: "PchDelivery",
          certitude: d.deliveredAt ? "fait" : "attente",
        });
      }
      if (o.deliveries.some((d) => d.deliveredAt)) livre += v;
      // Le repli par statut n'a plus rien à dire : les BL réels racontent mieux.
    } else {
    const arrivee = o.arrivedDate;
    const retardArrivee = ecartJours(o.expectedArrival, arrivee ?? new Date());
    if (livreeStatut || arrivee) {
      livre += v;
      events.push({
        id: `livraison:${o.id}`,
        date: iso(arrivee ?? o.receivedDate),
        kind: "livraison",
        titre: "Livraison",
        detail: arrivee ? null : "statut livré, date d'arrivée non saisie",
        etat: "fait",
        parent: bcId,
        ...(retardArrivee !== null && retardArrivee > 0 ? { retardJours: retardArrivee } : {}),
        fils: [...filsBc, ...(retardArrivee !== null && retardArrivee > 0 ? ["famille:retards"] : [])],
        provenance: "PchOrder.status / arrivedDate",
        certitude: arrivee ? "fait" : "deduit",
      });
    } else {
      // LE TROU : commandé, pas livré. Avec le retard s'il y en a un.
      const enRetard = o.expectedArrival && o.expectedArrival < new Date();
      events.push({
        id: `livraison:${o.id}`,
        date: iso(o.expectedArrival),
        kind: "livraison",
        titre: "Livraison attendue",
        detail: o.expectedArrival ? null : "aucune date d'arrivée prévue",
        etat: enRetard ? "echec" : "a-venir",
        parent: bcId,
        ...(enRetard ? { retardJours: Math.floor((Date.now() - o.expectedArrival!.getTime()) / DAY) } : {}),
        fils: [...filsBc, ...(enRetard ? ["famille:retards", "famille:risques"] : [])],
        provenance: "PchOrder.expectedArrival",
        certitude: "attente",
      });
    }

    }

    // ── LA FACTURE ET LE PAIEMENT ──────────────────────────────────────────────────────
    const factures = facturesParBon.get(o.id) ?? [];
    for (const f of factures) {
      const regle = invoiceSettlementState(f);
      const enRetardFacture = regle !== "PAID" && f.status !== "CANCELLED" && f.endDate !== null && f.endDate < new Date();
      events.push({
        id: `facture:${f.id}`,
        date: iso(f.startDate),
        kind: "facture",
        titre: `Facture ${f.reference ?? ""}`.trim(),
        detail: regle === "PAID" ? "réglée"
          : regle === "IN_CIRCUIT" ? "partie au règlement"
          : f.endDate ? `échéance ${iso(f.endDate)}` : "non réglée",
        etat: regle === "PAID" ? "fait" : enRetardFacture ? "echec" : "a-venir",
        parent: bcId,
        entityRef: { type: "INVOICE", id: f.id, label: f.reference ?? "facture" },
        metriques: num(f.amount) > 0 ? [{ valeur: dzd(num(f.amount)), label: "facturé" }] : [],
        ...(enRetardFacture && f.endDate ? { retardJours: Math.floor((Date.now() - f.endDate.getTime()) / DAY) } : {}),
        fils: [...filsBc, "famille:paiements", ...(enRetardFacture ? ["famille:retards", "famille:risques"] : [])],
        provenance: "LegalDocument kind INVOICE (sourceType PCH_ORDER)",
        certitude: "fait",
      });
      if (!facture) facture = 0;
      facture += num(f.amount);
    }

    const paye = o.status === "PAID" || o.paymentDate !== null;
    if (paye) {
      encaisse += v;
      const delai = ecartJours(o.arrivedDate ?? o.receivedDate, o.paymentDate);
      if (delai !== null) delaisPaiement.push(delai);
      events.push({
        id: `paiement:${o.id}`,
        date: iso(o.paymentDate),
        kind: "paiement",
        titre: "Paiement reçu",
        etat: "fait",
        parent: bcId,
        metriques: v > 0 ? [{ valeur: dzd(v), label: "encaissé", ton: "succes" }] : [],
        ...(delai !== null && delai > 60 ? { retardJours: delai - 60 } : {}),
        fils: [...filsBc, "famille:paiements", ...(delai !== null && delai > 60 ? ["famille:retards"] : [])],
        provenance: "PchOrder.paymentDate",
        certitude: "fait",
      });
    } else {
      events.push({
        id: `paiement:${o.id}`,
        date: null,
        kind: "paiement",
        titre: "Paiement en attente",
        detail: livreeStatut ? "livré, non réglé" : "non livré, non réglé",
        etat: livreeStatut ? "manque" : "a-venir",
        parent: bcId,
        metriques: v > 0 ? [{ valeur: dzd(v), label: "dû", ton: livreeStatut ? "alerte" : "neutre" }] : [],
        fils: [...filsBc, "famille:paiements", ...(livreeStatut ? ["famille:risques"] : [])],
        provenance: "PchOrder.status",
        certitude: "attente",
      });
    }
  }

  if (bcSansLigne > 0) {
    limites.push(`${bcSansLigne} bon(s) de commande non rattaché(s) à une ligne : présents dans les montants, absents des fils par produit`);
  }

  // ═══════════════ 6. LES COURRIERS ═══════════════
  const courriers = await prisma.mailEntry.findMany({
    where: {
      OR: [
        { reference: { contains: t.reference, mode: "insensitive" } },
        { title: { contains: t.reference, mode: "insensitive" } },
        { sourceType: "PCH_TENDER", sourceId: t.id },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, reference: true, title: true, direction: true, sentAt: true, receivedAt: true },
    take: 20,
  });
  for (const c of courriers) {
    events.push({
      id: `courrier:${c.id}`,
      date: iso(c.sentAt ?? c.receivedAt),
      kind: "courrier",
      titre: c.title,
      detail: c.direction === "OUTGOING" ? "Courrier sortant" : "Courrier entrant",
      etat: "fait",
      entityRef: { type: "MAIL_ENTRY", id: c.id, label: c.reference ?? c.title },
      fils: ["famille:courriers"],
      provenance: "MailEntry",
      certitude: "fait",
    });
  }

  // ═══════════════ 7. LA CLÔTURE ═══════════════
  if (t.status === "COMPLETED" || t.status === "CANCELLED") {
    events.push({
      id: "cloture",
      date: null,
      kind: "cloture",
      titre: t.status === "COMPLETED" ? "Marché clôturé" : "Marché annulé",
      etat: t.status === "COMPLETED" ? "fait" : "echec",
      provenance: "PchTender.status",
      certitude: "fait",
    });
  }

  // ═══════════════ LES KPI DE L'AFFAIRE (§50) ═══════════════
  const delaiMoyen = delaisPaiement.length
    ? Math.round(delaisPaiement.reduce((a, b) => a + b, 0) / delaisPaiement.length)
    : null;
  const retards = events.filter((e) => (e.retardJours ?? 0) > 0).length;

  const kpis: WorkspaceMetric[] = [
    { valeur: `${gagnees.length}/${t.lines.length}`, label: "lots gagnés", ton: gagnees.length ? "succes" : "neutre" },
    { valeur: dzd(attribue), label: "attribué" },
    { valeur: dzd(commande), label: "commandé" },
    { valeur: dzd(livre), label: "livré" },
    { valeur: dzd(encaisse), label: "encaissé", ton: "succes" },
    {
      valeur: dzd(Math.max(0, commande - encaisse)),
      label: "reste à encaisser",
      ton: commande - encaisse > 0 ? "attention" : "succes",
    },
    ...(facture !== null && facture > 0 ? [{ valeur: dzd(facture), label: "facturé" }] : []),
    ...(delaiMoyen !== null ? [{ valeur: `${delaiMoyen} j`, label: "délai moyen de paiement", ton: (delaiMoyen > 90 ? "alerte" : delaiMoyen > 60 ? "attention" : "succes") as WorkspaceMetric["ton"] }] : []),
    ...(retards > 0 ? [{ valeur: String(retards), label: "jalons en retard", ton: "alerte" as const }] : []),
    ...(nbAvenants > 0 ? [{ valeur: String(nbAvenants), label: "avenants" }] : []),
  ];

  // ═══════════════ LES FILS PROPOSÉS ═══════════════
  const familles: Record<string, string> = {
    "famille:gagnes": "Lots gagnés",
    "famille:perdus": "Lots perdus",
    "famille:contractuel": "Jalons contractuels",
    "famille:commandes": "Bons de commande",
    "famille:paiements": "Paiements",
    "famille:retards": "Retards",
    "famille:risques": "Risques",
    "famille:courriers": "Courriers",
  };
  const compte = new Map<string, number>();
  for (const e of events) for (const f of e.fils ?? []) compte.set(f, (compte.get(f) ?? 0) + 1);

  const threads: StoryThread[] = [
    ...[...filsProduit.entries()].map(([id, v]) => ({
      id, label: v.label, count: compte.get(id) ?? 0, genre: "produit" as const,
    })),
    ...Object.entries(familles)
      .filter(([id]) => (compte.get(id) ?? 0) > 0)
      .map(([id, label]) => ({
        id, label, count: compte.get(id) ?? 0,
        genre: (id.includes("retard") || id.includes("risque") ? "risque" : "famille") as "risque" | "famille",
      })),
  ].filter((f) => f.count > 0);

  if (t.lines.some((l) => !l.product)) {
    limites.push(`${t.lines.filter((l) => !l.product).length} ligne(s) sans produit canonique : absentes des fils par produit`);
  }

  return {
    ancre: { type: "PCH_TENDER", id: t.id, label: t.reference },
    titre: nom,
    sousTitre: [
      t.company?.shortName ?? t.company?.name,
      t.client,
      t.status === "COMPLETED" ? "clôturé" : t.status === "CANCELLED" ? "annulé" : "en cours",
    ].filter(Boolean).join(" · ") || null,
    kpis,
    events,
    threads,
    limites,
  };
}

/**
 * L'HISTOIRE D'UN PRODUIT — sa vie réglementaire, commerciale et promotionnelle.
 *
 * Plus courte qu'une histoire de marché, et c'est normal : un produit n'a pas de circuit
 * contractuel propre. Ce qu'il a, c'est un dossier qui avance, des marchés qu'il traverse et
 * des ventes qui s'accumulent.
 */
export async function storyProduit(productId: string): Promise<BusinessStory | null> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true, code: true, canonicalName: true, createdAt: true, lifecycle: true,
      regulatoryProfiles: {
        select: {
          id: true, reference: true, status: true, targetSubmissionDate: true, targetDate: true,
          createdAt: true, responsible: { select: { name: true } },
        },
        take: 10,
      },
      tenderLines: {
        select: {
          id: true, designation: true, status: true, quantityUnits: true, awardedUnitPriceDzd: true,
          tender: { select: { id: true, reference: true, awardDate: true } },
        },
        orderBy: { createdAt: "asc" }, take: 40,
      },
    },
  });
  if (!p) return null;

  const events: StoryEvent[] = [];
  const limites: string[] = [];

  events.push({
    id: "creation",
    date: iso(p.createdAt),
    kind: "jalon",
    titre: "Produit inscrit au catalogue canonique",
    detail: p.code,
    etat: "fait",
    entityRef: { type: "PRODUCT", id: p.id, label: p.code },
    provenance: "Product",
    certitude: "fait",
  });

  for (const r of p.regulatoryProfiles) {
    events.push({
      id: `dossier:${r.id}`,
      date: iso(r.createdAt),
      kind: "jalon",
      titre: `Dossier réglementaire ${r.reference}`,
      detail: r.responsible?.name ? `Chargé : ${r.responsible.name}` : null,
      etat: r.status === "DECISION_OBTAINED" ? "fait" : "en-cours",
      entityRef: { type: "REGULATORY_PRODUCT", id: r.id, label: r.reference },
      metriques: [{ valeur: r.status, label: "statut" }],
      fils: ["famille:reglementaire"],
      provenance: "RegulatoryProduct",
      certitude: "fait",
    });
    const cible = r.targetDate ?? r.targetSubmissionDate;
    if (cible && r.status !== "DECISION_OBTAINED") {
      const retard = Math.floor((Date.now() - cible.getTime()) / DAY);
      events.push({
        id: `cible:${r.id}`,
        date: iso(cible),
        kind: "jalon",
        titre: retard > 0 ? "Date cible dépassée" : "Date cible",
        parent: `dossier:${r.id}`,
        etat: retard > 0 ? "echec" : "a-venir",
        ...(retard > 0 ? { retardJours: retard } : {}),
        fils: ["famille:reglementaire", ...(retard > 0 ? ["famille:retards"] : [])],
        provenance: "RegulatoryProduct.targetDate",
        certitude: "fait",
      });
    }
  }

  for (const l of p.tenderLines) {
    events.push({
      id: `lot:${l.id}`,
      date: iso(l.tender.awardDate),
      kind: "attribution",
      titre: `${l.tender.reference} — ${l.designation}`,
      etat: l.status === "WON" ? "fait" : l.status === "LOST" ? "echec" : "en-cours",
      entityRef: { type: "PCH_TENDER_LINE", id: l.id, label: l.designation },
      metriques: l.awardedUnitPriceDzd !== null
        ? [{ valeur: dzd(l.quantityUnits * num(l.awardedUnitPriceDzd)), label: "attribué" }]
        : [{ valeur: String(l.quantityUnits), label: "unités" }],
      fils: ["famille:marches", l.status === "WON" ? "famille:gagnes" : "famille:perdus"],
      provenance: "PchTenderLine",
      certitude: "fait",
      actions: [{
        libelle: "Le marché",
        phrase: `État du marché ${l.tender.reference}`,
        icone: "voir" as const,
        ...(intentFor("pch.status", { marche: l.tender.reference })
          ? { intent: intentFor("pch.status", { marche: l.tender.reference })! }
          : {}),
      }],
    });
  }

  const ventes = await prisma.sale.aggregate({
    where: { productId },
    _count: { _all: true }, _sum: { revenue: true },
    _min: { date: true }, _max: { date: true },
  });
  if (ventes._count._all > 0) {
    events.push({
      id: "ventes",
      date: iso(ventes._min.date),
      kind: "jalon",
      titre: "Première vente enregistrée",
      detail: `${ventes._count._all} vente(s) jusqu'au ${iso(ventes._max.date) ?? "—"}`,
      etat: "fait",
      metriques: [{ valeur: dzd(num(ventes._sum.revenue)), label: "chiffre d'affaires cumulé" }],
      fils: ["famille:ventes"],
      provenance: "Sale",
      certitude: "fait",
    });
  }

  if (p.regulatoryProfiles.length === 0) {
    limites.push("aucun dossier réglementaire rattaché — le produit peut être à l'étude, ou son dossier non rapproché");
  }
  limites.push("les documents et courriers non rattachés au produit ne figurent pas ici : ils se cherchent par le texte");

  const compte = new Map<string, number>();
  for (const e of events) for (const f of e.fils ?? []) compte.set(f, (compte.get(f) ?? 0) + 1);
  const labels: Record<string, string> = {
    "famille:reglementaire": "Réglementaire", "famille:marches": "Marchés",
    "famille:gagnes": "Lots gagnés", "famille:perdus": "Lots perdus",
    "famille:ventes": "Ventes", "famille:retards": "Retards",
  };

  return {
    ancre: { type: "PRODUCT", id: p.id, label: p.code },
    titre: `${p.code} — ${p.canonicalName}`,
    sousTitre: p.lifecycle,
    kpis: [
      { valeur: String(p.regulatoryProfiles.length), label: "dossiers" },
      { valeur: String(p.tenderLines.filter((l) => l.status === "WON").length), label: "lots gagnés", ton: "succes" },
      { valeur: String(ventes._count._all), label: "ventes" },
      { valeur: dzd(num(ventes._sum.revenue)), label: "CA cumulé" },
    ],
    events,
    threads: Object.entries(labels)
      .filter(([id]) => (compte.get(id) ?? 0) > 0)
      .map(([id, label]) => ({
        id, label, count: compte.get(id) ?? 0,
        genre: (id.includes("retard") ? "risque" : "famille") as "risque" | "famille",
      })),
    limites,
  };
}
