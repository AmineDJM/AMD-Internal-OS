import { getCurrentUser, getCurrentUserPourEcrire } from "@/lib/session";
import { exporterAnnuaire } from "@/lib/exports/annuaire";
import { reponseExport } from "@/lib/exports/reponse";
import { refusExport } from "@/lib/exports/types";
import { sansBloquer } from "@/lib/journal";

/**
 * QUI EXPORTE — la règle des routes mixtes (vue exacte) : la lecture voit la personne à l'écran, le POST prend
 * l'identité d'écriture. Pour la vue filtrée, le fichier n'en change pas : les identifiants envoyés sont ceux que
 * l'écran montrait, et la portée de la personne qui exporte reste posée par-dessus.
 */
async function quiExporte(req: Request) {
  return req.method === "GET" ? await getCurrentUser() : await getCurrentUserPourEcrire();
}

/** EXPORT DE L'ANNUAIRE EN CLASSEUR — la logique est dans `exporterAnnuaire`, partagée avec l'Assistant IA (K7). */
export async function GET(req: Request) {
  const user = await quiExporte(req);
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  return reponseExport(await exporterAnnuaire(user, new URL(req.url).searchParams.get("grade")));
}

/**
 * EXPORT DE LA VUE FILTRÉE (« comme Excel », recette du 23/11) — le corps porte `{ ids }`, les lignes que la feuille
 * montre dans son ordre. Même fonction, même portée, même audit : les identifiants ne font que restreindre.
 */
export async function POST(req: Request) {
  const user = await quiExporte(req);
  if (!user) return reponseExport(refusExport(401, "Non authentifié."));
  const corps = (await req.json().catch(sansBloquer("annuaire.export.vue.corps", null))) as { ids?: unknown } | null;
  const ids = Array.isArray(corps?.ids) ? corps.ids.filter((x): x is string => typeof x === "string") : null;
  if (!ids) return reponseExport(refusExport(400, "Liste de lignes manquante."));
  return reponseExport(await exporterAnnuaire(user, new URL(req.url).searchParams.get("grade"), ids));
}
