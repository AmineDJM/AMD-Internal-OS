# 0024 — La proactivité sous mandat (lot J12, 30/10/2026)

**Décision de la Direction (29/10/2026)** — architecture « noyau Jarvis » (<https://claude.ai/artifact/34ig3QRV5X7LtanjyuX7U7>),
lot J12 : *veilleurs par rôle, suggestions au bon moment, routines qui écrivent sous mandat, budget d'interruptions*.
Critère de fin : **≤ 5 interruptions par personne et par jour ; ≥ 60 % jugées utiles**.

## Les principes

1. **Le code décide de déranger, le modèle rédige.** Un veilleur est une règle sur les données de la personne ; la même
   situation donne le même verdict, et l'écran dit pourquoi. Le modèle n'est appelé que pour rédiger le point du matin
   (rôle « rapide », filtre de confidentialité), avec un texte de secours sans lui.
2. **Dit une fois.** Chaque constat porte une signature (l'objet et l'état qui le rend problématique) ; la clé unique
   `(personne, veilleur, clé)` empêche qu'il soit redit. Un constat qui n'est plus vrai passe *résolu* ; s'il redevient vrai
   avec la même clé, il se rouvre **au journal** (visible, servi aux mandats, sans sonner une seconde fois).
3. **Un budget d'interruptions.** Heures calmes (19 h → 8 h, heure d'Alger, réglables), week-end vendredi-samedi ;
   regroupement (un passage = une interruption, au moins une heure entre deux) ; **5 par jour au plus** (la console fixe le
   plafond, la personne peut baisser). Au-delà : le journal, à l'écran, sans notification.
4. **Le retour en un clic** « utile / pas utile » est compté par veilleur (taux mesuré, cible 60 %) et l'**ajuste** : « pas
   utile » multiplie son seuil par 1,25 (jusqu'à ×3), « utile » le ramène vers 1 ; moins d'un tiers d'utiles sur 3 retours ou
   plus → le veilleur devient **discret** (journal seulement).
5. **Un mandat est une approbation durable, bornée, révocable**, accordée par la personne : une capacité nommée, des
   destinataires, un montant plafond quand le geste en porte un, un nombre de gestes par jour, une échéance obligatoire
   (≤ 90 jours). **R1 seulement par défaut** (écriture interne réversible) ; une famille sensible (salaires, contrats RH) ou
   un geste R2 exige en plus l'accord de la console ; au-delà de R2, jamais. Chaque geste et chaque refus va à l'audit ; le
   récapitulatif part dans le point du matin.

## Les veilleurs (`domaine/proactivite/veilleurs.ts`, lectures `infra/proactivite/sources.ts`)

| Pôle | Veilleur | Ce qu'il lit (ce qui est À la personne) | Seuil par défaut | Famille |
|---|---|---|---|---|
| Ad & Pro | Demande bloquée | sponsorings (demandeur ou chef de produit) et demandes « autre » en attente, sans mouvement | 7 j | AD_PRO |
| Ad & Pro | Budget presque consommé | lignes de budget dont elle est responsable, consommé + engagé | 90 % (palier 100 % dit à part) | BUDGETS |
| Ad & Pro | BC non signé | BC qu'elle a émis, entrés dans le circuit, ni signés ni renvoyés | 3 j | AD_PRO |
| Réglementaire | Échéance ANPP | obligations de ses dossiers ; échéance externe des produits dont elle est responsable | 14 j (puis « dépassée ») | REGLEMENTAIRE |
| Réglementaire | Réserve non levée | points de réserve qui lui sont assignés, cycle ouvert | 10 j après réception | REGLEMENTAIRE |
| RH | Fin de période d'essai | ses collaborateurs **directs** (renouvellement compris) | 15 j | FICHES |
| RH | Contrat à renouveler | CDD de ses collaborateurs directs | 30 j | **CONTRATS_RH** (fermée par défaut) |
| Finances | Paiement en retard | demandes de paiement et ordres de dépense qu'elle a émis, échus non payés | dès l'échéance | BUDGETS |
| Finances | Facture en double | même fournisseur et (même numéro, ou même montant le même jour) — toutes les factures pour qui valide en Finances, les siennes sinon | 90 j | BUDGETS |
| Terrain | Visite non rapportée | ses visites planifiées passées, ou faites sans compte rendu | 1 j | FICHES |
| Pour tous | Validation qui traîne | ses demandes de validation, depuis que l'étape attend son validateur | 5 j | ECRITURES |
| Pour tous | Réunion dans l'heure | réunions et événements d'agenda où elle est (organisatrice, invitée) ; points ouverts sur les participants | 60 min | DRIVE |

Deux portes avant toute lecture : un module d'écran ouvert (si la fiche en nomme) et la **famille de la console** ouverte
pour elle (relue à chaque passage). Un veilleur n'élargit jamais ce qu'elle voit.

## Les moments

- **Le battement** (`assistant.veilleurs`, `src/lib/scheduled.ts`) : les personnes venues ces 14 jours, une veille par
  quart d'heure chacune, 20 par battement. Personne relue en base (`proprietaire`) ; assistant fermé → rien.
- **Le matin** : premier passage d'un jour ouvré dans les 3 heures après la fin du calme — ce qui a attendu, et ce qui a
  été fait sous mandat depuis le point précédent. Rédigé par le modèle, sinon texte de secours.
- **Une heure avant une réunion** : le veilleur « Réunion dans l'heure » (fenêtre seuil − 30 / + 15 min).
- **À l'ouverture d'un dossier** : `SuggestionsDossier` (pages `/validations/[id]`, `/sponsoring/[id]`) montre les constats
  de la personne sur cette fiche, avec le retour en un clic. Aucune interruption consommée.

## Où s'exécutent les gestes sous mandat — et pourquoi pas sur le worker

Un geste passe par la **même porte qu'une carte confirmée** : `proposer` (contrôles de l'écran) puis `executerOperationIA`
(arrêt d'urgence, droit d'écran), qui appelle l'action métier de l'écran. Ces actions lisent la session (`requireUser`) et
appellent `revalidatePath` — qui **lève hors d'une requête** (Next 15 : « static generation store missing »), *après*
l'écriture. Exécutées sur le battement, elles écriraient puis échoueraient. Plutôt qu'une identité de fond (changement du
socle des sessions) ou un second chemin d'écriture, **les gestes se font dans une requête de la personne** : la coque de
l'ERP monte `ExecuteurMandats` (jamais en Vue exacte), qui appelle `executerMesGestesSousMandat` à l'ouverture d'une page
puis toutes les 10 minutes ; le serveur prend la fenêtre atomiquement (deux onglets ne font rien deux fois). La veille
constate en arrière-plan ; le geste suit dès que la personne est là.

Le **reçu** (`AssistantMandatGeste`, unique par mandat et constat) est pris AVANT le geste : un geste coupé reste
`EN_COURS`, jamais rejoué ; une étape n'est relancée qu'une fois, quel que soit le mandat.

> **Constat transverse (pour J8)** : `src/lib/missions/travaux/` (J2) exécute les gestes d'un travail sur le worker par
> le même `executerOperationIA` : la même limite s'y applique aux actions qui lisent la session.

## Capacités mandatables

| Capacité | Opération | Niveau | Veilleur | Console |
|---|---|---|---|---|
| Relancer le validateur d'une de mes demandes | `preparer_relance` | R1 | Validation qui traîne | non |

La table `NIVEAU_OPERATION` (`domaine/proactivite/mandats.ts`) classe les 19 opérations de l'Assistant IA (R1 → R4 ; une
opération inconnue vaut R4) en attendant le registre des capacités (J6), qui la dérivera de chaque action.

## Données (migration `20270210100000_assistant_ia_proactivite`, additive et idempotente)

`AssistantVeille` (préférences et état), `AssistantVeilleur` (actif, seuil, facteur, retours), `AssistantSignal`
(constats), `AssistantMandat`, `AssistantMandatGeste` ; `AssistantIaReglage.interruptionsMaxJour` (5) et
`proactiviteCoupee`.

## Écrans

- **« Ce que mon assistant surveille »** (`ecrans/veille-panel.tsx`, bouton radar de `/assistant`, `?veille=1`) : constats
  (canal, retour en un clic, écarter), veilleurs (activer, seuil, utilité, discret), mandats (bornes, gestes faits,
  révoquer, accorder), réglages (plafond, heures calmes, week-end, point du matin).
- **Console** (`/admin/ai/acces`, `ecrans/console-proactivite.tsx`) : plafond par personne et par jour, interrupteur général,
  mesure sur 7 jours (utilité, interruptions par personne et par jour), mandats en cours (accorder, révoquer).
- Actions : clé `assistant-ia-proactivite-actions` (`actions-proactivite.ts`), valeurs simples (cliquet du contrat tenu).

## Mesures

- `domaine/proactivite/proactivite.test.ts` (19 cas, purs) : signatures stables, paliers, doublons, fenêtre de réunion,
  seuil appris ; heures calmes et week-end ; regroupement ; **une journée de constats toutes les 15 min → 5 interruptions,
  pas une de plus** ; point du matin ; mandats (bornes, échéance, destinataires, plafond, R-niveaux).
- `infra/proactivite/proactivite.test.ts` (10 cas, vraie base, faux rédacteur) : 3 veilleurs → **1 notification
  regroupée**, rien redit au passage suivant ; dossier ; 22 h → attend, 8 h → point du matin ; plafond → journal ;
  retours → seuil ×1,95 et discret ; désactivation ; mandat de relance **par l'action de l'écran**, 2 par jour tenus, une
  fois par étape, audit, révocation ; destinataire hors mandat refusé ; échéance → `EXPIRE` ; console coupée ; assistant fermé.

- **Essai réel** (30/10, un seul appel, modèle « rapide » `gpt-6-luna`) : un point du matin rédigé à partir de 3 constats et
  d'un geste sous mandat — 4,3 s, 282 jetons en entrée, 203 en sortie, **0,003 $** ; texte fidèle (le plus urgent d'abord,
  aucun chiffre ajouté, le geste récapitulé).
- Suite complète : seul échec restant, `derive-schema/ordre-migrations.test.ts`, lié au clone superficiel du conteneur (il
  lit l'historique git des migrations ; 2 migrations de janvier mises en cause, aucune de J12).

## Ce qui reste

- Le taux d'utilité réel (cible 60 %) se mesure en production : la console l'affiche sur 7 jours.
- Les veilleurs RH ne voient que les collaborateurs directs ; une vue RH élargie passera par la porte du module `rh`.
- D'autres capacités (rappel personnel, tâche de suivi) après le registre J6 ; la persona Adam (J15) pourra lire les
  mêmes veilleurs.
