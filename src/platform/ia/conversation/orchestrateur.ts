/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORCHESTRATEUR DE CONVERSATION (lot O1, décision 0046) — UNE machine à états, pure, commune à l'ORAL et à l'ÉCRIT.
 * Zéro import : le navigateur (client GPT-Live, écran du fil) et le serveur la partagent.
 *
 * Direction : « des fois l'autre a fini, donc il me répond directement, il n'entend même pas ma question » ; « l'autre
 * n'a pas fini, il me pose une question, je réponds, il me dit ok et il ATTEND » ; « tant que l'autre n'a pas fini, on
 * continue à avoir une discussion, vraiment UTILE ». Donc :
 *
 *   • QUATRE ÉTATS DE DIALOGUE : la personne parle / l'assistant parle / une QUESTION de l'assistant attend sa réponse /
 *     libre. Une réponse de la personne en route vers le serveur (« prise en compte » pas encore rendue) compte comme
 *     la personne : on ne parle pas par-dessus.
 *   • Un résultat de travail qui arrive hors de « libre » est MIS EN ATTENTE (file d'annonces), puis livré au prochain
 *     POINT DE RUPTURE NATUREL — de préférence COLLÉ à l'accusé de la réponse de la personne : « Noté, PDF. Et
 *     justement, la recherche vient de finir : … ». Jamais une annonce qui écrase une question posée.
 *   • Une réponse qui CHANGE le travail (format, périmètre) rend son résultat en attente CADUC : il n'est pas dit ; on
 *     suit le travail ajusté, dont le résultat tient compte de la réponse.
 *   • Libre, sans annonce : l'AGENDA du travail (construit par le serveur, déterministe) — partiels d'abord, puis UNE
 *     précision qui change le résultat, puis une étape suivante à décider ; agenda vide : l'avancement réel, dit UNE
 *     fois, puis rien (la voix ne meuble pas). Jamais « ok, j'attends » : après chaque réponse, on enchaîne.
 *   • Plusieurs travaux : chacun son agenda ; les annonces dans l'ordre d'arrivée ; une seule prise de parole de
 *     l'orchestrateur à la fois (jamais deux annonces collées) ; la personne d'abord.
 *
 * Tout est DÉTERMINISTE : aucun appel de modèle ne décide s'il faut parler. Les horloges sont passées en argument.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureElement = "partiel" | "precision" | "suite";

/** Un élément d'agenda — une question qui change le résultat, un résultat partiel, une étape suivante à décider. */
export interface ElementAgenda {
  id: string;
  travail: string;
  nature: NatureElement;
  /** La question (ou l'information partielle), telle que la voix / le fil la dit. */
  texte: string;
  choix?: string[];
}

/**
 * CE QUE LE SERVEUR REND À L'ORCHESTRATEUR avec l'accusé d'une parole (la délégation vocale) — lu par le navigateur
 * pour enchaîner sans couper ni attendre.
 */
export interface RetourOrchestre {
  /** Ce que la voix va dire POSE une question (carte orale, « laquelle ? ») : rien ne s'y colle. */
  questionPosee?: boolean;
  /** C'était la réponse à cet élément d'agenda. */
  repondA?: string;
  /** Précision MAJEURE : le résultat en attente de ce travail est caduc ; `nouveau` : le travail ajusté qu'on suit. */
  change?: { travail: string; nouveau?: string };
  /** Un travail est né : son agenda, dérivé de la demande. */
  lance?: { id: string; agenda: ElementAgenda[] };
  /** Précision MINEURE de texte sur un résultat déjà là (tenu) : il est dit ainsi, sans relance. */
  miseEnForme?: { travail: string; consigne: string };
}

export interface Annonce {
  travail: string;
  nature: "resultat" | "echec";
  contenu: string;
  arriveeMs: number;
  /** La délégation sous laquelle la dire (oral) — celle du travail. */
  delegationId?: string | null;
  /** Une annonce qui n'est pas un résultat de travail (une pièce reçue) : dite telle quelle. */
  brut?: boolean;
}

export interface TravailSuivi {
  id: string;
  lanceMs: number;
  /** `en_cours` ; `ajuste` (une réponse l'a changé : on attend la version à jour) ; `fini` (son résultat est dit). */
  etat: "en_cours" | "ajuste" | "fini";
  agenda: ElementAgenda[];
  /** La dernière phrase d'avancement RÉELLE (étapes faites, durée estimée) — rendue par le serveur. */
  avancement: string | null;
  avancementDit: boolean;
  delegationId?: string | null;
}

export interface QuestionEnAttente {
  /** L'élément d'agenda posé, s'il en vient un (sinon : une question de l'assistant lui-même — « tu confirmes ? »). */
  element: string | null;
  travail: string | null;
  poseeMs: number;
}

export interface EtatConversation {
  /** Qui parle — et quand on l'a entendu pour la dernière fois (horloge murale, ms). */
  parole: "personne" | "assistant" | null;
  paroleMs: number;
  question: QuestionEnAttente | null;
  /** La personne a parlé ; sa demande est partie au serveur et n'est pas encore prise en compte. */
  reponseEnRoute: boolean;
  /** L'accusé rendu par le serveur pour la dernière parole de la personne — dit en premier. */
  accuse: { contenu: string; delegationId: string | null; questionPosee: boolean; element: string | null } | null;
  travaux: TravailSuivi[];
  annonces: Annonce[];
  /** L'orchestrateur a fait parler la voix et elle n'a pas encore commencé (pas de deuxième prise collée). */
  enVolMs: number | null;
  /** Une question restée sans réponse : l'agenda se tait jusqu'à ce que la personne reparle. */
  agendaSuspendu: boolean;
  /** Ce qui a été dit (journal du banc : 0 annonce qui coupe une question, 0 « j'attends »). */
  journal: Action[];
}

export type Evenement =
  | { type: "personne_parle"; ms: number }
  | { type: "assistant_parle"; ms: number }
  /** Une réplique complète de l'assistant (transcription de sortie regroupée) — finie par « ? », c'est une question. */
  | { type: "replique_assistant"; ms: number; texte: string }
  /** La parole de la personne part au serveur (délégation, message écrit). */
  | { type: "reponse_envoyee"; ms: number }
  /**
   * Le serveur a pris en compte ce que la personne a dit. `accuse` : ce que la voix en dit (« Noté, PDF ») ;
   * `questionPosee` : l'accusé POSE lui-même une question (carte orale, « laquelle ? ») — rien ne s'y colle ;
   * `repondA` : l'élément d'agenda auquel c'était la réponse ; `change` : la réponse a changé ce travail (son résultat
   * en attente est caduc ; `nouveau` : l'identifiant du travail ajusté, s'il en a changé) — une précision MAJEURE ;
   * `miseEnForme` : une précision MINEURE sur un résultat déjà là — il n'est PAS caduc, il sera dit ainsi ; `lance` : un
   * travail né.
   */
  | {
    type: "reponse_prise_en_compte"; ms: number; accuse: string; delegationId?: string | null; questionPosee?: boolean;
    element?: ElementAgenda | null; repondA?: string | null; change?: { travail: string; nouveau?: string } | null;
    miseEnForme?: { travail: string; consigne: string } | null;
    lance?: { id: string; agenda?: ElementAgenda[]; avancement?: string | null } | null; silencieux?: boolean;
  }
  | { type: "agenda"; travail: string; elements: ElementAgenda[] }
  /** Un travail né hors d'une réponse de la personne (la mise en forme d'un résultat, par exemple) : il est suivi. */
  | { type: "travail"; ms: number; id: string; agenda?: ElementAgenda[]; delegationId?: string | null }
  | { type: "avancement"; travail: string; texte: string }
  | { type: "resultat"; ms: number; travail: string; contenu: string; echec?: boolean; brut?: boolean }
  | { type: "remplace"; ancien: string; nouveau: string }
  /** L'action rendue par `decider` a été envoyée à la voix (ou affichée). */
  | { type: "dit"; ms: number; action: Action };

export type Action =
  | { type: "rien"; raison: RaisonSilence }
  /** Dire, en UNE prise de parole : l'accusé (s'il y en a un), puis UN seul élément. */
  | { type: "dire"; contenu: string; delegationId: string | null; accuse: boolean; annonce: Annonce | null; element: ElementAgenda | null; avancement: string | null; travail: string | null };

export type RaisonSilence =
  | "la personne parle" | "l'assistant parle" | "réponse de la personne en route" | "question en attente"
  | "prise de parole en vol" | "disponible";

export const REGLAGES = {
  /** Sans fragment de transcription depuis ce temps, la parole est finie (GPT-Live n'a pas d'événement de fin de tour). */
  silenceMs: 900,
  /** Une question sans réponse depuis ce temps n'est plus « en attente » : une annonce peut passer. */
  questionExpireMs: 20_000,
  /** Une prise de parole envoyée et jamais entendue (voix muette, réseau) ne bloque pas plus longtemps. */
  enVolMaxMs: 6_000,
} as const;

export function etatInitial(): EtatConversation {
  return { parole: null, paroleMs: 0, question: null, reponseEnRoute: false, accuse: null, travaux: [], annonces: [], enVolMs: null, agendaSuspendu: false, journal: [] };
}

/** Une phrase qui finit par une question (« … Excel ou PDF ? »). */
export const estQuestion = (texte: string): boolean => /\?\s*[»"')\]]*\s*$/.test(texte.trim());

/** Les tournures interdites : « j'attends », « je te préviendrai quand l'autre aura fini » — le silence qui bloque. */
export const ATTENTE_BLOQUANTE = /\b(j'attends|je patiente|j'attends que|je te pr[ée]viendrai quand (l'autre|ce sera|ça sera)|on attend que)\b/i;

function travailDe(e: EtatConversation, id: string): TravailSuivi | undefined {
  return e.travaux.find((t) => t.id === id);
}

function majTravail(e: EtatConversation, id: string, f: (t: TravailSuivi) => TravailSuivi): EtatConversation {
  return { ...e, travaux: e.travaux.map((t) => (t.id === id ? f(t) : t)) };
}

function retirerElement(e: EtatConversation, elementId: string | null | undefined): EtatConversation {
  if (!elementId) return e;
  return { ...e, travaux: e.travaux.map((t) => ({ ...t, agenda: t.agenda.filter((x) => x.id !== elementId) })) };
}

/** LA TRANSITION — pure : un événement, un nouvel état. */
export function transition(e: EtatConversation, ev: Evenement): EtatConversation {
  switch (ev.type) {
    case "personne_parle": {
      // Elle parle : l'agenda se rouvre (une question sans réponse l'avait suspendu).
      return { ...e, parole: "personne", paroleMs: ev.ms, agendaSuspendu: false };
    }
    case "assistant_parle":
      return { ...e, parole: "assistant", paroleMs: ev.ms, enVolMs: null };
    case "replique_assistant": {
      if (!estQuestion(ev.texte)) return e;
      // Une question de l'assistant attend réponse. Si l'orchestrateur venait d'en poser une, c'est elle.
      const derniere = [...e.journal].reverse().find((a): a is Extract<Action, { type: "dire" }> => a.type === "dire");
      const element = derniere?.element && derniere.element.nature !== "partiel" && !e.question ? derniere.element : null;
      if (e.question) return { ...e, question: { ...e.question, poseeMs: ev.ms } };
      return { ...e, question: { element: element?.id ?? null, travail: element?.travail ?? null, poseeMs: ev.ms } };
    }
    case "reponse_envoyee":
      // La délégation dit que la personne a fini sa phrase : son tour de parole est clos (elle peut reparler).
      return { ...e, reponseEnRoute: true, parole: null };
    case "reponse_prise_en_compte": {
      let s: EtatConversation = { ...e, reponseEnRoute: false };
      // La question à laquelle elle a répondu est levée (et son élément retiré de l'agenda).
      const repondA = ev.repondA ?? s.question?.element ?? null;
      s = retirerElement({ ...s, question: null }, repondA);
      if (ev.change) {
        // CADUC : le résultat tenu de ce travail ne sera pas dit — la version ajustée tiendra compte de la réponse.
        const ancien = ev.change.travail;
        const nouveau = ev.change.nouveau ?? ancien;
        s = { ...s, annonces: s.annonces.filter((a) => a.travail !== ancien) };
        // Le résultat ajusté se dira sous la DERNIÈRE délégation qui concerne ce travail (K9).
        s = majTravail(s, ancien, (t) => ({ ...t, id: nouveau, etat: "ajuste", avancementDit: false, delegationId: ev.delegationId ?? t.delegationId, agenda: t.agenda.map((x) => ({ ...x, travail: nouveau })) }));
      }
      if (ev.miseEnForme) {
        // MINEURE : le résultat tenu reste valable — il sera dit en tenant compte de la forme demandée.
        const m = ev.miseEnForme;
        s = { ...s, annonces: s.annonces.map((a) => (a.travail === m.travail ? { ...a, contenu: `${a.contenu} (Dis-le en tenant compte de ce que la personne a demandé pour la forme : ${m.consigne})` } : a)) };
      }
      if (ev.lance && !travailDe(s, ev.lance.id)) {
        s = {
          ...s,
          travaux: [...s.travaux, {
            id: ev.lance.id, lanceMs: ev.ms, etat: "en_cours", agenda: ev.lance.agenda ?? [], avancement: ev.lance.avancement ?? null,
            avancementDit: false, delegationId: ev.delegationId ?? null,
          }],
        };
      }
      if (ev.lance && ev.delegationId) s = majTravail(s, ev.lance.id, (t) => ({ ...t, delegationId: ev.delegationId }));
      if (ev.silencieux) return s;
      return { ...s, accuse: { contenu: ev.accuse, delegationId: ev.delegationId ?? null, questionPosee: ev.questionPosee === true, element: ev.element?.id ?? null } };
    }
    case "travail":
      if (travailDe(e, ev.id)) return e;
      return { ...e, travaux: [...e.travaux, { id: ev.id, lanceMs: ev.ms, etat: "en_cours", agenda: ev.agenda ?? [], avancement: null, avancementDit: false, delegationId: ev.delegationId ?? null }] };
    case "agenda": {
      const t = travailDe(e, ev.travail);
      if (!t) return e;
      const connus = new Set(t.agenda.map((x) => x.id));
      const dits = new Set(e.journal.flatMap((a) => (a.type === "dire" && a.element ? [a.element.id] : [])));
      const neufs = ev.elements.filter((x) => !connus.has(x.id) && !dits.has(x.id));
      return neufs.length ? majTravail(e, ev.travail, (x) => ({ ...x, agenda: [...x.agenda, ...neufs] })) : e;
    }
    case "avancement":
      return majTravail(e, ev.travail, (t) => (t.avancement === ev.texte ? t : { ...t, avancement: ev.texte }));
    case "resultat": {
      const t = travailDe(e, ev.travail);
      // Un résultat d'un travail inconnu ou déjà dit (doublon de suivi) n'est pas dit deux fois.
      if (t?.etat === "fini" || e.annonces.some((a) => a.travail === ev.travail)) return e;
      const annonce: Annonce = { travail: ev.travail, nature: ev.echec ? "echec" : "resultat", contenu: ev.contenu, arriveeMs: ev.ms, delegationId: t?.delegationId ?? null, ...(ev.brut ? { brut: true } : {}) };
      // Ses précisions restantes tombent quand le résultat est DIT (`dit`) — pas avant : une réponse peut encore le rendre caduc.
      return { ...e, annonces: [...e.annonces, annonce] };
    }
    case "remplace": {
      if (!travailDe(e, ev.ancien)) return e;
      const s = majTravail(e, ev.ancien, (t) => ({ ...t, id: ev.nouveau, etat: "ajuste", agenda: t.agenda.map((x) => ({ ...x, travail: ev.nouveau })) }));
      return { ...s, annonces: s.annonces.filter((a) => a.travail !== ev.ancien) };
    }
    case "dit": {
      const a = ev.action;
      if (a.type !== "dire") return e;
      let s: EtatConversation = { ...e, enVolMs: ev.ms, journal: [...e.journal, a].slice(-50) };
      if (a.accuse) {
        // L'accusé est dit ; s'il posait une question, elle attend réponse dès maintenant.
        if (s.accuse?.questionPosee) s = { ...s, question: { element: s.accuse.element, travail: null, poseeMs: ev.ms } };
        s = { ...s, accuse: null };
      }
      if (a.annonce) {
        s = { ...s, annonces: s.annonces.filter((x) => x !== a.annonce && !(x.travail === a.annonce!.travail && x.arriveeMs === a.annonce!.arriveeMs)) };
        // Le travail est fini : ses précisions restantes ne serviraient plus à rien (jamais une question inutile).
        s = majTravail(s, a.annonce.travail, (t) => ({ ...t, etat: "fini", agenda: t.agenda.filter((y) => y.nature === "suite") }));
      }
      if (a.element) {
        s = retirerElement(s, a.element.id);
        // Une question posée attend sa réponse (l'écrit n'a pas de transcription : on la tient pour posée ici).
        if (a.element.nature !== "partiel") s = { ...s, question: { element: a.element.id, travail: a.element.travail, poseeMs: ev.ms } };
      }
      if (a.avancement && a.travail) s = majTravail(s, a.travail, (t) => ({ ...t, avancementDit: true }));
      return s;
    }
  }
}

/** La personne d'abord, puis un seul élément : l'ordre raisonné de ce qui peut suivre. */
function prochainElement(e: EtatConversation): { annonce: Annonce | null; element: ElementAgenda | null; avancement: { travail: string; texte: string } | null } {
  // 1. Un résultat (ou un échec) tenu — le plus ancien d'abord.
  const annonce = [...e.annonces].sort((a, b) => a.arriveeMs - b.arriveeMs)[0] ?? null;
  if (annonce) return { annonce, element: null, avancement: null };
  // Un travail dont le résultat est tenu n'a plus de question à poser (son résultat passe avant, ci-dessus).
  const tenus = new Set(e.annonces.map((a) => a.travail));
  const vivants = e.travaux.filter((t) => t.etat !== "fini" && !tenus.has(t.id));
  // 2. Un résultat partiel (une sous-mission finie) — même si l'agenda est suspendu : c'est une information, pas une question.
  for (const t of vivants) {
    const p = t.agenda.find((x) => x.nature === "partiel");
    if (p) return { annonce: null, element: p, avancement: null };
  }
  if (!e.agendaSuspendu) {
    // 3. Une précision qui change le résultat — le travail le plus récent d'abord (celui dont on parle).
    const recents = [...vivants].sort((a, b) => b.lanceMs - a.lanceMs);
    for (const t of recents) {
      const q = t.agenda.find((x) => x.nature === "precision");
      if (q) return { annonce: null, element: q, avancement: null };
    }
    // 4. Une étape suivante à décider.
    for (const t of recents) {
      const q = t.agenda.find((x) => x.nature === "suite");
      if (q) return { annonce: null, element: q, avancement: null };
    }
  }
  // 5. Agenda vide : l'avancement réel, UNE fois par travail (puis la voix ne meuble pas).
  const sansNouvelles = vivants.find((t) => t.etat !== "fini" && !t.avancementDit && t.avancement);
  if (sansNouvelles) return { annonce: null, element: null, avancement: { travail: sansNouvelles.id, texte: sansNouvelles.avancement! } };
  return { annonce: null, element: null, avancement: null };
}

function phraseAnnonce(a: Annonce, colle: boolean): string {
  if (a.brut) return colle ? `Et au passage : ${a.contenu}` : a.contenu;
  const lien = colle ? "Et justement, " : "";
  return a.nature === "echec"
    ? `${lien}le travail en cours n'a pas abouti : ${a.contenu}`
    : `${lien}${colle ? "le résultat vient d'arriver" : "Le résultat est arrivé"} : ${a.contenu}`;
}

function phraseElement(x: ElementAgenda, colle: boolean): string {
  if (x.nature === "partiel") return `${colle ? "Et entre-temps, " : "Un premier résultat partiel : "}${x.texte}`;
  return `${colle ? "Puis, pour que le résultat te serve mieux, pose cette question : " : "Pendant que ça tourne, pose cette question (une seule) : "}${x.texte}`;
}

/** Ce qui se dit quand il n'y a rien à ajouter après un accusé : jamais « j'attends » — on reste disponible. */
export const DISPONIBLE = "Puis dis en une phrase que tu restes disponible pour autre chose pendant que ça avance — sans dire que tu attends.";

/**
 * LA DÉCISION — pure : faut-il parler maintenant, et quoi ? Rend au plus UNE prise de parole.
 * `maintenant` : l'horloge murale (ms) ; `reglages` : pour le banc.
 */
export function decider(e: EtatConversation, maintenant: number, reglages: { silenceMs?: number; questionExpireMs?: number; enVolMaxMs?: number } = {}): Action {
  const silence = reglages.silenceMs ?? REGLAGES.silenceMs;
  const expire = reglages.questionExpireMs ?? REGLAGES.questionExpireMs;
  const enVolMax = reglages.enVolMaxMs ?? REGLAGES.enVolMaxMs;
  if (e.parole === "personne" && maintenant - e.paroleMs < silence) return { type: "rien", raison: "la personne parle" };
  if (e.reponseEnRoute) return { type: "rien", raison: "réponse de la personne en route" };
  // L'ACCUSÉ passe en premier — même si la voix parlait (GPT-Live attend le résultat de SA délégation).
  if (e.accuse) {
    const a = e.accuse;
    // Un accusé qui pose une question (« tu confirmes ? ») : rien ne s'y colle — l'annonce attendra la réponse.
    const suite = a.questionPosee ? { annonce: null, element: null, avancement: null } : prochainElement(e);
    const morceaux = [a.contenu];
    if (suite.annonce) morceaux.push(phraseAnnonce(suite.annonce, true));
    else if (suite.element) morceaux.push(phraseElement(suite.element, true));
    else if (suite.avancement) morceaux.push(`Puis dis où ça en est, en une phrase : ${suite.avancement.texte}`);
    else if (!a.questionPosee && e.travaux.some((t) => t.etat !== "fini")) morceaux.push(DISPONIBLE);
    return {
      type: "dire", contenu: morceaux.join(" "), delegationId: a.delegationId, accuse: true,
      annonce: suite.annonce, element: suite.element, avancement: suite.avancement?.texte ?? null, travail: suite.avancement?.travail ?? suite.element?.travail ?? suite.annonce?.travail ?? null,
    };
  }
  if (e.parole === "assistant" && maintenant - e.paroleMs < silence) return { type: "rien", raison: "l'assistant parle" };
  if (e.question && maintenant - e.question.poseeMs < expire) return { type: "rien", raison: "question en attente" };
  if (e.enVolMs != null && maintenant - e.enVolMs < enVolMax) return { type: "rien", raison: "prise de parole en vol" };
  // LIBRE.
  const s = prochainElement(e);
  if (s.annonce) {
    return { type: "dire", contenu: phraseAnnonce(s.annonce, false), delegationId: s.annonce.delegationId ?? null, accuse: false, annonce: s.annonce, element: null, avancement: null, travail: s.annonce.travail };
  }
  if (s.element) {
    const t = travailDe(e, s.element.travail);
    return { type: "dire", contenu: phraseElement(s.element, false), delegationId: t?.delegationId ?? null, accuse: false, annonce: null, element: s.element, avancement: null, travail: s.element.travail };
  }
  if (s.avancement) {
    const t = travailDe(e, s.avancement.travail);
    return { type: "dire", contenu: `Dis où ça en est, en une phrase, sans poser de question : ${s.avancement.texte}`, delegationId: t?.delegationId ?? null, accuse: false, annonce: null, element: null, avancement: s.avancement.texte, travail: s.avancement.travail };
  }
  return { type: "rien", raison: "disponible" };
}

/**
 * Une question restée sans réponse au-delà du délai : elle n'est plus « en attente » — et l'agenda se tait (on ne pose
 * pas de question dans le vide) jusqu'à ce que la personne reparle. À appeler au battement.
 */
export function vieillir(e: EtatConversation, maintenant: number, questionExpireMs: number = REGLAGES.questionExpireMs): EtatConversation {
  if (e.question && maintenant - e.question.poseeMs >= questionExpireMs && e.parole !== "personne") {
    return { ...e, question: null, agendaSuspendu: true };
  }
  return e;
}

/**
 * L'ÉCRIT — la même machine, lue autrement : il n'y a ni parole ni silence ; une question de l'agenda est AFFICHÉE dans
 * le fil. Un résultat arrivé pendant qu'elle attend sa réponse est TENU (« résultat prêt — affiché après ta réponse »).
 */
export function affichageEcrit(e: EtatConversation): { tenus: string[]; question: string | null } {
  if (!e.question && !e.reponseEnRoute) return { tenus: [], question: null };
  return { tenus: e.annonces.map((a) => a.travail), question: e.question?.element ?? null };
}
