import type { PowerTool } from "@/platform/ia/outil";
import { peutPiloterMissionsAdam } from "@/lib/rbac/roles";
import { OUTILS_CHANTIER } from "@/lib/missions/chantiers/outils";

/**
 * LES CHANTIERS DE DÉVELOPPEMENT CHEZ ADAM (C1, décision 0042) — les MÊMES quatre outils que l'Assistant IA (une seule
 * définition, `lib/missions/chantiers/outils.ts`) : lancer un chantier, où en est, valider (écrit ou oral), annuler ou
 * compenser une fusion. Fermés par une RÈGLE et non par un module : réservés au Super Admin, comme les missions d'Adam ;
 * le service relit le rôle à chaque geste.
 */
export const CHANTIER_TOOLS: PowerTool[] = OUTILS_CHANTIER.map((o) => ({
  def: o.def,
  allowed: (u) => peutPiloterMissionsAdam(u),
  refus: "Les chantiers de développement sont réservés au Super Admin (comme les missions d'Adam).",
  label: o.label,
  run: (input, user) => o.run(input, user.id),
}));
