import { plier } from "@/lib/utils";
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIMITES DITES JUSTE (mandat 5 §34) — pur, sans import.
 *
 * Deux règles que le code tient à la place du prompt :
 *
 *   1. LA DÉCOUVERTE AVANT L'IMPOSSIBLE. Quand le modèle conclut « je ne peux pas / je n'ai pas
 *      d'outil » sans avoir appelé UN SEUL outil, le serveur ne prend pas sa parole : il lui remet la
 *      carte complète des capacités ouvertes (`list_more_tools`, exécutée côté serveur) et exige un
 *      second essai. Une fois. Si le refus tient encore, il est accepté — mais il doit alors dire sa
 *      LIMITE (règle 2), jamais « ce n'est pas codé ».
 *
 *   2. UNE LIMITE A UNE NATURE. Permission (un droit qui manque), ressource (python3 absent, clé de
 *      fournisseur non configurée, pièce sans texte), donnée (rien dans la base pour répondre), ou
 *      capacité (aucune brique ne fait cela). « Pas prévu », « pas codé », « pas dans mes fonctions »
 *      ne sont pas des natures : ce sont des aveux paresseux qui cachent l'une des quatre. Le
 *      classement sert la réponse (dire la bonne chose), le journal (compter les vraies lacunes de
 *      capacité — §44) et le banc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureLimite = "PERMISSION" | "RESSOURCE" | "DONNEE" | "CAPACITE";
export type VerdictImpossibilite = "RAS" | "REDECOUVRIR" | "ACCEPTER";

/** Le modèle DIT qu'il ne peut pas — sans nuance de droit ou de donnée. */
const REFUS_CAPACITE = [
  /\bje ne (?:peux|suis) pas (?:en mesure de |capable de )?(?:faire|executer|lancer|calculer|generer|produire|creer|modifier|ouvrir|lire|acceder|consulter|envoyer|programmer|surveiller)/,
  /\bje n'ai pas (?:d'|de |l')?(?:outil|fonction|capacite|acces|moyen|possibilite)/,
  /\bpas (?:d'|de )?(?:outil|fonction|fonctionnalite|capacite) (?:pour|permettant|qui)/,
  /\b(?:ce n'est pas|cela n'est pas|c'est) (?:possible|prevu|pris en charge|dans mes (?:fonctions|capacites|attributions|competences))/,
  /\bhors de (?:mes|mon) (?:capacites|competences|perimetre|champ)/,
  /\bje ne (?:dispose|sais) pas (?:de |d')?(?:outil|comment|faire)/,
  /\bimpossible (?:pour moi|de (?:faire|calculer|generer|lancer|executer))/,
  /\bn'est pas (?:code|implemente|programme|disponible dans (?:l'erp|adam|le systeme))/,
];

/** Une limite déjà DITE avec sa nature : le refus est honnête, on ne le rejoue pas. */
const LIMITE_NOMMEE = [
  /\b(?:droit|permission|habilitation|autorisation|module)\b[^.]{0,60}\b(?:manque|manquant|requis|necessaire|ne vous est pas ouvert|refuse)/,
  /\bne vous est pas ouvert/,
  /\bpython3? (?:est |n'est pas |)(?:indisponible|absent)/,
  /\b(?:cle|clef|fournisseur|service|connexion)\b[^.]{0,40}\b(?:non configure|indisponible|absent|manquant)/,
  /\baucun(?:e)? (?:donnee|enregistrement|ligne|resultat|trace|fiche|document)\b/,
  /\brien (?:dans la base|d'enregistre|n'est enregistre)/,
];

export interface EntreeGarde {
  question: string;
  reponse: string;
  outilsUtilises: readonly string[];
  /** Les outils ouverts à la personne — la carte complète, droits déjà appliqués. */
  outilsDisponibles: readonly string[];
  dejaRedecouvert: boolean;
}

/** Le refus PARAÎT-IL une impossibilité de capacité (et non une limite nommée) ? */
export function paraitImpossibilite(reponse: string): boolean {
  const t = plier(reponse);
  if (!REFUS_CAPACITE.some((r) => r.test(t))) return false;
  return !LIMITE_NOMMEE.some((r) => r.test(t));
}

/**
 * LA GARDE : « impossible » sans avoir rien essayé → redécouvrir une fois ; après redécouverte, le
 * refus est accepté (le modèle a vu la carte). Un refus qui nomme déjà sa limite n'est pas rejoué.
 */
export function gardeImpossibilite(e: EntreeGarde): VerdictImpossibilite {
  if (e.outilsUtilises.length > 0) return "RAS";
  if (e.outilsDisponibles.length === 0) return "RAS";
  if (!paraitImpossibilite(e.reponse)) return "RAS";
  if (e.dejaRedecouvert) return "ACCEPTER";
  return "REDECOUVRIR";
}

/** Le rappel injecté au modèle — un tour de plus, avec la carte complète, pas une prière de prompt. */
export const RAPPEL_DECOUVERTE =
  "CONTRÔLE DU SERVEUR : tu viens de répondre « impossible » sans avoir appelé un seul outil. La liste courte que tu "
  + "avais reçue n'est PAS l'étendue de tes capacités : voici la carte complète de ce qui est ouvert à cette personne "
  + "(ci-dessous). Réessaie MAINTENANT avec l'outil qui convient — un calcul se fait avec `run_analysis` ou `run_code`, "
  + "une lecture avec l'outil canonique du domaine, une action avec l'outil d'écriture, une tâche longue avec `launch_mission`. "
  + "Si, la carte lue, rien ne répond vraiment, dis alors la NATURE de la limite — un droit qui manque, une ressource absente, "
  + "une donnée qui n'existe pas, ou une capacité qui n'existe pas — jamais « ce n'est pas prévu ».";

export interface Limite { nature: NatureLimite; precise: boolean; motif: string }

/** CLASSER une phrase de limite : sa nature, et si elle est dite avec précision. */
export function classerLimite(reponse: string): Limite | null {
  const t = plier(reponse);
  if (/\b(?:droit|permission|habilitation|autorisation)\b|ne vous est pas ouvert|reserve (?:a|aux) |hors de votre perimetre/.test(t)) {
    return { nature: "PERMISSION", precise: /\b(?:module|droit|permission)\b[^.]{0,40}\b[A-Z_]{3,}|(?:finances?|rh|budgets?|drive|regulatory|legal|paie|salaires?)\b/.test(t) || /ne vous est pas ouvert/.test(t), motif: "un droit manque" };
  }
  if (/\bpython3?\b[^.]{0,30}\b(?:indisponible|absent)|\b(?:cle|clef|fournisseur|service|connexion|serveur)\b[^.]{0,40}\b(?:non configure|indisponible|absent|manquant|injoignable)|\bsans texte\b|\billisible\b/.test(t)) {
    return { nature: "RESSOURCE", precise: /\bpython|\bcle\b|\bfournisseur\b|\bconnexion\b|\bsans texte\b|\billisible\b/.test(t), motif: "une ressource manque sur ce serveur ou cette pièce" };
  }
  // Une capacité NOMMÉE comme absente (« aucun outil ne permet… ») se lit avant la donnée absente :
  // « une capacité qui n'existe pas dans l'ERP » parle de la brique, pas d'un enregistrement.
  if (/\baucun(?:e)? (?:outil|brique|capacite|fonction(?:nalite)?)\b[^.]{0,80}\b(?:pour|permet|permettant|qui|ne)\b/.test(t)) {
    return { nature: "CAPACITE", precise: true, motif: "aucune capacité ne fait cela" };
  }
  if (/\baucun(?:e)? (?:donnee|enregistrement|ligne|resultat|trace|fiche|document|reunion|tache|paiement)\b|\brien (?:dans la base|d'enregistre|n'est enregistre)|\b(?:donnee|enregistrement|fiche|dossier|ligne|reference)\b[^.]{0,40}\bn'existe pas/.test(t)) {
    return { nature: "DONNEE", precise: true, motif: "la donnée n'existe pas" };
  }
  if (REFUS_CAPACITE.some((r) => r.test(t))) {
    const paresseux = /\b(?:pas (?:prevu|code|implemente|programme)|dans mes (?:fonctions|capacites|attributions|competences))\b/.test(t);
    return { nature: "CAPACITE", precise: !paresseux && /\baucun(?:e)? (?:outil|brique|capacite)\b[^.]{0,80}\b(?:pour|permettant|qui)\b/.test(t), motif: paresseux ? "« pas prévu » cache la vraie nature de la limite" : "aucune capacité ne fait cela" };
  }
  return null;
}

/** La phrase que le serveur ajoute quand un refus accepté reste imprécis — dire la nature plutôt que le rien. */
export function complementDeLimite(reponse: string, outilsDisponibles: number): string | null {
  const l = classerLimite(reponse);
  if (!l || l.precise) return null;
  if (l.nature === "CAPACITE") {
    return `Précision du serveur : la carte complète (${outilsDisponibles} capacités ouvertes) a été relue avant cette réponse ; si une capacité manque réellement, elle est notée comme lacune à combler, pas comme un « non prévu ».`;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * NOT_FOUND N'EST PAS VERIFIED_ABSENT — la troisième règle de ce fichier.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * On demande à Adam ce qui existe sur les réseaux sociaux, chez une personne nommée Radia. Une
 * recherche, zéro résultat, et la réponse tombe : « je n'ai rien trouvé ». La donnée était là,
 * sous un autre libellé, rattachée à quelqu'un d'autre, dans un autre grenier.
 *
 * ── LE PIÈGE, ET IL ÉTAIT DANS CE FICHIER ───────────────────────────────────────────────
 *
 * `LIMITE_NOMMEE` compte « aucune donnée » parmi les refus HONNÊTES — donc `gardeImpossibilite`
 * rend RAS, et `classerLimite` rend `DONNEE` avec `precise: true`. Autrement dit : le code
 * CERTIFIAIT qu'une absence est une limite bien dite, sans jamais regarder ce qui avait été
 * cherché. Une recherche unique et infructueuse valait preuve d'inexistence.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────
 *
 * Une absence ne s'affirme qu'après ÉLARGISSEMENT. Si la réponse dit « je n'ai rien trouvé »
 * alors que le tour n'a essayé qu'une ou deux façons de chercher, le serveur ne prend pas sa
 * parole : il rend l'échelle d'élargissement et exige un second essai. Une fois. Après quoi
 * l'absence est acceptée — elle aura été cherchée.
 *
 * Deux garde-fous contre le faux positif :
 *   • on distingue l'absence de LA CHOSE CHERCHÉE (« je n'ai trouvé aucun contrat ») de
 *     l'absence d'une PROPRIÉTÉ (« aucun dossier n'est en retard »), qui est une CONCLUSION
 *     tirée de données bien lues et qu'il serait absurde de faire rechercher ;
 *   • rien ne se déclenche sans qu'un outil ait tourné : le tour sans aucun outil appartient à
 *     `gardeImpossibilite`, et deux gardes sur le même cas se contrediraient.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * COMBIEN DE FAÇONS DE CHERCHER SUFFISENT À NE PLUS ÉLARGIR.
 *
 * L'échelle compte sept barreaux (exact, approché, alias, créateur/assigné, historique, entités
 * liées, autres greniers). Conclure à l'absence après un ou deux, ce n'est pas avoir vérifié :
 * c'est avoir essayé. Au-delà, l'élargissement est en cours et le forcer coûterait un tour sans
 * rien apprendre — le seuil est donc un compromis assumé, pas une vérité.
 */
export const FACONS_AVANT_ABSENCE = 2;

/** L'absence de CE QU'ON CHERCHAIT — jamais l'absence d'une propriété dans ce qu'on a lu. */
const ABSENCE_DE_LA_CHOSE = [
  /\bje n'ai (?:rien |pas |malheureusement |)(?:pu |)(?:trouve|retrouve|repere|localise|identifie|deniche)/,
  /\baucun\w*(?: [a-z']{1,14}){0,4} (?:ne (?:correspond|existe|figure|apparait|ressort)|n'(?:existe|apparait|est enregistre)|n'a ete (?:trouve|retrouve))/,
  /\brien (?:n'a ete trouve|ne correspond|n'apparait|ne figure|de tel|n'existe)/,
  /\b(?:est |sont |reste |demeure |)introuvables?\b/,
  /\b(?:aucune|pas de) trace\b/,
  /\bn'(?:existe|apparait|figure) pas (?:dans|en base|au registre|a l'erp|dans l'erp)/,
];

/**
 * DEUX FAÇONS DONT UNE PHRASE D'ABSENCE N'EST PAS UN ÉCHEC DE RECHERCHE.
 *
 * • ELLE PORTE SUR UNE SOURCE DÉJÀ LUE. « Aucune réserve n'a été trouvée DANS CE DOCUMENT » est
 *   le résultat d'une lecture réussie : le document a été ouvert, il ne contient pas la chose.
 *   Faire réélargir là ferait payer un tour à chaque analyse de pièce.
 * • LA CHOSE A FINALEMENT ÉTÉ TROUVÉE. « Introuvable dans Legal, mais je l'ai retrouvé au
 *   Drive » contient les deux phrases ; seule la seconde compte.
 */
const SOURCE_DEJA_LUE = /\bdans (?:ce|cet|cette|le|la|les|leur) (?:document|fichier|piece|contrat|rapport|texte|pdf|classeur|tableau|courrier|mail|compte rendu|proces verbal)\b/;
const TROUVE_MALGRE_TOUT = [
  /\bj'ai (?:bien |finalement |en revanche |tout de meme |quand meme |)(?:trouve|retrouve|localise|repere)/,
  /\bje l'ai (?:trouve|retrouve|localise)/,
  /\b(?:le|la|les) voici\b/,
  /\ben revanche\b/,
];

export type VerdictAbsence = "RAS" | "ELARGIR";

export interface EntreeAbsence {
  reponse: string;
  /** Les outils appelés pendant le tour, doublons compris — c'est la DIVERSITÉ qui compte. */
  outilsUtilises: readonly string[];
  dejaElargi: boolean;
}

/** La réponse affirme-t-elle n'avoir pas TROUVÉ (et non pas : n'avoir rien constaté) ? */
export function affirmeUneAbsence(reponse: string): boolean {
  const t = plier(reponse);
  if (!ABSENCE_DE_LA_CHOSE.some((r) => r.test(t))) return false;
  if (SOURCE_DEJA_LUE.test(t)) return false;
  return !TROUVE_MALGRE_TOUT.some((r) => r.test(t));
}

/**
 * LA GARDE. Rend ELARGIR quand une absence est affirmée après trop peu de façons de chercher.
 * Muette sur tout le reste — y compris sur un tour sans outil, qui relève de l'autre garde.
 */
export function gardeAbsence(e: EntreeAbsence): VerdictAbsence {
  if (e.dejaElargi) return "RAS";
  if (e.outilsUtilises.length === 0) return "RAS";
  if (!affirmeUneAbsence(e.reponse)) return "RAS";
  const facons = new Set(e.outilsUtilises).size;
  if (facons > FACONS_AVANT_ABSENCE) return "RAS";
  return "ELARGIR";
}

/**
 * L'ÉCHELLE, RENDUE AU MODÈLE. Elle nomme des MANIÈRES de chercher, pas des outils : les outils
 * changent d'un profil à l'autre, la manière de chercher non. C'est ce qui la garde générale.
 */
export const RAPPEL_ELARGISSEMENT =
  "CONTRÔLE DU SERVEUR : tu conclus à une absence après une seule façon de chercher. « Je n'ai rien trouvé au premier "
  + "essai » n'est PAS « cela n'existe pas » — et c'est la seconde phrase que la personne va lire. Reprends MAINTENANT, "
  + "en montant l'échelle tant qu'il reste un barreau :\n"
  + "  1. EXACT — le libellé donné, tel quel.\n"
  + "  2. APPROCHÉ — orthographe, accents, majuscules, singulier/pluriel, mot partiel, ordre des mots inversé.\n"
  + "  3. ALIAS — prénom seul, nom seul, initiales, diminutif, ancien nom, sigle, nom commercial contre nom de molécule.\n"
  + "  4. PAR LA PERSONNE — créateur, responsable, assigné, participant, destinataire, demandeur.\n"
  + "  5. PAR L'HISTOIRE — ce qui a changé, le journal des événements, les éléments archivés ou supprimés.\n"
  + "  6. PAR LES ENTITÉS LIÉES — la société, le dossier, le produit, le contrat, la demande qui s'y rattache.\n"
  + "  7. AUTRES GRENIERS — Drive, courriers, pièces jointes des mails, RH, Finances, Legal, Regulatory, corpus.\n"
  + "Si, après avoir vraiment élargi, il n'y a toujours rien : dis-le en NOMMANT ce que tu as cherché et où — "
  + "« aucune trace sous X, Y ni Z, dans le Drive, les courriers et Legal ». Une absence se prouve, elle ne se constate pas.";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PROMESSE SANS OBJET DURABLE EST UN FAUX SUCCÈS — la troisième garde de cette famille.
 *
 * ── CE QUI L'A FAIT ÉCRIRE ──────────────────────────────────────────────────────────────
 *
 * Mesuré en conversation, et c'est le reproche qui pique le plus :
 *
 *     « Je t'avais dit de me rappeler hier quand t'as des réponses mais tu l'as pas fait. »
 *     — « Tu as raison : je ne t'ai pas prévenu. Aucun rappel ni suivi conditionnel n'était
 *        planifié. »
 *
 * Adam avait dit oui. Rien n'avait été créé. Aucune étape en échec, aucun signal, aucune trace :
 * la promesse vivait dans une phrase, et une phrase ne survit pas à la fin du tour. C'est le
 * faux succès le plus coûteux, parce que la personne, elle, a ARRÊTÉ d'y penser.
 *
 * Les deux gardes voisines traitent le même défaut ailleurs : `gardeImpossibilite` refuse un
 * « je ne peux pas » que rien n'a vérifié, `gardeAbsence` refuse un « rien trouvé » après une
 * seule façon de chercher. Celle-ci refuse un « je te préviens » que rien ne tient.
 *
 * ── CE QUI LA FAIT SE TAIRE, ET C'EST LA MOITIÉ DU TRAVAIL ──────────────────────────────
 *
 * Un refus à tort coûte un aller-retour et de la confiance (§118.27). Elle ne parle donc que
 * sur un engagement à la PREMIÈRE personne et au FUTUR — « je te préviens », « je reviens vers
 * toi », « dès que X répond, je t'écris ». Elle se tait sur le passé (« je t'ai prévenu »), sur
 * ce qui est livré dans le tour (« je te le montre ci-dessous »), sur une promesse RAPPORTÉE
 * (« Radia dit qu'elle reviendra vers toi ») et dès qu'un objet durable existe. Ce sont les
 * seules façons dont une promesse survit à la fin du tour, et c'est pour cela qu'on peut les
 * compter.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES OUTILS QUI FONT SURVIVRE UNE PROMESSE À LA FIN DU TOUR. La liste est FERMÉE : ouverte,
 * n'importe quelle lecture passerait pour un suivi.
 */
export const OUTILS_DURABLES: readonly string[] = [
  "plan_reminder",       // un rappel daté, éventuellement conditionnel, sur le canal demandé
  "watch_entity",        // une surveillance : rien ne sonne tant que tout va bien
  "run_mission",         // une mission qui ATTEND un fait puis agit
  "record_commitment",   // un engagement au registre, suivi jusqu'à son issue
  "record_decision",     // une décision à relire à une date
];

/** « Je te préviens » — première personne, futur, et c'est ADAM qui s'engage. */
const PROMESSE = [
  /\bje (?:te|vous) (?:previen|previendrai|tiendrai|rappellerai|reviendrai|relancerai|alerterai|informerai|notifierai)/,
  /\bje (?:reviens|repasse) vers (?:toi|vous)\b/,
  /\bje (?:te|vous) tiens au courant\b/,
  /\bje (?:te|vous) (?:le |la |les |)(?:dis|signale|remonte|fais savoir) (?:des|de|si|quand|apres|lorsque)\b/,
  /\bje (?:vais |)(?:surveille|surveiller|suivre|suis)\b[^.\n]{0,40}\bet (?:je |)(?:te|vous)\b/,
  /\bdes (?:qu'|que )[^.\n]{0,60}\bje (?:te|vous)\b/,
  /\bje m'en occupe et (?:je |)(?:te|vous)\b/,
];

/** Ce qui RESSEMBLE à une promesse sans en être une — et ferait refuser à tort. */
const PAS_UNE_PROMESSE = [
  // Le PASSÉ : le compte rendu d'un suivi déjà fait.
  /\bje (?:t'|vous )ai (?:prevenu|informe|rappele|alerte|tenu au courant)/,
  // Le TOUR LUI-MÊME : ce qui est livré ici n'a pas besoin de survivre.
  /\bje (?:te|vous) (?:le |la |les |)(?:montre|donne|liste|affiche|presente)\b[^.\n]{0,30}\b(?:ci-dessous|ici|maintenant|tout de suite)\b/,
  // La promesse de QUELQU'UN D'AUTRE, rapportée : ce n'est pas Adam qui s'engage.
  /\b(?:il|elle|ils|elles) (?:dit|indique|annonce|ecrit) qu'(?:il|elle)s? (?:reviendra|reviendront|previendra)/,
];

export type VerdictPromesse = "RAS" | "SANS_OBJET";

export interface EntreePromesse {
  reponse: string;
  /** Les outils appelés pendant le tour, doublons compris. */
  outilsUtilises: readonly string[];
  dejaRappele: boolean;
}

/** La réponse ENGAGE-t-elle Adam à revenir plus tard ? */
export function prometUnSuivi(reponse: string): boolean {
  const t = plier(reponse);
  if (!PROMESSE.some((r) => r.test(t))) return false;
  return !PAS_UNE_PROMESSE.some((r) => r.test(t));
}

/**
 * LA GARDE. Rend SANS_OBJET quand une promesse est faite et qu'AUCUN objet durable ne la porte.
 * Une seule relance : au second passage la réponse tient, et c'est le complément du serveur
 * (`avertirPromesseSansObjet`) qui l'empêche de rester nue.
 */
export function gardePromesse(e: EntreePromesse): VerdictPromesse {
  if (e.dejaRappele) return "RAS";
  if (!prometUnSuivi(e.reponse)) return "RAS";
  if (e.outilsUtilises.some((o) => OUTILS_DURABLES.includes(o))) return "RAS";
  return "SANS_OBJET";
}

export const RAPPEL_PROMESSE =
  "CONTRÔLE DU SERVEUR : tu viens de promettre de revenir vers la personne (« je te préviens », « je te rappelle », "
  + "« dès que… »), et AUCUN objet durable n'a été créé dans ce tour. Une promesse qui ne vit que dans une phrase "
  + "meurt à la fin du tour — la personne, elle, arrête d'y penser. C'est déjà arrivé, et le reproche a été : "
  + "« je t'avais dit de me rappeler quand t'as des réponses, tu l'as pas fait ».\n"
  + "DEUX ISSUES, PAS TROIS :\n"
  + "  1. CRÉE l'objet MAINTENANT, celui qui correspond :\n"
  + "     · une date, une heure, un délai → `plan_reminder` (« dans 2 minutes », « demain 9h », « chaque vendredi ») ; "
  + "il porte aussi `canal` (« email » pour un envoi dans sa boîte) et une échelle de relances ;\n"
  + "     · « préviens-moi SI / QUAND X change, répond, arrive » → `watch_entity` : rien ne sonne tant que tout va bien ;\n"
  + "     · « quand X arrive, FAIS Y » → `run_mission` : une surveillance prévient, elle n'agit pas ;\n"
  + "     · quelqu'un s'est engagé envers toi → `record_commitment`, suivi jusqu'à son issue.\n"
  + "  2. Si aucun ne convient — ou si `watch_entity` et `run_mission` ne sont PAS dans ta liste (les missions et "
  + "surveillances d'Adam sont réservées au Super Admin ; ne les cherche pas) — DIS-LE en clair : « je ne pourrai pas "
  + "revenir vers toi tout seul là-dessus », "
  + "et propose le geste qui le rendrait possible. Ne laisse pas la promesse debout sans rien derrière.";

/**
 * LE COMPLÉMENT, quand la seconde tentative promet encore sans rien créer. On ne censure pas la
 * réponse : on ajoute la seule phrase qui manque — celle que la personne doit lire pour ne pas
 * compter sur un suivi qui n'existe pas.
 */
export function avertirPromesseSansObjet(
  reponse: string,
  outilsUtilises: readonly string[],
  /**
   * `surveillances` : la personne a-t-elle droit aux surveillances et missions d'Adam (Super
   * Admin, §118.136) ? Sinon la phrase ne lui propose que ce qu'elle peut obtenir — proposer une
   * surveillance à qui n'y a pas droit est un remède faux, pire qu'aucun (§118.128).
   */
  opts: { surveillances?: boolean } = {},
): string | null {
  if (!prometUnSuivi(reponse)) return null;
  if (outilsUtilises.some((o) => OUTILS_DURABLES.includes(o))) return null;
  const surveillances = opts.surveillances ?? true;
  return surveillances
    ? "⚠️ Rien n'a été programmé pour ce suivi : aucun rappel, aucune surveillance, aucune mission. "
      + "Il ne survivra pas à cette conversation — demandez-moi de poser un rappel ou une surveillance si vous voulez que j'y revienne."
    : "⚠️ Rien n'a été programmé pour ce suivi : aucun rappel. Il ne survivra pas à cette conversation — "
      + "demandez-moi de poser un rappel daté si vous voulez que j'y revienne (les surveillances et missions d'Adam sont réservées au Super Admin).";
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « FAIT VÉRIFIÉ : aucun X » — la plus forte étiquette posée sur ce qu'on n'a PAS vu.
 *
 * ── LE CAS MESURÉ ───────────────────────────────────────────────────────────────────────
 *
 *     « FAIT VÉRIFIÉ : aucun rappel ni suivi conditionnel n'était planifié. »
 *
 * Cette phrase-là était juste : la table des rappels fait foi sur son propre contenu. Mais RIEN
 * dans le code ne le savait au moment de l'écrire — la même phrase après une recherche dans
 * l'index de contenu du Drive aurait porté la même étiquette, et elle aurait été fausse.
 *
 * ── CE QUE LE SOCLE SAIT DÉJÀ, ET QUE PERSONNE NE CONFRONTAIT ───────────────────────────
 *
 * `DescripteurSource.preuveNegative` dit, source par source, si une absence y est DÉMONTRABLE :
 * vrai quand un compte exhaustif est possible (une table bornée par un WHERE), faux quand la
 * couverture est partielle par nature. L'index de contenu ne couvre que les fichiers déjà
 * ingérés : « pas dans l'index » n'est PAS « pas dans le Drive ». Chaque fait du tour porte ce
 * booléen. Il ne restait qu'à le lire avant de laisser passer le mot « vérifié ».
 *
 * ── POURQUOI CETTE GARDE-CI NE FAIT PAS RECOMMENCER LE TOUR ─────────────────────────────
 *
 * Les trois autres exigent un second essai parce qu'il RESTE quelque chose à faire : chercher
 * ailleurs, élargir, créer l'objet. Ici le travail est fait — c'est le MOT qui est trop fort.
 * Refaire le tour ne changerait rien et coûterait un aller-retour (§118.27). On corrige donc
 * l'étiquette, et on dit ce qui a été couvert : une absence honnête se dit « rien trouvé dans
 * ce que j'ai pu lire », jamais « cela n'existe pas ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les formulations qui donnent à une phrase la force d'un fait établi. */
const ETIQUETTE_FORTE = [
  /\bfait verifie\b/,
  /\b(?:c'est |)(?:verifie|confirme) (?:et |)(?:certain|sur|exact)\b/,
  /\bavec certitude\b/,
  /\bde maniere certaine\b/,
  /\bje confirme (?:qu'|que )(?:il n'y a|aucun|rien|nul)/,
];

export interface EntreeAbsenceProuvable {
  reponse: string;
  /**
   * Combien de faits du tour viennent d'une source où une absence est DÉMONTRABLE
   * (`preuveNegative`). Compté par l'appelant : ce module reste pur.
   */
  faitsProuvantUneAbsence: number;
}

/**
 * TOUTE affirmation négative, et pas seulement l'échec d'une recherche.
 *
 * `affirmeUneAbsence` (au-dessus) est volontairement étroite : elle sert à faire RECHERCHER
 * encore, et l'élargir ferait relancer une recherche sur « aucun rappel n'était planifié » —
 * une phrase qui ne demande rien de tel. Ici la question est autre : la phrase AFFIRME-t-elle
 * que quelque chose n'existe pas ? Deux questions, deux détecteurs ; les confondre casserait
 * l'une des deux gardes.
 */
const AFFIRMATION_NEGATIVE = [
  /\baucun\w*\b/,
  /\brien n(?:'|e )/,
  /\bil n'y a (?:pas|aucun)/,
  /\bpas de\b/,
  /\bn'(?:existe|etait|est|a ete) (?:pas|jamais)\b/,
];

/** La réponse affirme-t-elle une absence AVEC la force d'un fait établi ? */
export function absenceDiteVerifiee(reponse: string): boolean {
  const t = plier(reponse);
  if (!AFFIRMATION_NEGATIVE.some((r) => r.test(t))) return false;
  return ETIQUETTE_FORTE.some((r) => r.test(t));
}

/**
 * LE COMPLÉMENT. `null` quand tout va bien — y compris quand une source fait RÉELLEMENT foi sur
 * l'absence, cas dans lequel « vérifié » est le mot juste et le taire serait affaiblir une
 * réponse correcte.
 */
export function avertirAbsenceNonProuvable(e: EntreeAbsenceProuvable): string | null {
  if (!absenceDiteVerifiee(e.reponse)) return null;
  if (e.faitsProuvantUneAbsence > 0) return null;
  return "⚠️ Nuance sur la formulation : aucune des sources lues ici ne permet de DÉMONTRER une absence — "
    + "elles ne couvrent qu'une partie de ce qui existe (un index ne connaît que ce qui a été ingéré). "
    + "À lire comme « rien trouvé dans ce que j'ai pu consulter », pas comme « cela n'existe pas ».";
}
