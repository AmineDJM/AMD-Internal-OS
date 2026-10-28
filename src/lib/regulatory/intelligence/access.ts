import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { accessBearerOf, getCompanies, getCompanyScope } from "@/lib/company";
import { allowedCompanyIds, resolveScope } from "@/lib/company-access";

/**
 * Couche d'ACCÈS du Regulatory Intelligence OS.
 *  - Feature flag PAR ORGANISATION (Company) : `RegulatoryFeatureAccess`.
 *  - Permissions fines `regulatory.*` mappées sur les rôles (rôle principal ET secondaire).
 *
 * Le module est masqué par défaut ; seul le Super Admin peut débloquer une organisation.
 * Ces vérifications sont volontairement défensives (ne jettent jamais) : en cas d'erreur,
 * on refuse l'accès.
 */

export const REG_PERMISSIONS = [
  "regulatory.module.unlock",
  "regulatory.workspace.view",
  "regulatory.workspace.manage",
  "regulatory.dossier.create",
  "regulatory.dossier.upload",
  "regulatory.dossier.analyse",
  "regulatory.dossier.compare",
  "regulatory.document.view",
  "regulatory.document.classify",
  "regulatory.document.approve",
  "regulatory.finding.view",
  "regulatory.finding.edit",
  "regulatory.finding.approve",
  "regulatory.rules.view",
  "regulatory.rules.manage",
  "regulatory.corpus.view",
  "regulatory.corpus.manage",
  "regulatory.reserve.manage",
  "regulatory.response.generate",
  "regulatory.response.approve",
  "regulatory.email.draft",
  "regulatory.document.generate",
  "regulatory.submission.prepare",
  "regulatory.submission.approve",
  "regulatory.audit.view",
  "regulatory.admin",
] as const;

export type RegPermission = (typeof REG_PERMISSIONS)[number];

type RoleBearer = { role: UserRole; secondaryRole?: UserRole | null };

// Permissions du Responsable Réglementaire (pharmacien) : opérationnel + approbations,
// SAUF le déblocage du module et l'administration (réservés au Super Admin).
const HEAD_PERMS: RegPermission[] = REG_PERMISSIONS.filter(
  (p) => p !== "regulatory.module.unlock" && p !== "regulatory.admin" && p !== "regulatory.rules.manage" && p !== "regulatory.corpus.manage",
);

// Assistante Réglementaire : prépare, ne valide/n'approuve pas.
const ASSISTANT_PERMS: RegPermission[] = [
  "regulatory.workspace.view", "regulatory.dossier.create", "regulatory.dossier.upload",
  "regulatory.dossier.analyse", "regulatory.dossier.compare", "regulatory.document.view",
  "regulatory.document.classify", "regulatory.finding.view", "regulatory.finding.edit",
  "regulatory.rules.view", "regulatory.corpus.view", "regulatory.reserve.manage",
  "regulatory.response.generate", "regulatory.email.draft", "regulatory.document.generate",
  "regulatory.submission.prepare", "regulatory.audit.view",
];

// Direction (vue globale) : consultation + approbations de validation.
const DIRECTION_PERMS: RegPermission[] = [
  "regulatory.workspace.view", "regulatory.document.view", "regulatory.finding.view",
  "regulatory.finding.approve", "regulatory.response.approve", "regulatory.submission.approve",
  "regulatory.audit.view",
];

const ROLE_REG_PERMS: Partial<Record<UserRole, RegPermission[]>> = {
  HEAD_OF_REGULATORY: HEAD_PERMS,
  REGULATORY_ASSISTANT: ASSISTANT_PERMS,
  DIRECTION: DIRECTION_PERMS,
};

/** Un rôle donné détient-il la permission ? */
function roleHas(role: UserRole | null | undefined, perm: RegPermission): boolean {
  if (!role) return false;
  if (role === "SUPER_ADMIN") return true;
  return (ROLE_REG_PERMS[role] ?? []).includes(perm);
}

/**
 * L'utilisateur détient-il la permission `regulatory.*` ? Évalue le rôle PRINCIPAL **et**
 * le rôle SECONDAIRE (régression historique de l'ERP à éviter).
 */
export function regCan(user: RoleBearer, perm: RegPermission): boolean {
  return roleHas(user.role, perm) || roleHas(user.secondaryRole, perm);
}

/** Ensemble des permissions effectives (pour l'UI/tests). */
export function regPermissions(user: RoleBearer): RegPermission[] {
  return REG_PERMISSIONS.filter((p) => regCan(user, p));
}

/** Organisations débloquées (ids). */
export async function enabledRegCompanyIds(): Promise<string[]> {
  try {
    const rows = await prisma.regulatoryFeatureAccess.findMany({ where: { enabled: true }, select: { companyId: true } });
    return rows.map((r) => r.companyId);
  } catch {
    return [];
  }
}

/**
 * LES ORGANISATIONS QUE CETTE PERSONNE PEUT OUVRIR — `null` quand elle n'est pas cloisonnée.
 *
 * Mêmes garde-fous que `platformScopeWhere` : un groupe mono-société n'est pas cloisonné, et ON
 * N'ENFERME PERSONNE PAR OMISSION — quelqu'un qui ne relève d'aucune entité garde la lecture
 * d'avant, plutôt que de voir le module se verrouiller parce qu'on a oublié sa fiche salarié.
 */
async function perimetreOrganisations(userId: string): Promise<{
  trouve: boolean;
  /** Les sociétés ouvertes ; `null` = pas de cloisonnement. */
  ouvertes: string[] | null;
  /** La portée du sélecteur, VALIDÉE contre les droits quand la personne est cloisonnée. */
  portee: string | null;
}> {
  const [all, bearer] = await Promise.all([getCompanies(), accessBearerOf(userId)]);
  if (!bearer) return { trouve: false, ouvertes: [], portee: null };
  const tous = all.map((c) => c.id);
  const ouvertes = allowedCompanyIds(bearer, tous);
  const demande = await getCompanyScope();
  if (tous.length < 2 || ouvertes.length === 0) return { trouve: true, ouvertes: null, portee: demande };
  return { trouve: true, ouvertes, portee: resolveScope(bearer, demande, tous) };
}

/**
 * L'ORGANISATION CIBLE DU MODULE POUR CETTE PERSONNE — la portée du sélecteur, VALIDÉE.
 *
 *  - portée précise, ouverte à la personne **et** activée → cette organisation ;
 *  - « toutes les entités » → l'unique organisation activée PARMI CELLES QUI LUI SONT OUVERTES
 *    (sinon `null`, l'écran demande de choisir une entité).
 * `null` si rien ne correspond → module verrouillé côté serveur.
 *
 * ── LE DÉFAUT QU'ON FERME (§118.177) ────────────────────────────────────────────────────────
 *
 * Trente-trois appels du module lisaient `resolveRegCompanyId(getCompanyScope())` — douze routes,
 * quatre pages et les actions serveur de dix fichiers : le cookie TEL QUEL. Le cookie se modifie à
 * la main, et la seule vérification était l'ACTIVATION du module — jamais le droit de la personne
 * sur cette société. Un salarié d'Adventum écrivait l'identifiant
 * de Pharmagène dans son cookie et ouvrait l'analyse CTD de Pharmagène, téléversement compris.
 * Et SANS cookie, « toutes les entités » désignait l'unique organisation activée — celle d'une
 * autre société si c'était la seule. C'est le défaut que `myCompanyScope` ferme pour tous les
 * autres écrans (« le cookie est une demande, jamais une autorisation »).
 *
 * L'identité est un PARAMÈTRE OBLIGATOIRE et la fonction a changé de nom : l'ancienne recevait
 * une portée, et un appelant qui lui aurait passé le cookie aurait compilé sans rien dire.
 */
export async function resolveRegCompanyIdFor(userId: string): Promise<string | null> {
  try {
    const { trouve, ouvertes, portee } = await perimetreOrganisations(userId);
    if (!trouve) return null;
    if (portee) {
      if (ouvertes && !ouvertes.includes(portee)) return null;
      const row = await prisma.regulatoryFeatureAccess.findUnique({ where: { companyId: portee }, select: { enabled: true } });
      return row?.enabled ? portee : null;
    }
    const enabled = await prisma.regulatoryFeatureAccess.findMany({
      where: { enabled: true, ...(ouvertes ? { companyId: { in: ouvertes } } : {}) },
      select: { companyId: true },
      take: 2,
    });
    return enabled.length === 1 ? enabled[0].companyId : null;
  } catch {
    return null;
  }
}

/**
 * Les organisations ACTIVÉES que cette personne peut ouvrir, et s'il en existe d'autres hors de son
 * périmètre — la carte-garde en a besoin pour nommer un geste POSSIBLE : « sélectionnez Pharmagène
 * dans la barre supérieure » ne se dit pas à quelqu'un dont le sélecteur ne propose pas Pharmagène
 * (§118.128 : un remède qui nomme un geste impossible fait chercher une panne qui n'existe pas).
 */
export async function organisationsActiveesPour(userId: string): Promise<{ ouvertes: string[]; ailleurs: number }> {
  try {
    const [{ ouvertes }, flags] = await Promise.all([
      perimetreOrganisations(userId),
      prisma.regulatoryFeatureAccess.findMany({ where: { enabled: true }, select: { companyId: true } }),
    ]);
    const ids = flags.map((f) => f.companyId);
    if (!ouvertes) return { ouvertes: ids, ailleurs: 0 };
    const dedans = ids.filter((id) => ouvertes.includes(id));
    return { ouvertes: dedans, ailleurs: ids.length - dedans.length };
  } catch {
    return { ouvertes: [], ailleurs: 0 };
  }
}
