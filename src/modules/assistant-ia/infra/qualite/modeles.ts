import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { modelePourRole, ROLES_MODELE, type EffortRaisonnement, type RoleModele, type SurchargesModeles } from "@/platform/ia/modeles-roles";
import { autorisationChangement, type Candidat } from "../../domaine/qualite/ab-modele";

/**
 * LE MODÈLE DE CHAQUE RÔLE, TEL QU'EN SERVICE (J14, décision 0022) — l'environnement, et au-dessus le choix fait à
 * l'écran (`AssistantIaModeleRole`), relu toutes les 30 s. Un choix ne s'écrit qu'avec un banc A/B VERT pour ce candidat
 * exact (`domaine/qualite/ab-modele.ts`) ; le retour à l'environnement est toujours permis.
 */
const TTL_MS = 30_000;
let cache: { lu: number; surcharges: SurchargesModeles } = { lu: 0, surcharges: {} };

/** Relit les choix de l'écran si le cache a vieilli. Ne lève jamais : sans base, l'environnement fait foi. */
export async function chargerModelesRoles(force = false): Promise<SurchargesModeles> {
  if (!force && Date.now() - cache.lu < TTL_MS) return cache.surcharges;
  try {
    const lignes = await prisma.assistantIaModeleRole.findMany();
    const surcharges: SurchargesModeles = {};
    for (const l of lignes) if ((ROLES_MODELE as readonly string[]).includes(l.role)) surcharges[l.role as RoleModele] = { modelId: l.modelId, effort: l.effort as EffortRaisonnement };
    cache = { lu: Date.now(), surcharges };
  } catch {
    cache = { ...cache, lu: Date.now() };
  }
  return cache.surcharges;
}

/** Les choix de l'écran connus à cet instant (synchrone : le dernier chargement). */
export const surchargesCourantes = (): SurchargesModeles => cache.surcharges;

export interface ModeleEnService { modelId: string; effort: EffortRaisonnement; source: "écran" | "environnement" }

/** Les trois rôles tels qu'en service maintenant. */
export async function modelesEnService(env: Record<string, string | undefined> = process.env): Promise<Record<RoleModele, ModeleEnService>> {
  const s = await chargerModelesRoles();
  const out = {} as Record<RoleModele, ModeleEnService>;
  for (const r of ROLES_MODELE) {
    const c = modelePourRole(r, env, s);
    out[r] = { modelId: c.modelId, effort: c.effort, source: s[r] ? "écran" : "environnement" };
  }
  return out;
}

/** LA GARDE : le modèle d'un rôle ne change qu'avec un banc vert enregistré pour ce candidat. */
export async function changerModeleRole(c: Candidat, decideParId: string, maintenant = new Date()): Promise<{ ok: true } | { ok: false; raison: string }> {
  const passages = await prisma.assistantIaBancPassage.findMany({
    where: { declencheur: "AB" }, orderBy: { demandeLe: "desc" }, take: 50,
    select: { id: true, statut: true, vert: true, candidat: true, finLe: true },
  });
  const a = autorisationChangement(c, passages, maintenant);
  if (!a.ok) return a;
  await prisma.assistantIaModeleRole.upsert({
    where: { role: c.role },
    create: { role: c.role, modelId: c.modelId, effort: c.effort, passageId: a.passageId, decideParId },
    update: { modelId: c.modelId, effort: c.effort, passageId: a.passageId, decideParId, decideLe: maintenant },
  });
  await recordAudit({ actorId: decideParId, action: "UPDATE", module: "Centre de contrôle IA", summary: `Modèle du rôle « ${c.role} » : ${c.modelId} (effort ${c.effort}) — banc vert ${a.passageId}` });
  await chargerModelesRoles(true);
  return { ok: true };
}

/** La voie de secours : le rôle revient au modèle de l'environnement (la référence). */
export async function revenirModeleEnvironnement(role: RoleModele, decideParId: string): Promise<void> {
  await prisma.assistantIaModeleRole.deleteMany({ where: { role } });
  await recordAudit({ actorId: decideParId, action: "UPDATE", module: "Centre de contrôle IA", summary: `Modèle du rôle « ${role} » : retour à l'environnement` });
  await chargerModelesRoles(true);
}
