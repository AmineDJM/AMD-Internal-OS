import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import type { JeuxDuTour } from "../../domaine/analyse/jeux";
import {
  champsDemandes, filtrer, LIGNES_JEU_MAX, LIGNES_RENDUES_MAX, normaliserFiltre, projeter, schemaCourt, schemaDeVue, trier, trouverChamp,
  type FiltreNormalise, type Ligne,
} from "../../domaine/primitives/vues";
import { VUES, vueNommee, type VueLisible } from "./vues";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — `lire` : UNE primitive pour lire l'ERP par ses VUES déclarées (décision 0065, AU2 §6.1 (a), étape M0).
 *
 * `{vue, filtres[], champs[], tri, limite, compter_par, jeu}` → un JEU nommé (gardé au serveur, réutilisable par `produire`
 * et `analyser_donnees`) et un aperçu borné pour le modèle. Ce qui le rend sûr est dans le moteur, pas dans une consigne :
 *   • la PORTÉE de l'écran, calculée ici (`vue.portee(u)`), est la seule clause que la lecture reçoit ;
 *   • une vue FERMÉE reste offerte et REFUSE en nommant le droit (jamais un jeu vide qui ferait dire « aucun ») ;
 *   • les colonnes du coffre ne sont déclarables dans aucune vue (`problemesDeDeclaration`, testé) ;
 *   • la sortie passe le filtre du catalogue (`outils-v1.ts` : jetonnée, encadrée, consignée) comme toute lecture.
 * Les entrées naturelles sont normalisées par le serveur (« octobre 2026 », « commercialisé », « infectieux »).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_LIRE = "lire";

const json = (o: unknown) => JSON.stringify(o);
const texte = (e: Record<string, unknown>, k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");

/** Les filtres reçus : une liste d'objets, ou un objet `{champ: valeur}` (forme naturelle tolérée). */
function filtresRecus(brut: unknown): { champ?: unknown; op?: unknown; valeur?: unknown }[] {
  if (Array.isArray(brut)) return brut.filter((f) => f && typeof f === "object") as { champ?: unknown; op?: unknown; valeur?: unknown }[];
  if (brut && typeof brut === "object") return Object.entries(brut as Record<string, unknown>).map(([champ, valeur]) => ({ champ, op: "=", valeur }));
  return [];
}

export interface ResultatLecture { statut: string; [k: string]: unknown }

/** EXÉCUTER une lecture : portée de l'écran, filtres normalisés, tri, projection, jeu inscrit. */
export async function executerVue(u: CurrentUser, e: Record<string, unknown>, jeux: Pick<JeuxDuTour, "inscrire">, maintenant = new Date()): Promise<ResultatLecture> {
  const vue = vueNommee(e.vue) as VueLisible<unknown> | null;
  if (!vue) return { statut: "INCONNUE", raison: `vue « ${String(e.vue ?? "")} » inconnue`, vues: VUES.map((v) => v.nom) };
  const portee = vue.portee(u);
  if (portee === null) {
    return {
      statut: "FERMEE", vue: vue.nom, droit: vue.droit, ecran: vue.ecran,
      raison: `La vue « ${vue.nom} » demande le droit « ${vue.droit} », que votre rôle n'a pas dans l'application (réglé en Administration › Accès). Rien n'a été lu.`,
    };
  }
  const filtres: FiltreNormalise[] = [];
  for (const f of filtresRecus(e.filtres)) {
    const n = normaliserFiltre(vue, f, maintenant);
    if ("erreur" in n) return { statut: "FILTRE_INVALIDE", vue: vue.nom, raison: n.erreur, schema: schemaDeVue(vue) };
    filtres.push(n);
  }
  const demandes = champsDemandes(vue, e.champs);
  if ("erreur" in demandes) return { statut: "CHAMP_INCONNU", vue: vue.nom, raison: demandes.erreur };
  const triBrut = (e.tri && typeof e.tri === "object" ? (e.tri as Record<string, unknown>) : { champ: e.tri }) as Record<string, unknown>;
  const champTri = triBrut.champ ? trouverChamp(vue, triBrut.champ) : null;
  const sens = String(triBrut.sens ?? "").toLowerCase().startsWith("d") ? "desc" : "asc";

  const brutes = await vue.lire(u, portee, maintenant);
  const gardees = trier(filtrer(brutes, filtres), champTri, sens);
  const lignes = projeter(gardees.slice(0, LIGNES_JEU_MAX), demandes.champs);
  const nomJeu = texte(e, "jeu") || vue.nom;
  jeux.inscrire({ id: nomJeu, origine: `lire ${vue.nom}${filtres.length ? ` · ${filtres.map(dire).join(" · ")}` : ""}`, lignes: lignes as never, masquees: [] });

  const limite = Math.min(Math.max(Number(e.limite) || 30, 1), LIGNES_RENDUES_MAX);
  const champGroupe = e.compter_par ? trouverChamp(vue, e.compter_par) : null;
  return {
    statut: "LU", vue: vue.nom, jeu: nomJeu, ecran: vue.ecran,
    // L'OBSERVATION de la lecture : ce que le serveur a compris du filtre, et combien de lignes il a trouvées.
    filtresAppliques: filtres.map(dire),
    total: gardees.length, rendues: Math.min(limite, lignes.length), colonnes: demandes.champs.map((c) => c.nom),
    ...(champGroupe ? { comptes: compter(gardees, champGroupe.nom) } : {}),
    lignes: lignes.slice(0, limite),
    ...(gardees.length > limite ? { suite: `${gardees.length - limite} ligne(s) de plus dans le jeu « ${nomJeu} » (produire, analyser_donnees)` } : {}),
  };
}

const dire = (f: FiltreNormalise): string => {
  const v = (x: unknown) => (x && typeof x === "object" ? ("jour" in (x as object) ? (x as { jour: string }).jour : (x as { mois: string }).mois) : String(x));
  if (f.op === "vide" || f.op === "renseigne") return `${f.champ.nom} ${f.op}`;
  return `${f.champ.nom} ${f.op} ${Array.isArray(f.valeur) ? f.valeur.map(v).join(" | ") : v(f.valeur)}`;
};

function compter(lignes: readonly Ligne[], champ: string): Record<string, number> {
  const c: Record<string, number> = {};
  for (const l of lignes) for (const v of Array.isArray(l[champ]) ? (l[champ] as unknown[]) : [l[champ]]) {
    const k = v === null || v === undefined || v === "" ? "(vide)" : String(v);
    c[k] = (c[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 40));
}

/** LE SCHÉMA EXPOSÉ : chaque vue, ses champs, ses valeurs — c'est sur eux que le modèle formule son filtre. */
export const DESCRIPTION_LIRE = "LIT l'ERP sous les droits de la personne par une VUE : filtres, champs, tri, compter_par ; le résultat est un JEU "
  + "nommé (pour produire, analyser_donnees) et chaque ligne porte son lien d'écran. Valeurs dites naturellement (« octobre 2026 », « commercialisé ») : "
  + "le serveur normalise. * = calculé par les règles de l'ERP. Vues : " + VUES.map(schemaCourt).join(" ; ") + ".";

export function outilLire(user: CurrentUser, jeux: Pick<JeuxDuTour, "inscrire">): PowerTool {
  return {
    def: {
      name: OUTIL_LIRE,
      description: DESCRIPTION_LIRE,
      input_schema: {
        type: "object",
        properties: {
          vue: { type: "string", enum: VUES.map((v) => v.nom) },
          filtres: { type: "array", items: { type: "object", properties: { champ: { type: "string" }, op: { type: "string", description: "=, !=, contient, >, <, entre, parmi, vide…" }, valeur: { type: "string" } }, required: ["champ"] } },
          champs: { type: "array", items: { type: "string" } },
          tri: { type: "object", properties: { champ: { type: "string" }, sens: { type: "string", enum: ["asc", "desc"] } } },
          compter_par: { type: "string" },
          limite: { type: "number" },
          jeu: { type: "string" },
        },
        required: ["vue"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Données lues",
    run: async (e, u) => json(await executerVue(u, e ?? {}, jeux)),
  };
}
