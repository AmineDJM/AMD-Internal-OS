import { prisma } from "@/lib/prisma";
import { canManageEnvelope, userCan, type SessionUser } from "@/lib/rbac";
import type { BudgetOverview } from "@/lib/queries/budget";
import { depensesDesPostes } from "@/lib/queries/budget-sources";
import { contexteDeLEnveloppe } from "@/lib/queries/budget-integration";
import { demandeDuPoste, libellesDesDemandes } from "@/lib/queries/budget-marketing-rapport";
import { lienBonDeCommande } from "@/lib/chemins/bons-de-commande";
import { ancrePoste } from "@/lib/chemins/ad-pro";
import { tuilesDepenses, type EtatDepense, type LieuConsommation, type Tuiles } from "@/lib/budget/depense-poste";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — L'ONGLET « DÉPENSES » : LES POSTES AD & PRO À BON DE COMMANDE SIGNÉ (maquette validée, 10/2026).
 *
 * Les lignes de l'enveloppe affichée :
 *   • les postes accordés RANGÉS dans une de ses catégories, quel que soit l'état de leur dépense (engagée, consommée,
 *     payée, annulée — et « à imputer » quand le budget choisi à l'accord est déjà l'une d'elles) ;
 *   • les postes À IMPUTER qui n'ont pas encore de budget marketing (aucun, ou une catégorie hors Budget Marketing),
 *     dont un BC a été signé pendant la période de l'enveloppe.
 * L'état de chaque dépense est la règle pure (`budget/depense-poste.ts`) appliquée aux faits lus en lot
 * (`depensesDesPostes`). Les tuiles se lisent sur les totaux de la vue d'ensemble : un seul calcul.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BcDeLigne {
  id: string;
  reference: string;
  fournisseur: string | null;
  montant: number | null;
  signeLe: string | null;
  /** Le BC dans le module Bons de commande, ou au registre Legal — selon les accès du spectateur ; `null` sinon. */
  href: string | null;
}

export interface LigneDepensePoste {
  id: string;
  poste: string;
  posteHref: string | null;
  demande: string;
  typeDemande: string;
  demandeHref: string | null;
  bcs: BcDeLigne[];
  montantEngage: number;
  consomme: number;
  paye: number;
  etat: EtatDepense;
  lieu: LieuConsommation | null;
  categorieId: string | null;
  categorie: string | null;
  facture: { nom: string; href: string | null } | null;
  ordre: string | null;
  motif: string | null;
  /** Un poste HISTORIQUE (intégration Ad & Pro 2026) : payé, sans circuit — sa ligne du fichier. */
  historique?: { ligne: number | null } | null;
}

export interface OptionBudget { id: string; label: string }

export interface DonneesDepensesPostes {
  lignes: LigneDepensePoste[];
  options: OptionBudget[];
  tuiles: Tuiles;
  peutGerer: boolean;
}

const SELECT_POSTE = {
  id: true, label: true, status: true, expenseOrderId: true, amountGranted: true, budgetCategoryId: true,
  depenseImputeeLe: true, depenseAnnuleeLe: true, depenseAnnulationMotif: true,
  sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true,
  promoMaterialParentId: true, declarationInfoMedId: true,
  montantPayeHistorique: true, historiqueLigne: true, historiquePayeLe: true,
} as const;

/** Les catégories des enveloppes MARKETING actives que la personne gère — l'enveloppe affichée d'abord. */
export async function optionsBudgetMarketing(user: SessionUser, envelopeId: string): Promise<OptionBudget[]> {
  const envs = await prisma.budgetEnvelope.findMany({
    where: { domaine: "MARKETING", OR: [{ isActive: true }, { id: envelopeId }] },
    orderBy: [{ periodStart: "desc" }],
    include: { categories: { orderBy: { name: "asc" }, select: { id: true, name: true, parentId: true } } },
  });
  const gerees = envs.filter((e) => canManageEnvelope(user, e)).sort((a, b) => (a.id === envelopeId ? -1 : b.id === envelopeId ? 1 : 0));
  const out: OptionBudget[] = [];
  for (const e of gerees) {
    const prefixe = e.id === envelopeId ? "" : `${e.name} › `;
    for (const t of e.categories.filter((c) => c.parentId === null)) {
      out.push({ id: t.id, label: `${prefixe}${t.name}` });
      for (const s of e.categories.filter((c) => c.parentId === t.id)) out.push({ id: s.id, label: `${prefixe}${t.name} › ${s.name}` });
    }
  }
  return out;
}

export async function depensesPostesMarketing(user: SessionUser, overview: BudgetOverview): Promise<{ donnees: DonneesDepensesPostes; ecritures: Set<string> }> {
  const catIds = overview.categories.map((c) => c.id);
  const debut = new Date(overview.envelope.periodStart), fin = new Date(overview.envelope.periodEnd);
  const [rangees, aImputer] = await Promise.all([
    catIds.length
      ? prisma.adProItem.findMany({ where: { status: "APPROVED", budgetCategoryId: { in: catIds }, trainingId: null }, select: SELECT_POSTE, orderBy: { updatedAt: "desc" } })
      : Promise.resolve([]),
    prisma.adProItem.findMany({
      where: {
        status: "APPROVED", trainingId: null, depenseImputeeLe: null, depenseAnnuleeLe: null, expenseOrderId: null,
        OR: [{ budgetCategoryId: null }, { budgetCategory: { envelope: { domaine: { not: "MARKETING" } } } }],
        pieces: { some: { nature: "BON_DE_COMMANDE", legalDocument: { signedAt: { gte: debut, lte: fin }, status: { not: "CANCELLED" } } } },
      },
      select: SELECT_POSTE,
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
  ]);
  const postes = [...rangees, ...aImputer.filter((p) => !rangees.some((r) => r.id === p.id))];
  // Les postes HISTORIQUES du lot actif de l'enveloppe (intégration Ad & Pro 2026) : payés, sans circuit — lus tels quels.
  const ctx = await contexteDeLEnveloppe(overview.envelope.id);
  const historiques = new Set(ctx ? ctx.postes.map((p) => p.id) : []);
  const [depenses, options] = await Promise.all([depensesDesPostes(postes), optionsBudgetMarketing(user, overview.envelope.id)]);

  const cles = new Map(postes.map((p) => [p.id, demandeDuPoste(p)]));
  const demandes = await libellesDesDemandes([...cles.values()].filter((c): c is string => Boolean(c)));
  const factureIds = [...depenses.values()].map((d) => d.facture?.id).filter((x): x is string => Boolean(x));
  const fichiers = factureIds.length
    ? await prisma.document.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: factureIds } }, orderBy: { createdAt: "asc" }, select: { entityId: true, name: true } })
    : [];
  const nomFichier = new Map<string, string>();
  for (const f of fichiers) if (!nomFichier.has(f.entityId)) nomFichier.set(f.entityId, f.name);

  const voitBc = userCan(user, "PURCHASE_ORDERS", "VIEW");
  const voitLegal = userCan(user, "LEGAL", "VIEW");
  const lienPiece = (id: string, bc: boolean) => (bc && voitBc ? lienBonDeCommande(id) : voitLegal ? `/legal/${id}` : null);
  const nomCat = new Map(overview.categories.map((c) => [c.id, c]));
  const libelleCat = (id: string | null) => {
    if (!id) return null;
    const c = nomCat.get(id);
    if (!c) return options.find((o) => o.id === id)?.label ?? null;
    const parent = c.parentId ? nomCat.get(c.parentId) : null;
    return parent ? `${parent.name} › ${c.name}` : c.name;
  };

  const lignes: LigneDepensePoste[] = [];
  // Les écritures de trésorerie qu'ont réglées les ordres de ces postes : l'écran les montre sur la ligne du poste,
  // la section « Autres dépenses » ne les répète pas.
  const ecritures = new Set<string>();
  for (const p of postes) {
    const lue = depenses.get(p.id);
    if (lue && historiques.has(p.id) && p.montantPayeHistorique != null) {
      const montant = Number(p.montantPayeHistorique);
      const cle = cles.get(p.id) ?? null;
      const d = cle ? demandes[cle] : undefined;
      for (const o of lue.ordres) if (o.transactionId) ecritures.add(o.transactionId);
      lignes.push({
        id: p.id, poste: p.label, posteHref: d?.href ? `${d.href}#${ancrePoste(p.id)}` : null,
        demande: d?.libelle ?? "Demande Ad & Pro", typeDemande: d?.type ?? "", demandeHref: d?.href ?? null,
        bcs: [], montantEngage: montant, consomme: montant, paye: montant, etat: "PAYEE", lieu: null,
        categorieId: p.budgetCategoryId, categorie: libelleCat(p.budgetCategoryId), facture: null, ordre: null, motif: null,
        historique: { ligne: p.historiqueLigne },
      });
      continue;
    }
    const etat = lue?.depense.etat ?? null;
    if (!lue || etat === null) continue;
    const dansLEnveloppe = p.budgetCategoryId != null && catIds.includes(p.budgetCategoryId);
    if (!dansLEnveloppe && etat !== "A_IMPUTER") continue;
    const cle = cles.get(p.id) ?? null;
    const d = cle ? demandes[cle] : undefined;
    const ordreVivant = lue.ordres.find((o) => o.statut !== "CANCELLED") ?? null;
    for (const o of lue.ordres) if (o.transactionId) ecritures.add(o.transactionId);
    lignes.push({
      id: p.id,
      poste: p.label,
      posteHref: d?.href ? `${d.href}#${ancrePoste(p.id)}` : null,
      demande: d?.libelle ?? "Demande Ad & Pro",
      typeDemande: d?.type ?? "",
      demandeHref: d?.href ?? null,
      bcs: lue.bcs.map((b) => ({
        id: b.id, reference: b.reference ?? b.titre, fournisseur: b.fournisseur, montant: b.montant,
        signeLe: b.signeLe ? b.signeLe.toISOString() : null, href: lienPiece(b.id, true),
      })),
      montantEngage: lue.depense.montantEngage,
      consomme: lue.depense.consomme,
      paye: lue.depense.paye,
      etat,
      lieu: lue.depense.lieu,
      categorieId: dansLEnveloppe || etat !== "A_IMPUTER" ? p.budgetCategoryId : null,
      categorie: dansLEnveloppe ? libelleCat(p.budgetCategoryId) : null,
      facture: lue.facture ? { nom: nomFichier.get(lue.facture.id) ?? lue.facture.reference ?? "Facture", href: lienPiece(lue.facture.id, false) } : null,
      ordre: ordreVivant?.reference ?? null,
      motif: p.depenseAnnulationMotif,
    });
  }
  // À imputer d'abord, puis engagées, consommées, payées, annulées.
  const rang: Record<EtatDepense, number> = { A_IMPUTER: 0, ENGAGEE: 1, CONSOMMEE: 2, PAYEE: 3, ANNULEE: 4 };
  lignes.sort((a, b) => rang[a.etat] - rang[b.etat]);

  const t = overview.totals;
  return {
    donnees: {
      lignes,
      options,
      tuiles: tuilesDepenses({ total: t.total, paye: t.consumed, nonPaye: t.committed, enCircuit: t.enCircuit ?? 0 }),
      peutGerer: canManageEnvelope(user, overview.envelope),
    },
    ecritures,
  };
}
