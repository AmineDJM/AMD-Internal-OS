/**
 * « QUI VOIT CETTE BASE ? » (lot D2, décision 0057) — calculé, pas déclaré : pour chaque personne active, ses modules
 * réels (`getAccess` : matrice du rôle, surcharges, rôle secondaire, intérims) croisés avec le niveau de la base.
 * Utile dès le premier jour, même sans rien fermer : c'est le contrôle que la Direction faisait à la main.
 */
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { baseDe, droitEffectif, droitParModules, niveauPour } from "../domaine/regle";
import type { DroitBase } from "../domaine/types";
import { reglagesVivants } from "./reglages";

export interface LigneQuiVoit extends DroitBase {
  userId: string;
  nom: string;
  role: string;
}

export async function quiVoitLaBase(cle: string, maintenant = new Date()): Promise<LigneQuiVoit[] | null> {
  const base = baseDe(cle);
  if (!base) return null;
  const [personnes, reglages] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true, secondaryRole: true }, orderBy: { name: "asc" } }),
    reglagesVivants(),
  ]);
  const lignes: LigneQuiVoit[] = [];
  for (const u of personnes) {
    const acces = await getAccess(u.id, u.role);
    const modules = droitParModules(base, (m, g) => acces.modules.get(m as never)?.actions.has(g as never) ?? false);
    const n = niveauPour({ userId: u.id, roles: [u.role, u.secondaryRole] }, cle, reglages, maintenant);
    lignes.push({ userId: u.id, nom: u.name, role: u.role, ...droitEffectif(modules, n, base.nom) });
  }
  return lignes;
}
