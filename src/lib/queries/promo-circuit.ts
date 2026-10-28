import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { entitePermisePourFiche } from "@/lib/company";
import { loadReportingLine } from "@/lib/departments";
import { managementChainOf } from "@/lib/hr/reporting-line";
import { anyRoleFilter, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { ROLE_DIRECTION_MARKETING } from "@/lib/personnes/roles-vente";
import { estDecideurInfoMed } from "@/lib/medical-info/decideur";
import {
  validateurDeLaDemande, estCheffeMarketing, directriceMarketingDe, cheffesMarketing,
  type Personne, type ValidateurDemande,
} from "@/lib/promo-material/validateurs";
import { totauxDeLaSelection, type DevisLu } from "@/lib/promo-material/devis";
import { tourDe, type ContexteCircuit, type PromoState, type TourPromo, type VersionCircuit } from "@/lib/promo-material/circuit";
import { sansBloquer } from "@/lib/journal";

/**
 * LE CHARGEUR DU CIRCUIT DU MATÉRIEL PROMOTIONNEL (§118.152) — ce que la règle pure ne peut pas lire.
 *
 * La règle vit dans `promo-material/validateurs.ts` et `circuit.ts`, sans base. Ce module lui
 * porte les faits : la chaîne hiérarchique canonique (`hr/reporting-line.ts`, la MÊME que celle
 * des congés et de « Mon Équipe » — une seconde lecture de l'organigramme finirait par envoyer la
 * demande à quelqu'un que « Mon Équipe » ne montre pas), les rôles, les devis retenus, le seuil.
 *
 * L'action ET l'écran lisent ici : deux lectures du contexte d'un dossier finiraient par annoncer
 * une étape que l'action refuse (§118.5).
 */

async function personnesDe(userIds: readonly string[]): Promise<Map<string, Personne>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, secondaryRole: true, isActive: true } });
  return new Map(rows.map((u) => [u.id, { userId: u.id, role: u.role, secondaryRole: u.secondaryRole, actif: u.isActive }]));
}

/**
 * LA PERSONNE ET SA CHAÎNE — du N+1 vers le haut, en comptes applicatifs.
 *
 * Un maillon de l'organigramme sans compte (un employé qui ne se connecte pas) ne peut rien
 * valider : il est omis, et la chaîne continue au-dessus de lui — c'est ce que fait déjà la
 * cascade pour un compte inactif.
 */
export async function personneEtChaine(userId: string): Promise<{ personne: Personne | null; chaine: Personne[] }> {
  const { employees, departments } = await loadReportingLine();
  const emp = employees.find((e) => e.userId === userId) ?? null;
  const chaineEmp = emp ? managementChainOf(emp.id, employees, departments) : [];
  const ids = [userId, ...chaineEmp.map((m) => m.userId).filter((x): x is string => Boolean(x))];
  const parId = await personnesDe(ids);
  return {
    personne: parId.get(userId) ?? null,
    chaine: chaineEmp.map((m) => (m.userId ? parId.get(m.userId) : undefined)).filter((p): p is Personne => Boolean(p)),
  };
}

export interface ValidateursFiges {
  validateur: ValidateurDemande;
  /** La cheffe de la Direction Marketing elle-même : l'étape de la Direction Marketing est sautée. */
  demandeurEstCheffe: boolean;
  /** Sa directrice marketing, quand le demandeur appartient à la Direction Marketing. */
  directriceId: string | null;
}

/** CE QUI SE FIGE À LA CRÉATION d'un dossier du circuit 2 — lu une fois, écrit sur le dossier. */
export async function validateursDeLaDemande(requesterId: string): Promise<ValidateursFiges> {
  const { personne, chaine } = await personneEtChaine(requesterId);
  const demandeur: Personne = personne ?? { userId: requesterId, role: null, secondaryRole: null, actif: true };
  return {
    validateur: validateurDeLaDemande(demandeur, chaine),
    demandeurEstCheffe: estCheffeMarketing(demandeur, chaine),
    directriceId: directriceMarketingDe(chaine)?.userId ?? null,
  };
}

/**
 * QUI VALIDE LE DEVIS POUR LA DIRECTION MARKETING — l'étape 2 du circuit 2, lue à l'étape.
 *
 * La directrice figée du demandeur quand il appartient à la Direction Marketing (et qu'elle est
 * toujours active) ; sinon les CHEFFES de la Direction Marketing, lues maintenant — c'est une
 * fonction qu'on sollicite, et si la cheffe change, c'est la nouvelle qui tranche. Le demandeur
 * n'est jamais dans la liste. `null` = aucune porteuse lisible : l'appelant retombe sur le rôle.
 */
export async function validateursMarketing(pm: { requesterId: string | null; marketingValidatorId: string | null }): Promise<string[] | null> {
  if (pm.marketingValidatorId) {
    const fixe = await prisma.user.findUnique({ where: { id: pm.marketingValidatorId }, select: { isActive: true } });
    if (fixe?.isActive) return [pm.marketingValidatorId];
  }
  return validateursMarketingDepuis(pm, false, await cheffesMarketingActuelles());
}

/**
 * LES CHEFFES DE LA DIRECTION MARKETING, lues maintenant — toutes, sans exclure personne.
 *
 * Sortie de `validateursMarketing` pour être lue UNE fois quand on juge plusieurs dossiers (le
 * centre d'actions) : elle charge l'organigramme pour chaque porteuse du rôle, et la refaire par
 * dossier multiplierait ce coût par le nombre de dossiers.
 */
export async function cheffesMarketingActuelles(): Promise<string[]> {
  const porteuses = await prisma.user.findMany({
    where: { ...anyRoleFilter([ROLE_DIRECTION_MARKETING]), isActive: true },
    select: { id: true },
  });
  const lues = await Promise.all(porteuses.map((p) => personneEtChaine(p.id)));
  return cheffesMarketing(
    lues.filter((l): l is { personne: Personne; chaine: Personne[] } => l.personne !== null)
      .map((l) => ({ personne: l.personne, chaine: l.chaine })),
  );
}

/**
 * LA RÈGLE, séparée de ses lectures : la validatrice figée si elle est active, sinon les cheffes
 * moins le demandeur, `null` quand il n'en reste aucune (l'appelant retombe alors sur le rôle).
 * Une seule écriture, lue par la fiche, les actions et le centre d'actions (§118.5).
 */
function validateursMarketingDepuis(
  pm: { requesterId: string | null; marketingValidatorId: string | null },
  fixeActif: boolean,
  cheffes: readonly string[],
): string[] | null {
  if (pm.marketingValidatorId && fixeActif) return [pm.marketingValidatorId];
  const restantes = cheffes.filter((id) => id !== pm.requesterId);
  return restantes.length > 0 ? restantes : null;
}

/** Les étapes où un dossier ATTEND quelqu'un — ni l'exécution, ni la fin, ni le refus. */
const ETATS_EN_ATTENTE = [
  "REVIEW_REQUEST", "QUOTE_TO_REQUEST", "QUOTE_REQUESTED", "REVIEW_REQUESTER",
  "REVIEW_MANAGER", "REVIEW_DG", "REVIEW_EXECUTIVE", "REVIEW_MEDICAL_INFO",
] as const satisfies readonly PromoState[];

/**
 * Borne de lecture. Elle se DIT au journal quand elle est atteinte : une file tronquée en silence
 * se lirait comme complète (§118.60). Un volume de dossiers en attente de validation dix fois
 * supérieur à tout ce que l'entreprise a connu serait déjà un signal en soi.
 */
const LIMITE_DOSSIERS_EN_ATTENTE = 500;

export interface DossierPromoAMonTour {
  id: string;
  reference: string;
  title: string;
  etat: PromoState;
  version: VersionCircuit;
  tour: TourPromo;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DOSSIERS DONT C'EST MON TOUR — ce que le centre d'actions affiche (§118.153).
 *
 * La règle vit dans le module pur (`tourDe`) ; ce chargeur lui porte les faits, avec la MÊME
 * lecture des validateurs que la fiche et les actions (la personne figée, la directrice ou les
 * cheffes de la Direction Marketing). Aucun filtre par module : le N+1 et l'assistante de
 * direction n'ont pas le module Matériel promotionnel et c'est pourtant leur tour — la fiche
 * s'ouvre à eux comme parties prenantes, la file doit les voir aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function dossiersPromoAMonTour(user: SessionUser): Promise<DossierPromoAMonTour[]> {
  const rows = await prisma.promoMaterial.findMany({
    where: { circuitState: { in: [...ETATS_EN_ATTENTE] } },
    select: {
      id: true, reference: true, title: true, circuitState: true, circuitVersion: true, returnedAt: true,
      requesterId: true, assistantId: true, managerId: true, requestValidatorId: true, marketingValidatorId: true,
    },
    // Le plus ancien d'abord : c'est lui qui bloque quelqu'un depuis le plus longtemps.
    orderBy: { createdAt: "asc" },
    take: LIMITE_DOSSIERS_EN_ATTENTE,
  });
  if (rows.length >= LIMITE_DOSSIERS_EN_ATTENTE) {
    console.warn(`[promo] centre d'actions : ${rows.length} dossiers en attente lus, borne atteinte — les plus récents peuvent manquer`);
  }
  if (rows.length === 0) return [];

  // LA DIRECTION MARKETING N'EST LUE QUE SI ELLE PEUT RÉPONDRE « OUI » : une personne qui ne porte
  // pas le rôle ne figure jamais parmi les cheffes, et n'est validatrice que si un dossier la
  // NOMME (la validatrice figée) — ce qui se lit sans l'organigramme.
  const aJuger = rows.filter((r) => r.circuitVersion === 2 && r.circuitState === "REVIEW_MANAGER");
  const fixes = [...new Set(aJuger.map((r) => r.marketingValidatorId).filter((x): x is string => Boolean(x)))];
  const actifs = fixes.length
    ? new Set((await prisma.user.findMany({ where: { id: { in: fixes }, isActive: true }, select: { id: true } })).map((u) => u.id))
    : new Set<string>();
  const porteRole = user.role === ROLE_DIRECTION_MARKETING || user.secondaryRole === ROLE_DIRECTION_MARKETING;
  const cheffes = aJuger.length > 0 && porteRole ? await cheffesMarketingActuelles() : [];

  const acteur = { id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) };
  const resultat: DossierPromoAMonTour[] = [];
  for (const r of rows) {
    const etat = r.circuitState as PromoState;
    const version: VersionCircuit = r.circuitVersion === 2 ? 2 : 1;
    const marketing = version === 2 && etat === "REVIEW_MANAGER"
      ? validateursMarketingDepuis(r, r.marketingValidatorId ? actifs.has(r.marketingValidatorId) : false, cheffes)
      : null;
    const tour = tourDe(
      acteur, etat,
      { requesterId: r.requesterId, assistantId: r.assistantId, returnedAt: r.returnedAt },
      { requesterId: r.requesterId, managerId: r.managerId, requestValidatorId: r.requestValidatorId, validateursMarketing: marketing },
      version,
    );
    if (tour) resultat.push({ id: r.id, reference: r.reference, title: r.title, etat, version, tour });
  }
  return resultat;
}

/** Les devis d'un dossier, lus pour la règle pure (nombres, pas de Decimal). */
export const SELECT_DEVIS = {
  id: true, position: true, supplierId: true, supplierName: true, reference: true, quoteDate: true,
  tvaRate: true, extraTaxLabel: true, extraTaxRate: true, announcedTotal: true, documentId: true, note: true,
  purchaseOrderId: true, purchaseOrderSentAt: true, purchaseOrderSentById: true, bcBrouillon: true,
  lines: { orderBy: { position: "asc" }, select: { id: true, position: true, reference: true, unit: true, quantity: true, unitPrice: true, selected: true, action: true, requestItemId: true } },
} satisfies Prisma.PromoQuoteSelect;

type DevisBrut = Prisma.PromoQuoteGetPayload<{ select: typeof SELECT_DEVIS }>;

export function devisLu(d: DevisBrut): DevisLu {
  return {
    id: d.id, supplierId: d.supplierId, supplierName: d.supplierName, reference: d.reference,
    tvaRate: d.tvaRate != null ? Number(d.tvaRate) : null, extraTaxLabel: d.extraTaxLabel, extraTaxRate: d.extraTaxRate != null ? Number(d.extraTaxRate) : null,
    announcedTotal: d.announcedTotal != null ? Number(d.announcedTotal) : null, documentId: d.documentId,
    lines: d.lines.map((l) => ({
      id: l.id, position: l.position, reference: l.reference, unit: l.unit, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), selected: l.selected,
      action: l.action ?? null, requestItemId: l.requestItemId,
    })),
  };
}

export async function devisDuDossier(promoId: string): Promise<DevisBrut[]> {
  return prisma.promoQuote.findMany({ where: { promoMaterialId: promoId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: SELECT_DEVIS });
}

/**
 * LE CONTEXTE D'UN DOSSIER, pour la règle pure — la version, qui demande, combien, quel seuil.
 *
 * Circuit 2 : le montant est le TTC des lignes RETENUES — c'est ce qui sera engagé, et ce que le
 * seuil du DG juge. Tant que rien n'est retenu, il vaut `null` (inconnu), et un montant inconnu
 * ouvre la porte du DG : on ne franchit pas une porte de contrôle sur une absence de donnée.
 * Circuit 1 : le devis retenu, à défaut le budget global (la règle d'avant, inchangée).
 */
export async function contexteDuDossier(pm: {
  id: string; circuitVersion: number; requesterId: string | null; requestValidation: boolean;
  chosenAmount: unknown; amount: unknown;
}): Promise<ContexteCircuit> {
  const version: VersionCircuit = pm.circuitVersion === 2 ? 2 : 1;
  const reglages = await getAppSettings().catch(sansBloquer("promo-circuit.contexteDuDossier.getAppSettings", null));
  const seuilDg = reglages?.adProDgThreshold ?? null;
  if (version === 2) {
    const [figes, devis] = await Promise.all([
      pm.requesterId ? validateursDeLaDemande(pm.requesterId) : Promise.resolve(null),
      devisDuDossier(pm.id),
    ]);
    const selection = totauxDeLaSelection(devis.map(devisLu));
    return {
      version,
      demandeurEstDirectionMarketing: figes?.demandeurEstCheffe ?? false,
      // La validation de la demande se décide À LA CRÉATION, et le dossier le porte : la relire
      // dans l'organigramme d'aujourd'hui pourrait faire réapparaître une étape déjà franchie.
      validationDemande: pm.requestValidation,
      montant: selection.lignes > 0 ? selection.ttc : null,
      seuilDg,
    };
  }
  const demandeur = pm.requesterId
    ? await prisma.user.findUnique({ where: { id: pm.requesterId }, select: { role: true, secondaryRole: true } }).catch(sansBloquer("promo-circuit.contexteDuDossier.user", null))
    : null;
  const montant = pm.chosenAmount != null ? Number(pm.chosenAmount) : pm.amount != null ? Number(pm.amount) : null;
  return {
    version,
    demandeurEstDirectionMarketing: demandeur?.role === ROLE_DIRECTION_MARKETING || demandeur?.secondaryRole === ROLE_DIRECTION_MARKETING,
    montant: montant != null && Number.isFinite(montant) ? montant : null,
    seuilDg,
  };
}

/**
 * QUI PEUT OUVRIR LE DOSSIER — la porte de la fiche, et pas seulement celle du module.
 *
 * Le circuit 2 adresse des gestes à des personnes qui n'ont PAS le module Matériel promotionnel :
 * le N+1 d'un KAM qui valide sa demande, l'assistante de direction qui retranscrit les devis, le
 * pharmacien qui instruit la demande de visa d'un paiement. Une fiche fermée à celui qui doit
 * agir, c'est un dossier que personne ne peut faire avancer — mort, sans une ligne d'échec
 * (§118.107). On ouvre donc aux PARTIES PRENANTES du dossier, et à elles seules.
 */
export async function peutOuvrirLeDossierPromo(user: SessionUser, pm: {
  id: string; requesterId: string | null; assistantId: string | null;
  requestValidatorId?: string | null; marketingValidatorId?: string | null;
  /** OBLIGATOIRE : la portée « toutes les lignes » s'arrête aux sociétés qu'on a le droit de voir. */
  companyId: string | null;
}): Promise<boolean> {
  if (hasGlobalView(user.role)) return true;
  if (userCan(user, "PROMO_MATERIAL", "VIEW")) {
    const m = user.access.modules.get("PROMO_MATERIAL");
    // « Toutes les lignes » veut dire toutes les lignes DES SOCIÉTÉS qu'on voit (§118.184) — la liste
    // le dit déjà. Qui TRANCHE le module (VALIDATE) n'y est pas tenu : une notification de rôle lui
    // amène les dossiers de toutes les sociétés, et il doit pouvoir ouvrir ce qu'il tranche.
    if (m?.scope === "ALL" && (userCan(user, "PROMO_MATERIAL", "VALIDATE") || (await entitePermisePourFiche(user.id, pm.companyId)))) return true;
  }
  if ([pm.requesterId, pm.assistantId, pm.requestValidatorId, pm.marketingValidatorId].includes(user.id)) return true;
  // L'assistante de direction tient le secrétariat : elle retranscrit les devis de TOUS les
  // dossiers, qu'on l'ait nommée ou non (la même règle que `canAccessEntity`, §PROMO_MATERIAL).
  if (user.role === "DIRECTION_ASSISTANT" || user.secondaryRole === "DIRECTION_ASSISTANT") return true;
  // Le PHARMACIEN qui instruit la demande de visa (ou de déclaration) d'un paiement de CE dossier :
  // le support à faire viser vit ici. La MÊME porte que la fiche de la déclaration
  // (`canViewDeclaration`) : le pharmacien responsable, ou qui valide l'information médicale —
  // pas quiconque a simplement le droit de LIRE ce module (les Finances l'ont, pour les bons de
  // versement : ce n'est pas une raison d'ouvrir le dossier de matériel).
  // Et le DÉCIDEUR de l'information médicale (le Directeur des Opérations, `medical-info/decideur.ts`) :
  // il tranche la demande du pharmacien, il lit le support sur lequel elle porte.
  const instruit = userCan(user, "MEDICAL_INFO", "VALIDATE")
    || (userCan(user, "MEDICAL_INFO", "VIEW") && (user.role === "MEDICAL_INFO_PHARMACIST" || user.secondaryRole === "MEDICAL_INFO_PHARMACIST" || estDecideurInfoMed(user)));
  if (instruit) {
    const factures = await prisma.legalDocument.findMany({
      where: { kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pm.id },
      select: { id: true },
    });
    if (factures.length > 0) {
      const n = await prisma.medicalInfoDeclaration.count({
        where: { sourceType: "LEGAL_DOCUMENT", sourceId: { in: factures.map((f) => f.id) } },
      });
      if (n > 0) return true;
    }
  }
  // Les cheffes de la Direction Marketing qui valident le devis d'un demandeur hors marketing ont
  // le module par leur rôle (MANAGE) : elles passent par la première porte.
  return false;
}
