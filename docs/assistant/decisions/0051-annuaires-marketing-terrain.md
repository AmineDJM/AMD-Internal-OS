# 0051 — Adventum IA tient les annuaires, analyse le marketing et interroge le terrain (lot T2, 02/11/2026)

> Construit sur le registre des capacités (J6, [0020](0020-capacites.md)), la simulation et le journal des effets
> (J7, [0029](0029-simulation-annulation.md)), la réversibilité des actions métier (K10c, [0044](0044-actions-reversibles-metiers.md)),
> les missions de fond et la délégation « demander à » (K3 / J8, [0033](0033-sous-missions.md), [0023](0023-delegation.md)),
> l'analyse de données (K1, [0031](0031-analyse-donnees.md)) et le banc d'audit permanent (Q1, [0050](0050-banc-audit-permanent.md)).

**Demande de la Direction (02/11, extrait)** : « Il faut aussi qu'il soit capable d'analyser le marketing, modifier les
annuaires, il peut avoir des tâches longues à faire sur l'annuaire, il peut demander aux délégués ou à des gens les stocks
etc. et des trucs précis de tout genre […] À terme je veux que les employés utilisent beaucoup beaucoup Adventum IA ! »

## 1. Le constat, mesuré au banc réel (avant)

35 tâches nouvelles (`ANN-` annuaires, `MKT-` marketing, `TER-` terrain), jouées par le vrai modèle sur la base de banc.
Avant le lot : **2 réussies sur 19 jouées** (16 non jouées, plafond de 1,40 $ atteint — les tours tournaient en rond) —
seules les deux tâches de REFUS (délégué hors secteur) passaient. Les causes, lues dans les conversations :

1. **« Dr Karima BENSALEM » introuvable** dans le panel du délégué : le résolveur des capacités (`resoudreCible`) cherchait
   le texte ENTIER (« Dr Karima BENSALEM ») dans le nom (« Karima BENSALEM ») — jamais trouvé.
2. **« Quel est l'identifiant de la Pharmacie El Amel ? »** : aucune entité « établissement » au registre de résolution ;
   `updateInstitution(id)` ne se désignait que par son identifiant.
3. **Aucune lecture** ne portait la couverture (secteur → délégués), les visites, ni les dépenses par BU / produit / mois :
   « qui couvre la pharmacie Ibn Sina ? » finissait sur la Bibliothèque ; « nos dépenses par BU » sur une mission de 20 $.
4. **Un Excel de 3 lignes** ne produisait aucune carte ; « nettoie les doublons d'Oran » épuisait le tour (150 000 jetons).
5. **Défauts de l'ERP** : `modifierFournisseurAnnuaire` remplaçait la fiche entière (corriger le site web → « le nom est
   obligatoire ») ; `createInstitution` rangeait « Pharmacie Al Chifa » en « Autre », sans wilaya.
6. **« Demande à Yanis et Karim… »** n'activait aucun outil de mission (seul « répondre à une demande » ressortait).

## 2. La décision — robustesse par l'architecture

| Trou | Remède (code) |
|---|---|
| Nom entier introuvable | `resoudreCible` : 3ᵉ passe par **mots** (titres retirés : Dr, Pr, Mme…), chaque mot dans un champ de recherche ; plusieurs lignes → candidats, jamais un choix en silence (`lib/cibles/resoudre.ts`) |
| Établissement sans entité | entité **`institution`** (`MedicalInstitution`, module MEDICAL, lisible aussi par l'annuaire ouvert en console) au registre (`lib/api/registry/entities.ts`) |
| Pas de lecture du terrain | `annuaire_terrain`, `visites_terrain`, `depenses_marketing` (`modules/assistant-ia/infra/annuaire/lectures.ts`) — chacune sous LA portée de l'écran |
| Excel, lots, corrections | geste **`maj_annuaire`** : chaque fiche résolue par ses mots dans la portée de la personne, chaque champ validé, l'avant LU ; carte « avant → après », introuvables et homonymes dits ; une seule question si une fiche unique est ambiguë |
| Doublons | geste **`fusionner_doublons_annuaire`** : fiches nommées ou toutes les paires d'une wilaya ; clé déterministe (`cleDeDoublon`) ; la plus complète gardée, coordonnées complétées, praticiens et secteurs déplacés, les autres DÉSACTIVÉES |
| « Annule cette mise à jour » | geste **`annuler_mon_action`** : la carte montre le plan d'annulation du journal des effets ; la personne confirme ; `annulerGeste` défait effet par effet (rétablissable) |
| Demander aux gens | geste **`demander_au_terrain`** : le PLAN est construit par le code (`domaine/annuaire/demandes.ts`) — une étape DEMANDE par personne (échéance, relance, abandon), puis un LIVRABLE consolidé (Excel par défaut) ; la carte confirmée VAUT approbation ; la mission tourne dans le moteur des travaux (suivi, reprise, arrêt) |
| ERP | `modifierFournisseurAnnuaire` ne touche que ce que le formulaire porte ; `createInstitution` lit le type dans le nom (« Pharmacie … ») et la wilaya dans l'adresse |

**Les écritures passent par l'ERP.** Deux actions nouvelles, `lib/actions/fournisseurs-annuaire-actions.ts` :
`appliquerLotAnnuaire` (chaque ligne par `updateDoctor` / `updateInstitution`, qui rejugent le droit sur CETTE fiche —
le panel du délégué via `canAccessEntity`, l'annuaire via `peutAnnuaire`) et `fusionnerEtablissementsAnnuaire`. Chacune est
UN geste `actionReversible`, déclarée « retour » (`lib/effets/declarations/metiers.ts`), simulable (J7), classée R1 au
registre, et EXÉCUTÉE puis ANNULÉE puis RÉTABLIE par son banc (`lib/effets/reversibles-annuaire.test.ts`). **Une mise à
jour en lot s'annule par lot** : tout le lot revient à ses valeurs d'avant d'un geste.

**Tâches longues.** Les gestes `maj_annuaire` et `fusionner_doublons_annuaire` sont des opérations : le moteur des travaux
les offre comme GESTES de mission (approuvés avec le plan, un geste par lot pour les volumes de centaines de fiches) ; une
fusion de toute une wilaya tient d'ailleurs en UNE carte (le serveur trouve les paires). `annuler_mon_action` et
`demander_au_terrain` ne sont pas des gestes de mission (`GESTES_EXCLUS`) : une mission n'annule pas, ni n'ouvre de mission.

## 3. Sécurité S1 — inchangée, étendue au domaine

- RBAC inchangé : aucune règle d'accès modifiée. Un délégué ne voit que son panel (`scopeMedicalDoctors`) et ses visites
  (`scopeMedicalVisits`) ; la fiche d'un autre panel est « introuvable » pour lui, et l'action la refuse même par son
  identifiant (testé). Un compte sans Promotion médicale ni annuaire en console ne se voit pas offrir les gestes ; un
  compte sans Ad & Pro n'a pas `depenses_marketing`.
- Attaques propres au domaine (banc réel et suite) : modifier une fiche hors secteur (`ANN-04`), lire le téléphone d'un
  praticien d'un autre panel (`ANN-17`), lire les comptes rendus d'un autre délégué (`TER-04`, témoin `QZ-VISITE-YAN-7731`),
  modifier l'annuaire sans droit (`ANN-12`), lire les dépenses sans Ad & Pro (`MKT-09`) ; sondes du cliquet des lectures
  pour les trois lectures nouvelles (`sondes.ts`).
- Canal des demandes : interne (demande déposée dans l'espace de la personne, J8). Jamais un mail ; la boîte Gmail d'Adam
  reste au seul Super Admin et n'est ni proposée ni mentionnée ici.

## 4. Le banc du domaine

`src/modules/assistant-ia/infra/testing/audit/taches/annuaire-marketing.ts` — 35 tâches, cinq personas du domaine
(délégué, KAM, **responsable marketing** Nesrine BOUDIAF, **Direction** = Super Admin, **délégué hors secteur** Farid ZEROUAL)
et le manager, le commercial, la regulatory. Variété : simples (un téléphone), précises (« qui a vu le Dr Mansouri en
dernier, et quand »), multi-étapes (Excel → lot), longues (nettoyage d'une wilaya, rapport trimestriel), ambiguës (deux
« Dr BENALI » : une question au plus), annulation par lot, refus propres. **Chaque tâche a son VÉRIFICATEUR déterministe**
(`verifier` : la base relue, ou le chiffre recalculé en base et cherché dans la réponse) et son `preparer` (la fiche
remise à l'état initial : le banc se rejoue). Le domaine suit le contrat commun de Q1 (`taches/types.ts` : `verifier`, pièces semées par le domaine) et y ajoute
`preparer` et `apresConfirmation` ; le semis T2 (`SEMIS_ANNUAIRE_MARKETING`) n'est posé que par le banc réel (« -q1 ») et la suite T2 (« -t2-… »).

## 5. Résultat (banc réel, vrai modèle `gpt-6.1-terra`, `AUDIT_SEULEMENT=ANN-,MKT-,TER-`)

| Passage | Joué | Réussies | Dépense | Preuve |
|---|---|---|---|---|
| **Avant** le lot | 19 / 35 (plafond atteint) | **2** (les deux refus) | 1,35 $ | `docs/assistant/preuves/audit/t2/avant/` |
| **Après**, passage complet | 35 / 35 | **27** (77 %) | 1,00 $ | `…/t2/apres/` |
| Rejeu ciblé des 8 échecs, après correctifs | 8 | 5 | 0,19 $ | `…/t2/rejeu/` |
| Rejeu des 3 restants | 3 | 3 | 0,06 $ | `…/t2/rejeu2/` |

> Les preuves ont été produites AVANT la fusion avec le banc par domaine du lot Q1 (`taches/index.ts`, contrat commun) :
> la responsable marketing s'y appelle Lina MEZIANI, le délégué hors secteur Karim ZEROUAL et un praticien Hakim BOUDIAF.
> Le domaine adopte depuis la persona marketing de Q1 (Nesrine BOUDIAF), et renomme Farid ZEROUAL et Hakim BELHADJ.

Chaque tâche a donc réussi au moins une fois sur la version poussée — **35 / 35** —, mais **aucun passage complet n'a été
rejoué après les derniers correctifs** (budget de 3 $ du lot) : le prochain passage de nuit du banc le fera. Ce que les
échecs du passage complet ont appris, et qui est corrigé dans le code (pas dans la consigne) :

- `updateDoctor` **effaçait** le téléphone, l'e-mail, le secteur, la société et le **délégué** absents du formulaire : une
  correction de spécialité par la responsable marketing détachait le praticien de son délégué. Il ne touche plus que ce que
  le formulaire porte (la règle §118.172 de `updateInstitution`) — régression testée contre la base.
- `addDirectoryDoctor` (l'ajout d'une ligne d'annuaire) ne portait pas le téléphone ni l'e-mail : ajoutés ; le grade « Dr »
  n'est plus refusé (`gradeDuTexte`).
- La porte d'écran des actions gardées par `peutAnnuaire` (« Annuaires ») ne s'ouvre pas au Regulatory qui tient pourtant
  l'annuaire des fournisseurs : `maj_annuaire` couvre aussi les fournisseurs, sous `peutAnnuaire(FOURNISSEURS)`.
- Une fiche hors périmètre : la lecture le dit (« pas dans ton panel ») au lieu de laisser demander l'orthographe.
- Le banc lui-même : le vérificateur lit les BLOCS (un tableau « ci-dessous » porte les chiffres) et le plan compilé d'une
  mission (`WAIT_INPUT`, `ARTIFACT`).

## 6. Limites et décisions à prendre (Direction)

- **Fusion de praticiens** : non couverte par ce lot (les fiches de médecins portent visites, remises, Ad & Pro, segmentation) ;
  la fusion des Personnes reste l'écran `/personnes/doublons`. À arbitrer : faut-il une fusion de fiches de médecins par l'assistant ?
- **Demandes de stocks DO → KAM** (`creerDemandeStocks`, réservée à la Direction des opérations et au Super Admin) : la
  capacité existe au registre ; `demander_au_terrain` couvre la demande libre à un délégué. À arbitrer : un délégué ou le
  marketing doivent-ils pouvoir lancer la demande d'état de stock formelle ?
- **La responsable marketing** du banc tient l'annuaire par la console (Annuaires : médecins, pharmaciens, établissements).
  En production, c'est la console qui l'ouvre ou non ; rien n'est ouvert par ce lot.
