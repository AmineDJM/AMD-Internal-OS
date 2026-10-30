# 0026 — « Mes notes » : un bloc-notes privé dans l'Assistant IA, que l'IA ne modifie qu'avec l'accord de la personne (30/10/2026)

**Spécification validée par la Direction** (maquette : <https://claude.ai/artifact/QMhHu5UY7R1bCjF2KRy13x>, section 1, et
ses réponses aux questions « À valider ») :

1. une **icône bloc-notes** dans l'Assistant IA ouvre le panneau « Mes notes » (plein écran sur téléphone) ;
2. un espace par personne, avec des **pages** qu'elle crée, nomme, renomme, réordonne et supprime (page par défaut
   « Mes notes ») ; blocs texte, titre, puce, case à cocher ; listes imbriquées (Tab / Maj+Tab) ; raccourcis « - », « [] »,
   « # » ; glisser une ligne ; cocher barre la ligne ; enregistrement automatique ; historique des versions ; corbeille
   30 jours ; accessible au clavier ; l'éditeur chargé à la demande ;
3. **privé** : seule la personne voit ses notes, Super Admin compris ; aucun écran d'administration ; seules les actions
   de l'IA vont au journal d'audit ;
4. l'assistant a ses outils (`lire_notes`, `ajouter_note`, `modifier_note`, `cocher_note`, `deplacer_note`,
   `supprimer_note`, `creer_page`, `renommer_page`) — mais **toute modification par l'IA demande la confirmation de la
   personne** (la maquette proposait « appliquée tout de suite avec Annuler » ; la Direction a tranché : confirmation) ;
   l'IA ne lit les notes que si la question s'y rapporte ; un montant sensible noté reste en repère ⟦Sn⟧ vers le modèle ;
5. « fais-en une tâche / une demande / un travail » passe par les outils existants, avec leurs cartes ;
6. la voix (gpt-live-1, construite par une autre session) utilise les mêmes outils.

> Code : `src/modules/assistant-ia/domaine/notes/` (pur : `blocs.ts`, `gestes.ts`, `regles.ts`), `infra/notes/`
> (`pages.ts`, `propositions.ts`, `outils.ts`), `actions-notes.ts` (clé `assistant-ia-notes-actions`),
> `ecrans/notes/` (`panneau-notes.tsx`, `editeur-notes.tsx`), `ecrans/notes-proposees-card.tsx` ; migration additive
> `20270210140000_assistant_ia_notes`. Tests : `domaine/notes/*.test.ts`, `notes.test.ts`, `e2e/notes.spec.ts`.

## 1. Le modèle de données

| Table | Rôle |
|---|---|
| `AssistantIaNotePage` | une page : `titre`, `rang`, `blocs` (JSON `[{ id, type, texte, fait?, niveau }]`), `version` (verrou optimiste), `supprimeeLe` (corbeille) |
| `AssistantIaNoteVersion` | l'état **d'avant** un changement : au plus un toutes les 5 minutes de frappe, toujours avant une modification de l'IA ou une restauration ; 50 par page |
| `AssistantIaNoteCorbeille` | une ligne **non vide** supprimée (avec son rang) — 30 jours |
| `AssistantIaNoteProposition` | une modification **proposée** par l'IA : `geste` + `args` (résolus), `resume`, `etat` (`PROPOSEE` → `ACCEPTEE` / `REFUSEE` / `PERIMEE`, puis `ANNULEE`), `dependDe`, `inverse`, `canal` (texte / voix) |
| `AssistantIaTour.notesProposees` | les propositions d'un tour (la carte de la conversation) |

Une page est une liste **plate** de blocs ; l'imbrication est un **niveau** (0 à 4) : un bloc et ceux qui le suivent plus à
droite forment son sous-arbre, que Tab, Maj+Tab et le glisser déplacent entier. Pas de dépendance d'éditeur : ~300 lignes
de règles pures, partagées par l'éditeur, le serveur et les outils.

## 2. Les choix

| Question | Décision | Pourquoi |
|---|---|---|
| Où vivent les notes ? | Dans le module `assistant-ia` (tables, portes, écran) — pas un module à part. | Elles n'existent que dans l'Assistant IA ; la voix les atteint par `api.ts` (`outilsNotes`). |
| Privé, comment ? | Toute lecture et écriture filtre sur `userId` **pris de la session** (actions : `porte`) ou de la personne du tour (outils). **Aucune** action ni outil ne prend un compte en paramètre ; aucune porte d'administration. La **« Vue exacte »** est refusée même en lecture (`porte(true)` dans chaque action ; `impersonatedBy` / `visualise` → REFUS dans chaque outil). | Le Super Admin qui visualise l'OS comme quelqu'un n'a pas à lire ses notes. |
| L'IA écrit-elle ? | **Jamais.** Un outil d'écriture crée une `AssistantIaNoteProposition` ; la page n'est touchée qu'à l'acceptation (`accepter`), dans une transaction qui « prend » la proposition (un double clic n'applique qu'une fois) et garde l'état d'avant en version. | Décision de la Direction. |
| Comment l'IA désigne une ligne ? | Par sa **référence** (8 caractères, rendue par `lire_notes`) ou un morceau de son texte ; plusieurs candidates → **AMBIGU** avec la liste ; aucune → **INTROUVABLE**. Position : `sous` un titre (fin de section), `apres` une ligne, `en_tete`. | Jamais deviné. |
| Plusieurs propositions | Résolues contre l'état **virtuel** (la page + les propositions en attente) : « crée la page Congrès et ajoute-y X » marche ; la ligne **dépend** de la page. Accepter accepte d'abord ses dépendances ; refuser refuse aussi ce qui en dépend. « Tout accepter » dans l'ordre de proposition. 12 au plus par tour. | La dépendance est explicite, pas une coïncidence d'ordre. |
| Annuler | L'**inverse** est calculé à l'acceptation (`inverseDe`) et rejoué par « Annuler » (24 h depuis le panneau ; au-delà, l'historique). Une ligne ajoutée puis annulée ne va pas à la corbeille. Si la ligne a disparu depuis, « Annuler » le dit et renvoie à l'historique. | Exact sans rejouer toute la page. |
| Où la personne décide | **Dans la page** (la ligne proposée surlignée, Accepter / Refuser — un ajout apparaît en « fantôme » à sa place), dans la **bande** des propositions du panneau (« Tout accepter », « Voir » une autre page, les pages proposées en onglets pointillés), et sur la **carte** de la conversation (`NotesProposeesCard`). Une proposition qui arrive ouvre le panneau. | La maquette, avec la confirmation. |
| L'IA ne lit que si ça s'y rapporte | `lire_notes` n'est **pas** au socle d'outils : il n'est présélectionné que par les mots d'une demande qui parle de notes, de liste, de cases (`MOTS_CLES`, J4) ; sa description et la règle (`REGLE_NOTES`, dite seulement quand un outil des notes est offert) le redisent. Aucune note n'entre au contexte d'office. | Test : un « bonjour, quel temps fait-il » n'offre pas `lire_notes`. |
| Montant sensible | `lire_notes` jetonne chaque ligne (`jetonnerTexte`, titulaire = la personne) et, sur une ligne au contexte sensible (salaire, prime, paie, IBAN… — `CONTEXTE_SENSIBLE`), **tous** ses montants (`jetonnerMontants`) : le modèle lit ⟦Sn⟧, la personne revoit la valeur (elle en est la titulaire). Sans coffret (routine) : « [confidentiel] ». Un repère écrit par le modèle dans un geste est remis en clair seulement si la personne y a droit (`substituerReperes`). | La règle de la décision 0012, appliquée aux notes. |
| Familles de la console | Aucune (comme `proposer_memoire`) : c'est le bloc-notes de la personne, chaque geste est accepté par elle. Hors **routines** et **travaux** pour les écritures (`ECRITURES_DU_MOTEUR`) : personne n'est là pour accepter. | — |
| Audit | `recordAudit` à chaque proposition, acceptation, refus, annulation — le **geste**, jamais le texte des notes. Les gestes de la personne elle-même ne sont pas audités. | Le journal est lisible par l'administration ; les notes ne le sont pas. |
| Enregistrement automatique | 0,7 s après la dernière frappe, avec la version lue ; **conflit** (autre onglet, autre appareil) → la page à jour est rendue, rien n'est écrasé, la personne est prévenue. Avant de décider d'une proposition ou de changer de page, ce qui attend part d'abord. | Pas de perte silencieuse. |
| Chargement | `next/dynamic` : le panneau et l'éditeur ne sont chargés qu'au premier clic sur le bloc-notes ; la carte de la conversation est légère (aucun import de l'éditeur). | La coque et `/assistant` ne paient rien tant qu'on ne s'en sert pas. |
| Voix | Les **mêmes** `PowerTool` (`outilsNotes(user, { canal: "voix", coffret, acces, proposees })`, exporté par `api.ts`) ; la proposition porte `canal = "voix"` (au journal), et s'affiche dans le panneau et la carte comme à l'écrit. | Une seule garde. |

## 3. L'éditeur (au clavier d'abord)

Entrée (nouvelle ligne du même type ; sur une puce ou une case vide : on sort de la liste), Retour arrière en début de ligne
(la puce redevient texte, puis remonte d'un cran, puis rejoint la ligne d'au-dessus), Tab / Maj+Tab, Alt+↑ / Alt+↓
(déplacer — l'équivalent clavier du glisser ; la poignée répond aussi aux flèches), ↑ / ↓ en bord de ligne, Ctrl+Entrée
(cocher), « - » / « * » / « [] » / « [x] » / « # » + espace en début de ligne. Onglets de pages : double-clic ou F2 pour
renommer, menu « Avancer / Reculer la page », « Mettre à la corbeille ». Échap ferme le panneau et rend le focus au bouton.
Chaque contrôle a son nom accessible (« Fait : … », « Déplacer la ligne « … » », « Supprimer la ligne « … » »).

## 4. Les preuves

| Test | Ce qu'il prouve |
|---|---|
| `domaine/notes/blocs.test.ts` | normalisation (types, textes, niveaux, doublons) ; raccourcis ; Tab / Maj+Tab avec sous-arbre ; glisser, Alt+↑/↓, déplacer après ; cocher, changer de type ; corbeille des lignes non vides |
| `domaine/notes/gestes.test.ts` | désigner (référence, texte, morceau ; AMBIGU, INTROUVABLE) ; position (sous un titre, après, en tête) ; chaque geste appliqué puis **son inverse rend la page d'origine** ; refus d'une cible disparue ; résumé ; versions (5 min, toujours avant l'IA), corbeille (30 j), lignes pour le modèle |
| `notes.test.ts` (vraie base) | **privé** : un collègue et le Super Admin ne lisent que leurs notes, même par la référence d'une page d'autrui ; **Vue exacte** refusée (outils et actions) ; repère ⟦Sn⟧ pour une prime ; **l'IA n'écrit rien** (page identique, version identique) ; **refus = rien d'écrit** ; acceptation (ligne sous son titre, version « IA ») puis annulation ; un autre compte n'accepte pas ; dépendance page → ligne et « Tout accepter » ; refus en cascade ; verrou de version ; corbeille ; un **vrai tour** au faux modèle (carte du tour, page intacte, `lire_notes` non offert pour une question sans rapport) |
| `infra/selection.test.ts` | +6 demandes « notes » au corpus (71) : l'outil juste dans les 8 premiers ; jamais hors droits |
| `e2e/notes.spec.ts` | icône → panneau ; créer et nommer une page ; puces (« - »), sous-puce (Tab), cases (« [] »), cocher ; relu après rechargement ; « ajoute X » au faux modèle → ligne **surlignée**, rien d'écrit, carte dans la conversation ; accepter → ligne réelle ; annuler ; une suppression proposée refusée ; téléphone plein écran — captures `e2e-screenshots/notes-*.png` |

## 5. Ce qui reste

- La conversation vocale (autre session) branchera `outilsNotes(…, { canal: "voix" })` ; rien d'autre à faire ici.
- Pas d'édition collaborative ni de partage d'une page : privé par décision.
- Le glisser d'une ligne est à la souris et au clavier (poignée + flèches, Alt+↑/↓) ; le glisser tactile n'est pas
  branché sur téléphone — les flèches de la poignée y servent.
- Les propositions restées en attente n'expirent pas (elles restent dans la bande du panneau jusqu'à décision).
