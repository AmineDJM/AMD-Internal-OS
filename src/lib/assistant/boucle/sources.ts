/**
 * CE QUE LE FLUX POUSSE AU NAVIGATEUR — le type des événements, les sources (liens internes)
 * tirées des résultats d'outil, la carte du prochain geste, et l'accord parlé d'un courriel.
 */

import {
  classifyReply, approveAndExecuteIntent, solePendingMailIntent, type MailExecutionResult, gmailTransport,
  type CurrentUser,
} from "@/lib/assistant/coeur/erp";
import { extraireFaits, resumerFait } from "@/platform/in-process/fabric/provenance";
import type { WorkspaceComposition } from "@/platform/ia/workspace/protocol";
import { persistActionIntents } from "@/platform/ia/intentions/action-intents";
import { gesteDuTour, isoJour, LIBELLE_GRAVITE } from "@/platform/in-process/intelligence";
import { lireSignauxDeSortie } from "@/lib/assistant/intelligence-tools";
import { sansBloquer } from "@/lib/journal";
import type { ProposedAction, AssistantResult } from "@/lib/assistant/coeur/contrat-actions";
import { buildProposal } from "@/lib/assistant/propositions/construire";

/** Événements poussés au navigateur pendant que l'assistant travaille. */
export type AssistantStreamEvent =
  | { type: "trace"; label: string }
  | { type: "delta"; text: string }
  /** Le texte déjà affiché n'était qu'un préambule à un appel d'outil : le client l'efface. */
  | { type: "reset" }
  /** Une SOURCE consultée (lien interne) — alimente le panneau CONTEXTE du Chief of Staff. */
  | { type: "source"; label: string; href: string; detail?: string }
  /**
   * L'ESPACE DE TRAVAIL — des blocs TYPÉS construits à partir d'une source canonique.
   *
   * Le modèle n'en est pas l'auteur : le serveur traduit la sortie exacte d'un outil. C'est ce
   * qui distingue cet affichage du vidage de JSON qui a un jour montré six lignes de salaire
   * en réponse à « Bonsoir, ça va ? ».
   */
  | { type: "workspace"; composition: WorkspaceComposition }
  | { type: "done"; result: AssistantResult };

/**
 * Extrait les LIENS INTERNES d'un résultat d'outil, avec un libellé lisible — la matière du
 * panneau CONTEXTE (« Sources ») : chaque dossier consulté devient un lien cliquable, sans que
 * l'utilisateur ait à refaire la recherche. Parcours superficiel et borné : un résultat d'outil
 * est petit, mais on ne parie jamais dessus.
 */
export function extractSources(raw: string): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const seen = new Set<string>();
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return out; }

  const labelOf = (o: Record<string, unknown>): string => {
    for (const k of ["reference", "nom", "titre", "objet", "rappel", "fichier", "dossier", "type", "famille"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 60);
    }
    return "Source";
  };

  const walk = (node: unknown, depth: number): void => {
    if (out.length >= 8 || depth > 3 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 30)) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const lien = o.lien;
    if (typeof lien === "string" && lien.startsWith("/") && !seen.has(lien)) {
      seen.add(lien);
      out.push({ label: labelOf(o), href: lien });
    }
    if (Array.isArray(o.liens)) {
      for (const l of o.liens) {
        if (typeof l === "string" && l.startsWith("/") && !seen.has(l)) {
          seen.add(l);
          out.push({ label: labelOf(o), href: l });
        }
      }
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/**
 * ── LE PROCHAIN GESTE, DÉCIDÉ PAR LE CODE (§118.126) ───────────────────────────────────────
 *
 * LE DÉFAUT MESURÉ. « Qu'est-ce qui bloque ? » rendait six blocages nommés, sourcés, liés à
 * leurs fiches — et ZÉRO proposition, trois passages sur trois. La trace disait pourquoi :
 * aucun outil d'écriture n'était même APPELÉ (§118.125). Trois niveaux de pression de prompt
 * n'y ont rien changé. Un constat critique qui ne propose rien est un tableau de bord, et
 * c'est exactement ce que le dirigeant décrit par « je ne ressens aucune différence ». Le
 * geste est donc une propriété du LOGICIEL : les modèles décident QUOI, le code décide COMMENT.
 *
 * UNE SEULE FONCTION POUR LES DEUX CHEMINS. Le tour en flux et le tour d'un trait rendent la
 * même conversation ; deux copies de cette règle divergeraient au premier réglage, et c'est la
 * voix — qui passe par le chemin sans flux — qui aurait perdu le geste (§118.5, §118.71 : une
 * porte gardée à côté d'une porte ouverte).
 *
 * CE QU'ELLE NE FAIT PAS. Elle ne double jamais une carte du modèle (ses deux appelants ne
 * l'atteignent que si AUCUNE écriture n'a été demandée), elle n'en produit qu'UNE (§118.32),
 * elle ne lit que ce que le signal DÉCLARE (`gesteDuTour` — jamais la prose, §118.125), et
 * elle ne FAIT rien : une tâche INSCRIT le pas suivant, elle ne l'exécute pas. C'est ce qui la
 * rend compatible avec « relancer le partenaire — jamais automatiquement », et c'est le remède
 * que §118.57a nomme — une promesse qui ne vit que dans une phrase meurt avec le tour.
 *
 * ET ELLE PASSE PAR LA MÊME PORTE QUE LE MODÈLE : `buildProposal` puis un intent persisté —
 * donc les mêmes gardes, la même résolution de cible, le même audit. Écrire une carte à la
 * main ici en ferait une seconde vérité, et c'est celle-ci qui prendrait du retard au premier
 * contrôle ajouté (§118.5). Elle ne lève jamais : un geste manqué coûte une proposition, une
 * exception coûterait la RÉPONSE, que le modèle a déjà produite.
 */
export async function carteDuProchainGeste(
  lectures: readonly { outil: string; sortie: string }[],
  user: CurrentUser,
  // L'ORIGINE EST LE TYPE EXACT, jamais `string` : c'est la porte par laquelle le geste a été
  // proposé, et elle est lue par la reprise d'intention. L'élargir aurait annulé le typecheck
  // au point d'appel (§118.71) et laissé passer une origine qu'aucun écran ne sait relire.
  origin: Parameters<typeof persistActionIntents>[2],
): Promise<ProposedAction[] | null> {
  // AUCUN FILTRE PAR NOM D'OUTIL. Le marqueur `tache` est posé à la SOURCE du signal, là où vit
  // le savoir métier ; c'est LUI le fait (§118.17), pas une liste de trois noms qui serait fausse
  // au quatrième outil d'intelligence, en silence (§118.73) — et qui fermerait la porte d'à côté
  // à un outil remontant LE MÊME constat (§118.71). `lireSignauxDeSortie` refuse déjà toute sortie
  // qui n'est pas de cette forme : mesuré, les alertes exécutives (`ExecutiveAlert`, qui porte
  // `criticite` et non `gravite`) en sont exclues sans qu'on ait à les nommer.
  const geste = gesteDuTour(lectures.flatMap((l) => lireSignauxDeSortie(l.sortie)), isoJour(new Date()));
  if (!geste) return null;
  const brouillon = await buildProposal("create_task", {
    title: geste.intitule,
    description: geste.pourquoi,
    ...(geste.echeance ? { dueDate: geste.echeance } : {}),
  }, user).catch(sansBloquer("assistant.carteDuProchainGeste.buildProposal", { error: "carte du geste indisponible" }));
  if ("error" in brouillon) return null;
  // LA CARTE DIT D'OÙ ELLE VIENT. Sans cela, une tâche apparaît sans que la personne sache quel
  // constat l'a produite — et « c'est fait » redevient une parole à croire (§104.16).
  brouillon.warnings.push(`Proposé depuis le signal « ${geste.code} » (${LIBELLE_GRAVITE[geste.gravite]}) relevé dans cette réponse — rien n'est créé avant votre confirmation.`);
  const ids = await persistActionIntents(user.id, [brouillon], origin).catch(sansBloquer("assistant.carteDuProchainGeste.persistActionIntents", []));
  if (ids[0]) brouillon.intentId = ids[0];
  return [brouillon];
}

/**
 * LES SOURCES D'UN RÉSULTAT, AVEC LEUR DÉTAIL DE PROVENANCE (F8) : la même marche que
 * `extractSources` (liens internes seulement), enrichie par la fabric — famille, date propre,
 * fraîcheur, confiance — pour que le panneau « Sources consultées » dise d'où ET de quand.
 */
export function sourcesDuResultat(outil: string, out: string, acteur: string): { label: string; href: string; detail?: string }[] {
  const faits = extraireFaits(outil, out, { acteur });
  return extractSources(out).map((s) => {
    const f = faits.find((x) => x.href === s.href);
    return f ? { ...s, detail: resumerFait(f) } : s;
  });
}

/**
 * VARIANTE STREAMING de `runAssistant` — même boucle agent, même garde-fous, mais la réponse
 * est poussée **au fil de sa génération** au lieu d'arriver en un bloc.
 *
 * Ce que voit l'utilisateur, dans l'ordre réel des événements :
 *   • `trace` — « je consulte vos validations… » dès qu'un outil de lecture est exécuté ;
 *   • `delta` — le texte, mot à mot, tel que le modèle l'écrit ;
 *   • `done`  — le résultat complet (réponse, trace, proposition d'action à confirmer).
 *
 * Les garanties de `runAssistant` sont inchangées : une action d'écriture est TOUJOURS
 * interceptée et proposée, jamais exécutée. Ne lève jamais.
 */
/**
 * « VAS-Y, ENVOIE. » → LE MESSAGE PART. Pas une carte de plus.
 *
 * LE BOGUE QUE CETTE FONCTION FERME — et il a eu deux vies. D'abord, « je confirme » repartait
 * dans le modèle comme une demande ordinaire, qui préparait un SECOND message. Corrigé, la
 * confirmation rendait alors la carte de l'intention exacte… que le PDG devait encore cliquer.
 * Mieux, mais toujours faux : on lui demandait de confirmer par un geste ce qu'il venait
 * d'approuver par une phrase. Une carte n'est pas l'autorisation, c'est sa REPRÉSENTATION.
 *
 * Le serveur exécute donc directement, par la MÊME fonction que le bouton de la carte.
 *
 * TROIS CONDITIONS, ET LES TROIS SONT DES GARDE-FOUS :
 *   • la phrase est un accord SANS RÉSERVE (`classifyReply`, volontairement strict — « oui mais
 *     change l'objet » n'en est pas un) ;
 *   • il n'y a qu'UNE SEULE intention en attente : deux, et « oui » redevient ambigu ;
 *   • elle est RÉCENTE — un accord ne rattrape pas un message oublié depuis des heures.
 *
 * Hors de ces conditions, on ne fait rien : la conversation suit son cours normal.
 */
export async function resolveSpokenMailApproval(
  user: CurrentUser,
  lastUserMessage: string,
): Promise<MailExecutionResult | null> {
  if (classifyReply(lastUserMessage) !== "CONFIRM") return null;
  const pending = await solePendingMailIntent(user.id);
  if (!pending) return null;
  return approveAndExecuteIntent(user, pending.id, gmailTransport);
}
