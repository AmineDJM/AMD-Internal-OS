import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import type { SessionUser } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";
import { companyLabel, getCompanies, predicatEntitePermise } from "@/lib/company";
import { getBudgetOverview } from "@/lib/queries/budget";
import { cumulerSousCategories } from "@/lib/budget/cumul-categories";
import { disponible } from "@/lib/budget/marketing-vue";
import { etatMarketingDesBC } from "@/lib/signature-en-ligne/signer-bc";
import { piecesDesPostes } from "@/modules/ad-pro/api";
import {
  CONTEXTE_VIDE, PARENT_COLONNE, cleLigne,
  type AdProParent, type ContexteLigneCentre, type LigneCentre, type PieceCentre, type PosteCentre,
} from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTEXTE DES LIGNES DU CENTRE AD & PRO — ce qu'il faut lire avant de viser (maquette du 24/11/2026).
 *
 * La lentille du centre (`demandesAuCentreAdPro`) dit CE QUI attend ; cette façade y ajoute, EN LOT, ce que
 * le Directeur Général regardait en ouvrant chaque dossier : la société, la ligne budgétaire imputée et son
 * disponible (le MÊME chiffre que l'écran Budgets : `getBudgetOverview` puis enveloppe − payé − engagé), les
 * pièces (`piecesDesPostes` pour les devis et BC des postes, les `Document` de la demande sinon), ce qui est
 * déjà validé en amont (journal du circuit, poste accordé, signature de la Direction Marketing), les postes
 * de la demande, les devis reçus, ce qui est déjà payé, et le fil des échanges.
 *
 * LECTURE SEULE : aucune règle n'est ici, aucune décision ne change. Elle vit dans `lib/queries` parce qu'elle
 * lit le budget, Legal et la signature en ligne, que le module Ad & Pro ne lit pas (`modules/frontieres.test.ts`).
 *
 * LES SOCIÉTÉS : une ligne s'affiche si sa société est permise à la personne (`predicatEntitePermise`, la règle
 * des fiches) ; les pastilles listent ces sociétés. Le siège voit tout le groupe par défaut — la règle ne
 * retire une ligne qu'à qui la console a donné le centre avec une portée plus étroite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const NATURES_DEMANDE = ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "AD_PRO_OTHER", "PROMO_MATERIAL", "CONSULTING_CONTRACT"] as const;
type NatureDemande = (typeof NATURES_DEMANDE)[number];
const estNatureDemande = (t: string | null | undefined): t is NatureDemande => Boolean(t) && (NATURES_DEMANDE as readonly string[]).includes(t!);
const estParent = (t: string): t is AdProParent => t in PARENT_COLONNE;

const SELECT_POSTE = {
  id: true, label: true, supplier: true, status: true, voie: true, amountGranted: true, amountEstimated: true,
  budgetCategoryId: true, expenseOrderId: true, decidedAt: true, orderRequestedAt: true,
  sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true,
} as const;

interface PosteLu {
  id: string; label: string; supplier: string | null; status: string; voie: "AGENCE" | "DIRECT" | null;
  amountGranted: unknown; amountEstimated: unknown; budgetCategoryId: string | null; expenseOrderId: string | null;
  decidedAt: Date | null; orderRequestedAt: Date | null;
  sponsoringId: string | null; congressNationalId: string | null; congressInternationalId: string | null; eventId: string | null; otherRequestId: string | null;
}

function parentDuPosteLu(p: PosteLu): { type: AdProParent; id: string } | null {
  for (const [type, col] of Object.entries(PARENT_COLONNE) as [AdProParent, (typeof PARENT_COLONNE)[AdProParent]][]) {
    if (p[col]) return { type, id: p[col]! };
  }
  return null;
}

const montantPoste = (p: PosteLu): number | null =>
  p.amountGranted != null ? toNumber(p.amountGranted as never) : p.amountEstimated != null ? toNumber(p.amountEstimated as never) : null;

const jour = (d: Date | string): string => new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Algiers" });
const dzd = (n: number): string => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

interface DemandeLue { companyId: string | null; createdAt: Date; nom: string; budgetCategoryId?: string | null }

/** Les demandes d'origine, par nature, en lot : société, date, nom (et la catégorie d'un dossier promo). */
async function lireDemandes(refs: readonly { type: NatureDemande; id: string }[]): Promise<Map<string, DemandeLue>> {
  const ids = (t: NatureDemande) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const s = { id: true, companyId: true, createdAt: true } as const;
  const [spons, natio, intl, evts, autres, promos, contrats] = await Promise.all([
    ids("SPONSORING").length ? prisma.sponsoringRequest.findMany({ where: { id: { in: ids("SPONSORING") } }, select: { ...s, reference: true, institution: true } }).catch(sansBloquer("centre-ad-pro-contexte.sponsoring", [])) : [],
    ids("CONGRESS_NATIONAL").length ? prisma.congressNational.findMany({ where: { id: { in: ids("CONGRESS_NATIONAL") } }, select: { ...s, name: true } }).catch(sansBloquer("centre-ad-pro-contexte.congressNational", [])) : [],
    ids("CONGRESS_INTERNATIONAL").length ? prisma.congressInternational.findMany({ where: { id: { in: ids("CONGRESS_INTERNATIONAL") } }, select: { ...s, name: true } }).catch(sansBloquer("centre-ad-pro-contexte.congressInternational", [])) : [],
    ids("EVENT").length ? prisma.event.findMany({ where: { id: { in: ids("EVENT") } }, select: { ...s, name: true } }).catch(sansBloquer("centre-ad-pro-contexte.event", [])) : [],
    ids("AD_PRO_OTHER").length ? prisma.adProOtherRequest.findMany({ where: { id: { in: ids("AD_PRO_OTHER") } }, select: { ...s, reference: true, title: true } }).catch(sansBloquer("centre-ad-pro-contexte.adProOther", [])) : [],
    ids("PROMO_MATERIAL").length ? prisma.promoMaterial.findMany({ where: { id: { in: ids("PROMO_MATERIAL") } }, select: { ...s, reference: true, title: true, budgetCategoryId: true } }).catch(sansBloquer("centre-ad-pro-contexte.promoMaterial", [])) : [],
    ids("CONSULTING_CONTRACT").length ? prisma.consultingContract.findMany({ where: { id: { in: ids("CONSULTING_CONTRACT") } }, select: { ...s, reference: true, title: true } }).catch(sansBloquer("centre-ad-pro-contexte.consulting", [])) : [],
  ]);
  const out = new Map<string, DemandeLue>();
  const ref = (r: string | null, n: string) => (r ? `${r} — ${n}` : n);
  for (const r of spons) out.set(`SPONSORING:${r.id}`, { companyId: r.companyId, createdAt: r.createdAt, nom: ref(r.reference, r.institution) });
  for (const r of natio) out.set(`CONGRESS_NATIONAL:${r.id}`, { companyId: r.companyId, createdAt: r.createdAt, nom: r.name });
  for (const r of intl) out.set(`CONGRESS_INTERNATIONAL:${r.id}`, { companyId: r.companyId, createdAt: r.createdAt, nom: r.name });
  for (const r of evts) out.set(`EVENT:${r.id}`, { companyId: r.companyId, createdAt: r.createdAt, nom: r.name });
  for (const r of autres) out.set(`AD_PRO_OTHER:${r.id}`, { companyId: r.companyId, createdAt: r.createdAt, nom: ref(r.reference, r.title) });
  for (const r of promos) out.set(`PROMO_MATERIAL:${r.id}`, { companyId: r.companyId, createdAt: r.createdAt, nom: ref(r.reference, r.title), budgetCategoryId: r.budgetCategoryId });
  for (const r of contrats) out.set(`CONSULTING_CONTRACT:${r.id}`, { companyId: r.companyId, createdAt: r.createdAt, nom: ref(r.reference, r.title) });
  return out;
}

/**
 * LE DISPONIBLE DES LIGNES BUDGÉTAIRES — par enveloppe, la synthèse de l'écran Budgets (`getBudgetOverview`), puis la
 * catégorie CUMULÉE avec ses sous-catégories et « enveloppe − payé − engagé » (`marketing-vue.disponible`). Le libellé :
 * « Parente › Catégorie » (ou « Enveloppe › Catégorie »).
 */
async function disponibleDesCategories(user: SessionUser, ids: readonly string[]): Promise<Map<string, { ligne: string; disponible: number }>> {
  const out = new Map<string, { ligne: string; disponible: number }>();
  if (ids.length === 0) return out;
  const cats = await prisma.budgetCategoryLine.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, envelopeId: true, parent: { select: { name: true } }, envelope: { select: { name: true } } },
  }).catch(sansBloquer("centre-ad-pro-contexte.budgetCategoryLine", []));
  // Une poignée d'enveloppes au plus : la file d'un centre ne s'étale pas sur tout le plan budgétaire.
  const enveloppes = [...new Set(cats.map((c) => c.envelopeId))].slice(0, 8);
  const vues = await Promise.all(enveloppes.map((e) => getBudgetOverview(user, e).catch(sansBloquer("centre-ad-pro-contexte.getBudgetOverview", null))));
  const parCategorie = new Map<string, { allocated: number; consumed: number; committed: number }>();
  for (const v of vues) {
    if (!v) continue;
    const cumul = cumulerSousCategories(v.categories);
    for (const c of v.categories) {
      const k = cumul.get(c.id);
      parCategorie.set(c.id, { allocated: c.allocated, consumed: k?.consumed ?? c.consumed, committed: k?.committed ?? c.committed });
    }
  }
  for (const c of cats) {
    const k = parCategorie.get(c.id);
    if (!k) continue;
    out.set(c.id, { ligne: `${c.parent?.name ?? c.envelope.name} › ${c.name}`, disponible: disponible(k.allocated, k.consumed, k.committed) });
  }
  return out;
}

export interface CentreAdProCharge {
  /** Les lignes que la personne peut voir (société permise), dans l'ordre reçu. */
  lignes: LigneCentre[];
  contextes: Record<string, ContexteLigneCentre>;
  /** Les sociétés permises, pour les pastilles. */
  societes: { id: string; nom: string }[];
}

export async function contexteDuCentreAdPro(lignes: readonly LigneCentre[], user: SessionUser): Promise<CentreAdProCharge> {
  const idsBCPoste = lignes.filter((l) => l.forme === "BC_POSTE").map((l) => l.entityId);
  const idsBCLegal = lignes.filter((l) => l.forme === "BC_LEGAL").map((l) => l.entityId);

  // ── 1. LES PIÈCES BC DU REGISTRE ET LEURS POSTES ─────────────────────────────────────────────
  const [legaux, liensLegal] = await Promise.all([
    idsBCLegal.length ? prisma.legalDocument.findMany({
      where: { id: { in: idsBCLegal } }, select: { id: true, companyId: true, sourceType: true, sourceId: true, createdAt: true },
    }).catch(sansBloquer("centre-ad-pro-contexte.legalDocument", [])) : [],
    idsBCLegal.length ? prisma.adProItemPiece.findMany({
      where: { legalDocumentId: { in: idsBCLegal }, nature: "BON_DE_COMMANDE" }, select: { legalDocumentId: true, itemId: true },
    }).catch(sansBloquer("centre-ad-pro-contexte.adProItemPiece", [])) : [],
  ]);
  const postesDuBC = new Map<string, string[]>();
  for (const l of liensLegal) postesDuBC.set(l.legalDocumentId, [...(postesDuBC.get(l.legalDocumentId) ?? []), l.itemId]);
  const postesBC = await prisma.adProItem.findMany({
    where: { id: { in: [...new Set([...idsBCPoste, ...liensLegal.map((l) => l.itemId)])] } }, select: SELECT_POSTE,
  }).catch(sansBloquer("centre-ad-pro-contexte.adProItem.bc", [])) as PosteLu[];
  const posteParId = new Map(postesBC.map((p) => [p.id, p]));

  // ── 2. LA DEMANDE D'ORIGINE DE CHAQUE LIGNE ──────────────────────────────────────────────────
  const demandeDe = new Map<string, { type: NatureDemande; id: string }>();
  for (const l of lignes) {
    const k = cleLigne(l);
    if (estNatureDemande(l.entityType)) demandeDe.set(k, { type: l.entityType, id: l.entityId });
    else if (l.forme === "BC_POSTE") {
      const p = posteParId.get(l.entityId);
      const par = p ? parentDuPosteLu(p) : null;
      if (par) demandeDe.set(k, par);
    } else if (l.forme === "BC_LEGAL") {
      const d = legaux.find((x) => x.id === l.entityId);
      if (d && estNatureDemande(d.sourceType) && d.sourceId) demandeDe.set(k, { type: d.sourceType, id: d.sourceId });
      else {
        const p = (postesDuBC.get(l.entityId) ?? []).map((id) => posteParId.get(id)).find(Boolean);
        const par = p ? parentDuPosteLu(p) : null;
        if (par) demandeDe.set(k, par);
      }
    }
  }
  const refs = [...demandeDe.values()];
  const idsParents = refs.filter((r) => estParent(r.type));
  const ouParent = (Object.keys(PARENT_COLONNE) as AdProParent[])
    .map((t) => ({ t, ids: [...new Set(idsParents.filter((r) => r.type === t).map((r) => r.id))] }))
    .filter((x) => x.ids.length > 0)
    .map((x) => ({ [PARENT_COLONNE[x.t]]: { in: x.ids } }));

  const cibles = (t: EntityType, ids: readonly string[]) => (ids.length ? [{ entityType: t, entityId: { in: [...ids] } }] : []);
  const entitesFil = [
    ...NATURES_DEMANDE.flatMap((t) => cibles(t, refs.filter((r) => r.type === t).map((r) => r.id))),
    ...cibles("AD_PRO_ITEM", idsBCPoste),
  ];
  const entitesPieces = [
    ...NATURES_DEMANDE.flatMap((t) => cibles(t, refs.filter((r) => r.type === t).map((r) => r.id))),
    ...cibles("LEGAL_DOCUMENT", idsBCLegal),
  ];

  const [demandes, postesDesDemandes, documents, messages, instances, marketing, societes, permise] = await Promise.all([
    lireDemandes(refs),
    ouParent.length
      ? prisma.adProItem.findMany({ where: { OR: ouParent }, select: SELECT_POSTE, orderBy: { createdAt: "asc" } }).catch(sansBloquer("centre-ad-pro-contexte.adProItem.demandes", [])) as Promise<PosteLu[]>
      : Promise.resolve([] as PosteLu[]),
    entitesPieces.length
      ? prisma.document.findMany({ where: { OR: entitesPieces }, orderBy: { createdAt: "desc" }, take: 300, select: { id: true, name: true, entityType: true, entityId: true, fileKey: true } }).catch(sansBloquer("centre-ad-pro-contexte.document", []))
      : [],
    entitesFil.length
      ? prisma.comment.findMany({ where: { OR: entitesFil }, orderBy: { createdAt: "desc" }, take: 300, select: { entityType: true, entityId: true, body: true, createdAt: true, author: { select: { name: true } } } }).catch(sansBloquer("centre-ad-pro-contexte.comment", []))
      : [],
    refs.length
      ? prisma.workflowInstance.findMany({
          where: { OR: refs.map((r) => ({ entityType: r.type, entityId: r.id })) },
          select: { entityType: true, entityId: true, events: { where: { action: { in: ["APPROVE", "RETURN"] } }, orderBy: { createdAt: "asc" }, select: { stepTitle: true, action: true, actorName: true, createdAt: true } } },
        }).catch(sansBloquer("centre-ad-pro-contexte.workflowInstance", []))
      : [],
    etatMarketingDesBC(idsBCLegal).catch(sansBloquer("centre-ad-pro-contexte.etatMarketingDesBC", {} as Awaited<ReturnType<typeof etatMarketingDesBC>>)),
    getCompanies(),
    predicatEntitePermise(user.id),
  ]);

  // Les postes de chaque demande, et leurs pièces (devis retenus, BC) — en lot.
  const postesDe = new Map<string, PosteLu[]>();
  for (const p of postesDesDemandes) {
    const par = parentDuPosteLu(p);
    if (par) postesDe.set(`${par.type}:${par.id}`, [...(postesDe.get(`${par.type}:${par.id}`) ?? []), p]);
  }
  const idsPostesTotaux = lignes
    .filter((l) => l.forme === "TOTAL_DG" || l.forme === "ETAPE_CIRCUIT")
    .flatMap((l) => (postesDe.get(cleLigne(l)) ?? []).map((p) => p.id));
  const [pieces, payes] = await Promise.all([
    piecesDesPostes([...new Set([...idsPostesTotaux, ...postesBC.map((p) => p.id)])]).catch(sansBloquer("centre-ad-pro-contexte.piecesDesPostes", new Map() as Awaited<ReturnType<typeof piecesDesPostes>>)),
    (async () => {
      const ids = [...new Set(postesDesDemandes.map((p) => p.expenseOrderId).filter((x): x is string => Boolean(x)))];
      if (!ids.length) return new Map<string, number>();
      const ordres = await prisma.expenseOrder.findMany({ where: { id: { in: ids }, status: "PAID" }, select: { id: true, amount: true } })
        .catch(sansBloquer("centre-ad-pro-contexte.expenseOrder", []));
      return new Map(ordres.map((o) => [o.id, toNumber(o.amount)]));
    })(),
  ]);

  // La ligne budgétaire de chaque ligne du centre : celle du poste du BC, sinon celle qui porte le plus d'argent.
  const categorieDe = new Map<string, { id: string; autres: number }>();
  const choisir = (ps: readonly PosteLu[]): { id: string; autres: number } | null => {
    const poids = new Map<string, number>();
    for (const p of ps) if (p.budgetCategoryId && p.status !== "REJECTED") poids.set(p.budgetCategoryId, (poids.get(p.budgetCategoryId) ?? 0) + (montantPoste(p) ?? 0));
    const tri = [...poids].sort((a, b) => b[1] - a[1]);
    return tri.length ? { id: tri[0][0], autres: tri.length - 1 } : null;
  };
  for (const l of lignes) {
    const k = cleLigne(l);
    const dem = demandeDe.get(k);
    let c: { id: string; autres: number } | null = null;
    if (l.forme === "BC_POSTE") c = choisir([posteParId.get(l.entityId)].filter((p): p is PosteLu => Boolean(p)));
    else if (l.forme === "BC_LEGAL") c = choisir((postesDuBC.get(l.entityId) ?? []).map((id) => posteParId.get(id)).filter((p): p is PosteLu => Boolean(p)));
    else if (dem?.type === "PROMO_MATERIAL") {
      const b = demandes.get(`${dem.type}:${dem.id}`)?.budgetCategoryId;
      c = b ? { id: b, autres: 0 } : null;
    } else if (dem) c = choisir(postesDe.get(`${dem.type}:${dem.id}`) ?? []);
    if (c) categorieDe.set(k, c);
  }
  const budgets = await disponibleDesCategories(user, [...new Set([...categorieDe.values()].map((c) => c.id))]);

  // ── 3. L'ASSEMBLAGE ───────────────────────────────────────────────────────────────────────────
  const nomSociete = new Map(societes.map((c) => [c.id, companyLabel(c)]));
  const contextes: Record<string, ContexteLigneCentre> = {};
  const visibles: LigneCentre[] = [];
  for (const l of lignes) {
    const k = cleLigne(l);
    const dem = demandeDe.get(k);
    const d = dem ? demandes.get(`${dem.type}:${dem.id}`) ?? null : null;
    const legal = l.forme === "BC_LEGAL" ? legaux.find((x) => x.id === l.entityId) ?? null : null;
    const societeId = legal?.companyId ?? d?.companyId ?? null;
    if (!permise(societeId)) continue;
    visibles.push(l);

    const postesOp = dem ? postesDe.get(`${dem.type}:${dem.id}`) ?? [] : [];
    const postesLigne: PosteLu[] = l.forme === "BC_POSTE"
      ? [posteParId.get(l.entityId)].filter((p): p is PosteLu => Boolean(p))
      : l.forme === "BC_LEGAL" ? (postesDuBC.get(l.entityId) ?? []).map((id) => posteParId.get(id)).filter((p): p is PosteLu => Boolean(p)) : [];
    const estBC = l.forme === "BC_POSTE" || l.forme === "BC_LEGAL" || l.forme === "BC_PROMO";

    // Les pièces : devis et BC des postes pour un bon de commande ; les documents de la demande sinon.
    const piecesLigne: PieceCentre[] = [];
    const devis: ContexteLigneCentre["devis"] = [];
    for (const p of postesLigne) {
      const pp = pieces.get(p.id);
      if (!pp) continue;
      const tranche = pp.devis.some((x) => x.nonRetenu);
      for (const x of pp.devis.filter((x) => !x.annulee)) {
        devis.push({ prestataire: x.titre, montant: x.montant, retenu: x.nonRetenu ? false : tranche || pp.devis.length === 1 ? true : null, documentId: x.fichierId });
        piecesLigne.push({ nom: x.reference ? `Devis ${x.reference}` : x.titre, documentId: x.fichierId, nature: "DEVIS" });
      }
      for (const b of pp.bcs) piecesLigne.push({ nom: b.reference ? `BC ${b.reference}` : b.titre, documentId: b.copieSignee?.documentId ?? b.fichierId, nature: "BC" });
      for (const f of pp.factures.filter((x) => !x.annulee)) piecesLigne.push({ nom: f.reference ? `Facture ${f.reference}` : f.titre, documentId: f.fichierId, nature: "FACTURE" });
    }
    const docsDe = (t: string, id: string) => documents.filter((x) => x.entityType === t && x.entityId === id);
    if (legal) {
      for (const x of docsDe("LEGAL_DOCUMENT", legal.id)) {
        if (!piecesLigne.some((p) => p.documentId === x.id)) piecesLigne.unshift({ nom: x.name, documentId: x.fileKey ? x.id : null, nature: "BC" });
      }
    }
    if (!estBC && dem) for (const x of docsDe(dem.type, dem.id).slice(0, 12)) piecesLigne.push({ nom: x.name, documentId: x.fileKey ? x.id : null, nature: "PIECE" });

    // Les postes de la demande (total au DG, étape du circuit).
    const postes: PosteCentre[] = !estBC && (l.forme === "TOTAL_DG" || l.forme === "ETAPE_CIRCUIT")
      ? postesOp.map((p) => {
          const pp = pieces.get(p.id);
          const vivants = pp?.devis.filter((x) => !x.annulee) ?? [];
          const retenu = vivants.find((x) => !x.nonRetenu && vivants.some((y) => y.nonRetenu)) ?? (vivants.length === 1 ? vivants[0] : null);
          const ecartes = vivants.filter((x) => x.nonRetenu).length;
          const devisTexte = retenu ? `${retenu.titre}${ecartes ? ` · ${ecartes} écarté${ecartes > 1 ? "s" : ""}` : ""}` : p.supplier;
          return { libelle: p.label, voie: p.voie, devis: devisTexte, montant: montantPoste(p), refuse: p.status === "REJECTED" };
        })
      : [];

    // Déjà validé.
    const chaine: ContexteLigneCentre["chaine"] = [];
    const inst = dem ? instances.find((i) => i.entityType === dem.type && i.entityId === dem.id) : undefined;
    for (const e of (inst?.events ?? []).slice(-4)) {
      chaine.push({ etape: e.action === "RETURN" ? `${e.stepTitle} — renvoyé` : e.stepTitle, detail: [e.actorName, jour(e.createdAt)].filter(Boolean).join(" · ") });
    }
    if (postes.length) {
      const accordes = postesOp.filter((p) => p.status === "APPROVED");
      if (accordes.length) {
        const dernier = accordes.map((p) => p.decidedAt).filter((x): x is Date => Boolean(x)).sort((a, b) => b.getTime() - a.getTime())[0];
        chaine.push({ etape: "Postes accordés", detail: `${accordes.length} sur ${postesOp.length}${dernier ? ` · ${jour(dernier)}` : ""}` });
      }
    }
    for (const p of postesLigne) {
      if (p.status === "APPROVED") chaine.push({ etape: `Poste accordé — ${p.label}`, detail: [p.amountGranted != null ? dzd(toNumber(p.amountGranted as never)) : null, p.decidedAt ? jour(p.decidedAt) : null].filter(Boolean).join(" · ") || null });
    }
    if (l.forme === "BC_POSTE") {
      const p = postesLigne[0];
      chaine.push({ etape: "Demande de BC", detail: [l.demandeur, p?.orderRequestedAt ? jour(p.orderRequestedAt) : null].filter(Boolean).join(" · ") || null });
    }
    if (legal) {
      chaine.push({ etape: "BC établi", detail: jour(legal.createdAt) });
      const dm = marketing[legal.id]?.dm;
      if (dm) chaine.push({ etape: "Signé par la Direction Marketing", detail: `${dm.nom} · ${jour(dm.le)}` });
    }

    // Le fil : la demande, et le poste d'un BC — les plus récents, dans l'ordre où ils ont été écrits.
    const fil = messages
      .filter((m) => (dem && m.entityType === dem.type && m.entityId === dem.id) || (l.forme === "BC_POSTE" && m.entityType === "AD_PRO_ITEM" && m.entityId === l.entityId))
      .slice(0, 6)
      .reverse()
      .map((m) => ({ auteur: m.author?.name ?? null, le: m.createdAt.toISOString(), texte: m.body }));

    const cat = categorieDe.get(k);
    const b = cat ? budgets.get(cat.id) : undefined;
    const accorde = postesLigne.length
      ? postesLigne.reduce((t, p) => t + (p.amountGranted != null ? toNumber(p.amountGranted as never) : 0), 0)
      : null;

    contextes[k] = {
      ...CONTEXTE_VIDE,
      societeId, societe: societeId ? nomSociete.get(societeId) ?? null : null,
      operation: estBC && d ? d.nom : null,
      poste: postesLigne.length ? postesLigne.map((p) => p.label).join(", ") : null,
      creeLe: d?.createdAt.toISOString() ?? null,
      budget: b ? { ...b, autres: cat!.autres } : null,
      pieces: piecesLigne, chaine, postes, devis,
      accorde: accorde != null && accorde > 0 ? accorde : null,
      dejaPaye: postesOp.reduce((t, p) => t + (p.expenseOrderId ? payes.get(p.expenseOrderId) ?? 0 : 0), 0),
      fil,
      // Où poser une question : le fil du poste (il prévient ses parties), sinon celui de la demande.
      filCible: l.forme === "BC_POSTE" ? { entityType: "AD_PRO_ITEM", entityId: l.entityId } : dem ? { entityType: dem.type, entityId: dem.id } : null,
    };
  }

  return {
    lignes: visibles,
    contextes,
    societes: societes.filter((c) => permise(c.id)).map((c) => ({ id: c.id, nom: companyLabel(c) })),
  };
}
