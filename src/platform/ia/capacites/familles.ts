/**
 * LES FAMILLES DE LA CONSOLE (`/admin/ai/acces`, décision 0012) — leur liste, au socle depuis J6 (décision 0020).
 *
 * Le registre des capacités range chaque action dans une famille ; la règle d'accès de l'Assistant IA
 * (`modules/assistant-ia/domaine/acces-regles.ts`) dit qui l'ouvre. La liste vit ici pour que les deux la lisent
 * sans que le socle importe l'Assistant IA (règle 3 de `frontieres.test.ts`). Pur, zéro import.
 */
export const FAMILLES_IA = ["SALAIRES", "BUDGETS", "CONTRATS_RH", "FICHES", "DRIVE", "REGLEMENTAIRE", "AD_PRO", "ECRITURES"] as const;
export type FamilleIa = (typeof FAMILLES_IA)[number];

export const estFamilleIa = (v: unknown): v is FamilleIa => typeof v === "string" && (FAMILLES_IA as readonly string[]).includes(v);
