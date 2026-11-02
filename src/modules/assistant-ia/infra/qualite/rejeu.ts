import type { CurrentUser } from "@/lib/session";
import { repondreAvecSecours } from "../repondre";
import { actifsDuRejeu, enRejeu, outilsDuRejeu, type Trace } from "./traces";

/**
 * LE REJEU D'UN TOUR (J14, décision 0022) — le même chemin que le produit (`repondreAvecSecours` : la boucle d'agent,
 * le budget, la lecture du flux), mais le modèle REJOUE ses sorties enregistrées et les outils rendent les leurs.
 * Aucun appel au fournisseur, aucune écriture métier. Rend le texte rejoué, l'original, et chaque divergence.
 */
export interface BilanRejeu {
  identique: boolean;
  texte: string;
  texteOriginal: string | null;
  outilsAppeles: string[];
  outilsOriginaux: string[];
  appelsRejoues: number;
  appelsEnregistres: number;
  divergences: string[];
  erreur: string | null;
}

export async function rejouerTrace(trace: Trace): Promise<BilanRejeu> {
  if (!trace.entree) throw new Error("Cette trace n'a pas d'entrée de boucle (le tour s'est arrêté avant le modèle) : rien à rejouer.");
  const e = trace.entree;
  const user = { id: trace.userId, name: "Rejeu", email: "rejeu@local", role: "VIEWER", secondaryRole: null, access: {}, mustChangePassword: false } as unknown as CurrentUser;
  const modelId = trace.appels.find((a) => a.nature === "tour")?.modelId ?? "rejeu";
  let texte = "";
  let outilsAppeles: string[] = [];
  let erreur: string | null = null;
  const { divergences, appelsServis } = await enRejeu(trace, async () => {
    try {
      const r = await repondreAvecSecours({
        user, message: e.message, historique: e.historique, instructions: e.instructions,
        outils: outilsDuRejeu(trace), modeles: [{ modelId, provider: "rejeu" }], delaiMs: e.delaiMs,
        config: e.nomAssistant ? ({ assistantName: e.nomAssistant } as never) : null,
        propositionsFaites: () => 0, maxEtapes: e.maxEtapes ?? undefined,
        actifs: actifsDuRejeu(trace), origine: "conversation",
        // Le flux, comme le fil le lit (le produit joue toujours en flux) : même chemin de lecture.
        surTexte: () => {},
      });
      texte = r.texte;
      outilsAppeles = r.outilsAppeles;
    } catch (x) {
      erreur = x instanceof Error ? x.message : String(x);
    }
  });
  const original = trace.resultat?.texte ?? null;
  if (original !== null && texte !== original) divergences.push("le texte final rejoué diffère de l'original");
  if (trace.resultat && JSON.stringify(outilsAppeles) !== JSON.stringify(trace.resultat.outilsAppeles)) divergences.push(`outils appelés : ${outilsAppeles.join(", ")} ≠ ${trace.resultat.outilsAppeles.join(", ")}`);
  if (erreur && !trace.erreur) divergences.push(`le rejeu a échoué : ${erreur}`);
  const tours = trace.appels.filter((a) => a.nature === "tour").length;
  return {
    identique: divergences.length === 0, texte, texteOriginal: original, outilsAppeles, outilsOriginaux: trace.resultat?.outilsAppeles ?? [],
    appelsRejoues: appelsServis, appelsEnregistres: tours, divergences, erreur,
  };
}
