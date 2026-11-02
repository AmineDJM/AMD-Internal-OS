import { classifyReply } from "@/lib/comms/confirmation";

/**
 * LE ROUTEUR VOCAL — ce que le PDG vient de dire, traduit en UN geste canonique, sans modèle.
 *
 * POURQUOI IL EXISTE. À l'oral, dix questions sur douze sont les mêmes : « des mails ? », « mon
 * prochain rendez-vous ? », « où en est Raltegravir ? », « envoie-le », « alors ? ». Les faire
 * traverser une planification générique coûte une à trois secondes — le temps exact pendant
 * lequel une conversation cesse d'être une conversation. Un aiguillage déterministe répond dans
 * la même seconde, et il a un second mérite : il est TESTABLE. On mesure sa justesse sur un banc,
 * ce qu'on ne peut pas faire d'une intuition de modèle.
 *
 * CE QU'IL N'EST PAS. Ce n'est pas un moteur de compréhension : il reconnaît des FORMES
 * fréquentes et laisse tout le reste au modèle (`DELEGATE`). Un routeur qui essaie de tout
 * attraper attrape surtout des choses qu'il comprend mal — et un mauvais aiguillage à l'oral est
 * pire qu'une seconde d'attente, parce qu'il répond à côté avec assurance.
 *
 * LA PRUDENCE EST ASYMÉTRIQUE, comme partout dans ce système : douter renvoie au modèle
 * (`DELEGATE`), jamais vers une action. Aucune route de ce fichier n'écrit quoi que ce soit —
 * `APPROVE_PENDING` désigne une intention DÉJÀ préparée et déjà montrée, et c'est le serveur qui
 * vérifie qu'elle existe.
 */

export type VoiceRouteKind =
  /** « des mails ? », « j'ai reçu quelque chose ? » — état de la boîte. */
  | "GMAIL_INBOX"
  /** « Deepak a répondu ? » — la boîte, filtrée sur une personne. */
  | "GMAIL_FROM"
  /** « mon prochain rendez-vous ? », « c'est quoi mon agenda ? » */
  | "CALENDAR_NEXT"
  /** « où en est Raltegravir ? » — la fiche canonique d'un dossier ou produit. */
  | "RECORD_STATUS"
  /** « envoie-le », « vas-y » — approuver l'intention d'envoi qui attend. */
  | "APPROVE_PENDING"
  /** « alors ? », « et donc ? » — réclamer le résultat en cours. */
  | "RESUME_DELIVERY"
  /** « qu'est-ce qui m'attend ? » — la file de décisions. */
  | "PENDING_DECISIONS"
  /** « l'adresse de Raihana ? » — UNE personne, ses coordonnées. */
  | "DIRECTORY_LOOKUP"
  /** « les salariés et leurs mails » — LE registre, en tableau. */
  | "DIRECTORY_LIST"
  /** Tout le reste : le modèle décide. */
  /** « D'où tu tiens ça ? » — la provenance d'un fait déjà servi : le code répond depuis le registre du tour, sans modèle. */
  | "PROVENANCE"
  | "DELEGATE";

export interface VoiceRoute {
  kind: VoiceRouteKind;
  /** L'outil canonique à appeler — `null` pour APPROVE_PENDING / RESUME_DELIVERY (serveur). */
  tool: string | null;
  /** Les arguments déjà résolus. */
  args: Record<string, string>;
  /** Vrai quand la route évite la planification générique — c'est ce qu'on mesure. */
  fast: boolean;
  /** Ce qui a déclenché la route — lisible dans le journal de débogage vocal. */
  reason: string;
}

/** Ce que la conversation sait déjà — indispensable pour résoudre « la », « lui », « et X ? ». */
export interface VoiceContext {
  /** La dernière personne nommée à voix haute (« Raihana », « Deepak »). */
  lastPerson?: string | null;
  /** Le dernier dossier / produit / référence évoqué (« Raltegravir », « ORD-2026-014 »). */
  lastSubject?: string | null;
  /** La dernière route empruntée — « et Raihana ? » reprend l'intention précédente. */
  lastKind?: VoiceRouteKind | null;
  /** Une intention d'envoi attend-elle vraiment ? (le serveur le sait, pas le modèle) */
  hasPendingMail?: boolean;
  /** Un résultat est-il en cours de production ? (« alors ? » n'a de sens que si oui) */
  hasOpenDelivery?: boolean;
}

// La classe de diacritiques s'écrit ÉCHAPPÉE (\u0300-\u036f) et jamais avec les caractères
// combinants littéraux : écrits tels quels, ils se recollent au crochet dans l'éditeur et la
// classe cesse silencieusement de couvrir les accents. Le piège s'est déjà refermé deux fois
// dans ce dépôt (comms/confirmation.ts, directory/rank.ts).
const stripAccents = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Forme comparable : sans accents, sans casse, sans ponctuation, espaces normalisés. */
/**
 * La date civile d'Alger (UTC+1, sans heure d'été) au format « AAAA-MM-JJ ». Trois lignes
 * d'arithmétique recopiées plutôt qu'un import de `calendar-tz` : la frontière Adam ↔ ERP est un
 * cliquet (`src/platform/boundary.test.ts`), et un fuseau n'apprend rien à Adam sur l'ERP.
 */
function algiersYmd(date: Date): string {
  const shifted = new Date(date.getTime() + 60 * 60000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function normalizeUtterance(raw: string): string {
  return stripAccents((raw ?? "").toLowerCase())
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Les mots qui disent « la boîte mail », quelle que soit la tournure. */
const MAIL_WORDS = /\b(mail|mails|email|emails|e mail|courriel|courriels|boite|messagerie)\b/;
const RECEIVED = /\b(recu|recus|recois|arrive|arrives|repondu|repond|ecrit|nouveau|nouveaux|neuf)\b/;
/**
 * L'AGENDA SE DIT DE DEUX FAÇONS, et une seule est sans ambiguïté.
 *
 * « rendez-vous », « agenda », « planning » ne désignent que le calendrier. « réunion » non :
 * « Raconte-moi la réunion d'hier » demande un compte rendu, pas l'agenda — ouvrir le calendrier
 * là-dessus, c'est répondre à côté avec assurance. Le mot faible n'ouvre donc la route que
 * lorsqu'un repère de temps l'accompagne (« ma prochaine réunion », « mes réunions demain »).
 */
const CALENDAR_STRONG = /\b(rendez vous|rdv|agenda|calendrier|planning)\b/;
const CALENDAR_WEAK = /\b(reunion|reunions)\b/;
const NEXT_WORDS = /\b(prochain|prochaine|suivant|suivante|aujourd hui|demain|apres)\b/;
const STATUS_WORDS = /\b(ou en est|ou en sont|statut|avancement|point sur|etat de|ou ca en est)\b/;
const DECISION_WORDS = /\b(attend|attends|attendent|valider|validation|validations|decisions|en attente|arbitrer)\b/;
/** « alors ? », « et donc ? », « ça donne quoi ? » — réclamer ce qui a été promis. */
const NUDGE = /^(alors|et alors|et donc|donc|ca donne quoi|ca dit quoi|tu as trouve|tu as fini|resultat|et alors donc)$/;

/**
 * Les mots qui portent un RISQUE. Leur seule présence suffit à interdire un aiguillage rapide :
 * une phrase qui parle de supprimer, payer ou changer un salaire n'a rien à faire dans un
 * raccourci — elle passe par le chemin complet, avec ses cartes et ses confirmations.
 */
const RISKY = /\b(supprime|supprimer|efface|effacer|detruit|detruire|paie|payer|paiement|vire|virement|salaire|augmente|licencie|annule|annuler|desactive|droit|droits|permission|acces)\b/;

/**
 * CE QUI N'EST PAS UN FAIT SIMPLE. Une question causale ou comparative n'a pas de réponse en
 * base : « Pourquoi Deepak ne répond pas ? » contient le mot « répond » et partait chercher sa
 * boîte, alors qu'on demandait une explication. Un raccourci qui répond à côté est pire qu'une
 * seconde d'attente.
 */
const COMPLEX = /\b(pourquoi|comment ca se fait|comment se fait il|comment on en est|analyse|analyser|compare|comparer|synthese|synthetise|contradiction|strategie|impact|consequences|scenario|arbitre|recommande|que penses tu|ton avis|bilan)\b/;

/**
 * LES QUESTIONS SUR ADAM LUI-MÊME. « Tu as une adresse e-mail ? » contient « e-mail » et partait
 * lire la boîte du PDG. C'est le défaut d'identité constaté en production — Adam disait s'appeler
 * « Assistant IA » et n'avoir « pas d'adresse propre » — et il n'a rien à faire dans un raccourci
 * de lecture : il se répond avec ce que le serveur sait de l'identité d'Adam.
 */
/**
 * « D'OÙ TU TIENS ÇA ? » — les formes fermées par lesquelles une personne demande la SOURCE de
 * ce qu'Adam vient de dire. Volontairement étroites : « d'où vient ce retard ? » est une question
 * causale (le modèle), pas une demande de provenance ; « la source du budget » parle du budget.
 */
const PROVENANCE = new RegExp([
  "\\bd ou (tu |vous )?(tiens|tenez|sors|sortez|sais|savez|tires|tirez) (tu |vous )?(ca|cela|ce|cette|ces|le|la|les)\\b",
  "\\bd ou (vient|viennent|sort|sortent) (ce|cette|ces) (chiffre|chiffres|montant|montants|nombre|info|information|infos|donnee|donnees|date|total|valeur|resultat|reponse|conclusion)\\b",
  "\\b(ta|tes) sources?\\b", "\\bquelle est ta source\\b", "\\bquelles sont tes sources\\b", "\\bcite (tes|les) sources\\b",
  "\\bsur quoi (tu |vous )?(te|vous) (bases|basez|fondes|fondez)\\b",
  "\\bcomment (tu |vous )?(le |la )?(sais|savez)( tu| vous)?( ca| cela)?$",
  "\\b(tu es|t es|vous etes) sur(e|s)? de (ca|cela|ce chiffre|cette info|cette information|ce montant|cette date)\\b",
  "\\bc est fiable\\b", "\\bprouve (le|la|moi)\\b", "\\bqui te l a dit\\b", "\\bdis moi (d ou|ou) (ca|cela) vient\\b",
].join("|"));

const SELF = /\b(tu t appelles|tu es qui|qui es tu|comment tu t appelles|ton nom|ton adresse|tu as une adresse|ton e mail|ton email|tu es quoi)\b/;

/**
 * UNE QUESTION SUR LES CAPACITÉS — et pourquoi elle doit DÉSAMORCER la provenance.
 *
 * Mesuré au banc (§44) : « Qu'est-ce que tu sais faire en simulation, et sur quoi t'appuies-tu
 * pour dire que c'est fiable ? » était happée par `PROVENANCE` sur les trois mots « c est
 * fiable ». Adam répondait en récitant les sources du TOUR PRÉCÉDENT — c'est-à-dire à côté, en
 * zéro appel de modèle, sans que rien ne le signale.
 *
 * La phrase pose deux questions ; la provenance déterministe n'en traite aucune. Attraper une
 * phrase qu'on comprend mal est PIRE que ne rien attraper : cela empêche le modèle de bien la
 * traiter, en silence. Quand la question porte sur ce qu'Adam SAIT FAIRE, elle part au modèle,
 * qui dispose du registre (`registre_capacites`, au socle de la liste courte).
 */
export const CAPACITES_QUESTION = /\b(qu est ce que tu (sais|peux) faire|que sais tu faire|que peux tu faire|de quoi (tu es|es tu) capable|tes capacites|quelles capacites|tu sais faire (quoi|en matiere)|tu es capable de faire|ce que tu sais faire)\b/;

/**
 * L'ANNUAIRE — ce qui a coûté deux tours au PDG, en production.
 *
 * « Est-ce que tu as les adresses mail des salariés ? » partait dans la recherche fédérée,
 * rendait zéro, et Adam renonçait. Le mot « mail » suffisait à ouvrir la messagerie, alors que
 * la phrase demandait un REGISTRE de personnes. Ces deux formes doivent atteindre l'annuaire
 * directement, sans passer par le moindre choix de modèle.
 *
 * LA DISTINCTION EST NETTE, et c'est ce qui la rend fiable : un NOM PROPRE au singulier
 * (« l'email de Raihana ») demande UNE fiche ; un pluriel de personnes (« les salariés »,
 * « les contacts ») demande LA liste. Confondre les deux fait perdre un tour ; ne reconnaître
 * ni l'un ni l'autre en fait perdre deux.
 */
/**
 * LES MOTS QUI NE DÉSIGNENT QUE DES COORDONNÉES. « adresse », « numéro » n'ouvrent jamais une
 * boîte mail : ils demandent une fiche.
 *
 * « ANNUAIRE » N'EST PAS DE CETTE FAMILLE, ET IL Y ÉTAIT. Une coordonnée est une DONNÉE qu'on
 * réclame (« l'adresse de Raihana ») ; « annuaire » est le NOM DU REGISTRE, et un nom peut être
 * le SUJET de n'importe quelle phrase — une question sur lui, une plainte à son propos, une
 * comparaison. Mesuré : sur dix phrases ordinaires qui contiennent le mot, SEPT partaient en
 * raccourci et rendaient le registre entier. « C'est quoi l'annuaire ? », « l'annuaire est pas à
 * jour, qui s'en occupe ? », « l'annuaire me sert à quoi ? », « est-ce qu'il est relié aux fiches
 * RH ? » — la personne recevait la liste des salariés. Le mot est parti dans `REGISTRE`, où il
 * faut de surcroît qu'on le DEMANDE.
 */
const CONTACT_ONLY = /\b(adresse|adresses|numero|numeros|telephone|telephones|coordonnees|joindre|joins|contacter|contacte|whatsapp)\b/;

/**
 * LE NOM DU REGISTRE — un seul mot, parce qu'il n'en a qu'un ici.
 *
 * En lister d'autres « par symétrie » (organigramme, trombinoscope) ferait répondre le registre
 * du personnel à une demande d'organigramme, qui a son propre écran. Le vocabulaire est FERMÉ :
 * l'élargir est une décision de revue de code.
 */
const REGISTRE = /\b(annuaire)\b/;

/**
 * LES MOTS QUI NE DISENT RIEN DE PLUS — pour juger si la phrase est JUSTE le registre.
 *
 * « annuaire », « l'annuaire », « l'annuaire svp » sont des demandes ; « c'est quoi l'annuaire »
 * n'en est pas une. La liste est celle des articles, possessifs et formules de politesse, et
 * elle est FERMÉE : y verser un verbe ferait passer une question pour une demande.
 */
const MOTS_ACCESSOIRES = new Set([
  "l", "le", "la", "les", "un", "une", "d", "de", "du", "des", "mon", "ma", "notre",
  "stp", "svp", "please", "merci", "adam", "et", "c", "ca",
]);

/** La phrase ne dit RIEN d'autre que le registre. */
function registreSeul(text: string): boolean {
  return text.split(" ").filter((m) => m.length > 0 && !REGISTRE.test(m) && !MOTS_ACCESSOIRES.has(m)).length === 0;
}

/**
 * « MAIL » EST AMBIGU, ET C'EST LE POSSESSIF QUI TRANCHE.
 *
 * « l'email DE Raihana » demande une fiche d'annuaire ; « DES mails DE Deepak » demande la
 * boîte. Le mot est le même, la construction ne l'est pas : article défini singulier + « de »
 * = la coordonnée d'une personne ; partitif ou pluriel = du courrier reçu.
 *
 * Sans cette distinction, la première version envoyait « Des mails de Deepak ? » vers l'annuaire
 * — le test l'a montré du premier coup.
 */
const MAIL_AS_CONTACT = /\b(l email|l e mail|le mail|le courriel|son mail|son email|sa messagerie)\s+(de|du|des|d)\b/;
const PEOPLE_PLURAL = /\b(salaries|employes|personnel|effectif|collaborateurs|contacts|equipes)\b/;
/**
 * Ce qui réclame une LISTE plutôt qu'une fiche.
 *
 * « annuaire » en a été retiré pour la même raison qu'au-dessus : il ne demande rien, il est ce
 * qu'on demande. Tant qu'il y figurait, `plural && LIST_WORD` était satisfait par le seul mot,
 * et une phrase qui le mentionnait valait un ordre de lister.
 */
const LIST_WORD = /\b(liste|lister|tous|toutes|chacun|donne|donne moi|montre|montre moi|sors)\b/;
/** « Qui travaille au service réglementaire ? » — le registre, filtré. */
/**
 * « Qui travaille au réglementaire ? » filtre le registre par service.
 *
 * La préposition « en » a été RETIRÉE de la liste, et ce n'est pas un détail : avec elle,
 * « Qui est EN CONGÉ cette semaine ? » interrogeait l'annuaire sur un service imaginaire nommé
 * « congé cette semaine ». Un congé n'est pas un département — c'est une question RH, et elle
 * doit suivre le chemin structuré.
 */
const WORKS_AT = /\bqui (travaille|bosse|est) (au|a la|aux|dans|chez)\s+(.+)$/;
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN OBJET NOMMÉ FERME LES RACCOURCIS — une seule liste, deux lectures.
 *
 * LA RÈGLE ÉTAIT DÉJÀ ÉCRITE DANS CE FICHIER, et elle ne gardait que deux portes sur quatre :
 * « quand un nom de domaine concurrent est présent, on rend la main ». La boîte mail et la file
 * de décisions la consultaient ; l'ANNUAIRE, non — il n'avait qu'un sous-ensemble de seize mots
 * (les documents), et seulement sur l'une de ses quatre entrées. Mesuré, avec la liste EXISTANTE
 * qui aurait suffi à les refuser :
 *
 *   « peux-tu joindre le PDF au courrier ? »          → fiche d'une personne « pdf courrier »
 *   « il faut joindre la facture à la demande »        → fiche d'une personne « facture demande »
 *   « le numéro du dossier ANPP c'est quoi ? »         → fiche d'une personne « dossier anpp »
 *   « quel est le numéro de la facture de Kwality ? »  → fiche d'une personne « kwality »
 *   « l'adresse de livraison de la commande PCH ? »    → fiche d'une personne « commande pch »
 *
 * « joindre » veut dire ATTACHER aussi souvent que JOINDRE QUELQU'UN : la personne demandait une
 * pièce jointe et recevait une recherche d'annuaire sur rien. Et le raccourci ne se contente pas
 * de choisir l'outil — il envoie ZÉRO schéma d'outil au modèle et ne lui donne que la sortie à
 * reformuler. Se tromper de porte RETIRE donc au modèle tout moyen de faire autrement, en
 * silence. C'est §104.5 mot pour mot, écrit pour l'autre décodeur de ce dépôt : « attraper une
 * phrase qu'on comprend mal est PIRE que ne rien attraper ».
 *
 * POURQUOI LA LISTE NE POUVAIT PAS ÊTRE BRANCHÉE TELLE QUELLE — et c'est tout l'intérêt de la
 * scinder : elle contient « salarié » et « employé », qui sont des objets CONCURRENTS pour la
 * boîte mail et le SUJET MÊME de l'annuaire. La brancher entière aurait refusé « les salariés et
 * leurs mails », c'est-à-dire le cas canonique — un refus à tort, plus coûteux que le défaut
 * qu'on corrige (§118.27). Deux questions, deux lectures, UNE liste : la recopier ferait deux
 * vocabulaires qui divergent au premier objet ajouté (§118.5).
 *
 * ET QUATRE ALTERNATIVES ÉTAIENT MORTES. Écrite en littéral, la liste portait `optimis\\w*` —
 * un antislash ÉCHAPPÉ dans une regex littérale, donc « optimis » suivi d'un antislash, donc
 * rien qu'une phrase française contienne. Mesuré : `optimis\\w*`, `maximis\\w*`, `minimis\\w*` et
 * `ordonnanc\\w*` ne s'accrochaient à RIEN. Une garde qui porte des alternatives qui ne peuvent
 * pas se déclencher est désarmée en ayant l'air armée (§118.88) ; en tableau de chaînes, la
 * forme correcte s'écrit une seule fois et se lit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/** Les objets de l'ERP — ni des personnes, ni des documents. */
const OBJETS_ERP = [
  "paiement", "paiements", "facture", "factures", "conge", "conges", "sponsoring",
  "commande", "commandes", "evenement", "evenements", "demande", "demandes", "stock", "stocks",
  // Les lieux de stock SONT des objets de l'ERP : « les coordonnées de l'entrepôt de Rouiba »
  // partait chercher une personne nommée « rouiba ».
  "entrepot", "entrepots", "depot", "depots",
  "budget", "engagement", "engagements", "recrutement", "salaire", "salaires",
  "webhook", "webhooks", "faits? externes?", "docusign", "hubspot", "iqvia", "sap",
  "signature", "signatures", "enveloppe", "enveloppes", "connecteur", "connecteurs", "ingestion",
  "simulation", "simule", "simuler", "monte.?carlo", "tirages",
  "optimis\\w*", "maximis\\w*", "minimis\\w*", "allocation", "chemin critique", "ordonnanc\\w*",
  "planning", "gantt", "regression", "correlation", "segmentation", "clustering",
  "prevision", "previsions", "anomalies", "statistique", "statistiques",
];

/** Les objets qu'on LIT — « dossier », « contrat » et « courrier » en font partie. */
const OBJETS_DOCUMENT = [
  "drive", "document", "documents", "fichier", "fichiers", "dossier", "dossiers",
  "contrat", "contrats", "courrier", "courriers",
  "note", "notes", "pdf", "classeur", "deck", "presentation", "resume", "resumer",
  "rapport", "compte rendu", "pv",
];

/**
 * Les mots qui nomment des PERSONNES. Concurrents pour la boîte mail — « les mails des
 * salariés » n'est pas l'état de MA boîte — et sujet légitime de l'annuaire.
 */
const PERSONNES_CONCURRENTES = ["salarie", "salaries", "employe", "employes"];

const ou = (...familles: readonly string[][]): RegExp =>
  new RegExp(`\\b(${familles.flat().join("|")})\\b`);

/** Les mots qui occupent la place d'un nom sans en être un — cf. `personAfter`. */
const NOT_A_NAME = new Set([
  "moi", "toi", "lui", "elle", "nous", "vous", "eux", "ce", "cet", "cette", "ces",
  "le", "la", "les", "un", "une", "des", "mon", "ma", "mes", "son", "sa", "ses",
  "notre", "nos", "leur", "leurs", "qui", "quoi", "quel", "quelle", "tout", "tous",
  "societe", "entreprise", "boite", "service", "equipe",
  // LES LIEUX ET LES UNITÉS D'ORGANISATION. Mesuré : « c'est quoi l'adresse du siège social ? »
  // interrogeait l'annuaire sur une personne nommée « siege social ». Ce ne sont pas des noms de
  // personnes, et une fois filtrés il ne reste RIEN — la phrase retombe alors sur « un mot de
  // coordonnées sans cible identifiable ne prend PAS de raccourci », qui est la bonne issue.
  "siege", "social", "agence", "filiale", "direction", "bureau", "bureaux",
  "site", "locaux", "usine", "batiment",
]);

/**
 * LE NOM VISÉ PAR UNE DEMANDE DE COORDONNÉES.
 *
 * On lit le texte NORMALISÉ ici, contrairement au filtrage de la boîte mail : « l'email de
 * raihana » dicté sans majuscule doit fonctionner. Le risque de faux positif est bien moindre —
 * la phrase contient déjà un mot de coordonnées, donc ce qui suit « de » est presque toujours
 * la personne cherchée.
 */
function contactTarget(text: string): string | null {
  const words = text.split(" ").filter(Boolean);
  // « joindre X » / « contacter X » : le nom suit directement le verbe.
  for (const verb of ["joindre", "joins", "contacter", "contacte"]) {
    const i = words.indexOf(verb);
    if (i >= 0) {
      const rest = words.slice(i + 1).filter((w) => w.length >= 3 && !NOT_A_NAME.has(w));
      if (rest.length > 0) return rest.slice(0, 2).join(" ");
    }
  }
  // Sinon : ce qui suit le DERNIER « de / du / des / d ».
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (["de", "du", "des", "d"].includes(words[i])) {
      const rest = words.slice(i + 1).filter((w) => w.length >= 3 && !NOT_A_NAME.has(w));
      if (rest.length > 0) return rest.slice(0, 2).join(" ");
    }
  }
  return null;
}

/**
 * LES NOMS QUI DISENT « CE N'EST NI LA BOÎTE NI MA FILE DE DÉCISIONS ».
 *
 * « Combien de paiements en attente ? » ouvrait la file de décisions du PDG ; « Quels documents
 * sont arrivés cette semaine ? » ouvrait sa boîte mail. Les deux raccourcis se déclenchaient sur
 * un mot isolé (« attente », « arrivés ») alors que la phrase nommait explicitement un AUTRE
 * objet. Quand un nom de domaine concurrent est présent, on rend la main : le chemin complet sait
 * lire une facture, un congé ou un document ; le raccourci, non.
 */
/**
 * UN PROBLÈME À CALCULER N'EST PAS UNE LECTURE (mandat 5 §39).
 *
 * « Dossier ANPP, planning : la rédaction prend 6 jours… en combien de jours le dossier part-il ? »
 * porte le mot « planning », et la voie rapide y lisait un AGENDA : `read_calendar` rendait
 * « aucune donnée sur le planning » — une réponse fausse et sûre d'elle, alors que la phrase
 * contenait TOUTES ses données. Le banc l'a montré.
 *
 * Ces expressions-là nomment une MÉTHODE, jamais un décor : « chemin critique », « loi
 * triangulaire », « probabilité de perte », « prix marginal » n'ont pas d'autre sens. Quand
 * l'une d'elles paraît, aucune voie rapide ne prend la main : la question va aux moteurs.
 */
export const CALCUL_EXPLICITE = /\b(monte.?carlo|loi (normale|triangulaire|uniforme|log.?normale|de poisson|pert)|probabilite de (perte|perdre|depasser|reussite)|p10|p90|percentile|percentiles|chemin critique|marge par heure|programmation lineaire|nombres entiers|prix marginal|prix marginaux|sac a dos|combien produire|allocation optimale|repartition optimale|affectation optimale|maximiser (la|le|les|notre|nos)|minimiser (la|le|les|notre|nos)|regression (lineaire|logistique|multiple)|test statistique|significativite|intervalle de confiance|composantes principales|k.?moyennes|silhouette|holt.?winters|saisonnalite|tirages|hors echantillon)\b/;

/**
 * UNE QUESTION DE RELATION EST UNE QUESTION DE GRAPHE (mandat 5 §40).
 *
 * « Comment le produit X est-il relié à la société Y ? » — mesuré au banc : la recherche
 * documentaire y répondait « aucune chaîne n'est enregistrée » alors qu'un lien déclaré existait,
 * à un intermédiaire de distance. Un faux négatif dit avec aplomb est le pire des résultats :
 * il ferme la question. Chercher un CHEMIN n'est pas chercher un DOCUMENT.
 */
export const RESEAU_EXPLICITE = /\b(relie a|reliee a|relies a|reliees a|lie a|liee a|lies a|liees a|quel lien|quels liens|quelle relation|quelles relations|lien entre|liens entre|relation entre|relations entre|comment sommes nous lies|comment est.?il lie|comment est.?elle liee|chaine d.intermediaires|intermediaires entre|qui connait|qui relie|point de passage|si (il|elle|cette personne|ce contrat|ce fournisseur) (part|saute|disparait))\b/;

/**
 * DES DONNÉES COLLÉES DANS LE MESSAGE (mandat 5 §41).
 *
 * « J'ai reçu un export de notre distributeur, je te le recopie » suivi de trois lignes
 * séparées par des points-virgules : mesuré au banc, le mot « reçu » envoyait la question à la
 * BOÎTE MAIL, qui répondait « le compte Google n'est pas connecté ». La personne avait pourtant
 * mis toutes ses données dans la phrase.
 *
 * Deux lignes ou plus portant le MÊME séparateur au même endroit, ce n'est pas une phrase :
 * c'est un tableau. On ne va pas chercher ailleurs ce qu'on a déjà sous les yeux.
 */
export function contientDonneesCollees(raw: string): boolean {
  const lignes = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 3);
  if (lignes.length < 2) return false;
  for (const sep of [";", "\t", "|"]) {
    const avec = lignes.filter((l) => l.split(sep).length >= 3);
    if (avec.length >= 2) return true;
  }
  // La virgule demande plus de prudence : une phrase en contient. On exige une RÉGULARITÉ stricte.
  const parVirgule = lignes.map((l) => l.split(",").length).filter((n) => n >= 3);
  return parVirgule.length >= 3 && new Set(parVirgule).size === 1;
}

/** LA BOÎTE ET LA FILE DE DÉCISIONS : tout objet nommé rend la main, personnes comprises. */
const OTHER_DOMAIN = ou(OBJETS_ERP, OBJETS_DOCUMENT, PERSONNES_CONCURRENTES);

/**
 * L'ANNUAIRE : tout objet nommé SAUF les personnes, qui sont ce qu'il contient.
 *
 * La différence entre les deux porte sa raison, et un banc la vérifie DANS LES DEUX SENS : sans
 * elle, une garde trop large refuserait le registre à qui le demande.
 */
const OBJET_HORS_ANNUAIRE = ou(OBJETS_ERP, OBJETS_DOCUMENT);

/**
 * QUI EST NOMMÉ DERRIÈRE « DE » — et pourquoi on exige la MAJUSCULE.
 *
 * « Des mails de Deepak » nomme un expéditeur. « Quelque chose de nouveau dans la boîte » n'en
 * nomme aucun : « de » y est une préposition ordinaire. Sur le texte normalisé (tout en bas de
 * casse) les deux sont indiscernables, et le routeur filtrait la boîte sur « nouveau ».
 *
 * On lit donc l'énoncé BRUT, où la transcription a conservé la majuscule des noms propres. Et
 * quand elle manque, on ne devine pas : on rend la boîte ENTIÈRE. L'asymétrie est la même que
 * partout ici — une lecture trop large fait perdre une phrase de tri, un filtre erroné répond
 * « rien de Nouveau » avec aplomb, ce qui est faux et se croit vrai.
 */
const NAMED_SENDER = /\b(?:de|d'|d’|chez|par)\s+([A-ZÀ-ÖØ-Þ][\p{L}'’-]{2,})/u;

function namedSender(raw: string): string | null {
  const m = NAMED_SENDER.exec(raw ?? "");
  if (!m) return null;
  const candidate = normalizeUtterance(m[1]);
  return candidate.length >= 3 && !STOP_AFTER.has(candidate) ? candidate : null;
}
const STOP_AFTER = new Set(["moi", "toi", "lui", "elle", "nous", "vous", "ce", "cette", "la", "le", "les", "mon", "ma", "mes", "aujourd", "hui", "quoi", "qui"]);

/** Un pronom qui renvoie à quelqu'un déjà nommé : « relance-la », « écris-lui ». */
const PRONOUN_PERSON = /\b(la|le|lui|leur|les)\b$/;

/**
 * Ce qui occupe la place d'un nom sans en être un. « Elle a répondu ? » désigne quelqu'un — la
 * personne du tour précédent ; « on a répondu ? » n'en désigne aucune. Dans les deux cas,
 * filtrer la boîte sur ce mot ne rendrait rien : on résout, ou on rend la boîte entière.
 */
const SUBJECT_PRONOUN = new Set(["il", "elle", "ils", "elles", "on", "tu", "vous", "quelqu", "ca", "personne", "quelqu un"]);

/**
 * LES VERBES QUI ORDONNENT — et pourquoi ils ferment les raccourcis de LECTURE.
 *
 * « Demande à Regulatory ce qu'ils attendent » contient « attendent » : la file de décisions du
 * PDG s'ouvrirait, alors qu'il demandait qu'on écrive à un service. C'est l'erreur la plus chère
 * du routeur — pas une seconde perdue, une réponse à côté, dite avec aplomb. Une phrase qui
 * COMMENCE par un ordre est une action : elle va au modèle, qui sait préparer, montrer et faire
 * confirmer. Le raccourci sert à répondre vite, jamais à agir vite.
 */
const ACTION_VERB = /^(demande|demandez|dis|dites|ecris|ecrivez|envoie|envoyez|transmets|transmet|transfere|relance|relances|appelle|appelez|assigne|assignes|attribue|confie|prepare|prepares|redige|ajoute|cree|creer|planifie|programme|invite|reponds|repondez|rappelle|note|marque|change|mets|met|deplace|reserve|commande|valide|valides|approuve|refuse|rejette)\b/;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ÉCRIRE N'EST PAS LIRE — le défaut d'une seule inflexion.
 *
 * En production : « tu peux envoyé un mail à Khaled ? ». Adam a cherché dans la messagerie, n'y a
 * trouvé aucun Khaled, et répondu « je n'ai pas son adresse e-mail » — alors que l'annuaire, lui,
 * l'avait, et que la description de `directory_lookup` interdit textuellement cette phrase.
 *
 * LA CAUSE TIENT EN UNE LETTRE. Le PDG a écrit le PARTICIPE (« envoyé »), pas l'impératif
 * (« envoie »). Normalisé, cela donne `envoye` — absent de `ACTION_VERB` comme de la liste du
 * routeur, parce que `envoyer` est le seul verbe de la famille dont le radical d'impératif
 * (`envoi-`) diffère du radical d'infinitif (`envoy-`). Les deux gardes qui devaient arrêter la
 * phrase l'ont donc laissée filer, et le raccourci « état de la boîte » l'a avalée : il lui
 * suffisait du mot « mail ».
 *
 * CE QU'ON NE FAIT PAS. Ajouter `envoye` à la liste des impératifs corrigerait CE cas et ferait
 * de « Envoyé ? » — question parfaitement légitime sur un courrier déjà parti — un ordre d'envoi.
 * On ne rattrape pas une classification par une exception.
 *
 * CE QUI SÉPARE VRAIMENT LES DEUX : le DESTINATAIRE. Une boîte se lit ; elle ne se lit pas
 * « à quelqu'un ». Dès qu'un verbe d'envoi, un nom de courrier et une adresse cohabitent, la
 * phrase est SORTANTE, quelle que soit l'orthographe du verbe — et aucun raccourci de lecture
 * n'a le droit de l'avaler.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const SEND_VERB = /\b(envoi|envoie|envoies|envoye|envoyes|envoyer|envoyez|renvoie|renvoye|renvoyer|transmet|transmets|transmettre|transmis|adresse|adresser|expedie|expedier|redige|rediger|ecris|ecrire|ecrivez)\b/;
const MAIL_NOUN = /\b(mail|mails|email|emails|e mail|courriel|courriels|message|messages|courrier|mot|note)\b/;
const ADDRESSEE = /\b(?:a|au|aux)\s+([a-z]{2,})\b/;

/**
 * Ce qui suit « à » sans être un destinataire. « Des mails à traiter » n'adresse rien à personne.
 *
 * La liste est FERMÉE et courte, et c'est volontaire : deviner qu'un mot est un infinitif à sa
 * terminaison écarterait Nadir, Kader et Amir. Un infinitif absent d'ici fait perdre le
 * raccourci de lecture — jamais une capacité : la phrase part au modèle, qui sait trancher.
 */
const NOT_AN_ADDRESSEE = new Set([
  "traiter", "lire", "relire", "repondre", "envoyer", "faire", "voir", "classer", "archiver",
  "valider", "signer", "verifier", "transmettre", "imprimer", "payer", "regler", "suivre",
  "corriger", "completer", "preparer", "rediger", "trier", "supprimer", "relancer",
]);

/** Un courrier ADRESSÉ à quelqu'un — donc une écriture, jamais une lecture de boîte. */
export function isOutboundMail(text: string): boolean {
  if (!SEND_VERB.test(text) || !MAIL_NOUN.test(text)) return false;
  const m = ADDRESSEE.exec(text);
  return m !== null && !NOT_AN_ADDRESSEE.has(m[1]);
}

/**
 * LE PREMIER MOT DE LA PHRASE DÉCIDE SOUVENT — mais pas seul.
 *
 * L'ordre des tests n'est pas cosmétique : l'accord (« envoie-le ») se teste AVANT la boîte
 * mail, sinon « envoie-le » partirait chercher des messages ; et le risque se teste avant tout,
 * parce qu'aucune économie de latence ne vaut une action mal comprise.
 */
export function routeVoiceUtterance(raw: string, ctx: VoiceContext = {}): VoiceRoute {
  const text = normalizeUtterance(raw);
  if (!text) return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "vide" };
  // ── 0. LE RISQUE FERME TOUS LES RACCOURCIS ──────────────────────────────────────────────
  // Une phrase qui touche à l'argent, aux droits ou à une suppression traverse le chemin
  // complet : cartes, confirmations, vérifications. On ne gagne pas une seconde là-dessus.
  if (RISKY.test(text)) {
    return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "vocabulaire sensible — pas de raccourci" };
  }

  // ── 0 bis. UN PROBLÈME À CALCULER FERME AUSSI LES RACCOURCIS (§39) ──────────────────────
  // « planning », « dossier », « budget » sont des mots de décor ; « chemin critique », « loi
  // triangulaire », « probabilité de perte » nomment une MÉTHODE. Quand la phrase porte sa
  // propre arithmétique, la lire comme un agenda rend « aucune donnée » — faux, et sûr de soi.
  if (CALCUL_EXPLICITE.test(text) || RESEAU_EXPLICITE.test(text)) {
    return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "problème à calculer ou à parcourir — les moteurs, pas une lecture" };
  }

  // ── 0 ter. LES DONNÉES SONT DÉJÀ LÀ (§41) ───────────────────────────────────────────────
  // Un tableau collé dans le message se lit ; il ne se cherche pas dans la boîte mail.
  if (contientDonneesCollees(raw)) {
    return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "des données sont collées dans le message — elles se lisent, elles ne se cherchent pas" };
  }

  // ── 1. L'ACCORD — « envoie-le », « vas-y », « je confirme » ─────────────────────────────
  // Il ne vaut que si une intention attend RÉELLEMENT : sans cela, « envoie » est une demande
  // neuve, pas une approbation, et la confondre expédierait le mauvais message.
  if (ctx.hasPendingMail && classifyReply(raw) === "CONFIRM") {
    return { kind: "APPROVE_PENDING", tool: null, args: {}, fast: true, reason: "accord sur l'envoi en attente" };
  }

  // ── 1 bis-a. « D'OÙ TU TIENS ÇA ? » — LA PROVENANCE SE LIT, ELLE NE SE RAISONNE PAS ─────
  // Une provenance paraphrasée par un modèle est une provenance inventée à moitié : le code
  // relit le registre des faits du tour précédent et répond (§22 du mandat 4). Testée avant les
  // questions sur Adam et avant le raisonnement : « comment tu sais ça ? » n'est ni l'un ni l'autre.
  // La garde `CAPACITES_QUESTION` : une phrase qui demande d'abord CE QU'ADAM SAIT FAIRE n'est
  // pas une demande de provenance, même quand elle contient « c'est fiable » (défaut mesuré §44).
  if (PROVENANCE.test(text) && !CAPACITES_QUESTION.test(text)) {
    return { kind: "PROVENANCE", tool: null, args: {}, fast: true, reason: "provenance d'un fait déjà servi — le code relit ses lectures" };
  }

  // ── 1 ter. NI UNE EXPLICATION, NI UNE QUESTION SUR ADAM ─────────────────────────────────
  // Testées après l'accord (« envoie-le » reste une approbation) et avant toute lecture.
  if (SELF.test(text)) {
    return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "question sur Adam lui-même" };
  }
  if (COMPLEX.test(text)) {
    return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "question causale ou comparative — pas un fait simple" };
  }

  // ── 1 bis. UN ORDRE N'EST PAS UNE QUESTION ──────────────────────────────────────────────
  // Testé APRÈS l'accord (« envoie-le » reste une approbation quand une intention attend) et
  // AVANT toutes les lectures. On résout quand même le pronom au passage : « relance-la » part
  // au modèle, mais avec « la » déjà traduit — c'est le seul travail que le routeur sait faire
  // ici sans risquer de se tromper de geste.
  if (ACTION_VERB.test(text) || isOutboundMail(text)) {
    const who = PRONOUN_PERSON.test(text) ? ctx.lastPerson ?? null : null;
    return {
      kind: "DELEGATE", tool: null, fast: false,
      args: who ? { resolvedPerson: who } : {},
      reason: who ? `ordre — pronom résolu vers ${who}` : "ordre — le modèle prépare l'action",
    };
  }

  // ── 2. « ALORS ? » — réclamer ce qui a été promis ───────────────────────────────────────
  // Le PDG ne devrait jamais avoir à le dire (c'est tout l'objet de l'obligation de
  // restitution) ; quand il le dit quand même, la réponse est le résultat en cours, pas une
  // nouvelle recherche.
  if (NUDGE.test(text)) {
    return ctx.hasOpenDelivery
      ? { kind: "RESUME_DELIVERY", tool: null, args: {}, fast: true, reason: "relance d'un résultat en cours" }
      : { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "relance sans travail en cours" };
  }

  // ── 3. LE SUIVI ELLIPTIQUE — « et Raihana ? » ───────────────────────────────────────────
  // Même intention, entité substituée. Sans ça, la conversation redémarre à zéro à chaque nom.
  const elliptic = /^et\s+(.+)$/.exec(text);
  if (elliptic && ctx.lastKind && ctx.lastKind !== "DELEGATE") {
    const who = elliptic[1].trim();
    if (who.length >= 3) {
      if (ctx.lastKind === "GMAIL_FROM" || ctx.lastKind === "GMAIL_INBOX") {
        return { kind: "GMAIL_FROM", tool: "gmail_search", args: { from: who }, fast: true, reason: "suivi elliptique (boîte)" };
      }
      if (ctx.lastKind === "RECORD_STATUS") {
        return { kind: "RECORD_STATUS", tool: "inspect_record", args: { reference: who }, fast: true, reason: "suivi elliptique (dossier)" };
      }
    }
  }

  // ── 3 bis. L'ANNUAIRE — AVANT la boîte mail, et ce n'est pas négociable ─────────────────
  // « Quel est l'email de Raihana ? » contient « email » : placée après, cette demande ouvrirait
  // la messagerie du PDG au lieu de l'annuaire. C'est exactement le tour perdu observé en
  // production, et l'ordre des portes est le seul remède.
  const contactOnly = CONTACT_ONLY.test(text);
  const mailAsContact = MAIL_AS_CONTACT.test(text);
  const plural = PEOPLE_PLURAL.test(text);
  // Trois entrées, et aucune n'est le simple mot « mail » : c'est ce qui empêche la boîte du PDG
  // d'être confondue avec le registre des personnes.
  //
  // UN OBJET DE L'ERP NOMMÉ DANS LA PHRASE FERME LES QUATRE ENTRÉES, et non plus la seule
  // `WORKS_AT`. « Résume-moi la note fournisseur Kwality QUI EST DANS mon Drive » : le relatif
  // porte sur la note, pas sur une personne, et c'est pour ce cas que la garde documentaire
  // avait été écrite — sur UNE porte. Les trois autres passaient : « joindre le PDF au
  // courrier » interrogeait l'annuaire sur une personne nommée « pdf courrier ». Voir le bloc
  // de `OBJET_HORS_ANNUAIRE` pour les cinq mesures.
  const objetNomme = OBJET_HORS_ANNUAIRE.test(text);
  // LE REGISTRE EST DEMANDÉ, pas seulement MENTIONNÉ. Il faut un mot de demande (« donne »,
  // « montre », « liste »), ou que la phrase ne dise RIEN d'autre (« l'annuaire »). Sans cette
  // condition, la seule présence du mot valait un ordre de lister : mesuré, sept phrases
  // ordinaires sur dix rendaient le registre entier à la place d'une réponse.
  const demandeLeRegistre = REGISTRE.test(text) && (LIST_WORD.test(text) || registreSeul(text));
  if (!objetNomme && (contactOnly || mailAsContact || (plural && LIST_WORD.test(text)) || demandeLeRegistre || WORKS_AT.test(text))) {
    const wantsList = demandeLeRegistre
      || (plural && (contactOnly || mailAsContact || LIST_WORD.test(text)));

    const worksAt = WORKS_AT.exec(text);
    if (worksAt) {
      const dept = worksAt[3].trim();
      return {
        kind: "DIRECTORY_LIST", tool: "directory_list",
        args: dept.length >= 3 ? { department: dept } : {},
        fast: true, reason: "registre filtré sur un service",
      };
    }
    if (wantsList) {
      return { kind: "DIRECTORY_LIST", tool: "directory_list", args: {}, fast: true, reason: "registre des personnes" };
    }
    if (!plural) {
      const who = contactTarget(text) ?? (PRONOUN_PERSON.test(text) ? normalizeUtterance(ctx.lastPerson ?? "") : "");
      if (who) {
        return { kind: "DIRECTORY_LOOKUP", tool: "directory_lookup", args: { name: who }, fast: true, reason: "coordonnées d'une personne" };
      }
    }
    // Un mot de coordonnées sans cible identifiable ne prend PAS de raccourci : mieux vaut le
    // chemin complet qu'un annuaire interrogé sur rien.
  }

  // ── 4. LA BOÎTE MAIL ────────────────────────────────────────────────────────────────────
  const asksMail = MAIL_WORDS.test(text);
  const asksReceived = RECEIVED.test(text);
  // « réunion » seul ne suffit pas à ouvrir l'agenda — il lui faut un repère de temps.
  const asksCalendar = CALENDAR_STRONG.test(text) || (CALENDAR_WEAK.test(text) && NEXT_WORDS.test(text));

  // « Deepak a répondu ? » — une personne + un verbe de réception, sans qu'on parle de « mail ».
  const namedReply = /^([a-z]{2,})\s+(a\s+)?(repondu|a ecrit|ecrit|repond)\b/.exec(text);
  if (namedReply) {
    // « Elle a répondu ? » ne nomme personne : le nom est dans le tour précédent. Sans contexte,
    // filtrer la boîte sur le mot « elle » ne rendrait rien — mieux vaut la boîte entière.
    const spoken = namedReply[1];
    const who = SUBJECT_PRONOUN.has(spoken) ? ctx.lastPerson ?? null : spoken;
    if (who) {
      return {
        kind: "GMAIL_FROM", tool: "gmail_search", args: { from: who }, fast: true,
        reason: SUBJECT_PRONOUN.has(spoken) ? `réponse attendue — pronom résolu vers ${who}` : "réponse attendue d'une personne",
      };
    }
    return { kind: "GMAIL_INBOX", tool: "gmail_search", args: {}, fast: true, reason: "réponse attendue, personne non résolue" };
  }
  // Le raccourci « boîte » ne vaut que si la phrase ne nomme pas explicitement un AUTRE objet :
  // « Donne-moi les salariés et leurs e-mails » parle du registre RH, pas de la messagerie.
  // LE REGISTRE NOMMÉ FERME AUSSI LA BOÎTE, et c'est ce fichier qui l'avait prédit : « placée
  // après, cette demande ouvrirait la messagerie du PDG au lieu de l'annuaire ». Tant que
  // « annuaire » vivait dans les mots de coordonnées, la porte 3 bis servait de barrière ; elle
  // ne la sert plus, donc la barrière se dit ici. Mesuré : « je trouve pas Amel dans l'annuaire,
  // tu peux vérifier son email ? » ouvrait la boîte du dirigeant.
  if ((asksMail || (asksReceived && !asksCalendar)) && !OTHER_DOMAIN.test(text) && !REGISTRE.test(text)) {
    const who = namedSender(raw);
    if (who) return { kind: "GMAIL_FROM", tool: "gmail_search", args: { from: who }, fast: true, reason: "boîte filtrée sur une personne nommée" };
    return { kind: "GMAIL_INBOX", tool: "gmail_search", args: {}, fast: true, reason: "état de la boîte" };
  }

  // ── 5. L'AGENDA ─────────────────────────────────────────────────────────────────────────
  if (asksCalendar) {
    // LE JOUR DEMANDÉ DEVIENT L'ARGUMENT QUE L'OUTIL LIT. « demain » et « aujourd'hui » se
    // traduisent en date d'Alger ; « prochain » et les formes sans jour laissent l'outil rendre
    // les prochains événements. L'ancien argument (`horizon`) n'existait pas dans le schéma de
    // l'outil : il était ignoré en silence, et « mes réunions de demain » rendait celles de la
    // semaine — le test de contrat routeur → outil l'a attrapé.
    const jour = /\bdemain\b/.test(text)
      ? algiersYmd(new Date(Date.now() + 86_400_000))
      : /\b(aujourd hui|ce matin|cet apres midi|cette apres midi|ce soir|ce midi)\b/.test(text)
        ? algiersYmd(new Date())
        : null;
    return { kind: "CALENDAR_NEXT", tool: "read_calendar", args: jour ? { date: jour } : {}, fast: true, reason: "agenda" };
  }

  // ── 6. L'ÉTAT D'UN DOSSIER — « où en est Raltegravir ? » ────────────────────────────────
  if (STATUS_WORDS.test(text)) {
    const subject = subjectAfterStatus(text) ?? ctx.lastSubject ?? null;
    if (subject) {
      return { kind: "RECORD_STATUS", tool: "inspect_record", args: { reference: subject }, fast: true, reason: "état d'un dossier nommé" };
    }
    return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "état demandé sans sujet identifiable" };
  }

  // ── 7. CE QUI ATTEND LE PDG ─────────────────────────────────────────────────────────────
  // Même garde : « Combien de paiements en attente ? » n'est pas ma file de décisions, c'est une
  // question sur les paiements. Un nom de domaine concurrent ferme le raccourci.
  if (DECISION_WORDS.test(text) && /\b(quoi|qu|combien|qui)\b/.test(text) && !OTHER_DOMAIN.test(text)) {
    return { kind: "PENDING_DECISIONS", tool: "list_pending_decisions", args: {}, fast: true, reason: "file de décisions" };
  }

  // ── 8. LE PRONOM SEUL — « relance-la » ──────────────────────────────────────────────────
  // On NE devine PAS : on note simplement que la personne visée est celle du contexte, et on
  // laisse le modèle formuler l'action. Le raccourci s'arrête où commence l'écriture.
  if (PRONOUN_PERSON.test(text) && ctx.lastPerson) {
    return {
      kind: "DELEGATE", tool: null, args: { resolvedPerson: ctx.lastPerson },
      fast: false, reason: `pronom résolu vers ${ctx.lastPerson}`,
    };
  }

  return { kind: "DELEGATE", tool: null, args: {}, fast: false, reason: "hors des formes rapides" };
}

/** Ce qui suit « où en est … » — le sujet, débarrassé des mots de liaison. */
/**
 * LE SUJET D'UNE QUESTION D'ÉTAT — sans le mot-classe qui le précède.
 *
 * « Où en est le dossier Nivolumab ? » nommait, avant, le sujet « dossier nivolumab » : servi tel
 * quel à `inspect_record`, ce fragment ne correspond à aucune DCI ni à aucun titre (la fiche
 * s'appelle « Nivolumab »), et la question la plus fréquente d'un dirigeant finissait en
 * « il me faut une référence » — mesuré au banc. Le mot-classe (dossier, produit, contrat,
 * marché, demande, projet, courrier, tâche, paiement, facture) dit le TYPE, jamais l'identité :
 * on le retire, et le reste est le sujet. Un sujet réduit à rien renonce, comme avant.
 */
const SUJET_MOT_CLASSE = /^(?:(?:le |la |les |l |mon |ma |mes |ce |cet |cette |ces )?(?:dossier|produit|contrat|marche|appel d offres|demande|projet|courrier|tache|paiement|facture|reglement|fiche)\s+(?:de |du |des |d |pour |sur |concernant )?)+/;

function subjectAfterStatus(text: string): string | null {
  const m = /(?:ou en est|ou en sont|statut de|statut du|avancement de|avancement du|point sur|etat de|etat du)\s+(?:le |la |les |l |mon |ma |mes )?(.+)$/.exec(text);
  if (!m) return null;
  const brut = m[1].trim();
  const subject = brut.replace(SUJET_MOT_CLASSE, "").trim() || brut;
  return subject.length >= 3 ? subject : null;
}
