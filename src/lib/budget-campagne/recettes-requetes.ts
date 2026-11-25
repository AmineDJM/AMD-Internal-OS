import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { getCompanies, getMyCompanies, companyLabel } from "@/lib/company";
import { userCan, type SessionUser } from "@/lib/rbac";
import { resoudrePrix } from "@/lib/products/fiche-360";
import { droitsCampagne, type DroitsCampagne } from "./regles";
import { entreeDroits } from "./requetes";
import { droitsRecettes, totauxRecettes, type DroitsRecettes, type SourcePrix, type TotauxRecettes } from "./recettes";
import {
  calculerPrevisions, estCleImpot, lireParametresImpots, montantPrevuDeLaLigne, natureDeLaDepense, totalGroupe,
  type AjustementImpot, type DepensePrevue, type NatureTva, type ParametresImpots, type PrevisionSociete,
} from "./impots";
import { retenuesDesFiches, type RetenuesMensuelles } from "./masse-salariale";

/**
 * LES LECTURES DES RECETTES ET DU RÉSULTAT PRÉVISIONNEL DE LA CAMPAGNE — les droits se lisent ici, une fois, et chaque
 * écran ne reçoit que ce qu'il a le droit de voir :
 *   • le Super Admin et la DG : toutes les sociétés du groupe (celle de la campagne si elle en nomme une), la saisie,
 *     la synthèse et le volet Impôts & taxes ;
 *   • la Direction, les valideurs, les Finances : les recettes des sociétés qui leur sont ouvertes, en lecture ;
 *   • le responsable d'un pôle : les recettes de la société de SES pôles, en lecture ;
 *   • les autres : rien (`interdit`).
 */

const estRole = (u: SessionUser, r: string) => u.role === r || u.secondaryRole === r;

export interface ContexteRecettes {
  campagne: { id: string; year: number; companyId: string | null; status: string; recettesFigeesLe: Date | null; taxSettings: unknown };
  droitsCampagne: DroitsCampagne;
  droits: DroitsRecettes;
  /** Les sociétés dont la personne voit (et, si elle saisit, écrit) les recettes. */
  societes: { id: string; label: string }[];
}

export async function contexteRecettes(user: SessionUser, campaignId: string): Promise<ContexteRecettes | null> {
  const c = await prisma.budgetCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true, year: true, companyId: true, status: true, recettesFigeesLe: true, taxSettings: true, validatorIds: true,
      proposals: { select: { departmentId: true, department: { select: { companyId: true } } } },
    },
  });
  if (!c) return null;
  const e = await entreeDroits(user, c.validatorIds);
  const dc = droitsCampagne(e);
  const mesPolesIci = c.proposals.filter((p) => p.departmentId && e.polesTenus.includes(p.departmentId));
  // Le DG saisit les recettes tant que la console ne lui a pas fermé la campagne (un blocage de la console prime).
  const droits = droitsRecettes({
    estSuperAdmin: e.estSuperAdmin, estDG: e.estDG && userCan(user, "BUDGET_CAMPAIGN", "VIEW"), accedeALaCampagne: dc.voitVueDG || mesPolesIci.length > 0,
  });

  const toutes = await getCompanies();
  let ids: string[];
  if (droits.saisit) ids = toutes.map((x) => x.id);
  else if (dc.voitVueDG) ids = (await getMyCompanies(user.id)).map((x) => x.id);
  else if (droits.voit) {
    // UN DIRECTEUR NE VOIT QUE SA SOCIÉTÉ (Super Admin, 24/11/2026) : celle de ses pôles ; un pôle transverse, celles
    // qui lui sont ouvertes.
    const deSesPoles = mesPolesIci.map((p) => p.department?.companyId ?? null);
    ids = [...new Set(deSesPoles.filter((x): x is string => x !== null))];
    if (deSesPoles.includes(null)) ids = [...new Set([...ids, ...(await getMyCompanies(user.id)).map((x) => x.id)])];
  } else ids = [];
  if (c.companyId) ids = ids.filter((id) => id === c.companyId);
  const societes = toutes.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, label: companyLabel(x) }));

  const campagne = { id: c.id, year: c.year, companyId: c.companyId, status: c.status, recettesFigeesLe: c.recettesFigeesLe, taxSettings: c.taxSettings };
  return { campagne, droitsCampagne: dc, droits, societes };
}

// ─────────────────────────────── Le volet Recettes ───────────────────────────────

export interface LigneRecetteVue {
  id: string; companyId: string; mois: number; productId: string | null; businessUnitId: string | null; client: string;
  label: string; quantite: number | null; prixUnitaire: number | null; montant: number; tvaPct: number | null;
  sourcePrix: SourcePrix | null; cle: string;
}

export interface ProduitCatalogue { id: string; label: string; companyId: string | null; businessUnitId: string | null; prixHopital: number | null }

export type VueRecettes =
  | { kind: "interdit" }
  | {
    kind: "ok"; annee: number; figeesLe: string | null; droits: DroitsRecettes; societes: { id: string; label: string }[];
    lignes: LigneRecetteVue[]; totaux: TotauxRecettes;
    /** Seulement pour qui saisit. */
    catalogue: { produits: ProduitCatalogue[]; bus: { id: string; label: string; companyId: string | null }[]; tvaDefaut: number } | null;
  };

/** Les recettes prévues d'une campagne, bornées aux sociétés données. */
export async function lireRecettes(campaignId: string, societes: readonly string[]): Promise<LigneRecetteVue[]> {
  if (societes.length === 0) return [];
  const rows = await prisma.budgetCampaignRevenue.findMany({
    where: { campaignId, companyId: { in: [...societes] } },
    orderBy: [{ companyId: "asc" }, { label: "asc" }, { month: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, companyId: r.companyId, mois: r.month, productId: r.productId, businessUnitId: r.businessUnitId, client: r.client,
    label: r.label, quantite: r.quantity === null ? null : toNumber(r.quantity), prixUnitaire: r.unitPrice === null ? null : toNumber(r.unitPrice),
    montant: toNumber(r.amount), tvaPct: r.vatRate === null ? null : toNumber(r.vatRate),
    sourcePrix: r.priceSource === "PRIX_HOPITAL" || r.priceSource === "SAISIE" ? r.priceSource : null, cle: r.matchKey,
  }));
}

/**
 * LE CATALOGUE DE SAISIE — les produits des sociétés (avec leur BU et leur PRIX HÔPITAL saisi, celui de la PCH, en
 * vigueur au 1er janvier de l'année budgétée) et les BU. Le prix observé de l'Explorateur n'est pas lu ici : on budgète
 * sur un prix décidé, et à défaut on tape le prix ou le montant.
 */
export async function catalogueRecettes(societes: readonly string[], annee: number): Promise<{ produits: ProduitCatalogue[]; bus: { id: string; label: string; companyId: string | null }[] }> {
  const auPremierJanvier = new Date(Date.UTC(annee, 0, 1));
  const [produits, bus] = await Promise.all([
    prisma.product.findMany({
      where: { isActive: true, OR: [{ companyId: { in: [...societes] } }, { companyId: null }] },
      select: {
        id: true, canonicalName: true, companyId: true,
        // Sans `take` imbriqué (LIMIT en mémoire, `prisma-take-imbrique.test.ts`) : un produit n'a que quelques profils.
        promoProfiles: { where: { businessUnitId: { not: null } }, select: { businessUnitId: true }, orderBy: { id: "asc" } },
        prixSaisis: { where: { kind: "PRIX_HOPITAL" }, select: { amountDzd: true, validFrom: true, createdAt: true, setById: true, note: true } },
      },
      orderBy: { canonicalName: "asc" },
    }),
    prisma.businessUnit.findMany({
      where: { isActive: true, OR: [{ companyId: { in: [...societes] } }, { companyId: null }] },
      select: { id: true, name: true, companyId: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
  ]);
  return {
    produits: produits.map((p) => ({
      id: p.id, label: p.canonicalName, companyId: p.companyId, businessUnitId: p.promoProfiles[0]?.businessUnitId ?? null,
      prixHopital: resoudrePrix("PRIX_HOPITAL", p.prixSaisis.map((s) => ({
        montant: s.amountDzd === null ? null : toNumber(s.amountDzd), depuis: s.validFrom, creeLe: s.createdAt, auteur: s.setById, note: s.note,
      })), { montant: null, source: null, date: null }, auPremierJanvier).montant,
    })),
    bus: bus.map((b) => ({ id: b.id, label: b.name, companyId: b.companyId })),
  };
}

export async function vueRecettesPour(user: SessionUser, campaignId: string): Promise<VueRecettes> {
  const ctx = await contexteRecettes(user, campaignId);
  if (!ctx || !ctx.droits.voit) return { kind: "interdit" };
  const ids = ctx.societes.map((s) => s.id);
  const lignes = await lireRecettes(campaignId, ids);
  const catalogue = ctx.droits.saisit
    ? { ...(await catalogueRecettes(ids, ctx.campagne.year)), tvaDefaut: lireParametresImpots(ctx.campagne.taxSettings).tvaParNature.RECETTES }
    : null;
  return {
    kind: "ok", annee: ctx.campagne.year, figeesLe: ctx.campagne.recettesFigeesLe?.toISOString() ?? null, droits: ctx.droits,
    societes: ctx.societes, lignes, totaux: totauxRecettes(lignes), catalogue,
  };
}

// ─────────────────────────────── La synthèse et les impôts ───────────────────────────────

export interface LigneDepenseTva { id: string; pole: string; label: string; companyId: string | null; montant: number; nature: NatureTva; tvaPct: number | null; profil: number[] | null; categoryKey: string | null }

/** Les dépenses prévues de la campagne, ligne par ligne (montant selon l'état de la proposition, société du pôle). */
export async function lireDepensesPrevues(campaignId: string, companyIdCampagne: string | null): Promise<LigneDepenseTva[]> {
  const ps = await prisma.budgetProposal.findMany({
    where: { campaignId },
    select: {
      status: true, poleLabel: true, department: { select: { companyId: true } },
      lines: { select: { id: true, label: true, source: true, categoryKey: true, propose: true, ajuste: true, decision: true, vatRate: true, monthlyProfile: true }, orderBy: { sortOrder: "asc" } },
    },
    orderBy: { poleLabel: "asc" },
  });
  return ps.flatMap((p) => p.lines.map((l) => ({
    id: l.id, pole: p.poleLabel, label: l.label, categoryKey: l.categoryKey,
    // Un pôle transverse (sans société) se range dans la société de la campagne quand elle en nomme une.
    companyId: p.department?.companyId ?? companyIdCampagne,
    montant: montantPrevuDeLaLigne(p.status, { propose: toNumber(l.propose), ajuste: l.ajuste === null ? null : toNumber(l.ajuste), decision: l.decision }),
    nature: natureDeLaDepense({ source: l.source, categoryKey: l.categoryKey }),
    tvaPct: l.vatRate === null ? null : toNumber(l.vatRate),
    profil: Array.isArray(l.monthlyProfile) && l.monthlyProfile.length === 12 ? l.monthlyProfile.map((x) => Number(x) || 0) : null,
  })));
}

export async function lireAjustementsImpots(campaignId: string): Promise<AjustementImpot[]> {
  const rows = await prisma.budgetCampaignTaxLine.findMany({ where: { campaignId }, select: { companyId: true, month: true, key: true, amount: true, computedAmount: true } });
  return rows.filter((r) => estCleImpot(r.key)).map((r) => ({
    companyId: r.companyId, mois: r.month, cle: r.key as AjustementImpot["cle"], montant: toNumber(r.amount),
    calcule: r.computedAmount === null ? null : toNumber(r.computedAmount),
  }));
}

/**
 * LES RETENUES MENSUELLES DES FICHES SALARIÉS, par société (IRG, CNAS, net, coût employeur) — en TOTAL seulement :
 * la synthèse qui les lit est au Super Admin et à la DG.
 */
export async function retenuesParSociete(societes: readonly string[]): Promise<Record<string, RetenuesMensuelles>> {
  if (societes.length === 0) return {};
  const fiches = await prisma.employee.findMany({
    where: { isActive: true, companyId: { in: [...societes] } },
    select: { companyId: true, netToPay: true, retIrg: true, retSS9: true, retSS35: true, employerCost: true },
  });
  const n = (v: unknown) => (v === null || v === undefined ? null : toNumber(v));
  const out: Record<string, RetenuesMensuelles> = {};
  for (const id of societes) {
    const deLaSociete = fiches.filter((f) => f.companyId === id);
    if (deLaSociete.length) out[id] = retenuesDesFiches(deLaSociete.map((f) => ({ net: n(f.netToPay), retIrg: n(f.retIrg), retSS9: n(f.retSS9), retSS35: n(f.retSS35), coutEmployeur: n(f.employerCost) })));
  }
  return out;
}

/** Le calcul complet d'une campagne pour des sociétés données (les actions s'en servent pour tracer l'écart d'un ajustement). */
export async function calculerPrevisionsCampagne(
  campagne: { id: string; companyId: string | null; taxSettings: unknown },
  societes: readonly string[],
): Promise<{ previsions: PrevisionSociete[]; parametres: ParametresImpots; depenses: LigneDepenseTva[] }> {
  const parametres = lireParametresImpots(campagne.taxSettings);
  const [recettes, depenses, ajustements, retenues] = await Promise.all([
    lireRecettes(campagne.id, societes),
    lireDepensesPrevues(campagne.id, campagne.companyId),
    lireAjustementsImpots(campagne.id),
    retenuesParSociete(societes),
  ]);
  // Les dépenses d'une société hors de portée ne comptent pas ; celles d'un pôle sans société forment leur ligne.
  const visibles = depenses.filter((d) => d.companyId === null || societes.includes(d.companyId));
  const previsions = calculerPrevisions({
    societes, parametres, ajustements,
    recettes: recettes.map((r) => ({ companyId: r.companyId, mois: r.mois, montant: r.montant, tvaPct: r.tvaPct })),
    depenses: visibles.map((d): DepensePrevue => ({ companyId: d.companyId, montant: d.montant, nature: d.nature, tvaPct: d.tvaPct, profil: d.profil, categoryKey: d.categoryKey })),
    retenues,
  });
  return { previsions, parametres, depenses: visibles };
}

export type VueSynthese =
  | { kind: "interdit" }
  | {
    kind: "ok"; annee: number; figeesLe: string | null; societes: { id: string; label: string }[];
    previsions: PrevisionSociete[]; groupe: ReturnType<typeof totalGroupe>; parametres: ParametresImpots; depenses: LigneDepenseTva[];
  };

/** LA SYNTHÈSE — Super Admin et DG seulement (règle serveur : la vue n'est pas construite pour les autres). */
export async function vueSynthesePour(user: SessionUser, campaignId: string): Promise<VueSynthese> {
  const ctx = await contexteRecettes(user, campaignId);
  if (!ctx || !ctx.droits.voitSynthese || !(user.role === "SUPER_ADMIN" || estRole(user, "GENERAL_MANAGER"))) return { kind: "interdit" };
  const { previsions, parametres, depenses } = await calculerPrevisionsCampagne(ctx.campagne, ctx.societes.map((s) => s.id));
  return {
    kind: "ok", annee: ctx.campagne.year, figeesLe: ctx.campagne.recettesFigeesLe?.toISOString() ?? null, societes: ctx.societes,
    previsions, groupe: totalGroupe(previsions), parametres, depenses,
  };
}
