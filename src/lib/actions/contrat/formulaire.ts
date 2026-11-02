/**
 * LE FORMULAIRE D'UNE ACTION — à quel rang il arrive, sous quels noms (alias compris), et à quelles
 * fonctions du MÊME fichier l'action le passe (délégation d'un niveau).
 *
 * Morceau de `actions/contrat.ts`. Pur, sans import hors du dossier.
 */
import { sansCommentaires } from "./decoupage";
import type { SourceAction } from "./types";

/**
 * À QUELLES FONCTIONS DU FICHIER CETTE ACTION PASSE-T-ELLE SON FORMULAIRE ? Toutes, pas la
 * première — et c'est une correction, pas un raffinement.
 *
 * `updateLegalDocument` lit `id` chez elle PUIS appelle `readFields(formData)`, qui lit le titre,
 * la nature, les dates et huit autres champs. Une première version ne suivait la délégation que
 * lorsque le corps ne lisait RIEN : l'action sortait donc « lisible » avec UN SEUL champ. Le
 * résultat n'est pas un manque, c'est un piège : `validerEntree` refuse tout champ hors contrat,
 * donc Adam ne pouvait NI passer le titre NI réussir sans lui — une action décrite et
 * inappelable, le « je ne peux pas » né d'une incohérence interne (§118.83), et une liste de
 * champs plausible mais fausse (§118.26).
 *
 * Le formulaire est le MÊME objet des deux côtés : l'union des clés lues est donc la vérité, et
 * elle ne peut qu'être plus complète. Un seul niveau, dans le seul fichier dont on a le texte.
 */
export function deleguesDuCorps(
  corps: string,
  formulaires: readonly string[],
  locales: Readonly<Record<string, SourceAction>>,
  /** Les LECTEURS du fichier (`num(fd, "k")`) : ce ne sont pas des délégations. */
  lecteurs: ReadonlySet<string>,
): SourceAction[] {
  if (formulaires.length === 0) return [];
  const ech = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fd = formulaires.map(ech).join("|");
  // Le formulaire peut arriver à N'IMPORTE QUEL rang (`readParties(user.id, formData)`) :
  // exiger le premier faisait manquer la moitié des délégations.
  const re = new RegExp(`(?<![.\\w$])([A-Za-z0-9_]+)\\s*\\(([^()]*)\\)`, "g");
  const formulaire = new RegExp(`(?<![.\\w$])(?:${fd})(?![\\w$])`);
  const out: SourceAction[] = [];
  for (const m of sansCommentaires(corps).matchAll(re)) {
    if (!formulaire.test(m[2]!)) continue;
    // UN LECTEUR N'EST PAS UN DÉLÉGUÉ, et les confondre a coûté 31 actions d'un coup :
    // `num(fd: FormData, key: string)` reçoit bien le formulaire, mais sa clé EST son
    // paramètre — c'est ce qui en fait un lecteur. Le suivre comme une délégation faisait
    // voir une « lecture calculée » dans le corps d'un helper parfaitement ordinaire, et sept
    // actions de `market-research-actions` devenaient illisibles pour cette seule raison.
    if (lecteurs.has(m[1]!)) continue;
    const cible = locales[m[1]!];
    // Une fonction qui s'appelle elle-même ne dit rien de plus, et la suivre boucle.
    if (cible && cible.corps !== corps && !out.includes(cible)) out.push(cible);
  }
  return out;
}

/**
 * À QUEL RANG L'ACTION REÇOIT-ELLE SON FORMULAIRE ?
 *
 * `null` quand elle n'en prend pas, ou quand il arrive APRÈS un argument qu'on ne saurait pas
 * fournir — deux actions de l'ERP prennent `(id, prev, formData)`, et deviner leur premier
 * argument reviendrait à choisir la cible à la place d'un humain. On le DIT au lieu de tenter.
 */
/**
 * LE NOM SOUS LEQUEL LE FORMULAIRE ARRIVE — et ses alias directs.
 *
 * Sans lui, le détecteur de lecture dynamique s'armait sur `.get|.getAll|.has` SANS REGARDER
 * LE RÉCEPTEUR, donc sur n'importe quel `.has(variable)` du corps. Mesuré : 19 des 27 actions
 * déclarées « noms de champs calculés à l'exécution » ne l'étaient pas du tout — leurs `.has`
 * portaient sur des ENSEMBLES (`PROJECT_TEXT.has(field)`, `CREATOR_DELETABLE.has(kind)`),
 * c'est-à-dire des tests d'appartenance sans le moindre rapport avec un formulaire. Une garde
 * armée sur une forme qui ignore son récepteur refuse ce qu'elle n'a pas regardé.
 *
 * Les ALIAS comptent : `const fd = formData` est du même objet, et fermer les yeux dessus
 * ferait déclarer COMPLÈTE une liste de champs qui ne l'est pas — le sens dangereux de
 * l'erreur, car un champ manquant peut être celui qui AIGUILLE l'écriture (`kind === "project"`
 * choisit la table). On ne suit pas une déstructuration ni un passage par argument : ce qu'on
 * ne relie pas au formulaire à coup sûr ne déclenche rien, et c'est la limite ASSUMÉE de ce
 * lecteur — elle est ici pour qu'on la lise avant de s'y fier.
 */
export function nomsDuFormulaire(signature: string, corps: string): string[] {
  const rang = rangDuFormulaire(signature);
  if (rang === null) return [];
  const params: string[] = [];
  let prof = 0, cur = "";
  for (const c of signature) {
    if ("<([{".includes(c)) prof++;
    else if (">)]}".includes(c)) prof--;
    if (c === "," && prof === 0) { params.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) params.push(cur);
  const nom = /(\w+)\s*:/.exec(params[rang] ?? "")?.[1];
  if (!nom) return [];
  const noms = new Set([nom]);
  // Les alias DIRECTS, autant de fois qu'il en faut (`const a = formData; const b = a;`).
  for (let i = 0; i < 3; i++) {
    for (const m of corps.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*;/g)) {
      if (noms.has(m[2]!)) noms.add(m[1]!);
    }
  }
  return [...noms];
}

/**
 * À QUEL RANG L'ACTION REÇOIT-ELLE SON FORMULAIRE ? `null` si elle n'en prend pas.
 *
 * Mesuré sur le parc : 100 actions au rang 1 — TOUTES avec l'état précédent de `useActionState`
 * juste avant — et 2 au rang 2, `(id: string, _prev: ActionResult | undefined, formData)`. Le
 * rang n'est donc pas une borne arbitraire : c'est la convention React, et le paramètre qui
 * précède immédiatement le formulaire est TOUJOURS l'état précédent.
 */
export function rangDuFormulaire(signature: string): number | null {
  if (!/FormData/.test(signature)) return null;
  const params: string[] = [];
  let profondeur = 0, courant = "";
  for (const c of signature) {
    if ("<([{".includes(c)) profondeur++;
    else if (">)]}".includes(c)) profondeur--;
    if (c === "," && profondeur === 0) { params.push(courant); courant = ""; continue; }
    courant += c;
  }
  if (courant.trim()) params.push(courant);
  const rang = params.findIndex((p) => /FormData/.test(p));
  return rang >= 0 ? rang : null;
}
