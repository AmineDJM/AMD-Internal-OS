import type { CurrentUser } from "@/lib/session";
import { lireBlocAnalyse } from "@/platform/ia/analyse/lecture";
import { deposerClasseurAnalyse, nomDuClasseur, octetsClasseurAnalyse } from "@/platform/ia/analyse/classeur";

/**
 * LE CLASSEUR D'UNE ANALYSE, DEMANDÉ PAR L'ÉCRAN (lot K1, décision 0031) — l'export d'un clic (« Excel ») et le dépôt
 * au Drive (« Enregistrer dans mon Drive »). Le dépôt est une ÉCRITURE : il n'a lieu que sur le geste de la personne,
 * jamais à l'initiative du modèle, et jamais en « Vue exacte » (on regarde l'écran de quelqu'un, on n'écrit pas chez lui).
 */
export type ClasseurDemande =
  | { ok: true; octets: Buffer; nom: string }
  | { ok: true; depose: { nom: string; href: string; nodeId: string } }
  | { ok: false; statut: number; erreur: string };

export async function classeurDAnalyse(user: CurrentUser, corps: unknown, vueExacte: boolean): Promise<ClasseurDemande> {
  const c = (corps && typeof corps === "object" ? corps : {}) as { bloc?: unknown; graphique?: unknown; depot?: unknown };
  const bloc = lireBlocAnalyse(c.bloc);
  if (!bloc) return { ok: false, statut: 400, erreur: "Tableau illisible : rien à exporter." };
  if (c.depot === true) {
    if (vueExacte) return { ok: false, statut: 403, erreur: "En « Vue exacte », rien ne s'écrit dans le Drive de la personne." };
    const d = await deposerClasseurAnalyse(user, bloc);
    return d.ok ? { ok: true, depose: { nom: d.nom, href: d.href, nodeId: d.nodeId } } : { ok: false, statut: 422, erreur: d.motif };
  }
  const graphique = typeof c.graphique === "number" && Number.isInteger(c.graphique) && c.graphique >= 0 ? c.graphique : null;
  const r = await octetsClasseurAnalyse(bloc, user.name ?? "Adventum IA", { graphique });
  if (!r.ok) return { ok: false, statut: 422, erreur: r.motif };
  return { ok: true, octets: r.octets, nom: nomDuClasseur(graphique !== null ? `${bloc.graphiques[graphique]?.titre ?? bloc.title} — données` : bloc.title) };
}
