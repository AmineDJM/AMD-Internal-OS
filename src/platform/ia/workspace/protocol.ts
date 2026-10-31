/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PROTOCOLE DE L'ESPACE DE TRAVAIL — ce qu'Adam a le DROIT d'afficher.
 *
 * ── POURQUOI UN PROTOCOLE TYPÉ, ET PAS DU MARKDOWN GÉNÉRÉ ─────────────────────────────────
 *
 * Un soir de production, à « Bonsoir, ça va ? Tu vas bien ? », l'écran a rendu vingt-sept
 * résultats bruts d'une recherche fédérée — dont six lignes de salaire. Personne n'avait
 * demandé cela : c'était une réponse d'outil recopiée telle quelle sur l'écran.
 *
 * La leçon n'est pas « mieux filtrer le texte ». C'est que L'AFFICHAGE NE DOIT PAS ÊTRE UNE
 * ÉCHAPPATOIRE. Ici, le modèle n'écrit AUCUN balisage. Le serveur lit une source canonique,
 * la traduit en blocs TYPÉS, et le client ne sait rendre que ces blocs-là.
 *
 * Trois conséquences, toutes voulues :
 *   • un outil dont la forme n'est pas reconnue ne produit AUCUN bloc — pas un bloc « brut ».
 *     Le repli est la réponse en texte, jamais le vidage de données ;
 *   • ce qui s'affiche vient de la base, pas de la génération : rien à halluciner ;
 *   • ajouter un rendu, c'est ajouter un type ici — donc une décision, jamais un effet de bord.
 *
 * ── CE QUE CE FICHIER N'A PAS LE DROIT D'IMPORTER ─────────────────────────────────────────
 *
 * Rien. Ce sont des types et des constantes pures : le composant client les importe, et la
 * frontière client/serveur du projet interdit qu'un tel import traîne `fs` derrière lui.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { VueArtefact } from "@/platform/ia/artifact/view-types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IDENTITÉ D'UNE ENTITÉ — ce qui remplace la reconnaissance par le titre.
 *
 * Avant : pour savoir de quoi parlait un bloc, on relisait son titre à l'expression régulière,
 * ou on regardait quel outil l'avait produit. Les deux se trompent — « Nivolumab » apparaît
 * dans le titre d'un dossier, d'un marché et d'une facture, et le nom de l'outil ne dit rien
 * de la LIGNE qu'on regarde.
 *
 * Avec `entityRef`, un bloc SAIT ce qu'il montre. C'est ce qui rend possibles, sans devinette :
 * le zoom (« ouvre le BC #2 »), le suivi d'état (le même objet qui change), le contexte actif
 * (« lui », « cette facture »), et l'action déterministe qui n'appelle aucun modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface WorkspaceEntityRef {
  /** Le type canonique : « PRODUCT », « PCH_TENDER », « PCH_ORDER », « USER », « INVOICE »… */
  type: string;
  id: string;
  /** Ce qu'on écrit quand on la cite. Facultatif : l'identité, c'est le couple type+id. */
  label?: string | null;
}

/**
 * L'ÉTAT D'UN OBJET DANS LE FIL — pourquoi un message envoyé ne crée pas une seconde carte.
 *
 * Un brouillon d'e-mail, une mission, une décision traversent plusieurs états. Sans état porté
 * par le bloc, chaque changement produisait une NOUVELLE carte, et le fil accumulait trois
 * versions du même message dont on ne savait plus laquelle faisait foi.
 *
 * `executed` et `failed` sont des états TERMINAUX, et la distinction avec `sending` compte :
 * « accepté par le fournisseur » n'est pas « reçu par le destinataire ».
 */
export type WorkspaceBlockState =
  | "loading" | "partial" | "complete"
  | "awaiting_confirmation" | "sending" | "executed" | "failed";

/**
 * CE QU'UNE VALEUR EST, ÉPISTÉMOLOGIQUEMENT.
 *
 * Un fait lu en base et une estimation ne se présentent pas pareil, et les confondre fait
 * prendre une hypothèse pour un chiffre. La distinction est PORTÉE par la donnée, pas laissée
 * au style de la phrase qui l'entoure.
 */
export type WorkspaceCertainty = "fait" | "deduit" | "estime" | "propose" | "attente";

/**
 * LES MÉTADONNÉES QUE TOUT BLOC PEUT PORTER.
 *
 * Facultatives partout : un bloc ancien reste valide, et l'ajout n'a cassé aucun composeur.
 * C'est ce qui permet de les généraliser progressivement au lieu de réécrire les treize types.
 */
export interface WorkspaceBlockMeta {
  /** L'identité du BLOC dans le fil. Stable : c'est la clé du morphing d'état. */
  blockId?: string;
  /** L'entité que ce bloc montre. */
  entityRef?: WorkspaceEntityRef | null;
  state?: WorkspaceBlockState;
  /** Incrémentée à chaque mutation du même `blockId` — une version qui recule est un bug. */
  version?: number;
  /** « lu à 14 h 32 », « il y a 3 min ». Un chiffre sans fraîcheur vieillit en silence. */
  freshness?: string | null;
  /** D'où vient l'information — « Contrat signé », « FinanceTransaction ». Discret. */
  provenance?: string | null;
  certitude?: WorkspaceCertainty;
  /**
   * LE POIDS D'AFFICHAGE, quand le GENRE ne suffit pas à dire l'importance.
   *
   * `turn.ts` classe les blocs par nature : une alerte passe devant un brouillon, un brouillon
   * devant une figure. C'est juste dans l'immense majorité des cas — mais un même genre peut
   * porter deux rôles. Mesuré au banc live : l'aperçu des sources lues emprunte la forme
   * `queue` (des lignes titrées et liées), et héritait donc du poids d'une FILE DE DÉCISIONS —
   * 80 contre 42 pour une figure. Résultat : « Recherche fédérée effectuée » prenait la tête
   * devant le graphique que la personne venait de demander.
   *
   * Plutôt qu'un genre de plus dans le protocole et dans l'écran, un bloc peut dire qu'il n'est
   * PAS le sujet. Absent, le genre décide comme avant.
   */
  poids?: number;
}

/** Une coordonnée : adresse, téléphone, WhatsApp — avec sa PROVENANCE, qui se dit toujours. */
export interface WorkspaceEndpoint {
  canal: "e-mail" | "téléphone" | "WhatsApp";
  valeur: string;
  usage?: string | null;
  /** « vérifiée en interne », « déduite — à confirmer »… Une adresse sans provenance ment. */
  fiabilite?: string | null;
  principale?: boolean;
}

/**
 * UN CHIFFRE QUI COMPTE — trois au maximum, sur une fiche.
 *
 * « 12 dossiers · 3 en retard · 98 % à jour » se lit d'un regard et dit l'essentiel d'une
 * personne au travail. Douze indicateurs ne diraient rien de plus : ils feraient un tableau de
 * bord, ce que ce produit refuse d'être.
 */
export interface WorkspaceMetric {
  valeur: string;
  label: string;
  ton?: "neutre" | "attention" | "alerte" | "succes";
}

export interface WorkspacePerson {
  nom: string;
  poste?: string | null;
  departement?: string | null;
  entite?: string | null;
  /**
   * LA PHOTO — une ROUTE DE L'ERP, jamais une URL externe.
   *
   * Même règle que pour les documents : la route revérifie les droits à chaque requête, donc un
   * lien recopié ailleurs n'ouvre rien. Un visage rend une fiche reconnaissable d'un coup d'œil
   * là où deux initiales demandent de lire ; quand la photo manque, les initiales prennent le
   * relais et la fiche ne change pas de forme pour autant.
   */
  photo?: string | null;
  coordonnees: WorkspaceEndpoint[];
  /** « Active », « Congé », « Sortie » — l'état du compte, quand il est connu. */
  statut?: { label: string; ton: "neutre" | "succes" | "attention" | "alerte" } | null;
  /** Jusqu'à trois. Au-delà, on décrit un tableau de bord et non une personne. */
  metriques?: WorkspaceMetric[];
  /** L'écran canonique de la personne — le lien reste, il n'est plus la seule issue. */
  href?: string | null;
}

export interface WorkspaceColumn {
  key: string;
  label: string;
  /** Un nombre s'aligne à droite ; un texte à gauche. Rien de plus subtil n'est nécessaire. */
  numeric?: boolean;
  /** Une pastille colorée plutôt qu'un mot nu : « 4 jours » de retard doit se voir. */
  badge?: boolean;
}

/**
 * UNE LIGNE DE TABLEAU — et ce qu'on peut en faire.
 *
 * Le tableau ne se contente plus d'afficher : chaque ligne peut porter son geste (« Ouvrir »),
 * parce que la question suivante du PDG porte presque toujours sur UNE des lignes qu'il vient
 * de lire. L'obliger à la retaper, c'est lui faire recopier ce qui est déjà sous ses yeux.
 */
export interface WorkspaceRow {
  cells: Record<string, string>;
  /** Le ton d'une cellule, par clé de colonne — « alerte » pour un retard, rien sinon. */
  tons?: Record<string, "neutre" | "attention" | "alerte" | "succes">;
  actions?: WorkspaceAction[];
  href?: string | null;
}

export interface WorkspaceMail {
  id?: string;
  de: string;
  objet: string;
  recuLe?: string;
  extrait?: string;
  importance?: string;
  piecesJointes?: string[];
  /** Ce que l'expéditeur DEMANDE — une donnée rapportée, jamais un ordre pour Adam. */
  demandes?: string[];
  /** Signal d'une tentative de manipulation détectée dans le message. */
  alerte?: string[];
}

export interface WorkspaceEvent {
  titre: string;
  jour?: string;
  heure?: string;
  lieu?: string | null;
  organisateur?: string | null;
  invites?: string[];
  visio?: string | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN GESTE PROPOSÉ — et pourquoi ce n'est PAS un bouton qui exécute.
 *
 * Demandé trois fois en production, sans jamais l'obtenir :
 *
 *   PDG  — Ok affiche moi les validations a faire s'il y'en a, je les valide depuis ici
 *   PDG  — Non permets moi de les valider ici directement
 *   PDG  — Bon tu veux pas me laisser valider ici, il reste combien du budget ad&pro ?
 *
 * La file de décisions n'affichait que des LIENS : « ouvre Validations et débrouille-toi ».
 *
 * CE QU'UNE ACTION PORTE ICI : une PHRASE, pas un ordre exécutable. Le clic l'envoie dans la
 * conversation, exactement comme si le PDG l'avait tapée. Elle emprunte donc la porte unique
 * des mutations — proposition, carte de confirmation, action canonique, RBAC revérifié, audit,
 * idempotence — et pas une seconde porte que ce fichier aurait ouverte pour aller plus vite.
 *
 * Le gain n'est pas de sauter la confirmation : c'est de ne plus QUITTER la conversation, et de
 * ne plus avoir à retrouver soi-même la référence exacte de la demande à trancher.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * LE PICTOGRAMME D'UN GESTE — vocabulaire FERMÉ, choisi par le serveur.
 *
 * Une rangée de quatre boutons gris se relit mot à mot ; les mêmes avec un pictogramme se
 * reconnaissent à la forme. On ne le devine donc pas depuis le libellé — un verbe français mal
 * découpé donnerait l'icône d'un autre geste, et c'est la pire des aides. Le serveur, lui, sait
 * ce que l'action FAIT au moment où il la rédige.
 *
 * La liste reste courte exprès : un pictogramme par famille de geste, pas un par bouton.
 */
export type WorkspaceActionIcon =
  | "voir" | "email" | "tache" | "modifier" | "apercu"
  | "envoyer" | "escalade" | "planifier" | "relancer" | "valider";

/**
 * L'INTENTION EXACTE D'UN BOUTON — ce qui lui évite de repasser par le modèle (§23).
 *
 * Le serveur qui dessine « Ouvrir le marché AO-2025-014 » SAIT déjà quelle lecture il faudra
 * faire et sur quel identifiant. Écrire la phrase, la renvoyer au modèle, lui faire redécouvrir
 * l'intention et extraire l'argument n'ajoute rien : c'est un aller-retour complet pour
 * retrouver ce qui était connu au départ.
 *
 * `capability` est vérifiée contre un registre FERMÉ de lectures, côté serveur. Un bouton ne
 * peut donc pas déclencher une mutation par ce chemin — celles-là gardent la phrase, donc la
 * proposition, la confirmation et l'audit.
 */
export interface WorkspaceActionIntent {
  capability: string;
  args: Record<string, string>;
}

export interface WorkspaceAction {
  /** Ce qui s'écrit sur le bouton — deux mots, à l'impératif. */
  libelle: string;
  /** La phrase envoyée dans la conversation. Rédigée par le SERVEUR, jamais par le modèle. */
  phrase: string;
  /** « danger » pour un refus ou une suppression : la couleur dit ce que le geste fait. */
  ton?: "primaire" | "danger";
  /** Le pictogramme, quand il aide. Absent ⇒ bouton texte, ce qui reste parfaitement lisible. */
  icone?: WorkspaceActionIcon;
  /**
   * L'appel DIRECT, quand il n'y a rien à comprendre. Absent ⇒ le geste écrit sa phrase, et
   * la conversation reprend son cours normal. C'est le repli, et il reste correct.
   */
  intent?: WorkspaceActionIntent;
}

export interface WorkspaceItem {
  titre: string;
  detail?: string | null;
  statut?: string | null;
  echeance?: string | null;
  href?: string | null;
  /** Les gestes possibles sur CETTE ligne. Absent quand la ligne n'est pas décidable par soi. */
  actions?: WorkspaceAction[];
}

export interface WorkspaceField {
  label: string;
  value: string;
  /**
   * QUAND LA VALEUR EST QUELQU'UN. « Responsable : Raihana Benkaci » se lit deux fois plus vite
   * avec son visage à côté — c'est la ligne que le PDG cherche en premier sur un dossier bloqué.
   * Le nom reste le texte de la valeur ; ceci ne fait qu'ajouter le visage.
   */
  avatar?: { nom: string; photo?: string | null } | null;
  /** Un ton porte un seuil franchi : un retard de quatre jours ne se lit pas en noir. */
  ton?: "neutre" | "attention" | "alerte" | "succes";
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * CE CHAMP SE MODIFIE SUR PLACE — sans ouvrir son module, et SANS nouvelle porte d'écriture.
   *
   * Le point crucial est le second. Éditer ne fait PAS un appel d'écriture depuis l'écran :
   * la nouvelle valeur est injectée dans `phrase` à la place de `%s`, et cette phrase part
   * dans la conversation exactement comme si le PDG l'avait tapée. Elle emprunte donc la
   * porte unique des mutations — proposition, carte de confirmation, action canonique, RBAC
   * revérifié, audit, idempotence — et pas un raccourci que ce fichier aurait ouvert.
   *
   * C'est ce qui rend l'édition généralisable sans risque : ajouter un champ modifiable
   * n'ajoute aucun chemin d'écriture, donc rien de nouveau à sécuriser.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  editable?: {
    /** La phrase, rédigée par le SERVEUR, où `%s` marque la place de la nouvelle valeur. */
    phrase: string;
    /** Ce que la valeur EST — décide du contrôle affiché, jamais de ce qui est autorisé. */
    type: "texte" | "choix" | "date" | "nombre";
    /** `choix` uniquement : les valeurs proposées. Le serveur revalide de toute façon. */
    options?: string[];
    /** Un mot d'aide sous le contrôle (« en jours », « format 31/12/2026 »). */
    aide?: string | null;
  } | null;
}

/**
 * UNE JAUGE — « il reste combien ? » répondu par une longueur, pas par une soustraction.
 *
 * Un pourcentage écrit dans une phrase se relit ; une barre se voit. C'est tout l'intérêt :
 * « 87 % de l'enveloppe Ad & Pro » demande un effort, une barre presque pleine n'en demande
 * aucun. Le ton n'est pas décoratif — il porte le seuil franchi, et c'est souvent la seule
 * chose qui compte.
 */
export interface WorkspaceGauge {
  label: string;
  /** Ce qui est atteint. */
  valeur: number;
  /** Le maximum. Absent ⇒ `valeur` est déjà un pourcentage (0–100). */
  total?: number | null;
  /** Ce que comptent `valeur` et `total` : « DZD », « dossiers », « jours ». */
  unite?: string | null;
  /** Ce qui s'écrit à droite quand « x / y » ne suffit pas (« reste 340 000 DZD »). */
  detail?: string | null;
  /** Un seuil franchi se VOIT. `alerte` = dépassement, `attention` = proche, `succes` = fini. */
  ton?: "neutre" | "attention" | "alerte" | "succes";
}

/** Ce qu'on sait faire d'un fichier à l'écran. Le reste se télécharge, et on le dit. */
export type WorkspaceDocKind = "pdf" | "image" | "feuille" | "texte" | "autre";

/**
 * UN DOCUMENT MONTRÉ SUR PLACE — contrat, PDF, feuille de calcul.
 *
 * `href` est une ROUTE DE L'ERP (`/api/documents/…`, `/api/drive/…/raw`), qui revérifie les
 * droits à chaque requête. Jamais une URL signée, jamais un lien externe : le document reste
 * derrière la même porte que sur son écran d'origine, et un lien recopié ailleurs n'ouvre rien.
 *
 * `feuille` porte le contenu D'UN TABLEUR déjà lu par le serveur : c'est ce qui permet de
 * relire un export AVANT de l'envoyer, sans quitter la conversation ni ouvrir Excel.
 */
export interface WorkspaceDoc {
  nom: string;
  href: string;
  type: WorkspaceDocKind;
  mime?: string | null;
  /** Ce que le document EST, en une ligne : « Contrat — Kwality, échéance 31/12/2026 ». */
  soustitre?: string | null;
  taille?: string | null;
  /** La date de la pièce, déjà mise en forme. « 320 ko · 18/08/2025 » situe le document. */
  date?: string | null;
  pages?: number | null;
  /** Le contenu d'un tableur, prêt à s'afficher. */
  feuille?: { columns: WorkspaceColumn[]; rows: Record<string, string>[]; total: number } | null;
}

/** Une étape de circuit — le fil rouge visuel d'un dossier. */
export interface WorkspaceStep {
  label: string;
  etat: "fait" | "courant" | "a-venir";
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BUSINESS STORY — « retrace-moi l'AONIO 2023 ».
 *
 * ── CE QU'ELLE EST, ET CE QU'ELLE N'EST PAS ──────────────────────────────────────────────
 *
 * Ce n'est PAS une liste d'événements. Une liste répond « quoi » ; une story répond « comment
 * on en est arrivé là » — ce qui suppose l'ordre, la HIÉRARCHIE (un bon de commande contient sa
 * livraison, sa facture, son paiement), les FILS (le lot Nivolumab traverse toute l'histoire),
 * les RETARDS chiffrés, et les pièces qui prouvent chaque jalon.
 *
 * ── LA RÈGLE QUI LA REND FIABLE ──────────────────────────────────────────────────────────
 *
 * ELLE EST CONSTRUITE PAR LE SERVEUR, à partir des relations et du registre d'événements. Le
 * modèle de langage ne l'INVENTE jamais : il peut la commenter, l'analyser, en tirer une
 * conclusion — il ne la fabrique pas. Une frise hallucinée serait la pire sortie possible de ce
 * produit, parce qu'elle a exactement l'apparence d'une preuve.
 *
 * ── POURQUOI `parent` ET `fils` PLUTÔT QU'UN ARBRE ───────────────────────────────────────
 *
 * Un événement appartient à PLUSIEURS lectures : la facture #2 est sous le BC #2 (hiérarchie)
 * ET dans le fil « Nivolumab » ET dans le fil « paiements en retard ». Un arbre unique
 * obligerait à choisir ; `parent` porte la hiérarchie, `fils` porte les appartenances, et le
 * zoom comme le filtre deviennent des opérations de LECTURE sur la même structure — c'est ce
 * qui permet de filtrer sans reconstruire le composant (§49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type StoryEventKind =
  | "publication" | "cahier-des-charges" | "soumission" | "attribution"
  | "contrat" | "avenant" | "commande" | "livraison" | "facture" | "paiement"
  | "courrier" | "decision" | "jalon" | "cloture" | "incident";

export interface StoryParticipant {
  nom: string;
  photo?: string | null;
  role?: string | null;
}

export interface StoryEvent {
  /** Identité STABLE dans la story — c'est la clé du zoom, du filtre et de l'ancrage. */
  id: string;
  /** ISO court (`2023-03-28`). `null` quand le jalon est attendu sans date connue. */
  date: string | null;
  kind: StoryEventKind;
  titre: string;
  detail?: string | null;
  /**
   * `manque` est un état à part entière et le plus utile de tous : un jalon ATTENDU qui n'a
   * jamais eu lieu (la facture jamais émise, le paiement jamais reçu) est précisément ce qu'on
   * cherche en retraçant une affaire. Ne pas l'afficher reviendrait à raconter une histoire
   * sans son trou.
   */
  etat: "fait" | "en-cours" | "a-venir" | "manque" | "echec";
  entityRef?: WorkspaceEntityRef | null;
  /** Les chiffres du jalon : « 8 produits · 1,24 Md DZD ». Trois au plus, comme partout. */
  metriques?: WorkspaceMetric[];
  participants?: StoryParticipant[];
  docs?: WorkspaceDoc[];
  /** Les fils auxquels ce jalon appartient (identifiants de `StoryBlock.filtres`). */
  fils?: string[];
  /** Le jalon parent, pour le sous-niveau. `null` ⇒ jalon de premier rang. */
  parent?: string | null;
  /** Jours d'écart avec l'attendu. Positif = retard. Le retard se VOIT plutôt qu'il se lit. */
  retardJours?: number | null;
  /** D'où vient ce jalon — « PchOrder », « BusinessEvent », « Contrat signé ». */
  provenance?: string | null;
  certitude?: WorkspaceCertainty;
  actions?: WorkspaceAction[];
}

/** Un fil de lecture : un produit, un lot, une famille de jalons. */
export interface StoryThread {
  id: string;
  label: string;
  /** Combien de jalons il porte — un fil vide ne se propose pas. */
  count: number;
  /** « produit », « famille », « risque » — pour grouper les filtres sans les mélanger. */
  genre?: "produit" | "famille" | "risque" | "acteur";
}

type WorkspaceBlockShape =
  /**
   * L'HISTOIRE D'UNE AFFAIRE — la primitive la plus riche du protocole.
   *
   * Elle porte tout ce qu'il faut pour se lire à trois niveaux de zoom sans nouvel appel :
   * les jalons de premier rang (`parent === null`), leurs enfants, et les fils transversaux.
   */
  | {
      kind: "story";
      title: string;
      subtitle?: string | null;
      /** Les KPI de l'affaire entière (§50) : demandé, attribué, encaissé, délai moyen… */
      kpis?: WorkspaceMetric[];
      events: StoryEvent[];
      threads?: StoryThread[];
      /** Ce que la reconstitution N'A PAS vu. Une story sans limites dites se croit complète. */
      limites?: string[];
      actions?: WorkspaceAction[];
    }
  /**
   * UNE VUE 360 D'ENTITÉ — produit, marché, contrat, personne.
   *
   * Un seul type pour les quatre, et c'est délibéré : ils ont la même FORME (en-tête, KPI,
   * sections repliables, story éventuelle), et quatre types identiques auraient produit quatre
   * renderers à maintenir en parallèle — donc trois qui divergent.
   *
   * La DIVULGATION PROGRESSIVE est portée par `sections[].ouvert` : deux sections ouvertes,
   * le reste replié. Cinquante indicateurs affichés d'un coup ne sont pas une vue 360, c'est
   * un tableau de bord — ce que ce produit refuse d'être.
   */
  | {
      kind: "entity360";
      title: string;
      subtitle?: string | null;
      badges?: { label: string; ton: "neutre" | "succes" | "attention" | "alerte" }[];
      /** Le visage, quand l'entité est une personne. */
      photo?: string | null;
      kpis?: WorkspaceMetric[];
      sections: {
        id: string;
        label: string;
        /** Ouverte d'emblée ? Deux au plus, sinon la divulgation progressive ne sert à rien. */
        ouvert?: boolean;
        fields?: WorkspaceField[];
        gauges?: WorkspaceGauge[];
        items?: WorkspaceItem[];
        table?: { columns: WorkspaceColumn[]; rows: WorkspaceRow[]; total?: number };
        docs?: WorkspaceDoc[];
        people?: WorkspacePerson[];
        note?: string | null;
        actions?: WorkspaceAction[];
      }[];
      /** Ce qui manque ou n'a pas pu être calculé — dit, jamais tu. */
      limites?: string[];
      href?: string | null;
      actions?: WorkspaceAction[];
    }
  /**
   * UNE COMPARAISON — deux affaires, deux produits, un contrat et son avenant.
   *
   * `delta` et `insight` sont SÉPARÉS parce qu'ils ne sont pas de même nature : le delta est
   * arithmétique et vérifiable, l'insight est une lecture. Les mélanger dans une colonne ferait
   * passer un commentaire pour un calcul.
   */
  | {
      kind: "comparison";
      title: string;
      subtitle?: string | null;
      /** Les deux (ou trois) colonnes comparées. */
      sujets: { id: string; label: string; sousTitre?: string | null; entityRef?: WorkspaceEntityRef | null }[];
      lignes: {
        dimension: string;
        /** Une valeur par sujet, dans l'ordre de `sujets`. */
        valeurs: (string | null)[];
        delta?: string | null;
        deltaTon?: "neutre" | "attention" | "alerte" | "succes";
        insight?: string | null;
      }[];
      note?: string | null;
      actions?: WorkspaceAction[];
    }
  /**
   * UNE MISSION — plusieurs gestes, UNE confirmation (§18).
   *
   * Le bloc porte les étapes ET leur état, si bien que la confirmation puis l'exécution se
   * jouent sur le MÊME objet : « ✓ e-mail envoyé · ✓ tâche créée · ✓ rappel planifié » remplace
   * les cases à cocher, sans qu'une seconde carte apparaisse dans le fil.
   */
  | {
      kind: "mission";
      title: string;
      subtitle?: string | null;
      etapes: {
        id: string;
        label: string;
        detail?: string | null;
        etat: "a-faire" | "en-cours" | "fait" | "echec" | "ignore";
        /** Le message d'erreur, ACTIONNABLE — « adresse rejetée », pas « erreur 400 ». */
        erreur?: string | null;
        /**
         * LE GESTE QUI RÉPARE. Un message qui dit « choisir une autre date » sans bouton pour
         * la choisir laisse le lecteur devant un constat : il sait ce qu'il faudrait faire, et
         * doit aller le faire ailleurs. §53 demande une erreur ACTIONNABLE, pas une erreur
         * bien rédigée — la capture de la carte en échec a montré la différence.
         */
        actions?: WorkspaceAction[];
      }[];
      /**
       * L'HORIZON D'UNE MISSION LONGUE (§118.50) — absent d'une mission courte, et c'est la
       * bonne réponse.
       *
       * Sans lui, la carte d'une mission de sept jalons montre les étapes du sous-plan COURANT
       * et rien d'autre : « 4/5 » sur une mission qui a six semaines devant elle. Le
       * `resultat` est ce qu'on doit pouvoir CONSTATER — c'est lui, pas le titre, que le
       * contrôle de fin comparera au réel, donc c'est lui qu'on montre.
       */
      jalons?: {
        ordre: number;
        titre: string;
        resultat?: string | null;
        etat: "a-faire" | "en-cours" | "fait" | "echec";
        /** Le sous-plan de ce jalon est-il écrit ? Faux = il n'existe que comme intention. */
        compile?: boolean;
      }[];
      /** Le geste unique qui confirme l'ensemble. Absent une fois la mission exécutée. */
      confirmation?: WorkspaceAction | null;
      actions?: WorkspaceAction[];
    }
  /**
   * UNE ALERTE PROACTIVE (§20) — Adam parle sans qu'on lui ait rien demandé.
   *
   * Elle vit dans le MÊME fil que le reste : une notification qui ouvre un autre écran oblige à
   * reconstruire le contexte qu'on avait déjà. Le ton porte l'urgence, les actions portent la
   * sortie — « corriger », « renvoyer » — parce qu'une alerte sans issue est une inquiétude.
   */
  | {
      kind: "alerte";
      title: string;
      ton: "info" | "attention" | "alerte";
      message: string;
      detail?: string | null;
      /** Ce qui a déclenché l'alerte — « NDR reçu de gmail.com ». */
      origine?: string | null;
      actions?: WorkspaceAction[];
    }
  /** Une ou plusieurs fiches de contact — `directory_lookup`. */
  | { kind: "people"; title: string; people: WorkspacePerson[]; note?: string; actions?: WorkspaceAction[] }
  /** Le registre du personnel — `directory_list`. Tableau, tri, recherche côté client. */
  | { kind: "directory"; title: string; total: number; rows: WorkspacePerson[]; note?: string; actions?: WorkspaceAction[] }
  /** Des messages — `gmail_search`. */
  | { kind: "mail"; title: string; messages: WorkspaceMail[]; actions?: WorkspaceAction[] }
  /** Une journée d'agenda — `read_calendar`. */
  | { kind: "agenda"; title: string; events: WorkspaceEvent[]; actions?: WorkspaceAction[] }
  /** Ce qui attend une décision — `list_pending_decisions`. */
  | { kind: "queue"; title: string; total: number; items: WorkspaceItem[]; actions?: WorkspaceAction[] }
  /** Une fiche canonique — `inspect_record`. */
  | { kind: "record"; title: string; subtitle?: string | null; fields: WorkspaceField[]; href?: string | null; actions?: WorkspaceAction[] }
  /** Le repli générique : une liste d'objets homogènes devient un tableau. */
  | { kind: "table"; title: string; columns: WorkspaceColumn[]; rows: WorkspaceRow[]; total?: number; actions?: WorkspaceAction[] }
  /** Une suite d'événements datés — histoire d'un dossier. */
  | { kind: "timeline"; title: string; steps: { date?: string | null; label: string; detail?: string | null }[]; actions?: WorkspaceAction[] }
  /** Des jauges — consommation d'une enveloppe, avancement d'un dossier, charge d'une personne. */
  | { kind: "progress"; title: string; gauges: WorkspaceGauge[]; note?: string | null; actions?: WorkspaceAction[] }
  /** Un ou plusieurs documents montrés SUR PLACE — PDF, image, feuille de calcul. */
  | { kind: "document"; title: string; docs: WorkspaceDoc[]; note?: string | null; actions?: WorkspaceAction[] }
  /**
   * LE DOSSIER — l'objet métier montré en entier, et lisible en deux secondes.
   *
   * C'est le bloc le plus dense du protocole, et il l'est pour une raison : quand le PDG ouvre
   * un dossier, il ne cherche pas une fiche, il cherche **où ça bloque**. L'ordre du rendu suit
   * donc l'ordre de sa question — l'étape courante et l'alerte d'abord, les pièces et l'histoire
   * ensuite, parce qu'elles ne servent qu'une fois la première question réglée.
   */
  | {
      kind: "dossier";
      title: string;
      subtitle?: string | null;
      badge?: { label: string; ton: "neutre" | "succes" | "attention" | "alerte" } | null;
      fields: WorkspaceField[];
      steps?: WorkspaceStep[];
      /** Ce qui empêche d'avancer, dit en une phrase. Rien de plus visible sur la carte. */
      alerte?: { label: string; ton: "attention" | "alerte" } | null;
      docs?: WorkspaceDoc[];
      participants?: WorkspacePerson[];
      activite?: { date?: string | null; label: string }[];
      href?: string | null;
      actions?: WorkspaceAction[];
    }
  /**
   * UN MESSAGE PRÊT — montré comme un message, pas raconté en prose.
   *
   * `statut` porte tout : un brouillon se relit et s'envoie, un message parti se compacte et
   * affiche l'heure. La même carte traverse les deux états, elle ne se duplique pas — c'est ce
   * qui évite la file de brouillons concurrents corrigée en amont.
   */
  /**
   * UNE PLANIFICATION — « chaque lundi, relance Regulatory ».
   *
   * §11 exige que cela devienne un objet RÉEL et non une mémoire de conversation. La carte le
   * montre : la cadence en toutes lettres, la prochaine exécution, l'état, et les derniers
   * passages. Sans elle, la seule preuve qu'une planification existe serait la phrase d'Adam qui
   * dit l'avoir créée — c'est-à-dire aucune preuve.
   */
  | {
      kind: "planification";
      title: string;
      /** La cadence en français vérifiable : « Tous les lundis à 07 h ». */
      cadence: string;
      prochaine: string;
      etat: "active" | "en-pause";
      /** Ce que la planification déclenche, en clair. */
      traitement: string;
      /** Les derniers passages, le plus récent d'abord. Vide = jamais encore exécutée. */
      passages?: { date: string; resultat: "ok" | "sans-effet" | "echec"; detail?: string | null }[];
      href?: string | null;
      actions?: WorkspaceAction[];
    }
  | {
      kind: "email";
      title: string;
      a: string[];
      cc?: string[];
      objet: string;
      corps: string;
      piecesJointes?: string[];
      statut: "brouillon" | "envoye" | "annule";
      envoyeLe?: string | null;
      actions?: WorkspaceAction[];
    }
  /**
   * LE DOCUMENT OUVERT — Word, Excel, PowerPoint ou PDF, VIVANT dans la conversation (§33-34).
   *
   * Ce bloc n'est pas un aperçu : c'est le poste de travail. Il porte la vue complète du
   * document et l'identifiant de session, ce qui permet à la personne de cliquer un paragraphe
   * pour le désigner, d'annuler, et d'enregistrer — sans quitter le fil.
   *
   * ── POURQUOI IL N'Y A QU'UN SEUL BLOC PAR DOCUMENT (§64) ───────────────────────────
   *
   * Le `blockId` de la vue devient celui du bloc, et `version` suit `revision`. Trois retouches
   * ne font donc pas trois cartes qui s'empilent : la MÊME carte se transforme, comme le
   * document sous les yeux de quelqu'un devant Word. Empiler serait plus simple à coder et
   * rendrait la conversation illisible au bout de dix instructions.
   */
  | {
      kind: "artifact";
      title: string;
      /** La vue complète — pages, blocs, feuilles ou diapositives, avec leurs styles résolus. */
      vue: VueArtefact;
      actions?: WorkspaceAction[];
    }
  /**
   * UNE REPRÉSENTATION (§35) — la forme est une donnée, le rendu est générique. `raison` dit pourquoi
   * cette forme ; `alertes` dit ce qui pourrait tromper (axe tronqué, trop de parts, échelle) : le
   * serveur les calcule (`sandbox/viz.ts`), le client les montre, personne ne les cache.
   */
  | {
      kind: "viz";
      title: string;
      type: VizType;
      donnees: VizDonnees;
      unite?: string | null;
      axeYdepartZero?: boolean;
      note?: string | null;
      raison?: string | null;
      alertes?: string[];
      source?: string | null;
      actions?: WorkspaceAction[];
    }
  /**
   * UN VISUEL GÉNÉRÉ (lot K2, décision 0032) — une image, une vidéo (modèle vidéo, en arrière-plan) ou une vidéo de
   * données (graphique animé rendu par le serveur). `src` et `telecharger` sont des ROUTES de l'ERP qui revérifient la
   * personne ; tant que le visuel n'est pas prêt, la carte relit `etatHref` et se met à jour (« Vidéo en cours »).
   */
  | {
      kind: "visuel";
      title: string;
      nature: "image" | "video" | "video-donnees";
      visuelId: string;
      etat: "en-file" | "en-cours" | "pret" | "echec";
      etatHref: string;
      src?: string | null;
      telecharger?: string | null;
      drive?: string | null;
      detail?: string | null;
      erreur?: string | null;
      progression?: number | null;
      actions?: WorkspaceAction[];
    }
  /** UN MINI-TABLEAU DE BORD : des tuiles (représentations, jauges, tableaux, fiches) sur une grille — composé à la volée, jamais un écran dédié. */
  | {
      kind: "dashboard";
      title: string;
      colonnes?: 2 | 3;
      tuiles: WorkspaceBlock[];
      note?: string | null;
      actions?: WorkspaceAction[];
    };


// ─────────────────────────── LA REPRÉSENTATION GÉNÉRIQUE (mandat 5 §35) ───────────────────────────
//
// UN SEUL bloc, `viz`, et UN SEUL rendu pour dix-sept formes : barres, barres empilées, courbe, aires,
// nuage, histogramme, secteurs, cascade, entonnoir, heatmap, Gantt, matrice, graphe, arbre, flux,
// carte, cartes. La forme est une DONNÉE (`type`), pas un composant : ajouter une représentation ne
// crée pas un fichier React, elle ajoute un cas au rendu générique. Les données sont NORMALISÉES par
// le serveur (`workspace/viz-block.ts`) : catégories + séries, points, cellules, tâches, nœuds et arcs,
// arbre, lieux, cartes — bornées, typées, jamais du HTML ni du code.

export type WorkspaceTone = "neutre" | "succes" | "attention" | "alerte";

export const VIZ_TYPES = [
  "barres", "barres_empilees", "courbe", "aires", "nuage", "histogramme", "secteurs", "cascade", "entonnoir",
  "heatmap", "gantt", "matrice", "graphe", "arbre", "flux", "carte", "cartes",
] as const;
export type VizType = (typeof VIZ_TYPES)[number];

export interface VizSerie { label: string; valeurs: (number | null)[]; ton?: WorkspaceTone }
export interface VizPoint { x: number; y: number; label?: string | null; taille?: number | null; groupe?: string | null }
export interface VizTache { label: string; debut: string; fin: string; groupe?: string | null; progression?: number | null; ton?: WorkspaceTone }
export interface VizNoeud { id: string; label: string; type?: string | null; poids?: number | null; ton?: WorkspaceTone; href?: string | null }
export interface VizArc { de: string; a: string; label?: string | null; poids?: number | null }
export interface VizArbre { label: string; valeur?: number | null; ton?: WorkspaceTone; enfants?: VizArbre[] }
export interface VizLieu { label: string; lat: number; lon: number; valeur?: number | null; ton?: WorkspaceTone }
export interface VizCarte { titre: string; valeur: string; detail?: string | null; ton?: WorkspaceTone; href?: string | null }

/** Les données d'une représentation — une famille par forme, toutes optionnelles, le lecteur exige la bonne. */
export interface VizDonnees {
  /** barres, barres_empilees, courbe, aires, histogramme, secteurs, cascade, entonnoir. */
  categories?: string[];
  series?: VizSerie[];
  /** nuage. */
  points?: VizPoint[];
  /** heatmap (valeurs) et matrice (cellules) : lignes × colonnes. */
  lignes?: string[];
  colonnes?: string[];
  valeurs?: (number | null)[][];
  cellules?: string[][];
  tons?: (WorkspaceTone | null)[][];
  /** gantt. */
  taches?: VizTache[];
  /** graphe, flux. */
  noeuds?: VizNoeud[];
  arcs?: VizArc[];
  /** arbre. */
  racine?: VizArbre;
  /** carte (schématique : positions relatives, jamais un fond de carte prétendu exact). */
  lieux?: VizLieu[];
  /** cartes (indicateurs). */
  cartes?: VizCarte[];
}

/**
 * LE BLOC TEL QU'IL CIRCULE — sa forme, PLUS son identité et son état.
 *
 * L'intersection plutôt que dix-sept champs recopiés : ajouter une métadonnée se fait en un
 * endroit, et TypeScript continue de vérifier l'exhaustivité du `switch` sur `kind` parce que
 * `(A | B) & M` se distribue en `(A & M) | (B & M)`.
 */
export type WorkspaceBlock = WorkspaceBlockShape & WorkspaceBlockMeta;

export type WorkspaceBlockKind = WorkspaceBlockShape["kind"];

export interface WorkspaceComposition {
  /** L'outil canonique qui a produit ces blocs — tracé, et vérifiable. */
  source: string;
  blocks: WorkspaceBlock[];
}

/**
 * LES BORNES D'AFFICHAGE. Un tableau de trois cents lignes déposé dans une conversation n'est
 * pas un espace de travail, c'est un vidage. Le serveur tronque, le client dit combien il
 * manque — et l'écran métier reste la destination pour tout voir.
 */
export const WORKSPACE_LIMITS = {
  /** Représentations (§35) : ce qu'un regard tient — au-delà, c'est un export, pas une vue. */
  vizCategories: 40,
  vizSeries: 6,
  vizPoints: 400,
  vizTaches: 40,
  vizNoeuds: 60,
  vizArcs: 120,
  vizCellules: 40,
  vizCartes: 8,
  vizArbre: 80,
  tuiles: 6,
  tableRows: 50,
  people: 6,
  mails: 12,
  events: 12,
  queueItems: 15,
  /** Deux gestes par ligne : approuver / refuser. Au-delà, la file devient un formulaire. */
  itemActions: 2,
  recordFields: 24,
  /** Six jauges tiennent dans un regard ; au-delà, c'est un rapport, pas une réponse. */
  gauges: 6,
  /** Trois documents montrés d'un coup — le quatrième s'appelle « ouvre le Drive ». */
  docs: 3,
  /** Un aperçu de feuille sert à RELIRE, pas à consulter : au-delà, on ouvre le fichier. */
  sheetRows: 30,
  /** Cinq étapes de circuit tiennent sur une ligne ; au-delà, la frise devient illisible. */
  steps: 7,
  /** Trois chiffres se lisent d'un regard. Le quatrième fait un tableau de bord. */
  metrics: 3,
  /** Quatre participants nommés, le reste derrière « voir tout ». */
  participants: 4,
  /** Trois activités récentes : ce qui vient de se passer, pas l'historique complet. */
  activity: 4,
  /** Deux gestes par ligne de tableau, comme dans la file de décisions. */
  rowActions: 2,
  /** Quatre actions sous un objet : une primaire, deux secondaires, un débordement. */
  blockActions: 4,
  timelineSteps: 20,
  /** Au-delà, un extrait n'aide plus à décider : il remplit l'écran. */
  snippetChars: 220,
} as const;
