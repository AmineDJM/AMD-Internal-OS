# 0057 — Les défauts produit du passage réel du 02/11 (soir), corrigés par l'architecture (lot F2, 02/11/2026)

Passage réel complet sur `f330f674` ([rapport](../preuves/audit/RAPPORT.md), [analyse](../preuves/audit/ANALYSE.md)) :
224/250 tâches, 110/110 attaques bloquées. Restaient neuf défauts du **produit**. Chacun est corrigé dans le code,
pas dans la consigne : une règle, à l'endroit où l'erreur naissait. Chacun a son test sur la base locale
(`src/modules/assistant-ia/f2-defauts-banc.test.ts`, 24 cas). Les rejeux réels ciblés sont en bas de page.

## Gravité élevée

### 1. TR-VX-02 — une consigne interne était prononcée

**Cause** : `pourVoix` portait à la fois le texte à dire et la consigne au modèle vocal. La consigne d'attente K9
(« Le travail est lancé… Dis en quelques mots que tu regardes… N'invente aucun résultat ») sortait donc telle quelle :
à l'oreille, dans la transcription, dans le banc.

**Correctif** : deux canaux, jamais mélangés. `pourVoix` contient ce qui se **dit**. `consigne` contient ce qu'on
demande au modèle vocal, envoyé en contexte silencieux (`session.thinking.append`, événements `silence_…`).
La garde de sortie, une règle pure (`src/platform/ia/voix/dit-et-consigne.ts`, `sortieOrale`), s'applique au serveur
(`deleguerALaVoix`, `suivreTravailVocal`, reprises, annonces) **et** au navigateur (`deleguer`, `suivreMaintenant`, `dire`).
Elle repère une phrase porteuse de consigne : un impératif adressé au modèle, une marque comme « la personne… »,
« de toi-même », « n'invente », « en trois mots ». Cette phrase quitte la parole pour la consigne. Une parole citée
(« Dis « Noté, PDF » », « Termine par « Tu confirmes ? » ») reste dite. Les textes du serveur (lancement, annulation,
carte orale, échec, stop, plus court) sont réécrits en deux champs.

### 2. TR-RH-01/02/06 (et TR-RH-04) — son propre congé, son absence, son avance refusés

**Cause** : la garde de famille des capacités jugeait la famille de l'**action** (`hr-actions` → « Fiches
collaborateurs », `salaryAdvance` → « Salaires & paie », `hr-document-actions` → « Contrats & documents RH »), comme si
la personne agissait sur autrui. Pour TR-RH-06 s'y ajoutait le filtre de confidentialité de la saisie : il prenait
« une avance sur **salaire de 30 000 DZD** » pour une rémunération et masquait le montant avant le modèle, qui le
redemandait.

**Correctif** :
- `GESTES_POUR_SOI` et `famillesAJuger` (`domaine/acces-regles.ts`, règle pure). Un geste de cette table (congé,
  avance, demande de document RH) **sans** le champ qui désigne autrui (`employeeId`) ne se juge pas sur les familles
  du dossier RH. « Écritures métier » reste exigée.
- **Avec** ce champ, il se juge comme avant. Une famille fermée refuse, donc rien n'est rouvert sur autrui. L'action
  elle-même n'honore `employeeId` que pour qui gère les RH, et prend sinon la fiche **liée** au compte.
- Si le modèle recopie la personne elle-même dans `employeeId` (son nom, ou l'identifiant de sa fiche liée), le champ
  est retiré (`sansSoiDesigne`).
- Filtre de saisie : « avance / acompte sur (son) salaire de X » n'est plus une rémunération. « Salaire net de X »
  reste masqué.

### 3. MI-01, DOC-11, MG-10 — plan de mission refusé, tour en erreur

**Cause (relevée au rejeu réel)** : l'étape LECTURE du plan désignait `trouver_outil`. La lecture des demandes
Ad & Pro (`demandes_adpro`) n'était pas active dans le tour du modèle, et le compilateur ne connaissait que les noms
exacts du catalogue.

**Correctif** :
- `CatalogueTravail` reçoit `resoudreLecture` et `resoudreGeste` (`lib/missions/travaux/plan.ts`). La persona
  (`infra/travaux.ts`) les construit avec l'index de sélection des outils (J4), **borné au catalogue de la personne**.
  Le meilleur outil n'est retenu que s'il se détache (≥ 1,25 × le second), et jamais hors catalogue, donc aucun droit
  de plus.
- Une étape restée introuvable est refusée, et la faute **liste les noms ouverts** : le modèle corrige au lieu de deviner.
- MG-10 (le modèle n'a pas répondu pendant 240 s) : le message dit la cause (`messageDEchec` : délai dépassé, ou modèle
  muet). Le fil **reprend la demande une fois** dans la même réponse (`ResultatDuTour.transitoire`, `fil/service.ts`).

### 4. TR-LO-01 — une carte toujours valable retirée comme « caduque »

**Cause** : la caducité comparait des mots de sujet. Deux tâches indépendantes partageaient, par leur description,
« appel d'offres oncologie CHU Mustapha ». Toutes les capacités partageaient aussi le même `kind`. Enfin, la question
« Rappelle-moi ce qu'on vient de préparer pour cet appel d'offres » retirait les deux cartes avant que le modèle réponde.

**Correctif** (`platform/ia/intentions/proposition-perimee.ts`) :
- Une carte de capacité se compare par son **objet** (`objetDeLaCharge` : titre ou objet de l'entrée), et non par sa
  description.
- La nature d'une capacité est son action (`assistant_ia_capacite:<id>`).
- Une **question ou un rappel** ne rend aucune carte caduque (`estQuestionOuRappel` : l'acte de parole, pas des mots
  de correction).
- Une carte réellement remplacée (même objet, nouvelle échéance) reste retirée. La correction sans re-proposition
  (« finalement pas Raihana, c'est Amel ») se juge toujours sur tout ce que la carte affiche.

## Gravité moyenne

5. **TR-EV-01** — la BU se désigne par son nom. Entité `business_unit` du registre (référentiel non personnel, lisible
   par les modules Ad & Pro et Ventes, ce que leurs formulaires montrent déjà). « BU » et « gamme » sont des mots vides
   de la désignation.
6. **TR-RH-04** — l'attestation pour soi passe par l'action existante `hr-document-actions:requestHrDocument` (RBAC de
   l'écran, compensation au registre des capacités), désormais ouverte pour soi (§2). Deux autres corrections :
   - son contrat ne rend plus `expenseMonth` obligatoire pour toute demande RH : le test propre à la note de frais ne
     s'écrit plus `!expenseMonth` ;
   - la recherche trouve « attestation, certificat, travail, salaire » (lexique des capacités).
7. **TR-MU-03** — un mail dont le destinataire est introuvable : la carte est **préparée**, avec « À » à compléter.
   - `preparerMails(…, { destinataireACompleter })` ;
   - un champ obligatoire vide est permis sur la carte **seulement** à la demande d'un outil du serveur. La clé est un
     symbole, `A_COMPLETER` : aucune entrée JSON du modèle ne la porte ;
   - la confirmation rejuge tout, et l'action refuse tant que le champ manque.
8. **TR-LM-04** — un article hors catalogue est proposé en **saisie libre** (« Autre article »), plus jamais retiré.
   - `createPromoMaterial` accepte dès la création les lignes `catalogueId: "AUTRE"`, avec la règle de la fiche ;
   - l'écriture est partagée : `lib/promo-material/article-hors-catalogue.ts` ;
   - l'article entre au catalogue archivé, marqué hors catalogue, une fois toute la demande recevable ;
   - l'opération de l'assistant propose la famille et l'action fournisseur probables sur la carte, modifiables.

## Gravité faible

9. **AN-ANNULER-03** — « Annule cette demande » face à une carte non confirmée : le serveur retire **lui-même** la
   dernière carte proposée (`retirerCarteAnnuleeAvantLeTour`, événement `CANCELLED_BY_USER_MESSAGE`) et le dit au
   modèle. Un ordre court sans autre objet est requis (`annuleLaCarte`). Si la dernière carte a été exécutée, « annule »
   reste l'annulation du journal des effets (K10).

## Ce qui ne bouge pas

Les plafonds ne sont pas relevés : doublons (jscpd 1436 / 1437), couverture hors carte (le seul fichier neuf de
`src/lib` est dans le domaine `adpro`), dette, taille des fichiers (`promo-material-actions.ts` reste sous 1 000
lignes), frontières. Le banc déterministe des attaques (`audit-assistant.test.ts`) et le banc de contournement S1
restent verts. Aucune migration. Réversibilité K10 :
- les seules écritures neuves sont l'article libre (déjà le comportement de la fiche) et le retrait d'une carte (état
  CANCELLED d'une intention jamais exécutée) ;
- les gestes ouverts pour soi gardent leur annulation au registre (compensation ou retour).

## Rejeu réel ciblé

Voir `docs/assistant/preuves/audit/f2/` (rapport du rejeu, avant → après).
