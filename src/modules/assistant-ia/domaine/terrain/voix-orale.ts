/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE CARTE DEVIENT UNE CONVERSATION (lot K4, décision 0035) — les RÈGLES de la voix orale, zéro import.
 *
 * Direction, 31/10/2026 : « En appel vocal, l'expérience doit être ORALE. Pour une action, il me RÉSUME la demande de façon
 * fluide, pas comme un robot. Il me propose les cases non obligatoires […] Puis : "Tu confirmes ?". Je peux confirmer à
 * l'oral. »
 *
 * Les étapes d'une carte à l'oral, dans cet ordre :
 *   1. MANQUANTS — un champ obligatoire vide : UNE question, la première.
 *   2. FACULTATIFS — les cases non obligatoires encore vides, proposées en une phrase (« un budget ? autre chose ? »).
 *   3. QUESTION — la demande RÉCITÉE, puis « Tu confirmes ? ». La confirmation n'est entendue qu'à cette étape.
 * Une correction dite (« mets plutôt 200 000 ») repasse par la porte de la correction écrite, puis on revient au récit.
 *
 * Ce qui est jugé ici l'est sur les MOTS DE LA PERSONNE (sa transcription, jamais la reformulation du modèle vocal) :
 * un « oui » explicite (français parlé ou darja : « vas-y », « go », « ih dirha », « ايه »), un « non », « rien à ajouter ».
 * K9 (décision 0039, Direction : « pas de mot imposé ») : pour une carte renforcée, c'est la VOIX qui RELIT l'élément clé
 * (le montant, le verbe) dans le récit ; un simple oui suffit ensuite — le serveur fournit la ressaisie stockée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ChampOral { label: string; value: string }

export interface CarteOrale {
  titre: string;
  champs: ChampOral[];
  /** Les cases non obligatoires encore vides, par leur libellé (au plus quelques-unes, les plus utiles d'abord). */
  facultatifs: string[];
  /** Les champs obligatoires encore vides (une carte préparée n'en a normalement aucun). */
  manquants: string[];
  /** Carte renforcée (R3/R4) : l'élément que la VOIX RELIT avant la question — le montant, ou le verbe de l'action (K9). */
  elementCle: string | null;
  avertissements?: string[];
}

export type EtapeOrale = "MANQUANTS" | "FACULTATIFS" | "QUESTION";

/** L'étape d'une carte : ce qui manque d'abord, puis les facultatifs (une fois), puis la question de confirmation. */
export function etapeOrale(c: CarteOrale, facultatifsProposes: boolean): EtapeOrale {
  if (c.manquants.length) return "MANQUANTS";
  if (!facultatifsProposes && c.facultatifs.length) return "FACULTATIFS";
  return "QUESTION";
}

const BRUT = /^(—|-|null|undefined|\[\]|\{\})$/;
/** Un identifiant technique (cuid, uuid) ne se dit pas : la personne ne le reconnaîtrait pas. */
const IDENTIFIANT = /^(c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-|[A-Za-z0-9_-]{24,}$)/;

/** La matière du récit : les champs DITS (sans identifiant technique ni valeur vide), en phrases courtes, pas une liste. */
export function recitDeCarte(c: CarteOrale): string {
  const dits = c.champs.filter((ch) => ch.value && !BRUT.test(ch.value.trim()) && !IDENTIFIANT.test(ch.value.trim())).slice(0, 7);
  const morceaux = dits.map((ch) => `${ch.label.toLowerCase()} ${ch.value}`);
  const corps = morceaux.length ? ` : ${morceaux.join(", ")}` : "";
  return `${c.titre}${corps}.`;
}

/**
 * CE QUE LA VOIX REÇOIT à chaque étape — la matière ET la manière : un résumé à dire avec ses mots, une seule question.
 * Jamais une liste de champs à lire.
 */
export function texteOral(c: CarteOrale, etape: EtapeOrale): string {
  const recit = recitDeCarte(c);
  const ton = "Dis-le avec tes mots, naturellement, en une ou deux phrases courtes — ne lis pas une liste de champs.";
  if (etape === "MANQUANTS") {
    return `Une demande est en préparation (${recit}) ${ton} Il manque « ${c.manquants[0]} » : pose UNE seule question pour l'obtenir.`;
  }
  if (etape === "FACULTATIFS") {
    const q = c.facultatifs.slice(0, 3).map((f) => `« ${f} »`).join(", ");
    return `J'ai préparé la demande — ${recit} ${ton} Puis propose, en une seule question légère, de préciser ce qui n'est pas obligatoire (${q}) ou autre chose à ajouter. Ne demande PAS encore de confirmer.`;
  }
  const cle = c.elementCle
    ? ` C'est une action renforcée : RELIS clairement « ${c.elementCle} » (« je relis : ${c.elementCle} »), puis termine par « Tu confirmes ? » — un simple oui suffit, aucun mot imposé.`
    : " Termine par « Tu confirmes ? ».";
  const attention = c.avertissements?.length ? ` Mentionne en passant : ${c.avertissements[0]}` : "";
  return `Récapitule la demande pour la faire confirmer — ${recit} ${ton}${attention}${cle} Rien n'est fait tant qu'elle n'a pas dit oui.`;
}

/** Les mots de la personne, ramenés à l'essentiel : minuscules, sans accents ni ponctuation. */
export function normaliserParole(parole: string): string {
  // L'arabe (darja écrite en lettres arabes par la transcription) est gardé : « ايه ديرها » est un accord.
  return (parole ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ").replace(/[^a-z0-9\u0621-\u064a\s]/g, " ").replace(/\s+/g, " ").trim();
}

// K9 : le français parlé (« ok fais-le », « pas de souci ») et la darja, en lettres latines ou arabes.
const OUI = /^(?:(?:oui|ouais|ouai|yes|yep|ok|okay|okey|d accord|daccord|dacc|parfait|nickel|impeccable|c est bon|c est ok|go|vas y|allez y|allez|bien sur|exactement|absolument|tout a fait|banco|carrement|ih|iih|iyeh|wah|wakha|ewa|yallah|yalla|zid|dir|dirha|sahit|mlih|safi dirha)\b|(?:je )?confirm|valide|envoie|lance|fais le|fais la|c est parti|(?:ايه|إيه|واه|واخا|يالله|يلا|ديرها|زيد|صحيت|مليح|اوكي)(?:\s|$))/;
const NEGATION = /\b(?:non|pas|attends?|attendez|annule|annuler|stop|arrete|change|changer|modifie|modifier|corrige|plutot|sauf|mais|ne|lala|machi|mazal)\b|(?:^|\s)(?:لا|ماشي|مازال|خليها)(?:\s|$)/;
const NON = /^(?:(?:non|nan|annule|annuler|laisse tomber|laisse|stop|arrete|pas maintenant|surtout pas|n envoie pas|ne fais rien|on oublie|lala|machi|khaliha|blach)\b|(?:لا|ماشي|خليها|بلاش)(?:\s|$))/;
const RIEN = /^(?:non|nan|rien|c est tout|ca ira|ca va|pas besoin|non merci|c est bon comme ca|ca suffit|rien d autre|rien de plus|non rien|aucun|aucune|pas pour l instant)\b/;

/** Un « oui » EXPLICITE et sans réserve (« oui, je confirme » ; pas « oui mais change la date »). */
export function estOuiExplicite(parole: string): boolean {
  // « Pas de souci », « sans problème » : des accords, malgré le « pas ».
  const t = normaliserParole(parole).replace(/^(?:pas de (?:souci|soucis|probleme)|sans probleme|aucun probleme)\b/, "ok");
  if (!t || t.split(" ").length > 14) return false;
  return OUI.test(t) && !NEGATION.test(t);
}

/** Un refus net à la question de confirmation (« non », « annule », « laisse tomber »). */
export function estNonExplicite(parole: string): boolean {
  const t = normaliserParole(parole);
  return !!t && t.split(" ").length <= 8 && NON.test(t) && !/\b(?:mais|plutot|change|mets|met)\b/.test(t);
}

/** « Rien à ajouter » à la proposition des facultatifs (« non, c'est tout »). */
export function estRienAAjouter(parole: string): boolean {
  const t = normaliserParole(parole);
  return !!t && t.split(" ").length <= 8 && RIEN.test(t) && !/\b(?:mais|plutot|mets|met|ajoute|budget|date)\b/.test(t);
}
