import { prisma } from "@/lib/prisma";
import { prochainCreneau } from "../../domaine/qualite/calendrier";
import { etatBaseEssai, lireReglageBanc } from "./banc";
import { modelesEnService } from "./modeles";
import { JOURS_TRACES, tracesActives } from "./traces";

/**
 * LE TABLEAU DE BORD QUALITÉ (J5 + J14, décision 0022) — ce que `/admin/ai/qualite` affiche, lu en une fois : le
 * calendrier du banc, la base d'essai, l'historique des passages, le détail du dernier, les modèles par rôle, les traces.
 */
export async function tableauQualite(maintenant = new Date()) {
  const [reglage, passages, modeles, choix, traces] = await Promise.all([
    lireReglageBanc(),
    prisma.assistantIaBancPassage.findMany({ orderBy: { demandeLe: "desc" }, take: 25 }),
    modelesEnService(),
    prisma.assistantIaModeleRole.findMany(),
    prisma.assistantIaTrace.aggregate({ _count: true, _sum: { octets: true } }),
  ]);
  const dernier = passages.find((p) => p.statut === "TERMINE") ?? null;
  const scenarios = dernier ? await prisma.assistantIaBancScenario.findMany({ where: { passageId: dernier.id }, orderBy: [{ famille: "asc" }, { scenario: "asc" }] }) : [];
  return {
    reglage,
    prochain: reglage.actif ? prochainCreneau(reglage, maintenant) : null,
    base: etatBaseEssai(),
    passages,
    dernier,
    scenarios,
    modeles,
    choix,
    traces: { actives: tracesActives(), jours: JOURS_TRACES(), nombre: traces._count, octets: traces._sum.octets ?? 0 },
  };
}
