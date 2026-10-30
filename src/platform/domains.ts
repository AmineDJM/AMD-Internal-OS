import fs from "node:fs";
import path from "node:path";
import { cibleInterne, specificateurs } from "./imports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE DES DOMAINES (§1) — un monolithe MODULAIRE, pas une constellation de services.
 *
 * ── LES QUATRE COUCHES ───────────────────────────────────────────────────────────────────
 *
 *   L0  SOCLE      `prisma`, `session`, `rbac`, `utils`, `crypto`, `platform`… L'infrastructure.
 *                  N'importe AUCUN domaine, AUCUNE façade. Vérifié durement, sans plafond.
 *   L1  DOMAINES   Les quinze métiers. Ne doivent ni s'importer entre eux, ni remonter vers une
 *                  façade. Deux cliquets : `crossings` et `domainToFacade`.
 *   L2  FAÇADES    `queries/` (lectures), `api/registry/` (écritures), `links/`. Elles EXISTENT
 *                  pour traverser les domaines : les compter comme des violations n'aurait aucun
 *                  sens. Elles sont le passage AUTORISÉ, et le seul.
 *   L3  ADAM       Consomme les façades et, pour l'instant, les domaines. Il a son propre
 *                  cliquet, dans `boundary.test.ts` — voir ci-dessous.
 *
 * Une couche ne parle qu'à celles du dessous. C'est tout le modèle.
 *
 * ── CE QUE CE FICHIER MESURE, ET CE QU'IL NE MESURE PAS ──────────────────────────────────
 *
 * Il mesure la couche métier. Il ne mesure PAS la frontière Adam ↔ ERP, qui a son propre cliquet
 * (`boundary-scan.ts`) et son propre plafond — deux questions différentes, deux chiffres
 * différents, et les mélanger empêcherait de faire baisser l'un sans masquer l'autre.
 *
 * ── LA RÈGLE, EN UNE PHRASE ──────────────────────────────────────────────────────────────
 *
 * « Une petite modification métier doit idéalement rester dans son module. » Un domaine qui
 * importe dix fichiers d'un autre n'est pas un module : c'est la moitié d'un module, et la
 * moindre retouche chez le voisin le casse.
 *
 * ── POURQUOI UN CLIQUET PLUTÔT QU'UN INTERDIT ────────────────────────────────────────────
 *
 * Le même raisonnement que pour la frontière Adam ↔ ERP : interdire d'un coup exigerait une
 * réécriture aveugle, que la mission proscrit explicitement. On MESURE, on empêche de grossir, on
 * fait baisser lot après lot. À tout instant le produit marche, et le chiffre dit où l'on en est.
 *
 * Deux choses échappent au cliquet et sont exigées à ZÉRO, parce qu'elles ne se corrigent pas
 * « progressivement » : les CYCLES (§1 les nomme explicitement) et la PROPRETÉ DU SOCLE. Cette
 * seconde est ce qui empêche de tricher avec le reste : sans elle, il suffirait de déplacer un
 * fichier gênant dans `utils/` pour faire baisser le compteur sans rien avoir assaini.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES DOMAINES. Chacun est un préfixe de chemin, et l'ordre compte : le PREMIER qui correspond
 * gagne. `finance/`, `finances/` et `payments/` ont déménagé ensemble dans le module
 * `src/modules/finances/` (lot V4, 28/10/2026) : le domaine `finance` ne garde ici que les budgets.
 */
export const DOMAINS: { name: string; paths: string[] }[] = [
  { name: "regulatory", paths: ["src/lib/regulatory/", "src/lib/products/", "src/lib/market/"] },
  { name: "finance", paths: ["src/lib/budget/"] },
  { name: "hr", paths: ["src/lib/hr/", "src/lib/recruitment/", "src/lib/org/"] },
  { name: "drive", paths: ["src/lib/drive/", "src/lib/files/"] },
  { name: "mail", paths: ["src/lib/mail/", "src/lib/mail-register/", "src/lib/comms/"] },
  { name: "tasks", paths: ["src/lib/tasks/", "src/lib/workflow/", "src/lib/validations/"] },
  { name: "legal", paths: ["src/lib/legal/"] },
  // `teach/` : la couche de règles enseignées à Adam (Teach Adam) — types, classement,
  // précédence, composition. Module PUR ; la persistance et les droits vivent dans le pont
  // (`platform/in-process/teach/`), comme pour `artifact/`.
  { name: "teach", paths: ["src/lib/teach/"] },
  // `sandbox/` : le bac à sable d'exécution (mandat 4 §25) — SQL en lecture seule, code isolé,
  // opérations d'analyse pures, conseil de visualisation. Il n'importe aucun domaine ; ses
  // capacités sur le Drive et l'audit vivent dans le pont (`platform/in-process/sandbox/`).
  { name: "sandbox", paths: ["src/lib/sandbox/"] },
  { name: "knowledge", paths: ["src/lib/knowledge/"] },
  { name: "scheduler", paths: ["src/lib/scheduler/"] },
  { name: "adam", paths: ["src/lib/assistant/", "src/lib/models/", "src/lib/assistant.ts"] },
  { name: "google", paths: ["src/lib/google/"] },
  { name: "directory", paths: ["src/lib/directory/", "src/lib/contacts/", "src/lib/medical/"] },
  // Le reste d'Ad & Pro (demandes, postes, prise en charge, événements) vit dans le module `src/modules/ad-pro/`
  // (lot V4) : ici ne reste que le stock et le dossier de matériel promotionnel, prochain lot du pôle.
  { name: "adpro", paths: ["src/lib/promo/", "src/lib/promo-material/"] },
  { name: "general-means", paths: ["src/lib/general-means/"] },
  // `site-web/` : la publication vers le site public Adventum (§118.158) — contrat de l'API du
  // site, lecture du Markdown, file de réessais, réconciliation. Déclaré pour être MESURÉ : il ne
  // doit importer aucun autre domaine. Les recrutements l'APPELLENT (depuis leurs actions, hors
  // carte) pour qu'une offre suive son poste ; lui ne lit que la base, les droits, les
  // notifications et la garde de sortie.
  { name: "siteweb", paths: ["src/lib/site-web/"] },
  // `artifact/` est le LIVE OFFICE : ouvrir, éditer et versionner un Word, un Excel, un
  // PowerPoint ou un PDF. C'est le même métier que `office/` (bureautique) et il est déclaré
  // ici pour être MESURÉ comme les autres — il ne doit importer aucun autre domaine, et ses
  // capacités lui arrivent par un port (`artifact/ports.ts`), rempli par le pont.
  // `payslip/` : la lecture d'un Word (`docx-lecture`), sa mise en page et son rendu PDF — de la
  // bureautique pure, qui ne lit que `artifact/` (le modèle XML). Rangé ici au découpage V4 des
  // fichiers géants : ses morceaux neufs auraient sinon grossi le compte « hors carte ».
  { name: "office", paths: ["src/lib/office/", "src/lib/pdf/", "src/lib/artifact/", "src/lib/payslip/"] },
  // `carte-plateforme/` : le catalogue DESCRIPTIF de `/admin/carte-plateforme` (modules, circuits,
  // mécanismes) et le calcul des niveaux d'accès qu'il affiche. Zéro import hors de son dossier :
  // déclaré pour être MESURÉ — il ne doit lire aucun autre domaine.
  { name: "carte", paths: ["src/lib/carte-plateforme/"] },
];

/**
 * L3 — ADAM. Il est déclaré comme un domaine ci-dessus (pour être MESURÉ), mais il vit au-dessus
 * des façades : `assistant/power-tools.ts → queries/hr` est le chemin VOULU, pas une entorse.
 * D'où cette exception, et elle seule, dans le compte des inversions de couche.
 */
const ADAM_DOMAIN = "adam";

/**
 * L0 — LE SOCLE. Tout le monde a le droit, et le compter n'apprendrait rien.
 *
 * La liste reste courte et défendable : ce sont des INFRASTRUCTURES (base, session, droits,
 * chiffrement) ou des utilitaires sans métier. Y figurer n'est pas un passe-droit mais une
 * OBLIGATION : `scanSocle()` échoue si l'un de ces fichiers importe un domaine ou une façade.
 *
 * `api/registry/entities` y est parce qu'il n'est qu'un CATALOGUE déclaratif — modèle Prisma,
 * module RBAC, champs — sans une ligne de métier. Le reste de `api/registry/` (les opérations
 * d'écriture) est bien une façade, lui, et reste en L2.
 */
const SOCLE = [
  "src/lib/prisma", "src/lib/session", "src/lib/rbac", "src/lib/utils", "src/lib/labels",
  "src/lib/crypto/", "src/lib/ai-text", "src/lib/name-match", "src/platform/",
  /**
   * `journal` : le journal unique et les `catch` nommés (`sansBloquer`, `attendu` — lot V3-E), zéro
   * import ; `migrations-appliquees` : la sonde de santé compare `prisma/migrations/` à la base (prisma
   * + journal). De l'infrastructure lue partout, qui ne lit aucun métier.
   */
  "src/lib/journal", "src/lib/migrations-appliquees",
  /**
   * J8 : `contexte-geste` (la personne d'un geste exécuté HORS requête, lue par `session` avant le cookie, et le store
   * de Next pour `revalidatePath`) et `async-local-storage-global` (le contexte asynchrone réel hors du serveur Next).
   * Le prolongement de `session`, au même rang : ils ne lisent aucun métier.
   */
  "src/lib/contexte-geste", "src/lib/async-local-storage-global",
  /**
   * J7 (décision 0029) : `effets/` — le contexte de geste étendu (mode réel / simulation), la capture des écritures,
   * la simulation transactionnelle, les ports de sortie, le journal des effets et l'annulation. Le prolongement de
   * `prisma` et de `contexte-geste` : il ne lit aucun métier (le schéma seul, par le DMMF).
   */
  "src/lib/effets/",
  /**
   * `acces/compose` : `et(…)`, la composition des clauses Prisma en `AND` (audit 27/10, SA-03 — deux `OR`
   * étalés s'écrasent). Zéro import ; lue par les façades, les domaines et les actions.
   */
  "src/lib/acces/compose",
  "src/lib/api/registry/entities",
  "src/lib/storage/",
  "src/lib/mutations/",
  "src/lib/personnes/",
  "src/lib/vues/",
  "src/lib/lecteurs/",
  /**
   * `seuils/` : le seuil Ad & Pro au-delà duquel la Direction Générale valide — UNE règle
   * arithmétique, zéro import. TROIS couches en ont besoin sans avoir le droit de se parler :
   * le domaine `tasks` (`workflow/parcours.ts`, les quatre circuits configurables), le domaine
   * `adpro` (`promo-material/circuit.ts`, qui n'a pas d'étapes en base, et `ad-pro/centre.ts`),
   * plus l'écran du centre et les actions. `tasks` et `adpro` ne peuvent pas s'importer : c'est
   * littéralement ce qui a fait écrire la règle DEUX FOIS (§118.138), et le symptôme aurait été
   * un matériel promotionnel franchissant la porte qu'un sponsoring du même montant respecte.
   */
  "src/lib/seuils/",
  /**
   * `interrupteurs/` : l'interrupteur global des missions d'Adam (§118.132) — une ligne
   * `AppSetting` lue et écrite, rien d'autre. Trois couches en ont besoin sans avoir le droit de
   * se parler : la façade `missions/` (le moteur le relit à chaque tour), le domaine `google/`
   * (la santé d'Adam le sert à l'écran des réglages), les actions et le pont (poser, lever).
   * Sous `missions/runtime/`, la santé d'Adam remontait vers une façade — mesuré : 1 inversion
   * de couche, et le seul autre remède était une seconde lecture de la même ligne chez `google/`,
   * qui aurait divergé au premier champ ajouté (§118.5).
   */
  "src/lib/interrupteurs/",
  /**
   * `grille/` : la sélection de cellules et la palette des feuilles (§118.133), zéro import ;
   * `annuaires/` : les TYPES des lignes d'annuaire, zéro import. Les écrans (composants client),
   * le chargeur serveur (`queries/annuaires`), les actions et l'op d'Adam en ont tous besoin, et
   * aucun n'a le droit d'importer l'autre — un composant client qui importerait le chargeur
   * tirerait Prisma dans le navigateur, un chargeur qui importerait un écran remonterait vers
   * l'application. Et la RÈGLE de l'accès par annuaire (`annuaires/acces.ts`, §118.147), zéro
   * import elle aussi : `rbac.ts` la lit — le socle ne lit que le socle —, la console
   * d'administration (composant client) coche ses annuaires, et les pages, les actions et la
   * conversation l'interrogent par `rbac`. Écrite ailleurs, elle aurait deux lecteurs sans droit
   * de se parler, donc deux copies.
   */
  "src/lib/grille/",
  "src/lib/annuaires/",
  /**
   * `notifications/` : l'ÉCRITURE des lignes de notification, et rien d'autre — elle n'importe
   * que la base. Six écrivains en ont besoin sans avoir le droit de se parler : la messagerie
   * interne (`notify.ts`), les directives, les tâches et deux actions serveur. Le remède qu'elle
   * porte (un lot refusé se rejoue ligne à ligne, §118.137) n'a de valeur que s'il est le SEUL,
   * et elle ne peut pas vivre dans `notify.ts` : celui-ci importe le push, donc `web-push`, que
   * les tâches tireraient alors dans un bundle client.
   */
  "src/lib/notifications/",
  /**
   * `bons-de-commande/regle` — la RÈGLE des bons de commande (§118.148), et elle seule : quel
   * centre (Ad & Pro ou validations), quel état, ce qui bloque la facture, ce que dit la phrase.
   * Zéro import. QUATRE couches en ont besoin sans avoir le droit de se parler : les actions de
   * Legal, la fabrique documentaire (le pont), le règlement des factures (module `finances`,
   * `domaine/chemins-paiement.ts`) et le centre Ad & Pro. L'AIGUILLAGE (`bons-de-commande/aiguillage`),
   * qui lit la base et pose les portes, n'est PAS au socle : le chemin est EXACT, pour qu'un
   * fichier serveur ajouté à côté ne se retrouve pas exempté sans décision (§118.128).
   */
  "src/lib/bons-de-commande/regle",
  /**
   * `actions/contrat/` — les morceaux du LECTEUR DE CONTRAT des actions (`actions/contrat.ts`, lot V4) :
   * découpage de la source, formulaire, écritures, porte, champs, arguments. Zéro import hors du
   * dossier ; Adam (par le pont), les tests et les scripts le lisent. Pur par construction.
   */
  "src/lib/actions/contrat/",
  // Les règles pures de l'Assistant IA (décisions 0011, 0012, 0015 : lecture des pièces, plafonds, contenu non
  // fiable, mémoire affichée, texte partiel, familles d'accès, dépôt, et le markdown déclaré au lot J2) étaient
  // déclarées ici par chemin exact : elles vivent dans `src/modules/assistant-ia/domaine/` depuis la phase B du
  // lot J0, où `frontieres.test.ts` tient leur pureté.
  /**
   * `bons-de-commande/prevalidation` — la règle PURE de la pré-validation d'un BC (Demandes de validations, 10/2026),
   * zéro import : la règle des BC (`regle`, au socle) en lit la phrase, et l'écran des validations comme les actions
   * en lisent les refus. Chemin EXACT, comme `regle`.
   */
  "src/lib/bons-de-commande/prevalidation",
  /**
   * LES RÈGLES QUE `rbac.ts` LIT — chemins EXACTS, déclarés le 27/10/2026 quand le scanner a
   * appris à lire les imports relatifs : `rbac.ts` les importait en `./…`, et l'invariant « le
   * socle fuit : 0 » ne les voyait pas. Ils ne sont pas « déplacés au socle pour faire baisser un
   * compteur » : `rbac` en DÉPEND pour répondre à `userCan`, ils sont donc de fait le socle des
   * droits, et `scanSocle()` les tient désormais à l'obligation de n'importer aucun domaine.
   *   - `hr/stand-in` et `hr/stand-in-resolve` : les droits délégués d'un absent (n'importent que
   *     `rbac` et `prisma`) ;
   *   - `regulatory/pipeline-access`, `regulatory/assignment` : l'accès par étape du pipeline
   *     Regulatory, zéro import ;
   *   - `budget/domaines` : les pôles budgétaires, zéro import.
   * Cible (rapport d'audit 08, ARCH-01) : les ranger sous `src/lib/rbac/` quand `rbac.ts` sera
   * découpé, et supprimer ces exceptions.
   */
  "src/lib/hr/stand-in",
  "src/lib/hr/stand-in-resolve",
  "src/lib/regulatory/pipeline-access",
  "src/lib/regulatory/assignment",
  "src/lib/budget/domaines",
  /**
   * `chemins/` : les ADRESSES des écrans que plusieurs couches citent (§118.173) — des constantes,
   * zéro import. Le menu (`labels.ts`, au socle) lit l'adresse du stock promotionnel ; les
   * écrivains du stock (domaine `adpro`), les actions, les chargeurs et les écrans aussi. Écrite
   * à vingt-cinq endroits, l'adresse a changé une fois et vingt-cinq copies auraient dû suivre :
   * c'est la garantie qu'un lien finit par mener à l'ancien écran (§118.5).
   */
  "src/lib/chemins/",
];

/**
 * POURQUOI `lecteurs/` EST AU SOCLE — et pourquoi ce n'est pas un plafond relevé.
 *
 * `lecteurs/legal.ts` répond à UNE question, sans base de données et sans un seul import :
 * « cette personne peut-elle ouvrir CE document légal ? » (lecteurs désignés, déposant, Super
 * Admin, ou aucune restriction déclarée). Le fichier le disait déjà de lui-même — « Module PUR
 * — testé, sans base de données » — et il vivait sous `legal/`, ce qui était juste tant qu'un
 * seul domaine le lisait.
 *
 * Le déclencheur est celui de `mutations/` et de `storage/`, et ils sont maintenant SIX à en
 * avoir besoin sans avoir le droit de se parler : les écrans Legal, `entity-access` (qui répond
 * par ENREGISTREMENT pour tout le parc), la recherche, deux fournisseurs de plateforme
 * (intelligence, surveillance de missions) et — le franchissement qui a fait tomber le cliquet —
 * le contexte des pièces liées d'Ad & Pro, qui doit proposer à rattacher exactement les
 * documents que la personne a le droit de VOIR.
 *
 * La seule autre issue était d'en écrire une seconde copie chez Ad & Pro. Elle aurait divergé au
 * premier changement de la règle, et le symptôme aurait été un document confidentiel proposé au
 * rattachement sur un écran métier — la version en retard étant celle qui laisse passer (§118.5,
 * §118.71). Le cliquet n'a donc pas empêché d'avancer : il a nommé le chemin qui n'ajoute pas de
 * dette (§118.72, §118.97, §118.105).
 */

/**
 * POURQUOI `mutations/` EST AU SOCLE — et pourquoi ce n'est pas un passe-droit.
 *
 * Il n'y contient qu'une règle, et elle n'a pas de métier : l'empreinte réelle d'une écriture ne
 * dépasse jamais l'empreinte demandée (profondeur × cardinalité). C'est du texte comparé à un nom
 * d'opération — zéro import, comme `name-match`.
 *
 * Le déclencheur est le même que pour `storage/` : DEUX couches en ont besoin et elles n'ont pas
 * le droit de se parler. La conversation (`assistant/`, L1) doit refuser une carte trop large ;
 * le compilateur de missions (`missions/`, L2 — qui n'importe JAMAIS `assistant/`) doit refuser
 * une étape trop large. Laisser la règle chez Adam aurait obligé le compilateur à en écrire une
 * seconde, qui aurait divergé — exactement ce que §118.5 interdit.
 *
 * L'OBLIGATION qui vient avec : `scanSocle()` échoue si un fichier de `mutations/` importe un
 * domaine ou une façade. La règle restera donc pure, ou elle cassera le test.
 */

/**
 * POURQUOI `personnes/` EST AU SOCLE — même critère que `mutations/`, même obligation.
 *
 * Il ne contient qu'une LECTURE, sans métier : traduire ce qu'un modèle, un plan ou un éventail a
 * mis dans une entrée « qui » en une désignation — `« Nom <adresse> »`, un nom, une adresse, ou
 * `null` quand rien ne s'y lit à coup sûr. Zéro import, comme `name-match`.
 *
 * Le déclencheur est mesuré : une étape de mission résout une personne, l'éventail déploie
 * l'objet candidat sur `recipientName`, et le lecteur — qui attendait une chaîne — refuse
 * « Destinataire «  » introuvable » sur quelqu'un dont il tient le nom ET l'adresse. La
 * conversation (`assistant/`, L1) et le compilateur de missions (`missions/`, L2, qui n'importe
 * JAMAIS `assistant/`) ont tous deux besoin de cette lecture. La laisser chez Adam aurait obligé
 * le moteur à en écrire une seconde, qui aurait divergé — ce que §118.5 interdit.
 *
 * L'OBLIGATION : `scanSocle()` échoue si `personnes/` importe un domaine ou une façade.
 */

/**
 * POURQUOI `vues/` EST AU SOCLE — même critère que `mutations/` et `personnes/`.
 *
 * Il ne contient que des CATALOGUES D'AFFICHAGE : les colonnes d'un tableau configurable, leur
 * en-tête français, leurs alias, et celles qui ne se masquent jamais. Zéro import, zéro règle
 * métier — la même nature que `api/registry/entities`, déjà au socle pour cette raison.
 *
 * Le déclencheur est mesuré, et c'est TROIS couches, pas deux : « dans Regulatory, supprime la
 * colonne classe thérapeutique » doit être compris par la CONVERSATION (`assistant/`, L1) pour
 * valider le réglage, par l'ÉCRAN Regulatory pour ne plus rendre la colonne, et par la CONSOLE
 * D'ADMINISTRATION pour proposer la même liste de cases. Aucune des trois n'a le droit
 * d'importer les deux autres. Laisser le catalogue chez Regulatory obligeait Adam à traverser
 * la frontière — `boundary.test.ts` l'a refusé, à juste titre : c'est exactement l'import
 * direct que le contrat de plateforme existe pour empêcher.
 *
 * ET LE DÉFAUT QU'ON ÉVITE : deux listes de colonnes divergent à la première ajoutée — le
 * tableau montre « Projet » et Adam répond « colonne inconnue » (§118.5).
 *
 * L'OBLIGATION qui vient avec : `scanSocle()` échoue si `vues/` importe un domaine ou une
 * façade. Un catalogue qui se mettrait à lire la base cesserait d'y avoir sa place.
 */

/**
 * POURQUOI `storage/` A CHANGÉ DE CÔTÉ — et pourquoi ce n'est pas une façon de faire baisser
 * le compteur.
 *
 * `storage/` ne contient QUE des opérations de fichier : détecter un type d'après les octets,
 * présigner un objet S3, rendre une page de PDF en image. Aucune règle métier, et — c'est le
 * point vérifiable — AUCUN import vers un domaine ni vers une façade. Il satisfait donc mot pour
 * mot la définition du socle donnée plus haut.
 *
 * Le déclencheur a été la rastérisation : elle vivait dans le moteur OCR du Regulatory, et
 * l'ingestion de connaissance en a besoin. La laisser là aurait forcé « Knowledge » à dépendre
 * de « Regulatory » pour lire une image — un couplage absurde entre deux métiers pour une
 * fonction qui n'en porte aucun.
 *
 * CE QUE CE CHANGEMENT COÛTE, et c'est volontaire : `storage/` est désormais tenu par
 * `scanSocle()`, qui échoue si l'un de ses fichiers importe un domaine ou une façade. Il gagne
 * donc une OBLIGATION qu'il n'avait pas, plus stricte que celle d'un domaine ordinaire.
 *
 * Effet MESURÉ sur les compteurs, dit franchement : les traversées passent de 76 à 69, parce
 * que les imports vers `storage/` cessent d'être des traversées de domaine. Le plafond est
 * re-calé sur la mesure ; il n'a pas été « levé », et il redescend.
 */

/**
 * L2 — LES FAÇADES TRANSVERSES. Elles traversent les domaines par CONSTRUCTION : `queries/` est
 * la couche de lecture canonique, `api/registry/` celle d'écriture. Leur reprocher de connaître
 * plusieurs métiers reviendrait à leur reprocher d'exister.
 *
 * Ce qui est surveillé, c'est le SENS : un domaine ne remonte pas vers une façade (`domainToFacade`).
 *
 * ── POURQUOI `missions/` EST UNE FAÇADE ET NON UN MORCEAU D'ADAM ─────────────────────────
 *
 * Le Mission Runtime exécute un graphe d'étapes durables : il persiste, ordonnance, reprend
 * après une panne, pose des idempotences et compte des reçus. Rien là-dedans n'est propre à
 * l'assistant — un cron, une route HTTP ou un webhook doivent pouvoir faire tourner une mission
 * sans passer par une conversation.
 *
 * Il n'importe donc JAMAIS `assistant/` : les capacités lui arrivent par un port que l'appelant
 * fournit (`missions/ports.ts`). C'est ce qui le maintient au niveau des façades — et ce qui
 * rend l'inversion visible ici même le jour où quelqu'un tenterait l'inverse.
 */
// `fabric/` est une façade pour la même raison que `missions/` : une couche TRANSVERSE par
// construction (recherche de contenu, registre des sources), consommée par Adam ET par les
// domaines, qui n'importe jamais `assistant/`.
//
// `admin-delete-registry` et `entity-access/` (lot V4, découpage des fichiers géants) : deux couches
// TRANSVERSES par construction, qui n'étaient rangées nulle part (hors carte). Le REGISTRE des
// suppressions déclare, pour chaque genre de TOUS les métiers, comment le décrire, le refuser et
// l'effacer (il lit `queries/` et les règles de refus des domaines) ; seuls Adam, le pont, une
// façade et des fichiers hors carte l'importent — chemin entier, porte comprise. La garde
// `canAccessEntity` répond par enregistrement pour tout le parc (`queries/` + une règle par
// domaine) : ses MORCEAUX sont une façade, mais sa PORTE `entity-access.ts` reste hors carte, car
// trois domaines (regulatory, legal, mail) l'appellent — la déclarer façade compterait trois
// inversions de couche, à défaire chez eux d'abord.
//
// `actions/internes/` (lot V4) : ce que les fichiers d'actions serveur ont sorti d'eux-mêmes pour passer
// sous 1 000 lignes — aides, types, lectures, corps intermédiaires. Même couche que les actions qu'elles
// servent (elles lisent les domaines et les façades), jamais importées par un domaine. Hors de la racine de
// `actions/` et sans `"use server"` : ce ne sont PAS des actions (`actions/parc.ts`).
const FACADES = [
  "src/lib/queries/", "src/lib/api/", "src/lib/links/", "src/lib/missions/", "src/lib/fabric/",
  "src/lib/admin-delete-registry", "src/lib/entity-access/", "src/lib/actions/internes/",
];

/**
 * LE PONT ADAM ↔ ERP — le seul fichier de `src/platform/` autorisé à connaître l'ERP, par
 * dessein. `boundary.test.ts` détient la même liste et la même justification.
 */
const BRIDGE = ["src/platform/in-process/"];

/**
 * LE SOCLE IA (`src/platform/ia/`, lot J0, décision 0013) — ce que partagent Adam et l'Assistant IA :
 * la forme d'un outil, les lectures et les propositions communes, les intentions, la fabrique de
 * documents, les médias. Comme le pont, il CONNAÎT l'ERP par dessein (il lit et prépare pour les
 * deux assistants) ; il n'est donc ni au socle L0 ni dans un domaine. Sa dette vers l'ERP est
 * comptée et plafonnée à part (`boundary.test.ts`, `SOCLE_IA_CEILING`) ; ce qu'il n'importe JAMAIS
 * — Adam, l'Assistant IA — est tenu par `src/platform/ia/frontieres.test.ts`.
 */
const SOCLE_IA = ["src/platform/ia/"];

/**
 * LES FOURNISSEURS EXTERNES, qui doivent rester ISOLÉS (§1).
 *
 * Un domaine métier qui importe directement le client OpenAI ou le SDK Google se lie à un
 * fournisseur : le changer devient un chantier au lieu d'un remplacement. Ces modules ont des
 * façades (`models/`, `google/`) ; les traverser est une violation d'un genre particulier, qu'on
 * compte à part parce qu'elle se corrige différemment.
 */
const PROVIDERS = ["src/lib/openai-luna", "src/lib/ai", "src/lib/anthropic", "src/lib/drive-storage"];

export interface DomainViolation {
  from: string;
  to: string;
  fromDomain: string;
  toDomain: string;
}

export interface DomainReport {
  /** Un domaine qui fouille dans un autre. */
  crossings: DomainViolation[];
  /** Un domaine métier qui parle directement à un fournisseur externe. */
  providerLeaks: DomainViolation[];
  /** Un domaine (hors Adam) qui remonte vers une façade — inversion de couche. */
  domainToFacade: DomainViolation[];
  /** Un fichier du socle qui connaît un domaine ou une façade. Doit rester VIDE. */
  socleLeaks: DomainViolation[];
  /** Les couples (A → B) et leur volume — dit par où commencer. */
  perPair: Map<string, number>;
  /** Les fichiers les plus poreux. */
  perFile: Map<string, number>;
  /** Les cycles A → B → A. Ce sont les plus coûteux : plus rien ne se modifie séparément. */
  cycles: string[];
}

/**
 * Les imports se lisent par `./imports` : `import … from`, `export … from` (une réexportation crée
 * la même dépendance) et `import("…")`, en `@/` comme en RELATIF — un `./hr/…` écrit au socle
 * échappait à ce scanner jusqu'au 27/10/2026 (voir `imports-relatifs.test.ts`).
 */

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** À quel domaine appartient ce chemin ? `null` = socle, façade, page, composant ou hors carte. */
export function domainOf(file: string): string | null {
  for (const d of DOMAINS) {
    if (d.paths.some((p) => file.startsWith(p))) return d.name;
  }
  return null;
}

/** Un préfixe de la liste, en tolérant que `src/lib/prisma` désigne `src/lib/prisma.ts`. */
const inList = (f: string, list: string[]): boolean =>
  list.some((s) => f.startsWith(s) || f === `${s}.ts` || f === `${s}.tsx`);

const isSocle = (t: string): boolean => inList(t, SOCLE);
const isFacade = (t: string): boolean => inList(t, FACADES);
const isProvider = (t: string): boolean => PROVIDERS.some((s) => t === s || t.startsWith(`${s}/`));

/** La couche d'un fichier de `src/lib/` ou `src/platform/` — `null` s'il n'est dans AUCUNE (hors carte). */
export type Couche = "socle" | "façade" | "pont" | "socle IA" | "fournisseur" | `domaine:${string}`;

/**
 * Où un fichier vit sur la carte. Un fichier `null` n'est mesuré par aucun cliquet : c'est ce
 * que compte `couverture.test.ts` (rapport d'audit 08, ARCH-02), et ce compte ne peut que baisser —
 * en rangeant le fichier dans un domaine, au socle, ou dans un module `src/modules/<m>/`.
 */
export function coucheDe(file: string): Couche | null {
  if (BRIDGE.some((b) => file.startsWith(b))) return "pont";
  if (SOCLE_IA.some((b) => file.startsWith(b))) return "socle IA";
  if (isSocle(file)) return "socle";
  if (isFacade(file)) return "façade";
  if (isProvider(file.replace(/\.tsx?$/, ""))) return "fournisseur";
  const d = domainOf(file);
  return d ? `domaine:${d}` : null;
}

/**
 * SCANNE LES DÉPENDANCES ENTRE COUCHES.
 *
 * Les TESTS sont exclus, pour la même raison que dans le cliquet de frontière : un test a le
 * droit de fabriquer un jeu de données depuis n'importe où, et il est souvent la seule
 * « racine de composition » légitime (c'est lui qui assemble un vrai transport avec un faux
 * dépôt). Ce qu'on protège, c'est le code qui part en production.
 */
export function scanDomains(root = process.cwd()): DomainReport {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const files = [...walk("src/lib"), ...walk("src/platform")]
      .map((f) => f.split(path.sep).join("/"))
      .filter((f) => !/\.test\.tsx?$/.test(f));

    const crossings: DomainViolation[] = [];
    const providerLeaks: DomainViolation[] = [];
    const domainToFacade: DomainViolation[] = [];
    const socleLeaks: DomainViolation[] = [];
    const perPair = new Map<string, number>();
    const perFile = new Map<string, number>();
    const edges = new Map<string, Set<string>>();

    for (const file of files) {
      const fromDomain = domainOf(file);
      const fromSocle = isSocle(file) && !BRIDGE.some((b) => file.startsWith(b)) && !SOCLE_IA.some((b) => file.startsWith(b));

      for (const spec of specificateurs(fs.readFileSync(file, "utf8"))) {
        const target = cibleInterne(spec, file);
        if (!target) continue;

        // ── L0 : le socle ne connaît ni domaine ni façade. Zéro toléré. ──────────────────
        if (fromSocle) {
          if (isSocle(target)) continue; // un fichier du socle déclaré par chemin EXACT sous un domaine
          const td = domainOf(target);
          if (td || isFacade(target)) {
            socleLeaks.push({ from: file, to: target, fromDomain: "socle", toDomain: td ?? "façade" });
          }
          continue;
        }

        if (!fromDomain) continue;
        if (isSocle(target)) continue;

        // ── L1 → L2 : un domaine ne remonte pas vers une façade. Adam, lui, est AU-DESSUS. ─
        if (isFacade(target)) {
          if (fromDomain !== ADAM_DOMAIN) {
            domainToFacade.push({ from: file, to: target, fromDomain, toDomain: "façade" });
          }
          continue;
        }

        if (isProvider(target)) {
          // `models/` EST la façade des fournisseurs : lui interdire d'y toucher n'aurait aucun
          // sens. Idem pour `google/`, façade du SDK Google.
          if (fromDomain === ADAM_DOMAIN && target.startsWith("src/lib/ai")) continue;
          if (fromDomain === "google") continue;
          providerLeaks.push({ from: file, to: target, fromDomain, toDomain: "provider" });
          continue;
        }

        const toDomain = domainOf(target) ?? domainOf(`${target}/`);
        if (!toDomain || toDomain === fromDomain) continue;

        crossings.push({ from: file, to: target, fromDomain, toDomain });
        const pair = `${fromDomain} → ${toDomain}`;
        perPair.set(pair, (perPair.get(pair) ?? 0) + 1);
        perFile.set(file, (perFile.get(file) ?? 0) + 1);
        if (!edges.has(fromDomain)) edges.set(fromDomain, new Set());
        edges.get(fromDomain)!.add(toDomain);
      }
    }

    return { crossings, providerLeaks, domainToFacade, socleLeaks, perPair, perFile, cycles: findCycles(edges) };
  } finally {
    process.chdir(cwd);
  }
}

/**
 * LES CYCLES À DEUX DOMAINES — A importe B et B importe A.
 *
 * On s'arrête aux cycles de longueur 2 délibérément. Ce sont les seuls qu'on sache CORRIGER
 * simplement (une inversion de dépendance), et ce sont de loin les plus fréquents. Détecter des
 * cycles de longueur 5 produirait une liste impressionnante et inexploitable.
 */
function findCycles(edges: Map<string, Set<string>>): string[] {
  const out = new Set<string>();
  for (const [a, targets] of edges) {
    for (const b of targets) {
      if (edges.get(b)?.has(a)) {
        // Trié pour que « a ↔ b » et « b ↔ a » ne comptent qu'une fois.
        out.add([a, b].sort().join(" ↔ "));
      }
    }
  }
  return [...out].sort();
}

/** Les arêtes exactes d'un cycle — sans elles, « google ↔ mail » ne dit pas quoi corriger. */
export function cycleEdges(r: DomainReport, cycle: string): DomainViolation[] {
  const [a, b] = cycle.split(" ↔ ");
  return r.crossings.filter(
    (v) => (v.fromDomain === a && v.toDomain === b) || (v.fromDomain === b && v.toDomain === a),
  );
}

/** Le rapport, tel qu'on le lit dans un terminal. */
export function formatDomains(r: DomainReport, topN = 12): string {
  const pairs = [...r.perPair.entries()].sort((a, b) => b[1] - a[1]);
  const files = [...r.perFile.entries()].sort((a, b) => b[1] - a[1]);
  return [
    "ARCHITECTURE — DÉPENDANCES ENTRE COUCHES",
    `  traversées inter-domaines   : ${r.crossings.length}`,
    `  fuites vers un fournisseur  : ${r.providerLeaks.length}`,
    `  domaine → façade (inversion): ${r.domainToFacade.length}`,
    `  fuites du socle (doit être 0): ${r.socleLeaks.length}`,
    `  cycles à deux domaines      : ${r.cycles.length}${r.cycles.length ? ` (${r.cycles.join(", ")})` : ""}`,
    "",
    `LES ${topN} COUPLES LES PLUS LIÉS :`,
    ...pairs.slice(0, topN).map(([p, n]) => `  ${String(n).padStart(3)}  ${p}`),
    "",
    `LES ${topN} FICHIERS LES PLUS POREUX :`,
    ...files.slice(0, topN).map(([f, n]) => `  ${String(n).padStart(3)}  ${f}`),
  ].join("\n");
}
