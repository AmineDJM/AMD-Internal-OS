import { prisma } from "@/lib/prisma";
import { scopeMedicalInfo, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { companyScopedWhere } from "@/lib/company";

/**
 * COMBIEN LE FILTRE D'ENTITÉ RETIRE de cette liste — compté ici, DIT par l'écran.
 *
 * Le cloisonnement est voulu ; son silence ne l'est pas. Le pharmacien voyait deux déclarations
 * dans « Mon espace » et zéro dans son module, sans qu'aucun écran ne relie les deux faits.
 */
export async function declarationsHiddenByScope(user: SessionUser): Promise<{ shown: number; total: number }> {
  const metier = scopeMedicalInfo(user);
  const [total, shown] = await Promise.all([
    prisma.medicalInfoDeclaration.count({ where: metier }),
    prisma.medicalInfoDeclaration.count({ where: await companyScopedWhere(user.id, metier) }),
  ]);
  return { shown, total };
}

export async function getDeclarations(user: SessionUser) {
  return prisma.medicalInfoDeclaration.findMany({
    where: await companyScopedWhere(user.id, scopeMedicalInfo(user)),
    include: {
      pharmacist: { select: { name: true } },
      requests: {
        select: {
          id: true, status: true, createdAt: true, fulfilledAt: true, targetUserId: true,
          targetUser: { select: { name: true } },
        },
      },
      company: { select: { id: true, name: true, shortName: true, color: true } },
    },
    orderBy: [{ createdAt: "desc" }],
  });
}

export async function getDeclaration(id: string) {
  return prisma.medicalInfoDeclaration.findUnique({
    where: { id },
    include: {
      pharmacist: { select: { name: true } },
      requests: {
        include: { targetUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
      // Ce que la règle de visibilité lit pour les Finances (audit 360°, I9) : un bon parti au paiement.
      slips: { select: { requestId: true } },
    },
  });
}

export type DeclarationDetail = NonNullable<Awaited<ReturnType<typeof getDeclaration>>>;

/**
 * Le détail d'une déclaration est visible par : le pharmacien responsable / la
 * Direction / un admin (accès au module), ou tout utilisateur sollicité pour une
 * pièce sur cette déclaration (afin qu'il puisse la déposer). Le DIRECTEUR DES OPÉRATIONS,
 * qui tranche tout ce que le pharmacien fait valider (`medical-info/decideur.ts`), lit le
 * module en portée ALL (`rbac.ts`) : il ouvre le dossier et ses pièces sur lesquels il décide.
 */
export function canViewDeclaration(
  user: SessionUser,
  decl: { pharmacistId: string | null; requests: { targetUserId: string | null }[]; slips?: { requestId: string | null }[] },
): boolean {
  if (hasGlobalView(user.role)) return true;
  // LES FINANCES, DÈS QU'UN BON EST PARTI AU PAIEMENT (audit 360°, I9). Elles règlent la quittance,
  // puis la REMETTENT au bureau du pharmacien — et la notification « à remettre » les envoyait sur
  // cette fiche, qui leur répondait « introuvable ». La porte s'ouvre sur le FAIT qui les concerne
  // (un bon dont le paiement a été demandé), pas sur tout le registre de l'information médicale.
  if (userCan(user, "FINANCES", "UPDATE") && (decl.slips ?? []).some((s) => s.requestId)) return true;
  if (userCan(user, "MEDICAL_INFO", "VIEW") && (decl.pharmacistId === user.id || user.role === "MEDICAL_INFO_PHARMACIST")) return true;
  if (decl.requests.some((r) => r.targetUserId === user.id)) return true;
  // Accès module avec portée ALL (ex. configuré par un admin) — ce que ce commentaire annonçait depuis
  // toujours, et que le code ne lisait pas : il ne regardait que VALIDATE. La LISTE (`scopeMedicalInfo`)
  // montre tout à une portée ALL ; la fiche lui répondait « introuvable » sur chaque ligne (§118.184 — S12).
  if (userCan(user, "MEDICAL_INFO", "VIEW") && user.access.modules.get("MEDICAL_INFO")?.scope === "ALL") return true;
  return userCan(user, "MEDICAL_INFO", "VALIDATE");
}

/**
 * LA DERNIÈRE RELANCE DE CHAQUE PIÈCE ATTENDUE — lue dans le journal, où chaque relance s'écrit
 * (`field` = RELANCE_PIECE_CHAMP, `newValue` = la demande). Pas de colonne en plus : le journal
 * garde déjà qui a relancé et quand, et une seconde trace finirait par diverger.
 */
export const RELANCE_PIECE_CHAMP = "relancePiece";

export async function dernieresRelancesPieces(declarationId: string): Promise<Map<string, Date>> {
  const lignes = await prisma.auditLog.findMany({
    where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: declarationId, field: RELANCE_PIECE_CHAMP },
    select: { newValue: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const out = new Map<string, Date>();
  for (const l of lignes) if (l.newValue && !out.has(l.newValue)) out.set(l.newValue, l.createdAt);
  return out;
}

/**
 * LE DERNIER REFUS DE LA VALIDATION FINALE — lu dans le journal, où `refuseDeclarationByDirection`
 * l'écrit (`field` = REFUS_FINAL_CHAMP, `newValue` = le motif). Pas de colonne en plus : le journal
 * garde déjà qui a refusé, quand et pourquoi.
 */
export const REFUS_FINAL_CHAMP = "refusValidationFinale";

export async function dernierRefusFinal(declarationId: string): Promise<{ motif: string; le: Date; par: string | null } | null> {
  const l = await prisma.auditLog.findFirst({
    where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: declarationId, field: REFUS_FINAL_CHAMP },
    select: { newValue: true, createdAt: true, actor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return l?.newValue ? { motif: l.newValue, le: l.createdAt, par: l.actor?.name ?? null } : null;
}

/** Lien vers l'événement source (pour l'interconnexion). */
export function sourceLink(sourceType: string, sourceId: string): string | null {
  switch (sourceType) {
    case "SPONSORING": return `/sponsoring/${sourceId}`;
    case "CONGRESS_INTERNATIONAL": return `/congress-international/${sourceId}`;
    case "CONGRESS_NATIONAL": return `/congress-national/${sourceId}`;
    case "EVENT": return `/events/${sourceId}`;
    case "AD_PRO_OTHER": return `/ad-pro/autres/${sourceId}`;
    default: return null;
  }
}
