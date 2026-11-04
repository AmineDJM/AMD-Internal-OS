import { chiffresNonSources } from "../analyse/chiffres";
import type { Observation } from "./contrat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRÔLE FINAL DU MESSAGE (lot I5, décision 0069 ; audit AU1 §4.5, étape 4) — PUR, déterministe, générique.
 *
 * Direction, 04/11/2026 : « il hallucine, il ment, il se trompe et continue dans l'erreur… il faut au moins qu'il se rende
 * compte au bout de la première erreur » — « Tout est une histoire d'architecture, pas de prompting. »
 *
 * Après chaque tour, AVANT d'afficher et de stocker : le message est découpé en phrases ; chaque phrase qui AFFIRME quelque
 * chose de vérifiable est typée (envoyé, fait, préparé, vérifié, rendu du mail, chiffre, fichier, état de mission, prévision,
 * « je n'ai pas trouvé ») et confrontée aux OBSERVATIONS du tour (journal I1) et aux gestes réellement joués. Trois verdicts :
 *
 *   • confirmée     — une observation l'appuie ;
 *   • contredite    — une observation dit le contraire (« la carte est PROPOSÉE », « le mail est à la charte », « la lecture
 *                     a rendu 3 lignes ») ;
 *   • non observée  — rien, dans le tour, ne l'appuie (« c'est envoyé » sans geste, un chiffre qu'aucune lecture ne rend).
 *
 * Ce module ne fait que JUGER ; l'infra (`infra/observation/controle-final.ts`) rejoue le tour UNE fois avec les écarts
 * énoncés comme faits, puis rectifie visiblement la phrase qui récidive. Il remplace les gardes par familles de mots
 * (`noteActionsNonVerifiees`) et la note des chiffres (`noteChiffresNonSources`), masquées quand il est actif.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type TypeAffirmation =
  | "envoye" | "accompli" | "prepare" | "verifie" | "rendu" | "chiffre" | "fichier" | "etat_mission" | "prevision" | "introuvable";

export type Verdict = "confirmee" | "contredite" | "non_observee";

/** Un geste du tour, tel que l'enveloppe des outils l'a vu (journal I1). */
export interface GesteObserve {
  outil: string;
  libelle: string;
  /** Le `statut` de la sortie JSON (FAIT, REFUS, PROPOSEE…), en majuscules — `null` si la sortie n'en dit pas. */
  statut: string | null;
  /** La sortie a dit un échec (REFUS, AMBIGU, ECHEC, BLOQUE, INCOMPLET, RIEN). */
  echec: boolean;
  /** Le nombre de lignes que la sortie dit avoir rendues (`total`), quand elle le dit — une lecture VIDE se relit. */
  lignes?: number | null;
  /** L'entrée du geste (une lecture vide se relit avec elle, sans ses filtres). */
  entree?: Readonly<Record<string, unknown>>;
}

export interface PreuvesDuTour {
  observations: readonly Observation[];
  gestes: readonly GesteObserve[];
  /** Ce qui fait foi pour un chiffre ou un nom de fichier : sorties d'outils, question, consigne, historique. */
  sources: readonly string[];
  /** L'historique (texte des réponses passées et leurs blocs « Observé ») — le rendu d'un mail préparé au tour d'avant. */
  historique?: string;
}

export interface Affirmation { type: TypeAffirmation; phrase: string; valeur?: string }

export interface Constat { affirmation: Affirmation; verdict: Verdict; observe: string }

// ─────────────────────────────── Les phrases ───────────────────────────────

const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ");

/** Les phrases du message — une citation (« … », "…"), un bloc cité (`>`), un tableau ou du code ne sont pas des affirmations. */
export function phrasesDe(message: string): string[] {
  const sansCode = message.replace(/```[\s\S]*?```/g, "\n");
  const lignes = sansCode.split("\n").filter((l) => !/^\s*(>|\|)/.test(l));
  // Une citation ne se coupe pas : « J'ai envoyé le rapport. » reste dans la phrase qui la cite.
  return lignes.flatMap((l) => l.match(/(?:«[^»]*»|"[^"\n]*"|“[^”]*”|[.!?…](?![\s.!?…]|$)|[^.!?…«"“])+(?:[.!?…]+|$)/g) ?? []).map((p) => p.trim()).filter((p) => p.length > 2);
}

/** Le texte d'une phrase à juger : citations et liens retirés (un mail cité « J'ai envoyé… » n'est pas une affirmation). */
const aJuger = (phrase: string): string =>
  plier(phrase.replace(/«[^»]*»|"[^"]*"|“[^”]*”/g, " « » ").replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+|\/[a-z][\w-]*\/[\w/-]+/gi, " "));

const QUESTION = /\?\s*$/;
/** Futur, condition, invitation : « il partira dès que tu confirmes », « veux-tu que je l'envoie ». */
const CONDITION = /\b(sera|seront|serait|seraient|va|vais|vont|allons|des que|une fois|apres (ta|votre|sa) confirmation|quand tu|quand vous|si tu|si vous|pourra|pourrai|pourras|pourrez|veux tu|voulez vous|souhaites|souhaitez|dois je|faut il|confirmez|a confirmer|attend|attendent|en attente)\b/;
const NEGATION = /\b(pas encore|ne (l |les )?(ai|a|est|sont|ont) pas|n (ai|a|est|ont) pas|rien n|aucun\w*|jamais|non)\b/;

const ENVOI = /\b(?:j ai|je (?:l |les |lui |leur |vous |te )?ai|nous avons|c est|est|sont|a ete|ont ete)\s+(?:bien\s+|deja\s+)?(?:envoye|expedie|transmis)e?s?\b/;
/** « est parti » ne vaut un envoi que dit d'un mail (« le délégué est parti en tournée » n'en est pas un). */
const PARTI = /\b(?:c est|est|sont)\s+(?:bien\s+|deja\s+)?partis?\b/;
const D_UN_MAIL = /\b(mail|e-?mail|message|courriel|envoi)s?\b/;
const ACCOMPLI = /\bc est (?:bien |deja )?fait\b|\b(?:j ai|je (?:l |les |lui |leur |vous |te )?ai|nous avons|je viens d|c est|a ete|ont ete)\s+(?:bien\s+|deja\s+)?(?:cree|modifie|enregistre|sauvegarde|fusionne|arrete|supprime|ajoute|mis a jour|mise a jour|programme|planifie|annule|relance|repris|renomme|mis en pause|mise en pause|depose|genere|valide|approuve|cloture|assigne|attribue|retire)e?s?\b/;
const PREPARE = /\b(?:j ai|je (?:t |vous )?ai|je viens de)\s+(?:bien\s+)?(?:prepare|propose)e?s?\b[^.]*\b(carte|mail|e-?mail|message|courriel|brouillon|tache|rappel|envoi|demande|confirmation)\b/;
const VERIFIE = /\b(j ai (bien )?(verifie|controle|consulte|relu)|apres verification|je confirme que)\b/;
const TEXTE_BRUT = /\b(texte (brut|seul)|en texte brut|sans (aucun )?html|pas de html|format brut)\b/;
const SIMPLE = /\b(texte simple|sans (aucune )?(mise en forme|mise en page|design|charte|bandeau|couleur)|pas de (mise en forme|design|charte|bandeau)|format simple|(mail|message|version) (tout )?simple|sobre)\b/;
const CHARTE = /\b(a la charte|charte (graphique|de la societe|adventum)|aux couleurs de|gabarit|avec (le |un )?bandeau)\b/;
const SIMPLE_NIE = /\b(pas|non|plutot que|au lieu d|et non)( en| un| une| du| de)? (texte (brut|simple|seul)|mail simple|version simple)\b/;
const D_UN_RENDU = /\b(mail|e-?mail|message|courriel|version|format|mise en forme|rendu)\b/;
const FICHIER = /([\p{L}\p{N}_-]+)\.(xlsx|xls|csv|docx|doc|pdf|pptx|txt|zip)\b/iu;
const MISSION = /\bmissions?\b/;
const PREVISION = /\b(dans (moins d une|quelques|une|deux|\d+) (minutes?|instants?|heures?)|d ici (peu|quelques|une)|sous peu|bientot|tres vite|au prochain (battement|balayage|passage)|(va|vont) (partir|demarrer|commencer|reprendre|avancer|se lancer)|partira|partiront|demarrera|demarreront|commencera|commenceront)\b/;
const PREVISION_NIEE = /\b(ne (peux|peut|sais|saurais) pas|impossible de|aucune garantie|pas garanti|sans garantie)\b/;
const INTROUVABLE = /\b(je n ai (pas|rien|aucun\w*)( \w+){0,3} (pu )?(trouve|trouver|identifie|repere)|je n ai trouve (aucun\w*|rien)|je ne (trouve|vois) (pas|aucun\w*|rien)|aucun\w* \w+( \w+)? (n a ete |n ont ete |n est |ne sont )?(trouve|retrouve|identifie|repere)e?s?\b|aucun\w* \w+ ne correspond|je n ai pas (d information|acces|les droits|la possibilite)|je ne (peux|peut) pas (acceder|confirmer|verifier|determiner|savoir)|je n ai pas pu (confirmer|verifier|determiner|acceder|trouver)|impossible de (confirmer|verifier|determiner|trouver)|ne (figure|figurent|apparait|apparaissent) pas)/;

/** Les états de mission qu'une phrase peut affirmer, et ce que le diagnostic observé doit dire pour l'appuyer. */
const ETATS_MISSION: readonly { motif: RegExp; appui: RegExp; dit: string }[] = [
  { motif: /\b(est|sont) (bien )?(terminee|finie|achevee|livree|bouclee)s?\b|\bmissions? (terminee|finie|achevee|livree)s?\b/, appui: /^terminee/, dit: "terminée" },
  { motif: /\b(est|sont) (bien )?(prete|pretes)\b|\bpretes? a partir\b/, appui: /^prete/, dit: "prête" },
  { motif: /\b(est|sont) (bien )?(en cours|en train d avancer)\b|\b(avance|avancent|tourne|tournent) (bien|normalement)\b/, appui: /^en cours|reessaie/, dit: "en cours" },
  { motif: /\b(est|sont) (bien )?(lancee|demarree)s?\b/, appui: /^(?!attend ton approbation|arretee|annulee)/, dit: "lancée" },
  { motif: /\b(est|sont) (bien )?(bloquee|en echec|echouee)s?\b/, appui: /bloquee|reessaie|echou/, dit: "bloquée" },
  { motif: /\b(est|sont) (bien )?(en pause|arretee|suspendue)s?\b/, appui: /pause|arretee|suspend/, dit: "en pause ou arrêtée" },
];

// ─────────────────────────────── Les affirmations ───────────────────────────────

/** EXTRAIRE les affirmations typées du message — une phrase peut en porter plusieurs (un envoi ET un chiffre). */
export function extraireAffirmations(message: string, sources: readonly string[] = []): Affirmation[] {
  const out: Affirmation[] = [];
  const parleDeMissions = MISSION.test(plier(message));
  for (const phrase of phrasesDe(message)) {
    const p = aJuger(phrase);
    const question = QUESTION.test(phrase);
    // « Je n'ai pas trouvé » se juge AVANT la négation (c'en est une).
    if (!question && INTROUVABLE.test(p)) out.push({ type: "introuvable", phrase });
    // Une prévision est un futur par nature : elle se juge avant le filtre des conditions.
    if (!question && parleDeMissions && PREVISION.test(p) && !PREVISION_NIEE.test(p)) out.push({ type: "prevision", phrase });
    const fichier = FICHIER.exec(phrase);
    if (fichier) out.push({ type: "fichier", phrase, valeur: `${fichier[1]}.${fichier[2]}` });
    if (question || CONDITION.test(p)) continue;
    // Le rendu se dit souvent par la négative (« sans aucune mise en forme ») : jugé avant le filtre des négations.
    // « rendu à la charte, pas en texte brut » : la charte est affirmée, le texte brut nié.
    if (CHARTE.test(p) && D_UN_RENDU.test(p) && (SIMPLE_NIE.test(p) || !(TEXTE_BRUT.test(p) || SIMPLE.test(p)))) out.push({ type: "rendu", phrase, valeur: "charte" });
    else if (TEXTE_BRUT.test(p) && !SIMPLE_NIE.test(p)) out.push({ type: "rendu", phrase, valeur: "texte brut" });
    else if (SIMPLE.test(p) && !SIMPLE_NIE.test(p)) out.push({ type: "rendu", phrase, valeur: "simple" });
    if (NEGATION.test(p)) continue;
    const etat = MISSION.test(p) ? ETATS_MISSION.find((e) => e.motif.test(p)) : undefined;
    if (etat) out.push({ type: "etat_mission", phrase, valeur: etat.dit });
    if (ENVOI.test(p) || (PARTI.test(p) && D_UN_MAIL.test(p))) out.push({ type: "envoye", phrase });
    else if (!etat && ACCOMPLI.test(p)) out.push({ type: "accompli", phrase });
    if (PREPARE.test(p)) out.push({ type: "prepare", phrase });
    if (VERIFIE.test(p)) out.push({ type: "verifie", phrase });
  }
  // Les CHIFFRES (la garde K1, déplacée ici) : chaque nombre que rien du tour ne rend, rattaché à sa phrase.
  const phrases = phrasesDe(message);
  for (const c of chiffresNonSources(phrases.filter((ph) => !QUESTION.test(ph)).map(sansLiens).join("\n"), sources)) {
    const phrase = phrases.find((ph) => sansLiens(ph).includes(c));
    if (phrase) out.push({ type: "chiffre", phrase, valeur: c });
  }
  return out;
}

/** Un lien ou un identifiant n'est pas un chiffre cité (`/missions/cm3k9…`, `](…)`). */
const sansLiens = (t: string): string => t.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+|\/[a-z][\w-]*\/[\w/-]+|\bc[a-z0-9]{20,}\b/gi, " ");

// ─────────────────────────────── Les verdicts ───────────────────────────────

const SUR_UNE_ACTION = /\b(envoye|envoyee|envoi|parti|partie|expedie|transmis|execute|executee|action)s?\b/;
const SUR_UN_ACCES = /\b(acces|droits?|ouvert|autorise)\b/;

/** Une phrase dit-elle « je n'ai pas trouvé » ? (l'infra relit alors les lectures vides avant de juger). */
export const ditIntrouvable = (message: string): boolean => extraireAffirmations(message).some((a) => a.type === "introuvable");

/** Les états d'une observation qui disent qu'un geste A EU LIEU (pas seulement préparé). */
const ACCOMPLIS = new Set(["EXECUTEE", "CONFIRMEE", "PARTI", "PROGRAMME", "ECRIT"]);
const EN_ATTENTE = new Set(["PROPOSEE", "A_COMPLETER"]);
const STATUTS_FAITS = new Set(["FAIT"]);
const STATUTS_PROPOSES = new Set(["PROPOSEE", "PROPOSED", "EN_ATTENTE_DE_CONFIRMATION"]);
/** La cuisine du tour : ni une lecture, ni un geste. */
const PAS_UN_GESTE = new Set(["trouver_outil"]);

const cartesEnAttente = (o: readonly Observation[]) => o.filter((x) => x.nature === "carte" && EN_ATTENTE.has(x.etat));
const titre = (o: Observation) => String(o.projection.titre ?? o.objet.id);
const diagnostic = (o: Observation) => plier(String(o.projection.diagnostic ?? ""));
const ditMission = (o: Observation) => `« ${titre(o)} » : ${String(o.projection.diagnostic ?? o.etat.toLowerCase())}${o.objet.lien ? ` [${o.objet.lien}]` : ""}`;
const lectures = (o: readonly Observation[]) => o.filter((x) => x.nature === "lecture" && x.etat === "LU" && x.objet.type !== "bloc" && Number(x.projection.lignes ?? 0) > 0);
const estCharte = (rendu: string) => /a la charte|charte en partie|mixte/.test(plier(rendu));

/** Le rendu du mail observé : celui du tour, sinon le dernier dit par un bloc « Observé » de l'historique. */
function renduObserve(p: PreuvesDuTour): { rendu: string; titre: string } | null {
  const carte = [...p.observations].reverse().find((o) => typeof o.projection.rendu === "string");
  if (carte) return { rendu: String(carte.projection.rendu), titre: titre(carte) };
  const vus = [...(p.historique ?? "").matchAll(/carte \(id [^)]*\)[^\n]*?titre : ([^;\n]*);[^\n]*?rendu : ([^;\]\n]*)/g)];
  const dernier = vus[vus.length - 1];
  return dernier ? { rendu: dernier[2]!.trim(), titre: dernier[1]!.trim() } : null;
}

function juger(a: Affirmation, p: PreuvesDuTour): Constat {
  const v = (verdict: Verdict, observe: string): Constat => ({ affirmation: a, verdict, observe });
  const obs = p.observations;
  const gestes = p.gestes.filter((g) => !PAS_UN_GESTE.has(g.outil));
  const reussis = gestes.filter((g) => !g.echec);
  const accomplis = obs.filter((o) => ACCOMPLIS.has(o.etat) && o.nature !== "lecture");
  const faits = reussis.filter((g) => g.statut && STATUTS_FAITS.has(g.statut));
  const attente = cartesEnAttente(obs);
  const enAttente = () => `la carte « ${titre(attente[0]!)} » est PROPOSÉE — elle attend la confirmation de la personne ; rien n'est exécuté ni parti`;
  switch (a.type) {
    case "envoye": {
      if (obs.some((o) => ["PARTI", "PROGRAMME", "EXECUTEE"].includes(o.etat) && o.nature !== "lecture") || faits.some((g) => /mail|envoi|send|message/i.test(g.outil))) return v("confirmee", "envoi observé");
      return attente.length ? v("contredite", enAttente()) : v("non_observee", "aucun envoi n'a été fait ni préparé dans ce tour");
    }
    case "accompli": {
      // « j'ai corrigé / mis à jour la carte » : la carte elle-même est l'objet du geste, et elle est observée.
      if (/\b(carte|proposition)s?\b/.test(aJuger(a.phrase)) && (obs.some((o) => o.nature === "carte") || reussis.some((g) => g.statut && STATUTS_PROPOSES.has(g.statut)))) return v("confirmee", "carte observée");
      if (accomplis.length || faits.length) return v("confirmee", accomplis[0] ? `${accomplis[0].nature} « ${titre(accomplis[0])} » : ${accomplis[0].etat.toLowerCase()}` : `${faits[0]!.libelle} : fait`);
      return attente.length ? v("contredite", enAttente()) : v("non_observee", "aucune action n'a été exécutée dans ce tour");
    }
    case "prepare": {
      // Une carte du tour, ou d'un tour précédent (bloc « Observé » de l'historique) : « je t'ai proposé le mail » en parle.
      if (obs.some((o) => o.nature === "carte") || reussis.some((g) => g.statut && STATUTS_PROPOSES.has(g.statut)) || /\bcarte \(id /.test(p.historique ?? "")) return v("confirmee", "carte observée");
      return v("non_observee", "aucune carte ni proposition n'a été préparée dans ce tour");
    }
    case "verifie":
      return reussis.length ? v("confirmee", `${reussis[0]!.libelle}`) : v("non_observee", "aucune lecture ni vérification n'a été faite dans ce tour");
    case "rendu": {
      const r = renduObserve(p);
      if (!r) return v("non_observee", "aucun mail préparé n'est observé (ni dans ce tour, ni dans l'historique) : sa mise en forme n'est pas connue");
      const brut = plier(r.rendu).startsWith("texte brut");
      const ok = a.valeur === "texte brut" ? brut : a.valeur === "simple" ? !estCharte(r.rendu) : estCharte(r.rendu);
      return v(ok ? "confirmee" : "contredite", `le mail « ${r.titre} » est rendu en : ${r.rendu}`);
    }
    case "chiffre":
      return v("non_observee", `le chiffre ${a.valeur} ne vient d'aucune lecture ni d'aucun calcul de ce tour`);
    case "fichier": {
      const nom = plier(a.valeur ?? "");
      const vu = obs.some((o) => o.nature === "fichier" && plier(String(o.projection.nom ?? "")).includes(nom)) || p.sources.some((s) => plier(s).includes(nom));
      return vu ? v("confirmee", "fichier observé") : v("non_observee", `aucun fichier « ${a.valeur} » n'a été produit ni lu dans ce tour`);
    }
    case "etat_mission": {
      const missions = obs.filter((o) => o.nature === "mission");
      if (!missions.length) return v("non_observee", "aucune mission n'a été lue dans ce tour (mes_missions) : son état n'est pas observé");
      const appui = ETATS_MISSION.find((e) => e.dit === a.valeur)!.appui;
      return missions.some((m) => appui.test(diagnostic(m)))
        ? v("confirmee", "état observé")
        : v("contredite", `observé : ${missions.slice(0, 3).map(ditMission).join(" ; ")}`);
    }
    case "prevision": {
      const missions = obs.filter((o) => o.nature === "mission");
      return v("non_observee", `aucune observation ne prévoit un départ${missions.length ? ` ; observé : ${missions.slice(0, 3).map(ditMission).join(" ; ")}` : ""}`);
    }
    case "introuvable": {
      const ph = aJuger(a.phrase);
      // « je ne peux pas confirmer que le mail est parti » : une négation sur une ACTION, honnête tant qu'aucun envoi n'est observé.
      if (SUR_UNE_ACTION.test(ph)) {
        const parti = obs.find((o) => ["PARTI", "PROGRAMME", "EXECUTEE"].includes(o.etat) && o.nature !== "lecture");
        return parti ? v("contredite", `${parti.nature} « ${titre(parti)} » : ${parti.etat.toLowerCase()}`) : v("confirmee", "aucune action observée");
      }
      // « je n'ai pas accès » : honnête quand un geste du tour a été refusé.
      if (SUR_UN_ACCES.test(ph) && gestes.some((g) => g.echec)) return v("confirmee", "refus observé");
      const lu = lectures(obs);
      if (lu.length) return v("contredite", `${lu.slice(0, 2).map((o) => `la lecture « ${titre(o)} » a rendu ${Number(o.projection.lignes)} ligne(s)`).join(" ; ")}`);
      // Une lecture vide RELUE sans ses filtres (`elargir`) : ce que la base porte vraiment.
      const elargie = obs.find((o) => o.nature === "lecture" && Array.isArray(o.projection.elargir) && o.projection.elargir.length);
      if (elargie) return v("contredite", `la lecture « ${titre(elargie)} » a rendu 0 ligne avec ses filtres, mais la base en porte : ${(elargie.projection.elargir as readonly string[]).join(" ; ")} — un filtre est trop étroit`);
      return gestes.length ? v("confirmee", "lectures sans résultat") : v("non_observee", "aucune lecture n'a été tentée dans ce tour");
    }
  }
}

/** LE CONTRÔLE : chaque affirmation du message, jugée. */
export function controlerMessage(message: string, p: PreuvesDuTour): Constat[] {
  return extraireAffirmations(message, p.sources).map((a) => juger(a, p));
}

/** Ce qui doit être repris : les affirmations contredites ou non observées. */
export const aReprendre = (c: readonly Constat[]): Constat[] => c.filter((x) => x.verdict !== "confirmee");

const court = (t: string, n = 220) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * LA REPRISE — ce que le serveur dit au modèle quand son message ne tient pas : les écarts ÉNONCÉS COMME DES FAITS (« tu as
 * écrit X ; l'observation dit Y »). Une seule fois par tour.
 */
export function noteDeReprise(c: readonly Constat[]): string {
  const lignes = aReprendre(c).map((x) => `- Tu as écrit « ${court(x.affirmation.phrase)} » ; ${x.verdict === "contredite" ? "l'observation dit" : "rien de ce tour ne l'appuie"} : ${x.observe}.`);
  return [
    "[CONTRÔLE FINAL DU SERVEUR — ta réponse précédente n'a PAS été affichée. Le serveur a confronté ce que tu as écrit à ce que les gestes de ce tour ont réellement produit :",
    ...lignes,
    "Réécris ta réponse ENTIÈRE pour la personne à partir de ces faits. Si un fait te manque, fais le geste (lis, prépare la carte) ou dis simplement que ce n'est pas fait ou pas vérifié. Les cartes déjà préparées restent affichées : n'en prépare pas une deuxième pour la même chose. Ne parle pas de ce contrôle.]",
  ].join("\n");
}

/**
 * LA RECTIFICATION — le modèle a récidivé : la phrase fautive est REMPLACÉE par le fait observé, marquée visiblement.
 * Jamais un texte faux affiché ; jamais une deuxième boucle.
 */
export function rectifier(message: string, c: readonly Constat[]): string {
  const parPhrase = new Map<string, string[]>();
  for (const x of aReprendre(c)) parPhrase.set(x.affirmation.phrase, [...(parPhrase.get(x.affirmation.phrase) ?? []), x.observe]);
  let out = message;
  for (const [phrase, faits] of parPhrase) out = out.replace(phrase, `⚠️ _Rectifié par le contrôle : ${[...new Set(faits)].join(" ; ")}._`);
  return out;
}
