import type { CurrentUser } from "@/lib/session";
import { CONTRAT_PAR_ID } from "./contrat.genere";
import { MODULES_ACTIONS } from "./aiguillage.genere";
import { interdictionDeLAssistantIa, interdictionGenerique, validerEntree, argumentsDAppel, type EntreeRefusee } from "./generique";
import type { ContratAction } from "./contrat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * APPELER UNE ACTION QUELCONQUE — par L'ACTION ELLE-MÊME, jamais par une copie.
 *
 * ── CE QUE CE MODULE N'EST PAS ───────────────────────────────────────────────────────────
 *
 * Ce n'est PAS une porte dérobée (§118.7). Il n'écrit pas en base, ne construit aucune requête
 * et ne connaît aucun droit : il APPELLE la server action de l'écran, celle-là même que le
 * bouton appelle. Tous les contrôles — `requireUser`, `userCan`, `canAccessEntity`,
 * `requireAdmin` — sont DANS l'action et s'exécutent comme d'habitude. Réécrire ici la
 * moindre vérification en ferait une seconde vérité qui prendrait du retard au premier
 * correctif (§118.5), et c'est la version en retard qui serait la faille.
 *
 * ── L'ORDRE DES PORTES, ET POURQUOI IL EST CELUI-LÀ ──────────────────────────────────────
 *
 * 1. L'action EXISTE (sinon on ne sait pas de quoi on parle) ;
 * 2. elle est OUVERTE au chemin générique — le refus d'auto-escalade est le PREMIER contrôle
 *    de fond, avant même de regarder les entrées : constater qu'une entrée est mal formée sur
 *    `updateUserRole` reviendrait à dire « corrige ta saisie et réessaie » ;
 * 3. l'entrée TIENT dans le contrat (un champ inconnu serait ignoré, et « c'est fait » serait
 *    faux) ;
 * 4. l'action décide — et elle seule.
 *
 * ── ET LE RÉSULTAT EST RENDU TEL QUEL ────────────────────────────────────────────────────
 *
 * Une action qui rend `{ ok: false, error }` a ÉCHOUÉ, et ce module le dit (§118.25). Il ne
 * traduit pas, ne réinterprète pas, n'enjolive pas : le mot de l'action est la vérité de
 * l'action. Une action qui LÈVE remonte en échec nommé, jamais en `{ ok: true }`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatGenerique =
  | { ok: true; contrat: ContratAction; retour: unknown }
  | { ok: false; motif: "inconnue" | "interdite" | "entree" | "absente" | "erreur" | "refusee";
      message: string; refus?: EntreeRefusee[]; contrat?: ContratAction; retour?: unknown };

/**
 * UNE ACTION QUI DÉCLARE SON PROPRE ÉCHEC A ÉCHOUÉ (§118.25).
 *
 * 629 actions rendent `{ ok, error }`. Sans cette lecture, `executerAction` rendrait `ok: true`
 * pour « l'appel a eu lieu » et l'échec dormirait dans `retour` — chaque appelant devrait
 * penser à le déplier, et l'un d'eux ne le ferait pas. Je l'ai vérifié sur moi : la première
 * version de mon propre test affirmait `r.ok === true` sur un appel qui avait rendu
 * « Non autorisé. » et n'avait rien créé. Le faux succès était dans le banc avant d'être dans
 * le produit.
 *
 * La lecture est restreinte aux actions qui ÉCRIVENT : sur une lecture, `ok: false` peut être
 * une réponse légitime (« non conforme »), et refuser à tort est strictement pire.
 */
export function echecDeclare(contrat: ContratAction, retour: unknown): string | null {
  if (!contrat.ecrit) return null;
  if (!retour || typeof retour !== "object") return null;
  const r = retour as { ok?: unknown; error?: unknown };
  if (r.ok !== false) return null;
  return typeof r.error === "string" && r.error ? r.error : "L'action a refusé sans donner de motif.";
}

/**
 * L'ACTION, RÉSOLUE DEPUIS SON MODULE.
 *
 * Deux formes d'espace de noms selon l'empaqueteur : les exports nommés, ou un objet sous
 * `default` (interop CommonJS). On lit les deux — se fier à une seule ferait échouer le
 * chemin générique dans l'un des deux environnements, en annonçant « action absente » sur une
 * action parfaitement présente : le « je ne peux pas » artificiel exactement (§118.63).
 */
export async function resoudreFonction(
  fichier: string,
  fonction: string,
): Promise<((...args: never[]) => unknown) | null> {
  const charger = MODULES_ACTIONS[fichier];
  if (!charger) return null;
  const mod = await charger();
  const direct = mod[fonction];
  if (typeof direct === "function") return direct as (...args: never[]) => unknown;
  const def = mod.default as Record<string, unknown> | undefined;
  const via = def && typeof def === "object" ? def[fonction] : undefined;
  return typeof via === "function" ? (via as (...args: never[]) => unknown) : null;
}

/**
 * APPELLE UNE ACTION DE L'ERP par son identifiant `fichier:fonction`.
 *
 * `user` n'est PAS transmis : l'action lit la session elle-même (`requireUser`). Le passer
 * ouvrirait la possibilité d'agir au nom de quelqu'un d'autre — et le fait qu'aucun appelant
 * actuel ne le ferait ne suffit pas, la porte existerait.
 */
export async function executerAction(
  _user: CurrentUser,
  id: string,
  entree: Readonly<Record<string, unknown>> = {},
  politique: "generique" | "assistant-ia" = "generique",
): Promise<ResultatGenerique> {
  const contrat = CONTRAT_PAR_ID.get(id);
  if (!contrat) {
    return { ok: false, motif: "inconnue", message: `Aucune action « ${id} » dans l'ERP.` };
  }

  // L'ASSISTANT IA a sa politique (décision 0020) : le refus générique, moins les gestes de fiche ; leurs champs
  // retenus (`GESTES_DE_FICHE`), le module les ôte de ce que propose le modèle.
  const interdit = politique === "assistant-ia" ? interdictionDeLAssistantIa(contrat) : interdictionGenerique(contrat);
  if (interdit) return { ok: false, motif: "interdite", message: interdit, contrat };

  const refus = validerEntree(contrat, entree);
  if (refus.length > 0) {
    return {
      ok: false, motif: "entree", contrat, refus,
      message: refus.map((r) => r.raison).join(" "),
    };
  }

  const fn = await resoudreFonction(contrat.fichier, contrat.fonction);
  if (!fn) {
    return {
      ok: false, motif: "absente", contrat,
      message: `L'action « ${id} » est décrite mais introuvable dans son module — l'artefact a `
        + `pris du retard sur le code (\`npm run actions:contrat\`).`,
    };
  }

  try {
    // SIX FORMES D'APPEL, et le contrat les distingue : 100 actions de l'ERP sont des
    // `useActionState` et reçoivent l'état précédent AVANT le formulaire. Se tromper d'arité
    // ferait passer le FormData en premier argument, et l'action lirait un état là où on lui
    // donne des données — sans erreur, sans effet. Le choix vit dans `argumentsDAppel`, en un
    // seul endroit exhaustif : une forme ajoutée sans son appel ne compile pas.
    const retour = await (fn as (...a: unknown[]) => unknown)(...argumentsDAppel(contrat, entree));
    const refuse = echecDeclare(contrat, retour);
    if (refuse) return { ok: false, motif: "refusee", contrat, retour, message: refuse };
    return { ok: true, contrat, retour };
  } catch (e) {
    return {
      ok: false, motif: "erreur", contrat,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
