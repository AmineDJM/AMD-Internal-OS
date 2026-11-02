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

## Précision de la Direction (29/10/2026) — elle prime sur le brief initial
1. Le **Super Admin** : l'assistant a accès à TOUT (salaires, budgets, contrats, documents RH, paie, finances,
   réglementaire…), lectures ET écritures métier (par carte). Aucun masquage pour lui.
2. Les **autres** : seulement ce que la Direction leur ouvre, **réglé dans la console** — **Administration › Contrôle de
   l'IA › Assistant IA — accès** (`/admin/ai/acces`, Super Admin seul), par rôle (défaut de ses membres) et par personne
   (prime sur son rôle), par **familles** : Salaires & paie, Budgets & finances, Contrats & documents RH, Fiches
   collaborateurs, Drive & documents, Réglementaire, Ad & Pro, Écritures métier.
3. **Défaut** (non-Super-Admin) : chaque famille suit les droits applicatifs de la personne (`droitsApplicatifsIa`) ;
   **Salaires & paie** et **Contrats & documents RH** sont FERMÉES tant que la Direction ne les ouvre pas — y compris pour
   qui gère les RH dans l'application. « Défaut » ne donne jamais plus que les droits applicatifs ; **ouvrir
   explicitement** le peut (décision de la Direction), et chaque changement est à l'audit (avant → après).
4. Relu **à chaque tour** (`accesAssistantIa`, sans cache) — conversation et routines. Une famille fermée : l'outil reste
   offert mais refuse en disant **quelle famille** et que **la Direction l'ouvre dans la console** ; le contexte du tour
   liste aussi les familles fermées pour que l'assistant réponde directement.

Règle pure : `src/lib/agent/acces-regles.ts` (zéro import, au socle — lue par le moteur et par la console). Stockage :
table `AssistantIaAcces` (une ligne par rôle OU par personne : `ouvertes`, `fermees`), migration additive
`20270207100000_assistant_ia_acces`. Action : `enregistrerAccesAssistantIa` (Super Admin, audit, classée EXCLUDED au
registre — une IA ne règle jamais ses propres accès). Ce que chaque famille garde :

| Famille | Outils | Ouverture explicite au-delà des droits |
|---|---|---|
| Salaires & paie | `lire_paie`, masse salariale de `read_hr_overview`, **révélation** des repères de nature salaire | oui (lecture et révélation ; la révélation est alors tracée à l'audit) |
| Contrats & documents RH | `documents_rh` (liste, lien, lecture) | oui — et la route `/api/rh/document/[id]` sert alors le fichier (société permise) |
| Fiches collaborateurs | `lire_fiche_rh`, `read_hr_overview`, `hr_operation` | oui pour `lire_fiche_rh` ; les outils du moteur gardent leur droit |
| Budgets & finances | `read_budget`, `finance_totals` | non : la garde du moteur (droit de l'écran) reste |
| Drive & documents | `search_drive`, `search_everything`, `drive_operation` | non (ACL du Drive) |
| Réglementaire | lectures Regulatory, `regulatory_operation`, outils d'écriture Regulatory | non (porte de l'écran) |
| Ad & Pro | `read_workflow`, cartes `preparer_*` Ad & Pro et bons de commande | non |
| Écritures métier | toute carte (outils d'écriture, ops de domaine, opérations de l'Assistant IA hors routines et mémoire) | — |

La personne garde toujours l'accès à SON dossier (sa fiche, sa paie, ses pièces visibles) : c'est ce que l'application
lui montre déjà (« Mon dossier RH »). Défense en profondeur : chaque outil porte les accès de SA personne et refuse s'il
est appelé sous une autre.

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

## Réponses de la Direction (29/10/2026) — implémentées
1. **Ouverture explicite au-delà des droits pour Budgets & finances, Drive & documents, Réglementaire, Ad & Pro**
   (comme Salaires et Contrats). La garde devient « droit applicatif OU ouverture explicite de la console » :
   `vueDeLAssistant` (`role-config.ts`) donne aux LECTURES du moteur la personne avec, en plus, le droit de VOIR les
   modules des familles ouvertes explicitement (Budgets → BUDGETS, FINANCES ; Drive → DRIVE, DOCUMENTS ; Réglementaire →
   REGULATORY, REGULATORY_PIPELINE ; Ad & Pro → SPONSORING, AD_PRO_CENTRE, EVENTS, congrès, PROMO_MATERIAL, AD_PRO_OTHER ;
   Fiches → RH). `assistantToolsFor`, `executeReadTool`, `executePowerTool` et les lectures annuaire / Regulatory jugent
   sur cette vue. Limites dites : les ÉCRITURES s'exécutent toujours sous la vraie session (l'action de l'écran relit
   `requireUser`) — ouvrir une famille n'ouvre pas ses gestes ; le partage nœud par nœud du Drive et l'étanchéité des
   sociétés restent. Chaque ouverture est à l'audit (action de la console). Le Super Admin a toujours tout.
2. **Un repère dans une carte, après confirmation** (« envoie le salaire d'Assia à Karim ») : tout geste préparé passe par
   `substituerReperes` — chaque `⟦Sn⟧` de l'entrée est remplacé par la vraie valeur AVANT la carte, si la personne a le
   droit de la voir (même décision que la révélation, journalisée), sinon la carte est refusée et rien n'est préparé ; la
   carte garde ses valeurs substituées (`reperesSubstitues` dans la charge de l'intention) ; la sortie rendue au modèle
   remet chaque valeur en repère ; à la CONFIRMATION, `verifierReperesAvantExecution` rejuge chaque valeur pour qui
   confirme, avec ses accès du moment (une famille refermée entre-temps → rien ne s'exécute) ; chaque substitution est
   tracée à l'audit — qui, quelle donnée (nature, origine), vers quelle carte et quel destinataire — à la carte ET à
   l'exécution.
3. **Tout tracer** : une valeur HORS colonne du coffre (historique de paie, montant d'un contrat, IBAN lu dans un
   document) écrit une ligne `AccesDonneeSensible` quand l'assistant la montre ou la refuse —
   `journaliserLectureHorsColonne` (porte `@/modules/coffre/api`, sans déchiffrement) : qui, nature, quand, geste avec
   l'OUTIL qui l'a lue (« Assistant IA — réponse à la personne — outil documents_rh »), origine (`PayrollEntry`,
   `EmployeeDocument`) quand l'outil la connaît, motif (POLITIQUE, OUVERTURE_DIRECTION, FAMILLE_FERMEE, HORS_PERIMETRE).
   Une valeur d'une colonne du coffre l'était déjà (`controlerLecture`).
4. **« Contrats & documents RH » ouverte → téléchargement par la route** : gardé, testé (403 fermée, 200 ouverte, 403
   pour une autre personne).

Bancs (`droits-metier.test.ts`) : par famille (Budgets, Drive, Réglementaire, Ad & Pro) fermée par défaut → refus, ouverte →
l'outil lit, la voisine du même rôle reste au défaut ; repère dans une carte (valeur dans la carte, jamais au modèle ;
refus sans droit ; exécution tracée ; famille refermée → refus à la confirmation) ; journal hors colonne (accord et
refus) ; route des documents RH.

## Manques du banc « Jarvis » en direct (V4-H, 29/10/2026) — corrigés dans ce lot
Le banc (`docs/bench/assistant-jarvis-live.md`, `scripts/bench/assistant-jarvis-live.ts`) avait été joué sur `ed81866f`,
AVANT ce lot. Repris un à un :

| N° | Manque | Correction |
|---|---|---|
| 1 | le filtre de saisie détruisait « le salaire d'Assia » ; « salaire de base de 165 000 DZD » laissait passer le montant | motif : un montant commence par un chiffre ; « est / de / du / à » acceptés devant le montant |
| 2 | aucun outil RH | `lire_fiche_rh` (avec N+1 et **congés de l'année**), `lire_paie`, `documents_rh` — familles et repères (ci-dessus) |
| 3 | l'annuaire ne rend pas le manager | `findPeople` charge `Employee.manager` et le département ; `directory_lookup` rend `responsable` |
| 5 | pas de file « à valider par moi » | `list_pending_decisions` offerte (centre d'action + congés à trancher, la file de l'utilisateur) |
| 6 | pas de lecture des demandes Ad & Pro ni des budgets | `demandes_adpro` (requête de l'écran `getAdProRequests`, par année / état / nature, totaux) ; `read_budget`, `finance_totals` |
| 7 | pas d'écriture Regulatory ni de demande administrative | `regulatory_operation` (`create_product`…) et `create_admin_request` sont offerts (outils du moteur, cartes) — pas dans `OPERATIONS_IA` |
| 8 | état d'un dossier superficiel | `etat_dossier_reglementaire` : dossier du PÉRIMÈTRE (société, portée, verrou) — statut, échéances, retards, blocages, frise (réserves ANPP), commentaires. `product_360` n'est pas prêté : il résout le produit sans périmètre |
| 9 | coût du cache au plein tarif ; « inconnu » sans variable | le cache à son tarif (`ASSISTANT_IA_PRICE_CACHED`) ; défauts documentés `gpt-6.1-terra` 2 $ / 12 $ / 0,20 $ par million (`TARIFS_PAR_DEFAUT`) |
| — | refus « avec les outils disponibles » | règle fondamentale : un refus nomme le DROIT ; le contexte liste les gestes non ouverts au rôle |
| — | `send_message` renvoyait à `search_people`, absent | la description renvoie à `directory_lookup` |

Hors de ce lot (consigne) : recherche du Drive par contenu (lot J1), réduction du prompt (lot J4).

## Encore ouvert
- Les ÉCRITURES d'une famille ouverte au-delà des droits (créer un dossier réglementaire sans le droit de l'écran) :
  il faudrait une exécution « au nom de la Direction » — non fait, à décider.
