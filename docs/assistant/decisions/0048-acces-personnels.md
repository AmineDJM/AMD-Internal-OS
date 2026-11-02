# 0048 — Un assistant par employé : qui il sait être, ce qu'il voit (lot S1, 02/11/2026)

**Constat de la Direction en production (02/11, mot pour mot)** : « J'ai essayé l'assistant IA depuis le compte de Radia :
les accès ne sont pas du tout respectés. Il m'a dit "Salut Amine" alors que c'est Radia. » L'accueil disait « Bonjour
Radia 👋 » ; « Salut » → « Salut Amine ! » ; « Quel est mon salaire ? » → « Aucune fiche RH n'est rattachée à votre
compte » ; « Quel est le salaire de radia ? » → 110 000 DZD net ; « et de assia ? » → 400 000 DZD. Puis : « Je veux un
assistant IA pour CHAQUE employé : ouvert dans le compte d'un employé, il sait déjà à qui il s'adresse — connecté au
collaborateur, à son contrat, à son profil, à ses accès. […] Et évidemment, absolument AUCUN accès aux autres, quel que
soit le truc. » « Le contrôle des accès doit être encore plus personnalisé : contrat, avenants… »

## 1. La cause — reproduite sur la base locale (banc `s1-acces-personnels.test.ts`)

**H1, confirmée — c'était la Vue exacte.** La Direction (Amine, Super Admin) avait ouvert le compte de Radia en « Vue
exacte ». L'accueil est un **rendu** : la vue y est honorée, d'où « Bonjour Radia ». Le message, lui, part par une
**action serveur** (`envoyerMessageBeta`, `src/app/(app)/assistant/beta/actions.ts`, l'écran y bascule en Vue exacte,
`use-fil.ts` → `envoyerLocal`). Le **corps** d'une action s'exécute au nom du Super Admin réel (§118.184 : `requireUser()`
rend Amine, avec `visualise` = Radia). `jouerTour(user, …)` jouait donc le tour avec l'identité d'Amine (« Salut Amine »,
consigne « Nom : Amine… »), **sa** mémoire et **ses** droits de Super Admin (toute la paie). « Mon salaire » → Amine n'a pas
de fiche RH → « Aucune fiche RH n'est rattachée à votre compte » : la signature exacte du constat.

**H2, confirmée en partie — un réglage de RÔLE ouvrait la paie de tous.** En connexion réelle, Radia (assistante de
direction, sans droit RH) est refusée par défaut. Mais si la console ouvrait « Salaires & paie » **au rôle** Assistante de
direction (décision 0012 : « ouvrir explicitement peut aller au-delà des droits »), `droitSurAutrui` et la révélation
(`peutVoirLaValeur`, `parOuverture`) rendaient la paie de **tout** salarié des entités permises — mesuré : le banc voyait
400 000 DZD. Même chose pour le dossier RH d'autrui (`/api/rh/document/[id]`). La « mémoire commune » de la décision 0027 est
commune aux conversations **d'une même personne** (requêtes `where userId`) : rien d'une autre personne n'y entre — vérifié.

**H3, tenue.** `employeDesigne("moi")` ne cherche que la fiche **liée** (`Employee.userId`), jamais par nom ou adresse : un
lien manquant refuse (« Aucune fiche RH… »), il n'ouvre rien.

## 2. La correction (poussée en premier)

1. **Vue exacte : l'assistant est FERMÉ.** C'est la voie la plus sûre, et nous la choisissons : jouer « comme Radia »
   exigerait de garantir qu'aucun outil n'écrit (sous-missions, chantiers, notes, mémoire automatique, visuels payants,
   journal de consommation), une liste qui grandit à chaque lot. La voix, les gestes, les notes et la captation terrain
   étaient déjà fermés en Vue exacte ; le texte l'est désormais aussi. Trois portes :
   - `envoyerMessageBeta` et `confirmerActionBeta` refusent dès que l'identité porte `visualise` ou `impersonatedBy`
     (`enVueExacteIa`, `domaine/acces-regles.ts`) ;
   - `jouerTour` refuse lui-même, quel que soit l'appelant, **avant** tout appel de modèle (échec fermé) ;
   - `accesAssistantIa` rend un accès vide pour une identité vue.
   L'accueil, en Vue exacte, dit la fermeture et renvoie vers **Administration › Contrôle de l'IA › Assistant IA — accès**,
   où la Direction vérifie ce que l'assistant de la personne voit (§5).
2. **Les valeurs sensibles d'autrui ne s'ouvrent plus jamais par un réglage de rôle** (§3).
3. **Audit D1** : `directory_list` (extraction du registre complet, coordonnées de tous) se juge sur le **droit réel**
   de la personne, plus sur un module que la console ajoute à la vue de l'assistant (`outils-v1.ts`, `surDroitReel`).

## 3. Les accès de l'assistant d'une personne — dérivés du contrat et des avenants

Règle pure : `src/modules/assistant-ia/domaine/perimetres.ts` (+ `acces-regles.ts`). **Par défaut, chacun ne voit que ses
propres données** (sa paie, sa fiche, ses documents si sa fiche est liée). Une valeur sensible d'**autrui** (paie,
dossier RH, IBAN, NIN) ne s'ouvre que par l'une de ces trois origines, toutes nominatives :

| Origine | Quoi | Bornes |
|---|---|---|
| **Rôle** (droit applicatif) | gérer les RH (`RH` modifier/valider) dans la société de la fiche — ce que l'écran de la paie lui montre déjà | entités permises |
| **Avenant** (`AvenantContrat`, objet `DELEGATION`) | une famille (ex. `SALAIRES`) sur **une** entité nommée | de `effetLe` à `finLe` (jour compris), non révoqué, **contrat en vigueur** (fiche active, échéance non dépassée) |
| **Console** (`AssistantIaDroitDate`) | un droit explicite **et daté**, nommément, motif dit | `du` → `au`, entité ou « entités permises », révocable |

- Un **réglage de rôle** de la console ouvre encore une famille pour **soi** et les données non sensibles ; il n'ouvre
  **jamais** autrui. Une **fermeture nominative** prime sur tout, avenant compris.
- Cocher « ouverte » pour une **personne** dans la console inscrit un droit daté (aujourd'hui, sans fin, motif) ; décocher
  le révoque. La migration `20270221000000_s1_acces_personnels` reprend ainsi les ouvertures nominatives existantes (paie,
  dossier RH) — la Direction les voit, les borne ou les révoque. Les ouvertures de rôle ne sont pas reprises.
- Un intitulé de poste en texte libre n'ouvre rien : la fonction au contrat (et un avenant `FONCTION`) informe le profil, pas
  les droits.
- **Chaque lecture sensible est auditée avec son motif** : le coffre journalise les colonnes (`controlerLecture`), le hors-
  colonne passe par `journaliserLectureHorsColonne`, et une révélation par avenant ou droit daté écrit à l'audit l'origine,
  la référence et le motif (« Rémunération montrée par l'Assistant IA sur avenant au contrat … réf. … — motif : … »).
- La hiérarchie : un responsable n'a, par l'assistant, que ce que l'écran lui montre de son équipe (congé/absent, jamais la
  nature ni la paie).

## 4. Un assistant par employé — le PROFIL de la personne

Chaque tour porte une section « INTERLOCUTEUR » construite par le **serveur** (`infra/profil-personne.ts`, règle pure
`domaine/profil-personne.ts`) depuis le compte de la **session** et la fiche RH **liée** — jamais d'une mémoire, d'un
historique ou d'une autre personne : nom, prénom (« Radia KEBIR » → « Radia »), adresse (tutoiement/vouvoiement, préférence
`AssistantIaPreference.adresse`, réglable dans le panneau Mémoire, réversible), rôle(s), fonction (contrat ou dernier
avenant `FONCTION`), département, entité, responsable, contrat (type, dates, en vigueur ou non), avenants en vigueur,
périmètres sur autrui (ou « aucun »). La consigne dit : « Adresse-toi à cette personne par son prénom — JAMAIS par un autre
prénom, même si la mémoire, l'historique ou un document en cite un autre. » Taille ≈ 100–200 jetons ; la part lue en base
est gardée 60 s par personne, les familles et périmètres sont ceux de l'accès du tour (jamais en cache). L'accueil de
l'écran suit le prénom et l'adresse.

## 5. Administration › IA › Accès — « Ce que son assistant voit »

Pour une personne : la consigne exacte du profil, chaque famille avec son état et son **origine** (défaut des droits,
réglage du rôle, réglage de la personne, avenant, droit daté), les périmètres en vigueur, l'historique des avenants et des
droits datés — calculés par le moteur lui-même (`apercuAssistantDe`). La Direction y accorde un droit daté (famille
sensible, entité, du/au, motif obligatoire), enregistre un avenant (fonction, ou délégation d'une famille sur une entité,
datée), et révoque l'un ou l'autre. Super Admin seul (jamais en Vue exacte), chaque geste à l'audit avec sa référence.

## 6. Preuves

- `src/modules/assistant-ia/s1-acces-personnels.test.ts` — le scénario exact (Vue exacte : refus sans appel de modèle ;
  Radia : son salaire oui, celui d'Assia jamais, même famille ouverte à son rôle ; sans fiche liée : refus), puis les
  avenants (entité, dates, révocation, contrat échu), le droit daté de la console, D1.
- `e2e/s1-acces-personnels.spec.ts` — serveur réel : l'accueil de Radia la nomme ; en Vue exacte, l'assistant est fermé,
  aucun salut au nom du Super Admin, aucun montant.
- `docs/assistant/preuves/s1/` — l'audit de fuite outil par outil.
