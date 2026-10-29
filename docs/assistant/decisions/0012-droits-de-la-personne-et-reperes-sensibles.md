# 0012 — L'Assistant IA a les droits de la personne ; les données sensibles en repères (28/10/2026)

**Retour de la Direction (28/10, en production, connectée en Super Admin — « inadmissible »)** sur `/assistant` :
1. « C'est quoi le salaire d'Assia ? » → « Je ne peux pas consulter ni communiquer le salaire individuel » ;
2. « Donne-moi son contrat » (un Word déposé dans sa fiche RH) → « Je n'ai pas accès au contrat » ;
3. « Crée un nouveau dossier pour daclatasvir » / « réglementaire » → « Je ne dispose pas d'un outil pour créer un dossier réglementaire ».

> Code (aucun fichier de production nouveau : le cliquet `horsCarte` ne se relève pas) : `src/lib/agent/outils-v1.ts`
> (assemblage), `lectures.ts` (`lecturesRh` : fiche, paie, documents RH), `filtre-confidentialite.ts` (repères, pur :
> `CoffretDuTour`, `jetonnerSortie`, `jetonnerMontants`, `sansValeursRevelees`, `CONSIGNE_JETONS` ; `remplacerSensibles`,
> `natureDeCle` ; motif « salaire » corrigé), `fil/tour.ts` (coffret du tour, consigne, `Revelateur`, historique),
> `fil/service.ts` (voix et notification sans valeur), `routines/passage.ts` (aucune écriture du moteur à une routine),
> `contexte.ts` (règle de confidentialité), `src/modules/coffre/api.ts` (exports du contrôle journalisé).
> Banc : `src/lib/agent/droits-metier.test.ts`.

## Causes constatées
- L'Assistant IA n'exposait qu'une petite partie du moteur : annuaire, lectures Regulatory, 3 lectures du moteur, et deux
  écritures (`create_task`, `send_message`). Aucun outil de fiche RH, de paie, de documents RH, ni de création de dossier
  réglementaire — alors que le moteur d'Adam (`assistant.ts`, `executive-read-tools.ts`, ops de domaine) sait tout faire.
- `censurerSortie` masquait toute rémunération avant le modèle, pour tout le monde ; et la règle fondamentale disait au
  modèle « tu ne manipules ni rémunération… » — il refusait donc de lui-même.
- **Trouvé à l'essai réel** : le filtre de la SAISIE prenait l'espace de « le salaire d'Assia » pour un montant — la question
  arrivait au modèle sous la forme « C'est quoi le [CONFIDENTIEL]d'Assia ? ». Le motif exige désormais un chiffre.

## A. Les droits = ceux de la personne, rien de plus, rien de moins
| Outil | Qui | Garde revérifiée à l'exécution |
|---|---|---|
| `lire_fiche_rh` | la personne (soi), ou qui lit le module RH | `userCan(RH, VIEW)` ; recherche dans les sociétés permises (`ficheScopedWhere`) |
| `lire_paie` | soi, ou qui GÈRE les RH | `voitLesSalaires` + `entitePermisePourFiche` ; masse du mois : `voitLesSalaires`, sociétés permises |
| `documents_rh` | soi (pièces marquées visibles), ou qui gère les RH | la règle de `/api/rh/document/[id]` : `voitLesSalaires` + `entitePermisePourFiche` |
| `read_hr_overview`, `search_everything`, `read_calendar`, `search_drive` | le droit de l'outil du moteur (`allowed`) | `executePowerTool` rejuge ; la masse salariale de la situation RH est retirée à qui n'a que la lecture des RH, en repère pour qui les gère |
| `list_my_requests`, `my_overview` (+ les lectures V1) | chacun | `executeReadTool` (requêtes de la personne) |
| Écritures `create_task`, `update_task`, `send_message`, `create_hr_request`, `create_admin_request`, `update_regulatory_product`, `assign_regulatory_responsible`, `set_regulatory_step`, `request_regulatory_status_update` | chacun ; `buildProposal` juge le droit | carte (`persistActionIntents`), jamais exécutée par le modèle ; `confirmerIntentionAssistantIA` → `performAction` rejuge |
| Domaines `regulatory_operation` (dont **`create_product` = nouveau dossier réglementaire**), `hr_operation`, `task_operation`, `drive_operation`, `request_operation` | offerts si la personne passe la porte d'AU MOINS une op (`meta.gate`, la règle de l'écran) | `buildProposal` rejuge l'op ; l'action canonique rejuge à la confirmation |

Écartés volontairement : `read_employee` / `read_payroll` du moteur (garde = lecture du module RH, sans société — plus
large que l'écran) ; `create_dossier` (un PROJET, que le modèle confondait avec un dossier réglementaire) ;
`create_calendar_event` (doublon de `preparer_rendez_vous`) ; les créations Ad & Pro du moteur (les opérations de
l'Assistant IA les font) ; `capability_operation` et les outils d'administration (Adam / écran d'administration).
Un préambule dit au modèle que « crée un dossier pour <DCI> » est `regulatory_operation` / `create_product`.

## B. Les données sensibles montrées à qui a le droit, jamais envoyées au modèle
1. **Repères** : la sortie de chaque outil passe `jetonnerSortie` (avec le **coffret du tour**) : chaque valeur sensible —
   clé sensible (`salaire*`, `netToPay`, `employerCost`, `iban`, `rib`, `nin`, `passeport`…) ou motif (IBAN groupé ou non,
   RIB 20 chiffres, NIN, salaire chiffré) — devient `⟦S1⟧`, `⟦S2⟧`… Le coffret garde la valeur, sa **nature** (celle du
   coffre), son **titulaire** (le compte du salarié, s'il est connu) et, pour une colonne d'une fiche, son **origine**
   (`Employee.baseSalary`…). Un repère écrit dans un document pour en « pêcher » un autre est neutralisé (`⟦?⟧`).
   Dans une pièce RH lue (contrat, avenant), **tout montant** (chiffres ou lettres) devient un repère.
2. **Consigne** (`CONSIGNE_JETONS`, ajoutée au tour) : recopier le repère tel quel ; ne jamais dire « je ne peux pas » pour une
   valeur rendue en repère ; ne jamais mettre un repère dans l'entrée d'un outil. La règle fondamentale de confidentialité dit
   de même, et : « ne refuse jamais de toi-même, appelle l'outil ».
3. **Révélation** (`Revelateur`, `fil/tour.ts`), **avant d'afficher et de stocker** la réponse (texte ET blocs de l'UI
   générative) : la règle est celle du coffre, `peutLire` (Super Admin ; titulaire ; RH — `voitLesSalaires` — pour salaires
   et identité ; Finances pour RIB / IBAN). Une valeur lue sur une **colonne du coffre** passe en plus par
   `controlerLecture`, qui **écrit sa décision au journal `AccesDonneeSensible`** (accord comme refus) avant de rendre quoi que
   ce soit — si le journal échoue, rien ne sort. Refusé, inconnu → « [confidentiel] ». Une décision par repère et par tour.
4. **Rien ne repart** : une valeur révélée est bornée par deux séparateurs invisibles (U+2063). `filtrerSaisie` remplace
   toujours, dans l'historique renvoyé au modèle, chaque valeur révélée par « [confidentiel] » (quel que soit le réglage
   `censurerSaisie`) ; la **réponse vocale** (synthèse OpenAI) et la **notification** aussi. En flux, un repère s'affiche
   « ••• » jusqu'à la réponse finale.
5. Sans coffret (les **routines**, qui tournent sans personne devant l'écran) : la censure d'avant, « [CONFIDENTIEL] ».

**Écart assumé avec la consigne** : elle disait « lecture par la porte `src/modules/coffre/api-lecture.ts` ». Cette porte
DÉCHIFFRE, et la frontière du coffre (`frontiere.test.ts`, décision de la Direction V2-E) interdit à l'assistant et aux agents
de l'atteindre, même indirectement. La révélation n'a pas besoin de déchiffrer : la valeur est celle que l'outil a lue sur la
colonne (qui fait foi jusqu'au palier P5). Elle passe donc par `controlerLecture` — politique + journal, **sans
déchiffrement**, que `api.ts` exporte désormais avec `lecteurDepuisSession` et `peutLire`. La frontière reste verte.

## C. Le contrat
« Donne-moi son contrat » → `documents_rh` trouve l'`EmployeeDocument` (nature contrat) et rend le **lien**
`/api/rh/document/<id>?dl=1` (la route garde ses propres contrôles), que la réponse donne en lien Markdown. « Que dit son
contrat sur… » → `documents_rh` avec `documentId` et `lire: true` : seulement contrat, avenant, attestations, diplôme, autre —
jamais bulletin, relevé des émoluments, domiciliation, pièce d'identité, certificat médical, ni un nom qui annonce le coffre ;
lecture **LOCALE** (texte du Word / PDF, OCR sur ce serveur — rien ne part à la vision) ; un texte reconnu comme pièce
d'identité ou bulletin est refusé (`natureSensible`) ; chaque montant devient un repère (B). Le contenu part au modèle
encadré comme contenu non fiable (« document du dossier RH »).

## Essai réel (base locale semée, `gpt-6.1-terra` via le proxy, 28/10)
| Demande | Super Admin | KAM (délégué médical) |
|---|---|---|
| « C'est quoi le salaire d'Assia ? » | « …185 000 DZD de base, 210 000 DZD brut et 168 450 DZD net à payer. » (modèle : repères seulement) | « L'accès à la paie d'un autre salarié est réservé aux personnes qui gèrent les RH dans sa société. » |
| « Donne-moi son contrat » | lien `[contrat de travail d'Assia Benmoussa](/api/rh/document/…?dl=1)` | refus (documents RH réservés) |
| « Que dit son contrat sur sa rémunération ? » | « L'article 5… salaire mensuel brut de 210 000 DA (deux cent dix mille dinars algériens). » | refus |
| « Crée un nouveau dossier pour daclatasvir » → « réglementaire, pour Adventum » | demande l'entité, puis **carte** « Créer le dossier réglementaire DACLATASVIR » (Adventum Pharma) | « Le module Regulatory ne vous est pas ouvert » |

Coût : 59 outils pour le Super Admin (≈ 67 Ko de définitions), 54 pour un KAM ; ~5–8 s par tour.

## Décisions à prendre (Direction)
- **Repère dans une écriture** : aujourd'hui interdit (le modèle doit dire de copier la valeur). Faut-il remplacer, côté
  serveur, un repère dans l'entrée d'une carte (ex. « envoie son salaire à X ») quand la personne a le droit de le voir ?
- **Valeurs hors colonnes du coffre** (historique de paie, montants lus dans un contrat) : jugées par la même politique, mais
  pas journalisées dans `AccesDonneeSensible` (aucune ligne du coffre ne les porte). Faut-il un journal « lecture par
  l'assistant » pour celles-là ?
- **Masse salariale** : traitée comme une rémunération (repère, visible des RH et du Super Admin). La garder pour un
  agrégat ?
- **Étendre** : autres domaines (Finance, Legal, réunions, courrier) — même mécanisme, à ouvrir domaine par domaine.
