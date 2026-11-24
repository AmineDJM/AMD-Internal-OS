import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { engagementsDesCategories } from "@/lib/queries/budget-sources";
import { fichiersDuPerimetre, type Perimetre } from "./destruction";
import { composerApercu, type ApercuDefinitif } from "./definitive";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APERÇU DE LA SUPPRESSION DÉFINITIVE (et la porte serveur du geste) — lu dans le MÊME périmètre que la destruction : l'aperçu
 * n'annonce jamais un périmètre que la suppression dépasserait (§118.53).
 *
 * L'engagé rendu au budget se lit par la RÈGLE DES BUDGETS elle-même (`engagementsDesCategories`) :
 * les engagements des catégories touchées, puis ceux qui appartiennent à la demande (ses postes, ses
 * ordres, son matériel). La consommation rendue, ce sont ses écritures de trésorerie réglées.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une date assez lointaine pour qu'aucun ordre émis ne soit écarté de l'engagé par sa date. */
const SANS_FIN = new Date("9999-12-31T00:00:00Z");

export async function apercuDuPerimetre(p: Perimetre): Promise<ApercuDefinitif> {
  const { inv } = p;
  const de = (modele: string) => inv.lignes.filter((l) => l.modele === modele);
  const postes = new Set(de("AdProItem").map((l) => l.id));
  const ordres = de("ExpenseOrder");
  const idsOrdres = new Set(ordres.map((l) => l.id));
  const promos = new Set(de("PromoMaterial").map((l) => l.id));

  // Les catégories touchées : celles que portent les lignes du lot ; et, si un ordre engagé n'en porte aucune, toutes les
  // catégories de tête des enveloppes actives — c'est là que l'attribution automatique l'imputerait.
  const categories = new Set<string>();
  for (const l of inv.lignes) {
    const c = l.donnees.budgetCategoryId;
    if (typeof c === "string" && c) categories.add(c);
  }
  if (ordres.some((o) => !o.donnees.budgetCategoryId && (o.donnees.status === "PENDING" || o.donnees.status === "REVISION_REQUESTED"))) {
    for (const c of await prisma.budgetCategoryLine.findMany({ where: { parentId: null, envelope: { isActive: true } }, select: { id: true } })) categories.add(c.id);
  }
  const lus = categories.size ? await engagementsDesCategories([...categories], SANS_FIN) : { details: [] };
  const engagements = lus.details
    .filter((e) => (e.posteId && postes.has(e.posteId)) || (e.ordreId && idsOrdres.has(e.ordreId))
      || (e.sourceType === "PROMO_MATERIAL" && e.sourceId && promos.has(e.sourceId)))
    .map((e) => ({ categorieId: e.categoryId, montant: e.montant }));

  const ecritures = de("FinanceTransaction").map((l) => ({
    montant: toNumber(l.donnees.amount), direction: String(l.donnees.direction), statut: String(l.donnees.status),
    categorieId: typeof l.donnees.budgetCategoryId === "string" ? l.donnees.budgetCategoryId : null,
  }));
  const citees = new Set([...engagements.map((e) => e.categorieId), ...ecritures.map((e) => e.categorieId).filter((x): x is string => !!x)]);
  const noms = citees.size
    ? await prisma.budgetCategoryLine.findMany({ where: { id: { in: [...citees] } }, select: { id: true, name: true, envelope: { select: { name: true } } } })
    : [];
  const fichiers = fichiersDuPerimetre(p);

  return composerApercu({
    postes: postes.size,
    ordres: ordres.map((o) => ({
      reference: String(o.donnees.reference), montant: toNumber(o.donnees.amount), statut: String(o.donnees.status), centralStatus: String(o.donnees.centralStatus),
    })),
    ecritures,
    engagements,
    categories: Object.fromEntries(noms.map((c) => [c.id, `${c.envelope.name} › ${c.name}`])),
    legal: de("LegalDocument").length,
    jointes: inv.documents.length,
    fichiers: fichiers.cles.length + fichiers.blobs.length,
    gardees: p.gardees.map((g) => ({ libelle: g.libelle, pourquoi: g.pourquoi })),
    resume: inv.resume,
    faits: inv.faits,
    bloquants: inv.bloquants,
    lignes: inv.lignes.length + inv.documents.length + inv.commentaires.length,
  });
}

// LA PORTE SERVEUR de la suppression définitive : l'action du module ad-pro ne lit que ce fichier.
export { perimetreDefinitif, detruireDefinitivement, fichiersDuPerimetre, libererLesFichiers, type Perimetre } from "./destruction";
export { TETES_DEFINITIVES, resumeDeLaDestruction, type ApercuDefinitif } from "./definitive";
