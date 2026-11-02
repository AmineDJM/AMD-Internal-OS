import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { chargerStrategie, chargerPanel, type LignePanel, type StrategieChargee } from "@/lib/segmentation/service";
import { porteeSegmentation } from "@/lib/segmentation/droits";
import type { Instantane } from "@/lib/segmentation/cycle-service";
import type { EtatProduit, Lettre, Statut } from "@/lib/segmentation/regles";
import { splitMulti } from "@/modules/ad-pro/partage";
import { chargerLiensAdPro, medecinsParDemande } from "@/modules/ad-pro/api";
import { getBudgetOverview, getEnvelopes } from "@/lib/queries/budget";
import {
  aSesDeuxReponses, dansFenetre, lettreFigee, lettrePourProduit, moisDe, moisGlissants, partDeLAnnee, partImputee,
  segmentPourProduit, statsMessage, type Depense, type Fenetre, type NatureAdPro, type PraticienCockpit, type StatsMessage,
} from "./calculs";
import { sansBloquer } from "@/lib/journal";

/**
 * MARKETING COCKPIT — les LECTURES (serveur). Chaque chiffre vient d'une table existante : la segmentation (moteur
 * du Studio, jamais recalculé à part), les visites terminées de la Force de vente, les liens message ↔ visite, les
 * postes Ad & Pro accordés et leurs imputations produit, le matériel promotionnel, les enveloppes budgétaires.
 * Les calculs sont dans `calculs.ts` (purs, testés) ; ici, on lit et on assemble.
 */

// ───────────────────────────── Le périmètre : BU et produit ─────────────────────────────

export interface ProduitCockpit {
  /** Le produit promu de la BU (`PromoProduct`). */
  id: string;
  /** Le produit canonique — celui que la segmentation, les messages et Ad & Pro désignent. */
  productId: string | null;
  nom: string;
  dci: string | null;
  businessUnitId: string;
}

export interface BuCockpit {
  id: string;
  nom: string;
  strategieId: string | null;
  produits: ProduitCockpit[];
}

/** Les BU actives et leurs produits promus actifs — la portée du sélecteur. */
export async function chargerBusCockpit(): Promise<BuCockpit[]> {
  const bus = await prisma.businessUnit.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true, name: true,
      segmentationStrategies: { where: { statut: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
      products: {
        where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, productId: true, canonicalProduct: { select: { canonicalName: true, dci: true } } },
      },
    },
  });
  return bus.map((b) => ({
    id: b.id, nom: b.name, strategieId: b.segmentationStrategies[0]?.id ?? null,
    produits: b.products.map((p) => ({
      id: p.id, productId: p.productId, nom: p.canonicalProduct?.canonicalName ?? p.name, dci: p.canonicalProduct?.dci ?? null, businessUnitId: b.id,
    })),
  }));
}

/**
 * LE PÉRIMÈTRE DEMANDÉ : `?produit=` (un produit promu) l'emporte, puis `?bu=` (tous les produits de la BU). Sans rien,
 * la première BU qui a une segmentation active, sur son produit n° 1.
 */
export function choisirPerimetre(bus: readonly BuCockpit[], params: { bu?: string; produit?: string }): { bu: BuCockpit; produit: ProduitCockpit | null; explicite: boolean } | null {
  for (const b of bus) {
    const p = b.produits.find((x) => x.id === params.produit);
    if (p) return { bu: b, produit: p, explicite: true };
  }
  const parBu = bus.find((b) => b.id === params.bu);
  if (parBu) return { bu: parBu, produit: null, explicite: true };
  const bu = bus.find((b) => b.strategieId) ?? bus.find((b) => b.produits.length) ?? bus[0];
  return bu ? { bu, produit: null, explicite: false } : null;
}

// ───────────────────────────── La base : panel, cycle, visites ─────────────────────────────

export interface CycleCockpit extends Fenetre {
  libelle: string;
  /** Vrai = un cycle de segmentation ouvert ; faux = le mois civil, faute de cycle. */
  segmentation: boolean;
}

export interface BaseCockpit {
  strategie: StrategieChargee | null;
  /** Le produit dont on lit la lettre (le produit choisi, sinon le n° 1 de la stratégie). */
  productId: string | null;
  /** Le produit choisi est-il classé par la stratégie ? (sinon : la lettre de la BU). */
  produitClasse: boolean;
  panel: LignePanel[];
  lettreDe: Map<string, Lettre>;
  segmentDe: Map<string, EtatProduit | null>;
  praticiens: PraticienCockpit[];
  cycle: CycleCockpit;
  precedent: { libelle: string; segments: Map<string, EtatProduit | null> } | null;
  visites: Map<string, { cycle: number; six: number }>;
  /** Médecins de l'annuaire dans les spécialités visées — null si aucune spécialité n'est déclarée. */
  annuaire: number | null;
  /** KAM actifs de la BU. */
  delegues: number;
}

const libelleDuMois = (d: Date) => d.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });

export async function chargerBase(user: SessionUser, bu: BuCockpit, produit: ProduitCockpit | null, maintenant: Date): Promise<BaseCockpit> {
  const portee = porteeSegmentation(user);
  const strategie = bu.strategieId ? await chargerStrategie(bu.strategieId) : null;
  const panel = strategie ? await chargerPanel(strategie, portee) : [];
  const classes = strategie?.produits.map((p) => p.productId) ?? [];
  const productId = produit?.productId ?? classes[0] ?? null;
  const produitClasse = !!productId && classes.includes(productId);

  // LE CYCLE : celui de la segmentation, ouvert aujourd'hui ; à défaut, le mois civil.
  const debutDuJour = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate()));
  const ouvert = strategie ? await prisma.segmentationCycle.findFirst({
    where: { strategieId: strategie.id, statut: "OUVERT", debut: { lte: maintenant }, fin: { gte: debutDuJour } },
    orderBy: { debut: "desc" }, select: { libelle: true, debut: true, fin: true },
  }) : null;
  const mois = moisDe(maintenant);
  const cycle: CycleCockpit = ouvert
    ? { debut: ouvert.debut, fin: ouvert.fin, libelle: ouvert.libelle, segmentation: true }
    : { ...mois, libelle: libelleDuMois(maintenant), segmentation: false };

  // LE CYCLE PRÉCÉDENT, tel qu'il a été FIGÉ (lettres de l'époque) — pour dire ce qui a bougé.
  const avant = strategie ? await prisma.segmentationCycle.findFirst({
    where: { strategieId: strategie.id, debut: { lt: cycle.debut } }, orderBy: { debut: "desc" }, select: { libelle: true, instantane: true },
  }) : null;
  let precedent: BaseCockpit["precedent"] = null;
  if (avant && productId) {
    const inst = avant.instantane as unknown as Instantane;
    const idx = inst?.produits?.findIndex((p) => p.productId === productId) ?? -1;
    if (idx >= 0 && Array.isArray(inst.praticiens)) {
      precedent = { libelle: avant.libelle, segments: new Map(inst.praticiens.map((p) => [p.doctorId, lettreFigee(p, idx).segment])) };
    }
  }

  // LES VISITES TERMINÉES (Force de vente) : ce cycle, et les six derniers mois.
  const ids = panel.map((l) => l.doctorId);
  const depuis = new Date(Math.min(moisGlissants(maintenant, 6)[0].debut.getTime(), cycle.debut.getTime()));
  const lues = ids.length ? await prisma.medicalVisit.findMany({
    where: { status: "COMPLETED", doctorId: { in: ids }, date: { gte: depuis } }, select: { doctorId: true, date: true },
  }) : [];
  const six = moisGlissants(maintenant, 6)[0].debut;
  const visites = new Map<string, { cycle: number; six: number }>();
  for (const v of lues) {
    if (!v.doctorId) continue;
    const x = visites.get(v.doctorId) ?? { cycle: 0, six: 0 };
    if (dansFenetre(v.date, cycle)) x.cycle++;
    if (v.date >= six) x.six++;
    visites.set(v.doctorId, x);
  }

  const lettreDe = new Map<string, Lettre>();
  const segmentDe = new Map<string, EtatProduit | null>();
  const praticiens: PraticienCockpit[] = panel.map((l) => {
    const lettre = lettrePourProduit(l.resultat, productId);
    const segment = segmentPourProduit(l.resultat, productId);
    lettreDe.set(l.doctorId, lettre);
    segmentDe.set(l.doctorId, segment);
    return {
      doctorId: l.doctorId, lettre, segment, deuxReponses: aSesDeuxReponses(l.resultat, productId),
      requises: l.resultat?.visites ?? 0, faitesCycle: visites.get(l.doctorId)?.cycle ?? 0,
    };
  });

  // L'ANNUAIRE VISÉ : les spécialités du produit dans la BU, sinon celles de la BU.
  const [speProduit, speBu, delegues] = await Promise.all([
    produit ? prisma.promoProductSpecialite.findMany({ where: { promoProductId: produit.id }, select: { specialtyId: true } }) : Promise.resolve([]),
    prisma.businessUnitSpecialty.findMany({ where: { businessUnitId: bu.id }, select: { specialtyId: true } }),
    prisma.salesRepProfile.count({ where: { businessUnitId: bu.id, isActive: true } }),
  ]);
  const specialites = (speProduit.length ? speProduit : speBu).map((s) => s.specialtyId);
  const annuaire = specialites.length
    ? await prisma.medicalDoctor.count({ where: { AND: [portee, { archivedAt: null, specialtyId: { in: specialites } }] } })
    : null;

  return { strategie, productId, produitClasse, panel, lettreDe, segmentDe, praticiens, cycle, precedent, visites, annuaire, delegues };
}

// ───────────────────────────── Messages ─────────────────────────────

export interface LigneMessage {
  id: string;
  title: string;
  body: string | null;
  businessUnitId: string | null;
  productId: string | null;
  portee: string;
  isActive: boolean;
  sortOrder: number;
  usages: number;
  stats: StatsMessage;
}

/** Les messages du périmètre (le produit, ou la BU) — et ceux qui valent pour toutes les gammes —, avec leur portage. */
export async function chargerMessages(base: BaseCockpit, bu: BuCockpit, produit: ProduitCockpit | null, maintenant: Date): Promise<LigneMessage[]> {
  const produitsBu = bu.produits.map((p) => p.productId).filter((x): x is string => !!x);
  const sansProduitDeLaBu: Prisma.PromoMessageWhereInput = { productId: null, OR: [{ businessUnitId: bu.id }, { businessUnitId: null }] };
  const where: Prisma.PromoMessageWhereInput = produit?.productId
    ? { OR: [{ productId: produit.productId }, sansProduitDeLaBu] }
    : { OR: [sansProduitDeLaBu, ...(produitsBu.length ? [{ productId: { in: produitsBu } }] : [])] };
  const messages = await prisma.promoMessage.findMany({
    where,
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { title: "asc" }],
    select: {
      id: true, title: true, body: true, businessUnitId: true, productId: true, isActive: true, sortOrder: true,
      businessUnit: { select: { name: true } }, product: { select: { canonicalName: true } },
      _count: { select: { visitLinks: true } },
    },
  });
  const mois = moisGlissants(maintenant, 6);
  const depuis = new Date(Math.min(mois[0].debut.getTime(), base.cycle.debut.getTime()));
  const liens = messages.length ? await prisma.medicalVisitMessage.findMany({
    where: { messageId: { in: messages.map((m) => m.id) }, visit: { date: { gte: depuis } } },
    select: { messageId: true, visit: { select: { date: true, doctorId: true, delegateId: true } } },
  }) : [];
  const parMessage = new Map<string, { date: Date; doctorId: string | null; delegateId: string | null }[]>();
  for (const l of liens) parMessage.set(l.messageId, [...(parMessage.get(l.messageId) ?? []), l.visit]);
  return messages.map((m) => ({
    id: m.id, title: m.title, body: m.body, businessUnitId: m.businessUnitId, productId: m.productId,
    portee: m.product?.canonicalName ?? (m.businessUnit ? `BU ${m.businessUnit.name}` : "Toutes les gammes"),
    isActive: m.isActive, sortOrder: m.sortOrder, usages: m._count.visitLinks,
    stats: statsMessage(parMessage.get(m.id) ?? [], base.cycle, mois, (id) => base.lettreDe.get(id) ?? null),
  }));
}

// ───────────────────────────── Leaders d'opinion ─────────────────────────────

export const STATUTS_LEADERS: readonly Statut[] = ["DECIDEUR", "INFLUENCEUR", "REFERENT"];

export interface LigneLeader {
  doctorId: string;
  nom: string;
  etablissement: string | null;
  specialite: string | null;
  specialiteId: string | null;
  statut: Statut;
  lettre: Lettre;
  derniereVisite: Date | null;
  visites6: number;
  adPro: string[];
  /** Montant attribuable à CE praticien (prises en charge nominatives, sponsoring à son seul nom) — null si rien. */
  investi: number | null;
}

const nomNorme = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export async function chargerLeaders(base: BaseCockpit, maintenant: Date): Promise<LigneLeader[]> {
  const leaders = base.panel.filter((l) => l.statut && STATUTS_LEADERS.includes(l.statut));
  if (leaders.length === 0) return [];
  const ids = leaders.map((l) => l.doctorId);
  const depuis = new Date(maintenant.getTime() - 365 * 86_400_000);
  const noms = leaders.map((l) => l.nom.trim()).filter(Boolean);
  const [dernieres, beneficiaires, invitations, sponsorings, evenements] = await Promise.all([
    prisma.medicalVisit.groupBy({ by: ["doctorId"], where: { status: "COMPLETED", doctorId: { in: ids } }, _max: { date: true } }),
    prisma.careBeneficiary.findMany({
      where: { doctorId: { in: ids }, status: { in: ["PROPOSED", "APPROVED"] }, createdAt: { gte: depuis } },
      select: {
        doctorId: true, status: true,
        congressNational: { select: { name: true } }, congressInternational: { select: { name: true } },
        cells: { select: { amountDzd: true, status: true } },
      },
    }),
    Promise.all([
      prisma.congressNational.findMany({ where: { invitedDoctorIds: { hasSome: ids }, createdAt: { gte: depuis } }, select: { name: true, invitedDoctorIds: true } }),
      prisma.congressInternational.findMany({ where: { invitedDoctorIds: { hasSome: ids }, createdAt: { gte: depuis } }, select: { name: true, invitedDoctorIds: true } }),
    ]),
    noms.length ? prisma.sponsoringRequest.findMany({
      where: { requestDate: { gte: depuis }, status: { notIn: ["REFUSED", "CANCELLED"] }, OR: noms.map((n) => ({ doctor: { contains: n } })) },
      select: { id: true, doctor: true, type: true, amountGranted: true },
    }) : Promise.resolve([]),
    noms.length ? prisma.event.findMany({
      where: { createdAt: { gte: depuis }, status: { not: "CANCELLED" }, OR: noms.map((n) => ({ doctor: { contains: n } })) },
      select: { id: true, name: true, doctor: true },
    }) : Promise.resolve([]),
  ]);
  // LE LIEN AVEC L'ANNUAIRE (Direction, 08/10) : les médecins concernés choisis sur chaque demande Ad & Pro, et ceux que
  // les congrès portent déjà. Le rapprochement par NOM (plus bas) ne sert plus qu'aux demandes sans aucun médecin relié.
  const liensAdPro = await chargerLiensAdPro(ids, depuis);
  const reliees = new Set(
    sponsorings.length + evenements.length === 0 ? [] : (await prisma.adProMedecin.findMany({
      where: { OR: [
        { entityType: "SPONSORING", entityId: { in: sponsorings.map((x) => x.id) } },
        { entityType: "EVENT", entityId: { in: evenements.map((x) => x.id) } },
      ] },
      select: { entityType: true, entityId: true },
    })).map((x) => `${x.entityType}:${x.entityId}`),
  );
  const derniere = new Map(dernieres.map((d) => [d.doctorId, d._max.date]));
  return leaders.map((l): LigneLeader => {
    const adPro: string[] = [];
    let investi = 0;
    for (const b of beneficiaires.filter((x) => x.doctorId === l.doctorId)) {
      const nom = b.congressNational?.name ?? b.congressInternational?.name;
      if (nom) adPro.push(`Congrès ${nom}`);
      if (b.status === "APPROVED") investi += b.cells.filter((c) => c.status !== "WAIVED").reduce((s, c) => s + Number(c.amountDzd ?? 0), 0);
    }
    for (const c of [...invitations[0], ...invitations[1]]) if (c.invitedDoctorIds.includes(l.doctorId) && !adPro.includes(`Congrès ${c.name}`)) adPro.push(`Congrès ${c.name}`);
    const moi = nomNorme(l.nom);
    for (const lien of liensAdPro.filter((x) => x.doctorId === l.doctorId)) {
      adPro.push(lien.nom);
      // Les congrès ont leur argent dans les prises en charge (ci-dessus) : on ne le compte pas deux fois.
      if (lien.investi !== null && lien.nature !== "CONGRESS_NATIONAL" && lien.nature !== "CONGRESS_INTERNATIONAL") investi += lien.investi;
    }
    for (const s of sponsorings) {
      if (reliees.has(`SPONSORING:${s.id}`)) continue;
      const nommes = splitMulti(s.doctor).map(nomNorme);
      if (!nommes.includes(moi)) continue;
      adPro.push(`Sponsoring ${s.type}`.trim());
      // Attribuable seulement quand le sponsoring ne nomme QUE lui : sinon on ne sait pas le partager.
      if (nommes.length === 1 && s.amountGranted !== null) investi += Number(s.amountGranted);
    }
    for (const e of evenements) if (!reliees.has(`EVENT:${e.id}`) && splitMulti(e.doctor).map(nomNorme).includes(moi)) adPro.push(e.name);
    return {
      doctorId: l.doctorId, nom: l.nom, etablissement: l.etablissement, specialite: l.specialite, specialiteId: l.specialiteId,
      statut: l.statut as Statut, lettre: base.lettreDe.get(l.doctorId) ?? "NA",
      derniereVisite: derniere.get(l.doctorId) ?? null, visites6: base.visites.get(l.doctorId)?.six ?? 0,
      adPro: [...new Set(adPro)], investi: investi > 0 ? investi : null,
    };
  }).sort((a, b) => STATUTS_LEADERS.indexOf(a.statut) - STATUTS_LEADERS.indexOf(b.statut) || a.nom.localeCompare(b.nom, "fr"));
}

// ───────────────────────────── Investissements ─────────────────────────────

/**
 * L'ARGENT ENGAGÉ SUR 12 MOIS, rattaché au périmètre :
 *   • les postes Ad & Pro ACCORDÉS (congrès, sponsoring, événements) — pour un produit, la part que ses imputations
 *     lui donnent ; un poste de la BU sans imputation, la part que la règle de répartition de l'année lui donne
 *     (`CoutRepartitionBu`) — sinon il n'est pas compté pour le produit ;
 *   • le matériel promotionnel au devis retenu — pour un produit, au prorata des articles qui le portent.
 * Les praticiens NOMMÉS par chaque demande donnent ses lettres (prises en charge et invités des congrès, noms du
 * sponsoring et de l'événement, choisis dans l'annuaire).
 */
export async function chargerDepenses(base: BaseCockpit, bu: BuCockpit, produit: ProduitCockpit | null, maintenant: Date): Promise<Depense[]> {
  const depuis = new Date(maintenant.getTime() - 365 * 86_400_000);
  const productId = produit?.productId ?? null;
  const parBu: Prisma.AdProItemWhereInput[] = [
    { sponsoring: { businessUnitId: bu.id } }, { congressNational: { businessUnitId: bu.id } },
    { congressInternational: { businessUnitId: bu.id } }, { event: { businessUnitId: bu.id } },
  ];
  const congres = { select: { id: true, businessUnitId: true, invitedDoctorIds: true, careBeneficiaries: { select: { doctorId: true, status: true } } } } as const;
  const [items, repartitions, materiels] = await Promise.all([
    prisma.adProItem.findMany({
      where: {
        status: "APPROVED", amountGranted: { not: null },
        AND: [
          { OR: [{ decidedAt: { gte: depuis } }, { decidedAt: null, createdAt: { gte: depuis } }] },
          productId ? { OR: [{ productAllocations: { some: { productId } } }, { productAllocations: { none: {} }, OR: parBu }] } : { OR: parBu },
        ],
      },
      select: {
        amountGranted: true, decidedAt: true, createdAt: true,
        productAllocations: { select: { productId: true, sharePct: true, amountAllocated: true } },
        sponsoring: { select: { id: true, businessUnitId: true, doctor: true } },
        congressNational: congres, congressInternational: congres,
        event: { select: { id: true, businessUnitId: true, doctor: true } },
      },
    }),
    productId ? prisma.coutRepartitionBu.findMany({ where: { businessUnitId: bu.id, productId }, select: { annee: true, pct: true } }) : Promise.resolve([]),
    prisma.promoMaterial.findMany({
      where: {
        createdAt: { gte: depuis }, status: { not: "CANCELLED" }, OR: [{ chosenAmount: { not: null } }, { amount: { not: null } }],
        ...(productId ? { articlesDemandes: { some: { produits: { some: { productId } } } } } : { businessUnitId: bu.id }),
      },
      select: { id: true, chosenAmount: true, amount: true, articlesDemandes: { select: { produits: { select: { productId: true } } } } },
    }),
  ]);
  // LES MÉDECINS RELIÉS À L'ANNUAIRE sur chaque demande (Direction, 08/10) : ce sont eux qui donnent la lettre H·A·B de la
  // dépense ; le nom écrit à la main ne sert qu'aux demandes sans médecin relié.
  const reliesParDemande = await medecinsParDemande([
    ...items.flatMap((i) => [
      ...(i.sponsoring ? [{ nature: "SPONSORING" as const, id: i.sponsoring.id }] : []),
      ...(i.event ? [{ nature: "EVENT" as const, id: i.event.id }] : []),
      ...(i.congressNational ? [{ nature: "CONGRESS_NATIONAL" as const, id: i.congressNational.id }] : []),
      ...(i.congressInternational ? [{ nature: "CONGRESS_INTERNATIONAL" as const, id: i.congressInternational.id }] : []),
    ]),
    ...materiels.map((m) => ({ nature: "PROMO_MATERIAL" as const, id: m.id })),
  ]);
  const pctAnnee = new Map(repartitions.map((r) => [r.annee, Number(r.pct)]));
  const docParNom = new Map<string, string>();
  for (const l of base.panel) if (!docParNom.has(nomNorme(l.nom))) docParNom.set(nomNorme(l.nom), l.doctorId);
  const lettreDuDoc = (id: string): Lettre | null => base.lettreDe.get(id) ?? null;
  const lettresDesNoms = (texte: string | null): (Lettre | null)[] =>
    splitMulti(texte).map((n) => { const id = docParNom.get(nomNorme(n)); return id ? lettreDuDoc(id) : null; });

  const out: Depense[] = [];
  for (const i of items) {
    const montant = Number(i.amountGranted ?? 0);
    const c = i.congressNational ?? i.congressInternational;
    const nature: NatureAdPro | null = c ? "CONGRES" : i.sponsoring ? "SPONSORING" : i.event ? "EVENEMENTS" : null;
    if (!nature) continue;
    let part: number | null = montant;
    if (productId) {
      const imputations = i.productAllocations.map((a) => ({ productId: a.productId, pct: a.sharePct === null ? null : Number(a.sharePct), montant: a.amountAllocated === null ? null : Number(a.amountAllocated) }));
      if (imputations.length) part = partImputee(montant, imputations, productId);
      else {
        const pct = pctAnnee.get((i.decidedAt ?? i.createdAt).getUTCFullYear());
        part = pct === undefined ? null : montant * (pct / 100);
      }
    }
    if (part === null || !(part > 0)) continue;
    let lettres: (Lettre | null)[] = [];
    if (c) {
      const reliesCongres = reliesParDemande.get(`${i.congressNational ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL"}:${c.id}`) ?? [];
      const nommes = new Set([...c.careBeneficiaries.filter((b) => b.doctorId && b.status !== "REJECTED" && b.status !== "WITHDRAWN").map((b) => b.doctorId!), ...c.invitedDoctorIds, ...reliesCongres]);
      lettres = [...nommes].map(lettreDuDoc);
    } else {
      const reliesIci = reliesParDemande.get(i.sponsoring ? `SPONSORING:${i.sponsoring.id}` : `EVENT:${i.event?.id ?? ""}`) ?? [];
      lettres = reliesIci.length ? reliesIci.map(lettreDuDoc) : lettresDesNoms(i.sponsoring?.doctor ?? i.event?.doctor ?? null);
    }
    out.push({ nature, montant: part, lettres });
  }
  for (const m of materiels) {
    const montant = Number(m.chosenAmount ?? m.amount ?? 0);
    if (!(montant > 0)) continue;
    let part = montant;
    if (productId) {
      const total = m.articlesDemandes.length;
      const avec = m.articlesDemandes.filter((a) => a.produits.some((x) => x.productId === productId)).length;
      part = total ? montant * (avec / total) : 0;
    }
    if (part > 0) out.push({ nature: "MATERIEL", montant: part, lettres: (reliesParDemande.get(`PROMO_MATERIAL:${m.id}`) ?? []).map(lettreDuDoc) });
  }
  return out;
}

// ───────────────────────────── L'enveloppe ─────────────────────────────

const MODULES_AD_PRO = ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS", "PROMO_MATERIAL", "AD_PRO_OTHER"];

export interface EnveloppeCockpit {
  /** L'enveloppe dans Budget Marketing (le lien de la carte). */
  id: string;
  nom: string;
  annee: number;
  total: number;
  consomme: number;
  engage: number;
  disponible: number;
  /** Part de la période de l'enveloppe déjà écoulée (0..1). */
  tempsEcoule: number;
}

/**
 * L'ENVELOPPE MARKETING EN COURS que la personne a le droit de voir — lue dans BUDGET MARKETING (Direction, 08/10) :
 * une enveloppe `domaine = MARKETING`, active, couvrant aujourd'hui ; celle qui porte la famille Ad & Pro d'abord.
 * Ses chiffres sont ceux de l'écran Budget Marketing (`getBudgetOverview`, portée MARKETING) — consommé = réglé,
 * engagé = en attente de paiement.
 */
export async function chargerEnveloppe(user: SessionUser, maintenant: Date): Promise<EnveloppeCockpit | null> {
  if (!userCan(user, "BUDGET_MARKETING", "VIEW") && !userCan(user, "BUDGETS", "VIEW")) return null;
  const opts = { portee: "MARKETING" as const };
  const enveloppes = await getEnvelopes(user, opts);
  const t = maintenant.getTime();
  const enCours = enveloppes.filter((x) => x.isActive && new Date(x.periodStart).getTime() <= t && new Date(x.periodEnd).getTime() >= t);
  const adPro = (x: (typeof enCours)[number]) => x.modules.some((m) => MODULES_AD_PRO.includes(m)) || (x.module !== null && MODULES_AD_PRO.includes(x.module));
  const e = enCours.find(adPro) ?? enCours[0];
  if (!e) return null;
  const v = await getBudgetOverview(user, e.id, null, null, opts).catch(sansBloquer("donnees.chargerEnveloppe.getBudgetOverview", null));
  if (!v) return null;
  const debut = new Date(v.period.from).getTime(), fin = new Date(v.period.to).getTime();
  return {
    id: v.envelope.id, nom: v.envelope.name, annee: new Date(v.period.from).getUTCFullYear(),
    total: v.totals.total, consomme: v.totals.consumed, engage: v.totals.committed,
    disponible: v.totals.total - v.totals.consumed - v.totals.committed,
    tempsEcoule: fin > debut ? Math.min(1, Math.max(0, (t - debut) / (fin - debut))) : partDeLAnnee(maintenant),
  };
}
