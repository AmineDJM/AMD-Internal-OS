import { callModel } from "@/lib/models/gateway";
import { textOf } from "@/lib/models/contract";
import { sousImputation } from "@/lib/models/telemetry";
import { coutDeLAppel } from "@/lib/models/tarifs";
import { appelerMimo, mimoDisponible } from "@/lib/models/mimo";
import { MODELE_SOL, MODELE_TERRA, type NiveauModele } from "@/lib/missions/chantiers/routeur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CERVEAU D'UN CHANTIER (lot C1, décision 0042) — le PORT par lequel les étapes demandent un texte à MiMo, Terra
 * ou Sol. Le routeur (`routeur.ts`) a déjà choisi le niveau ; ce port l'exécute par la passerelle unique, SOUS
 * IMPUTATION (`missionId`, `feature: "chantier"`) : chaque appel entre au journal K8 au nom du chantier qui paie.
 * Les tests injectent un double ; aucun appel réseau direct ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type IssueCerveau = { ok: true; texte: string; coutUsd: number | null; modele: string } | { ok: false; erreur: string };

export interface CerveauChantier {
  disponibles(): { mimo: boolean; terra: boolean; sol: boolean };
  executer(niveau: Exclude<NiveauModele, "DETERMINISTE">, d: { consigne: string; texte: string; missionId: string; userId: string; maxSortie?: number }): Promise<IssueCerveau>;
}

const usd = (s: string | null): number | null => (s === null ? null : Number(s));

export const cerveauReel: CerveauChantier = {
  disponibles: () => {
    const openai = !!process.env.OPENAI_API_KEY?.trim();
    return { mimo: mimoDisponible(), terra: openai, sol: openai };
  },
  executer: (niveau, d) => sousImputation({ missionId: d.missionId, userId: d.userId, feature: "chantier" }, async (): Promise<IssueCerveau> => {
    if (niveau === "MIMO") {
      const r = await appelerMimo({ systeme: d.consigne, texte: d.texte, maxSortie: d.maxSortie });
      return r.ok ? { ok: true, texte: r.texte, coutUsd: r.usage.coutUsd, modele: r.usage.modele } : { ok: false, erreur: r.erreur };
    }
    const modele = niveau === "SOL" ? MODELE_SOL : MODELE_TERRA;
    const r = await callModel("worker", [{ role: "user", content: d.texte }], {
      system: d.consigne, modelOverride: modele, reasoning: niveau === "SOL" ? "medium" : "low", maxOutputTokens: d.maxSortie ?? 1_500,
    });
    if (!r.ok) return { ok: false, erreur: r.error ?? "appel du modèle en échec" };
    const u = r.usage;
    return {
      ok: true, texte: textOf(r.blocks).trim(), modele,
      coutUsd: usd(coutDeLAppel(modele, { entree: u.inputTokens, entreeCache: u.cachedInputTokens, sortie: u.outputTokens })),
    };
  }),
};
