import { prisma } from "@/lib/prisma";
import { hasGlobalView, hasRole, userCan, type Module, type SessionUser } from "@/lib/rbac";
import { predicatEntitePermise } from "@/lib/company";
import type { ElementFile } from "@/lib/espace/aujourdhui";
import { horizonEcheances, lignesEcheances, type Echeance, type Lecteur, type SourceEcheances } from "@/lib/echeances/regles";
import { SOURCES_ECHEANCES } from "@/lib/echeances/registre";
import { sansBloquer } from "@/lib/journal";

/**
 * LES ÉCHÉANCES DES MODULES, LUES POUR UNE PERSONNE — les lignes qu'« Aujourd'hui » ajoute à sa file.
 * Chaque source est lue à part : une source en panne tait SES lignes, jamais la file entière.
 */
export async function lignesEcheancesPour(
  user: SessionUser,
  maintenant: Date,
  sources: readonly SourceEcheances[] = SOURCES_ECHEANCES,
): Promise<ElementFile[]> {
  const jusquau = horizonEcheances(maintenant);
  const [lues, societePermise, societes] = await Promise.all([
    Promise.all(sources.map((s) => s.lire({ maintenant, jusquau }).catch(sansBloquer(`echeances-aujourdhui.${s.cle}`, [] as Echeance[])))),
    predicatEntitePermise(user.id),
    prisma.company.findMany({ select: { id: true, name: true, shortName: true } }),
  ]);
  const lecteur: Lecteur = {
    id: user.id,
    sommet: hasGlobalView(user) || hasRole(user, "GENERAL_MANAGER"),
    superAdmin: hasRole(user, "SUPER_ADMIN"),
    peut: (droit) => userCan(user, droit.module as Module, droit.action),
    societePermise: (companyId) => societePermise(companyId),
  };
  return lignesEcheances(lues.flat(), lecteur, maintenant, new Map(societes.map((c) => [c.id, c.shortName || c.name])));
}
