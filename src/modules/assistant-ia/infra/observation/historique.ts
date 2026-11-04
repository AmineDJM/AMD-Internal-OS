import type { CurrentUser } from "@/lib/session";
import { lireObservations, type Observation } from "../../domaine/observation/contrat";
import { lectureDeBloc, projeterCarte } from "../../domaine/observation/projecteurs";
import { blocsObserves } from "./reprojeter";
import { historiqueObserveActif } from "./interrupteurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'HISTORIQUE OBSERVÉ (lot I1, étape 1 ; audit AU1 C1, C5, C6) — chaque réponse passée repart au modèle avec son bloc
 * « Observé » : la carte (titre, mail tel qu'il partira, STATUT ACTUEL), les blocs montrés (titres, lignes, identifiants),
 * les fichiers, les missions — RE-PROJETÉS depuis la base à chaque tour. Jamais de HTML brut. Borné (≈ 300 jetons par
 * réponse) et placé dans les messages (la partie variable) : le préfixe en cache ne bouge pas.
 *
 * Un tour d'avant I1 (sans `observations`) est observé depuis ce qu'il a stocké : son intention et ses blocs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface TourHistorique {
  role: "user" | "assistant";
  content: string;
  /** Les observations stockées du tour (`AssistantIaTour.observations`). */
  observations?: unknown;
  /** Repli pour un tour d'avant I1 : la carte et les blocs stockés. */
  intent?: unknown;
  blocs?: unknown;
}

/** Les observations d'un tour stocké — les siennes, sinon celles qu'on peut tirer de sa carte et de ses blocs. */
export function observationsDuTour(t: Pick<TourHistorique, "observations" | "intent" | "blocs">): Observation[] {
  const propres = lireObservations(t.observations);
  if (propres.length || Array.isArray(t.observations)) return propres;
  const out: Observation[] = [];
  const i = t.intent && typeof t.intent === "object" ? (t.intent as Record<string, unknown>) : null;
  if (i && typeof i.id === "string" && typeof i.title === "string") {
    out.push(projeterCarte({
      id: i.id, titre: i.title, statut: typeof i.status === "string" ? i.status : "PROPOSED",
      champs: Array.isArray(i.fields) ? (i.fields as { label: string; value: string }[]) : [], avertissements: Array.isArray(i.warnings) ? (i.warnings as string[]) : [],
    }));
  }
  if (Array.isArray(t.blocs)) t.blocs.forEach((b, k) => { const o = lectureDeBloc(b, k); if (o) out.push(o); });
  return out;
}

/** L'historique tel que le modèle le relit : le texte, et pour chaque réponse, ce qui a été observé — à jour. */
export async function historiqueObserve<T extends TourHistorique>(user: CurrentUser, tours: readonly T[]): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const base = tours.map((t) => ({ role: t.role, content: t.content }));
  if (!historiqueObserveActif()) return base;
  const rangs = tours.map((t, i) => (t.role === "assistant" ? i : -1)).filter((i) => i >= 0);
  const blocs = await blocsObserves(user, rangs.map((i) => observationsDuTour(tours[i]!)));
  rangs.forEach((i, k) => {
    const b = blocs[k];
    if (b) base[i] = { ...base[i]!, content: base[i]!.content ? `${base[i]!.content}\n\n${b}` : b };
  });
  return base;
}
