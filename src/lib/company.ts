import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import {
  allowedCompanyIds, canEditCompany, companyAccessWhere, platformScopeWhere, resolveScope,
  seesWholeGroup, type AccessBearer, type ScopeWhere,
} from "@/lib/company-access";
import { productRangeWhere } from "@/lib/org/product-ranges";
import { trouverAdventum } from "@/lib/company-defaut";

// Mémoïsation par requête si React `cache` est disponible ; sinon (tests, hors requête) no-op.
const perRequest: <T extends (...args: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

/**
 * Dimension multi-entités (sociétés du groupe : Adventum Pharma, Pharmagène, …).
 *
 * Une **portée d'entité** est mémorisée dans un cookie et pilotée par le sélecteur de
 * la barre supérieure. `null` (« Toutes les entités ») n'applique aucun filtre ; une
 * entité précise restreint les listes aux enregistrements de cette entité. Les objets
 * non rattachés (companyId = null) restent visibles en vue « Toutes » — on peut ensuite
 * les affecter. Tout est dynamique : les entités se créent/renomment/désactivent en
 * Administration, sans code.
 */

export const COMPANY_COOKIE = "amd-company";

export interface CompanyLite {
  id: string;
  name: string;
  shortName: string | null;
  color: string | null;
}

/** Entités actives, triées (ordre d'affichage puis nom). Mémoïsé par requête (appelé sur
 *  de nombreuses pages) → une seule lecture BDD par rendu. */
export const getCompanies = perRequest(async (): Promise<CompanyLite[]> => {
  return prisma.company.findMany({
    where: { isActive: true },
    select: { id: true, name: true, shortName: true, color: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
});

/**
 * L'identifiant d'Adventum parmi les entités actives, ou `null` si elle n'existe pas. Les demandes
 * de paiement des salariés y sont rattachées d'office (Direction, 06/10) : aucun choix d'entité.
 */
export async function adventumCompanyId(): Promise<string | null> {
  return trouverAdventum(await getCompanies())?.id ?? null;
}

/**
 * Portée d'entité active (cookie). `null` = toutes les entités. Défensif : hors
 * contexte de requête (tests, tâches planifiées), renvoie `null` (aucun filtre).
 */
export async function getCompanyScope(): Promise<string | null> {
  try {
    const raw = (await cookies()).get(COMPANY_COOKIE)?.value;
    return raw && raw !== "ALL" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * LE FILTRE D'ENTITÉ DES ÉCRANS DE MODULE — la portée du sélecteur, VALIDÉE contre les droits.
 *
 * ── CE QU'IL VALIDE ─────────────────────────────────────────────────────────────────────────
 *
 * Il remplace l'ancien `currentCompanyWhere()`, qui posait le cookie tel quel. Deux trous s'y
 * ouvraient, et le second n'avait rien de théorique :
 *
 *   • le cookie se modifie à la main : il suffisait d'y écrire l'identifiant d'une autre société
 *     pour lire ses dossiers, puisque aucun écran ne revalidait la demande ;
 *   • SANS cookie, il ne filtrait RIEN. Un salarié mono-entité dont le module a une portée
 *     « toutes les lignes » (Regulatory, Legal, Courriers…) voyait donc, par défaut, le travail
 *     de toutes les sociétés du groupe — exactement ce que le cloisonnement doit empêcher.
 *
 * On passe donc par `platformScope`, qui applique la règle commune et ses deux garde-fous :
 * aucun filtre si le groupe ne compte qu'une société, aucun filtre pour qui ne relève d'aucune
 * entité (on n'aveugle personne par omission).
 *
 * ── LE DÉFAUT QU'ON CORRIGE, ET POURQUOI LE FILTRE NE S'ÉTALE PLUS ──────────────────────────
 *
 * `companyId` est NULLABLE sur presque tous les modèles, et beaucoup de lignes n'ont pas
 * d'entité — celles créées avant le multi-entités, celles nées d'un circuit qui ne la renseigne
 * pas. Un filtre `{ companyId: X }` ne les retient PAS : `null` n'est égal à rien. Elles
 * disparaissaient donc de TOUS les écrans dès qu'une portée d'entité s'appliquait.
 *
 * Ce n'est pas une hypothèse : c'est ce qui a produit deux pannes rapportées le même jour —
 * « des fois 19 courriers, des fois 14 », et un pharmacien responsable qui voyait ses
 * déclarations dans « Mon espace » (aucun filtre d'entité) et zéro dans son module (filtre).
 * Et c'est une impasse : une ligne qu'on ne voit pas est une ligne qu'on ne peut pas rattacher
 * — l'écran « non rattachés » existe précisément pour aller les rechercher.
 *
 * Une ligne SANS entité n'est le secret d'aucune société. La cacher ne protège rien et perd du
 * travail. Elle reste donc dans la portée, et « non rattachés » sert à l'affecter.
 *
 * Le filtre s'écrit dès lors `OR` (l'entité, ou rien). L'ÉTALER dans un `where` qui porte déjà
 * un `OR` — c'est le cas de la plupart des portées RBAC — écraserait silencieusement la portée
 * métier et ouvrirait les lignes des autres. On ne rend donc plus d'objet à étaler : la
 * composition se fait ICI, par un `AND`, et le type force le passage par cette fonction.
 * L'ancien `currentCompanyWhereFor` a été SUPPRIMÉ pour cette raison — le laisser, c'était
 * laisser le défaut se réintroduire au prochain écran.
 */
export async function companyScopedWhere<W extends object>(userId: string, base: W): Promise<W> {
  const where = await platformScope(userId);
  if (!("companyId" in where) || where.companyId === undefined) return base;
  const entite = { OR: [{ companyId: where.companyId }, { companyId: null }] };
  return { AND: [base, entite] } as unknown as W;
}

/**
 * LE FILTRE D'ENTITÉ D'UNE FICHE OUVERTE PAR SON LIEN (§118.184) — toutes les sociétés auxquelles la
 * personne a DROIT, et non la seule société choisie dans l'en-tête.
 *
 * Une LISTE suit le sélecteur (« je travaille sur Pharmagène en ce moment ») : c'est `companyScopedWhere`.
 * Une FICHE s'ouvre depuis une notification, un lien partagé, un favori — la juger sur la sélection du
 * moment ferait répondre « introuvable » à un dossier de la société B pour qui l'a sous les yeux en A,
 * alors qu'elle y a droit. À l'inverse, ne pas la juger du tout (l'état d'avant, mesuré par l'audit) ouvrait
 * le dossier d'une société à laquelle la personne n'a AUCUN droit, pour peu qu'elle en connaisse l'identifiant.
 *
 * Mêmes garde-fous que `platformScopeWhere` : aucun filtre dans un groupe d'une seule société, ni pour qui ne
 * relève d'aucune entité (on n'aveugle personne par omission), ni pour qui a droit à tout le groupe. Une ligne
 * SANS entité reste lisible : elle n'est le secret d'aucune société (même règle que `companyScopedWhere`).
 */
export async function ficheScopedWhere<W extends object>(userId: string, base: W): Promise<W> {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  if (!bearer) return base;
  const allIds = all.map((c) => c.id);
  if (allIds.length < 2) return base;
  const permises = allowedCompanyIds(bearer, allIds);
  if (permises.length === 0 || permises.length === allIds.length) return base;
  return { AND: [base, { OR: [{ companyId: { in: permises } }, { companyId: null }] }] } as unknown as W;
}

/** La même règle que `ficheScopedWhere`, pour UNE ligne déjà lue : sa société est-elle permise à la personne ? */
export async function entitePermisePourFiche(userId: string, companyId: string | null | undefined): Promise<boolean> {
  return (await predicatEntitePermise(userId))(companyId);
}

/**
 * LA MÊME RÈGLE, calculée UNE fois pour une personne et appliquée à beaucoup de lignes — un balayage qui
 * décide pour trois cents documents ne relit pas trois cents fois les droits du même gestionnaire.
 */
export async function predicatEntitePermise(userId: string): Promise<(companyId: string | null | undefined) => boolean> {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  const allIds = all.map((c) => c.id);
  if (!bearer || allIds.length < 2) return () => true;
  const permises = allowedCompanyIds(bearer, allIds);
  if (permises.length === 0) return () => true;
  const ensemble = new Set(permises);
  return (companyId) => !companyId || ensemble.has(companyId);
}

/** Libellé court d'une entité (fallback sur le nom complet). */
export function companyLabel(c: CompanyLite): string {
  return c.shortName || c.name;
}

/** Options `{ value, label }` d'un `<select>` d'entité pour les formulaires. */
export function companyOptions(companies: CompanyLite[]): { value: string; label: string }[] {
  return companies.map((c) => ({ value: c.id, label: companyLabel(c) }));
}

// ─────────────────────── Étanchéité : les entités auxquelles J'AI DROIT ───────────────────────

/**
 * Les entités visibles PAR CETTE PERSONNE.
 *
 * `getCompanies()` rend toutes les entités actives — c'est ce qu'il faut pour l'administration.
 * Mais le sélecteur de la barre supérieure ne doit proposer que ce à quoi on a droit, sans quoi
 * il suffirait de basculer pour lire les dossiers d'une autre société du groupe.
 *
 * Mémoïsé par requête : appelé sur presque toutes les pages.
 */
export const getMyCompanies = perRequest(async (userId: string): Promise<CompanyLite[]> => {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  if (!bearer) return [];
  const ids = allowedCompanyIds(bearer, all.map((c) => c.id));
  return all.filter((c) => ids.includes(c.id));
});

/**
 * Le porteur de droits d'une personne : ses rôles, son entité d'appartenance et ses
 * autorisations. Lu une seule fois par requête.
 */
export const accessBearerOf = perRequest(async (userId: string): Promise<AccessBearer | null> => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true, secondaryRole: true,
        companyAccess: { select: { companyId: true, canEdit: true } },
        rangeAccess: { select: { rangeId: true, range: { select: { companyId: true } } } },
        employee: { select: { companyId: true } },
      },
    });
    if (!u) return null;
    return {
      role: String(u.role),
      secondaryRole: u.secondaryRole ? String(u.secondaryRole) : null,
      homeCompanyId: u.employee?.companyId ?? null,
      grants: u.companyAccess.map((g) => ({ companyId: g.companyId, canEdit: g.canEdit })),
      rangeGrants: u.rangeAccess.map((g) => ({ rangeId: g.rangeId, companyId: g.range.companyId })),
    };
  } catch (e) {
    console.error("[company] lecture des droits d'entité impossible", e);
    return null;
  }
});

/**
 * La portée RÉELLEMENT applicable : le cookie validé contre les droits.
 *
 * ⚠️ Le cookie vient du navigateur, il se modifie à la main. On ne s'en sert donc que comme
 * d'une **demande**, jamais comme d'une autorisation.
 */
export async function myCompanyScope(userId: string): Promise<string | null> {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  if (!bearer) return null;
  return resolveScope(bearer, await getCompanyScope(), all.map((c) => c.id));
}

/**
 * Le filtre Prisma qui rend l'étanchéité réelle : même « toutes les entités » signifie
 * « toutes celles auxquelles j'ai droit », jamais toutes celles qui existent.
 */
export async function myCompanyWhere(userId: string): Promise<{ companyId?: string | { in: string[] } }> {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  if (!bearer) return { companyId: { in: [] } };
  return companyAccessWhere(bearer, await getCompanyScope(), all.map((c) => c.id));
}

/**
 * LE FILTRE À POSER DANS LES MODULES TRANSVERSES (budget, Ad & Pro, finances, demandes).
 *
 * Voir `platformScopeWhere` pour la règle exacte : portée validée contre les droits, et, appliqué
 * SEUL, il exclut un enregistrement NON rattaché (`companyId` nul) de toute vue cloisonnée — seuls
 * les rôles qui voient tout le groupe le lisent, en vue « Toutes les entités ». `companyScopedWhere`
 * (plus bas) le compose et y AJOUTE exprès les lignes sans entité. Cette phrase annonçait l'inverse
 * — l'exception levée depuis longtemps — et un écrivain qui s'y fiait créait une demande au
 * secrétariat que personne ne voyait (§118.154).
 *
 * S'utilise en composition, jamais en remplacement d'un filtre métier :
 *   `where: { AND: [ scopeSponsoring(user), await platformScope(user.id) ] }`
 */
export async function platformScope(userId: string): Promise<ScopeWhere> {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  if (!bearer) return {};
  return platformScopeWhere(bearer, await getCompanyScope(), all.map((c) => c.id));
}

/**
 * LE FILTRE PAR GAMME — plus fin que l'entité, à composer AVEC elle.
 *
 * Rend `null` quand rien n'est à restreindre (aucune gamme rattachée, ou des gammes dont
 * l'entité est déjà ouverte en entier). Sinon, un `OR` : les produits des gammes de la
 * personne, plus tout ce qui relève des sociétés qu'elle a en entier.
 *
 * S'utilise en COMPOSITION, jamais en remplacement du filtre d'entité :
 *   `where: await companyScopedWhere(id, { AND: [scopeRegulatory(user), ...rangeAnd] })`
 */
export async function productRangeScope(userId: string): Promise<ReturnType<typeof productRangeWhere>> {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  if (!bearer) return null;
  const allIds = all.map((c) => c.id);
  // Les sociétés ouvertes EN ENTIER : autorisation nominative d'entité + société
  // d'appartenance. Les gammes, elles, n'en font justement pas partie.
  const full = new Set<string>();
  for (const g of bearer.grants) if (allIds.includes(g.companyId)) full.add(g.companyId);
  if (bearer.homeCompanyId && allIds.includes(bearer.homeCompanyId)) full.add(bearer.homeCompanyId);
  return productRangeWhere({
    wholeGroup: seesWholeGroup(bearer),
    fullCompanyIds: [...full],
    rangeGrants: (bearer.rangeGrants ?? []).filter((g) => allIds.includes(g.companyId)),
  });
}

/**
 * L'entité à inscrire sur un objet QUI SE CRÉE.
 *
 * Ordre : la portée réellement sélectionnée (« je travaille sur Pharmagène en ce moment »),
 * à défaut l'entité d'appartenance du créateur. `null` si rien n'est déterminable — on ne
 * devine pas : un objet non rattaché se voit et se corrige, un objet mal rattaché se découvre
 * trop tard.
 */
export async function companyIdForNew(userId: string): Promise<string | null> {
  const scope = await myCompanyScope(userId);
  if (scope) return scope;
  const bearer = await accessBearerOf(userId);
  return bearer?.homeCompanyId ?? null;
}

/**
 * L'ENTITÉ D'UN MOUVEMENT D'ARGENT — celle de la PERSONNE, pas celle de son écran.
 *
 * `companyIdForNew` répond à « sur quoi je travaille en ce moment » : elle privilégie la portée
 * SÉLECTIONNÉE dans la barre supérieure. C'est juste pour un dossier qu'on ouvre — et faux pour
 * de l'argent. Un délégué de Pharmagène qui consulte Adventum et dépose une demande de paiement
 * l'aurait imputée à Adventum : la société qui paie aurait été décidée par un cookie d'affichage.
 *
 * Pour l'argent, l'ordre est donc inversé : la société où la personne TRAVAILLE d'abord (sa fiche
 * employé), à défaut celle de son DÉPARTEMENT, et seulement ensuite la portée sélectionnée. La
 * Direction reste libre de corriger au moment où elle valide — au seul moment où quelqu'un a le
 * dossier entier sous les yeux.
 */
export async function moneyEntityOf(userId: string): Promise<string | null> {
  try {
    const emp = await prisma.employee.findFirst({
      where: { userId },
      select: { companyId: true, departmentRef: { select: { companyId: true } } },
    });
    if (emp?.companyId) return emp.companyId;
    if (emp?.departmentRef?.companyId) return emp.departmentRef.companyId;
  } catch (e) {
    console.error("[company] entité de la personne indéterminable", e);
  }
  return companyIdForNew(userId);
}

/** Peut-on écrire sur cette entité ? Voir ne suffit pas. */
export async function canEditCompanyId(userId: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return true; // objet non rattaché : la portée ne s'applique pas
  const bearer = await accessBearerOf(userId);
  return bearer ? canEditCompany(bearer, companyId) : false;
}
