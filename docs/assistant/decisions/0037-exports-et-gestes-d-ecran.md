# 0037 — Exports de l'ERP, envoi à un collègue, gestes d'écran hors actions (lot K7, 31/10/2026)

**Lot K7 du plan Jarvis.** Il s'appuie sur le registre des capacités de J6 ([0020](0020-capacites.md)), sur la sélection
d'outils à la demande de J4 ([0018](0018-vitesse-memoire.md)), sur la Bibliothèque et le Drive ([0014](0014-bibliotheque.md))
et sur les pièces renvoyées par l'assistant ([0015](0015-glisser-deposer.md)).

> Code : `src/lib/exports/` — `types.ts` (le résultat d'un export, pur), `filtres.ts` (les filtres d'écran, purs),
> `catalogue.ts` (une fiche par export, pur), `producteurs.ts` (fiche → fonction, portes d'écran), `reponse.ts` (la
> réponse HTTP d'une route) et les fonctions d'export, une par fichier (`regulatory.ts`, `budget.ts`, `pilotage.ts`,
> `appel-d-offres.ts`, `segmentation.ts`, `demande-stocks.ts`, `evenement.ts`, `etude-de-marche.ts`, `coaching.ts`,
> `annuaire.ts`, `plan-de-tournee.ts`) — une FAÇADE transverse (L2, `platform/domains.ts`), comme `queries/` ; la porte
> du socle IA `src/platform/ia/exports.ts` (un seul franchissement compté) ; module `src/modules/assistant-ia/` — `infra/exports.ts`
> (les outils `exporter_*`, le dépôt au Drive), `infra/operations/quotidien.ts` (`send_message` avec pièces),
> `infra/selection.ts` (`ecransPour`), `infra/contexte.ts` (règle 14), `gestes-ecran.test.ts` (l'inventaire et son cliquet).
> Preuves : `exports.test.ts` (le scénario de la Direction en base),
> `scripts/bench/k7-exports.ts` (banc sur `amd_bench`, modèle réel), `e2e-live/k7-exports.spec.ts` (Playwright).
> Aucune migration.

## 1. Le constat

> « Envoie à Amine Djouamai l'Excel du suivi Regulatory. »
> → « Je ne peux pas générer directement l'export Excel du suivi Regulatory avec les fonctions retrouvées. »

La Direction : « je croyais qu'il pouvait faire toutes les actions de l'ERP ». Cause vérifiée : le registre (J6) dérive
des **actions serveur** (`contrat.genere.json`). Les exports, eux, sont des **routes** (`src/app/api/…/export`)
appelées par les boutons des écrans : l'assistant ne les voyait pas. Il y en avait douze, et d'autres gestes d'écran
(PDF, téléchargements, téléversements) passent aussi par des routes.

## 2. Une fonction par export, partagée par la route et l'assistant

Chaque export est sorti de sa route dans une fonction `(personne, options) → ResultatExport` :
`{ ok: true, fichier: { octets, nomDeFichier, mime, resume } }` ou `{ ok: false, statut, erreur }` (le statut HTTP que
la route rendait : 400, 403, 404, 409, 413). La route ne fait plus que lire ses paramètres et appeler la fonction
(`reponseExport`) : **même portée, mêmes droits, même audit** — l'assistant ne peut pas sortir ce que l'écran cache, ni
l'inverse. Aucune duplication : la logique n'existe qu'une fois (le cliquet vérifie qu'une route d'export n'importe
plus ni `prisma`, ni `userCan`, ni `recordAudit`). Les tests qui lisaient la portée dans le source des routes
(`visibilite-listes`, `integration-regle.cliquet`, `pch-entite`, `acces-points`) lisent désormais la fonction.

Les fonctions vivent dans `src/lib/exports/`, déclarée FAÇADE (L2, `platform/domains.ts`) : un export lit `queries/` et
le domaine qu'il exporte — rangé dans le dossier du domaine, il aurait été une inversion de couche. L'assistant les
atteint par une seule porte du socle IA (`platform/ia/exports.ts`) : la dette du module vers `src/lib/` ne grossit pas,
et le socle compte un franchissement de plus, sous son plafond (177).

Deux ajustements, assumés :
- **Audit uniforme** : les exports qui n'en laissaient pas (pilotage, segmentation, demande de stocks, inscrits d'un
  événement) écrivent maintenant une ligne `EXPORT` au journal, comme les autres.
- **Désignation par le nom** : l'écran passe un identifiant ; l'assistant peut passer un nom (l'enveloppe « Marketing
  2026 », l'appel d'offres par sa référence, la BU d'une segmentation, le collaborateur d'une fiche de coaching, le KAM
  et le mois d'un plan de tournée). Le nom se résout, puis **la même porte** se rejuge sur l'identifiant trouvé ; hors
  portée, la réponse est celle d'une fiche qui n'existe pas.

Les filtres se donnent comme à l'écran (`filtres.ts`) : la clé ou le **libellé affiché** (« Attente ANPP », « Gamme de
ville », « Dispositif médical »), accents et casse indifférents. Un filtre qui ne désigne rien est **refusé en le
disant** (400, avec la liste des valeurs admises) — jamais deviné.

## 3. Les outils `exporter_*` de l'Assistant IA

Le catalogue (`lib/exports/catalogue.ts`, pur) porte **une fiche par export** : outil, route, libellé français, écran,
format, filtres, mots d'une demande. Quatorze exports :

| Outil | Ce qu'il produit | Écran |
|---|---|---|
| `exporter_suivi_regulatory` | Excel du suivi des dossiers (statuts, catégorie, gamme, responsable, recherche) | `/regulatory` |
| `exporter_budget` | Excel d'une enveloppe + total | `/budgets` |
| `exporter_budget_marketing` | Excel, PDF, CSV ou PowerPoint du budget Marketing (mois, catégorie, N-1) | `/budget-marketing` |
| `exporter_pilotage_force_de_vente` | Excel du pilotage (année, mois, BU) | `/planning` |
| `exporter_appel_d_offres_pch` | Excel de réponse à un appel d'offres | `/pch` |
| `exporter_segmentation` | Excel de la segmentation d'une BU | `/segmentation` |
| `exporter_demande_stocks` | CSV d'une demande de stocks | `/stocks/demandes` |
| `exporter_inscrits_evenement` | CSV des inscrits d'un événement | `/events` |
| `exporter_etude_de_marche` | Excel d'une étude de marché | `/business-development/etudes` |
| `exporter_presentation_etude` | PowerPoint de la présentation d'une étude | `/business-development/etudes` |
| `exporter_suivi_coaching` | Excel du suivi du coaching (collaborateur, statut) | `/medical/coaching` |
| `exporter_fiche_coaching` | Excel d'une fiche de coaching | `/medical/coaching` |
| `exporter_annuaire` | Excel de l'annuaire (médecins, pharmaciens) | `/annuaires/medecins` |
| `exporter_plan_de_tournee_pdf` | PDF d'un plan de tournée validé | `/medical/plan-de-tournee` |

- **Offert à qui a le bouton** (`exportOuvert` : le module de l'écran) ; la fonction rejuge tout à chaque appel.
- **Familles de la console** : `DRIVE` (le fichier y est déposé) et celle du domaine (`REGLEMENTAIRE`, `BUDGETS`,
  `AD_PRO`) ; fermée, l'outil refuse en nommant la famille, comme les autres.
- **Le fichier** est déposé dans le **Drive personnel** de la personne, dossier « Exports » (port du Live Office :
  inscrit à la Bibliothèque), et l'outil rend `ouvrir` (`/drive/<id>` — la réponse le cite, l'écran en fait un **bloc
  fichier** ouvrable, décision 0015) et `telecharger` (`/api/drive/<id>/raw?dl=1`).
- **Au registre des capacités** : une fiche `outil:exporter_*` par export (R0 — rien n'est écrit chez un autre ; le
  dépôt est dans le Drive de la personne elle-même), et à la **sélection d'outils** par ses mots (`MOTS_EXPORTS`).
- **Conversation seulement** (comme les capacités) : ni routine ni travail ne déposent de fichier.

## 4. Envoyer le fichier à un collègue

« Envoie-le à Amine Djouamai » : `send_message` accepte désormais des **pièces** (`pieces` : nodeId ou nom de fichier
du Drive). C'est un geste d'écriture : une **carte** à confirmer, qui nomme le destinataire résolu, le message et la
pièce, et avertit que le collègue pourra l'ouvrir en lecture. À la confirmation, la messagerie de l'ERP envoie par **sa
propre porte** (`sendMessage`, champ `driveRefs`) : elle rejuge que l'expéditeur VOIT chaque pièce (`resolveDriveAccess`)
et n'ouvre au destinataire que ces fichiers, en lecture (`grantDriveRefAccess`). **Le destinataire ne reçoit que ce que
l'expéditeur a le droit de partager** : une pièce qu'il ne voit pas refuse la carte ; une pièce retirée entre la carte et
le clic est écartée, et le résultat le dit (« n pièce(s) n'ont pas pu être jointes »). Un fichier sans mot part avec
« Voici le fichier. ».

## 5. La consigne : plus de « je ne peux pas » quand un écran le fait

- Règle 14 de la consigne (`contexte.ts`, toujours dite) : tout ce qu'un écran permet, l'assistant le **cherche**
  (`trouver_outil` avec l'intention) avant de répondre ; un export se donne avec son lien ; l'envoi passe par
  `send_message` avec la pièce ; s'il n'existe vraiment aucun outil, il dit **quel écran** le fait, avec son lien direct.
- `trouver_outil`, quand rien ne couvre l'intention, rend désormais les **écrans** qui la portent (`ecransPour` : le menu
  de l'ERP, ses onglets, et les écrans des exports) et la consigne de donner leur lien. Un export refusé rend aussi son
  écran.

## 6. L'inventaire des gestes d'écran hors actions

Toutes les routes de `src/app/api` (132) sont classées dans `modules/assistant-ia/gestes-ecran.test.ts`. **Le
cliquet** (`gestes-ecran.test.ts`) relit le dossier : une route nouvelle, ou une méthode nouvelle sur une route, qui
n'y est pas classée fait échouer `npm test` ; la présente décision doit aussi la nommer (le test le vérifie). Les
exposés sont exactement le catalogue (et chaque fiche du catalogue pointe sa route) ; un COUVERT nomme un outil qui
existe ; un HORS dit pourquoi.

Exposés en plus des douze exports : le **PDF du plan de tournée** (génération de PDF) et la **présentation PowerPoint**
d'une étude (téléchargement), et la **pièce jointe d'un message** (`/api/messaging/upload` → `send_message` avec une
pièce du Drive). Restent hors de l'assistant, avec leur raison : les téléversements (plomberie), les flux de lecture des
écrans, les appels entrants, l'API v1 et le site web, Adam, la boîte mail personnelle, les archives ZIP, les pièces d'un
fil (elles s'ouvrent là où le fil les porte) et deux gestes d'écriture lourds qui restent au bouton (le **livret de
séjour**, qui range un PDF dans la demande avec un voyageur choisi ; le **lancement de l'analyse** d'un dossier CTD).

### Exposé par ce lot (15)

| Route | Méthodes | Outil |
|---|---|---|
| `/api/regulatory/export` | POST | `exporter_suivi_regulatory` |
| `/api/budgets/export` | GET | `exporter_budget` |
| `/api/budgets/marketing/export` | GET | `exporter_budget_marketing` |
| `/api/planning/export` | GET | `exporter_pilotage_force_de_vente` |
| `/api/pch/export` | GET | `exporter_appel_d_offres_pch` |
| `/api/segmentation/export` | GET | `exporter_segmentation` |
| `/api/stocks/demandes/[id]/export` | GET | `exporter_demande_stocks` |
| `/api/events/[id]/export` | GET | `exporter_inscrits_evenement` |
| `/api/market-research/[id]/export` | GET | `exporter_etude_de_marche` |
| `/api/market-research/presentation/[versionId]` | GET | `exporter_presentation_etude` |
| `/api/medical/coaching/export` | GET | `exporter_suivi_coaching` |
| `/api/medical/coaching/[id]/export` | GET | `exporter_fiche_coaching` |
| `/api/medical/annuaire/export` | GET | `exporter_annuaire` |
| `/api/medical/plan-de-tournee/[id]/pdf` | GET | `exporter_plan_de_tournee_pdf` |
| `/api/messaging/upload` | POST | `send_message` — joindre un fichier à un message : l'assistant joint une pièce du Drive (un export, un document), carte à confirmer |

### Déjà couvert par un outil (10)

| Route | Méthodes | Outil |
|---|---|---|
| `/api/search` | GET | `search_everything` |
| `/api/drive/[id]/raw` | GET | `ouvrir_documents` — l'assistant rend le lien du fichier (`/drive/<id>`, téléchargement `?dl=1`) |
| `/api/drive/[id]/texte` | GET | `lire_document` |
| `/api/drive/[id]/texte/enregistrer` | POST | `enregistrer_document` |
| `/api/documents/[id]` | GET | `ouvrir_documents` |
| `/api/documents/[id]/texte` | GET | `lire_document` |
| `/api/documents/[id]/texte/enregistrer` | POST | `enregistrer_document` |
| `/api/rh/document/[id]` | GET | `documents_rh` |
| `/api/field-reports/[id]/transcribe` | POST | `terrain_compte_rendu` |
| `/api/field-reports/[id]/upload` | POST | `terrain_piece_visite` |

### Volontairement hors de l’assistant (107)

| Route | Méthodes | Raison |
|---|---|---|
| `/api/prises-en-charge/livret` | POST | génère ET range le livret de séjour dans les pièces de la demande, voyageur choisi à l'écran « Billets et confirmations » : un geste d'écriture qui reste au bouton |
| `/api/regulatory/intelligence/process` | POST | lance l'analyse lourde d'un dossier CTD (OCR, extraction) depuis l'écran Enregistrement ; l'assistant lit le résultat (lire_dossier_depose, etat_dossier_reglementaire) |
| `/api/regulatory/intelligence/document/[documentId]` | GET | pièce d'un dossier CTD analysé : servie à l'écran Enregistrement ; l'assistant en lit l'état (etat_dossier_reglementaire) |
| `/api/regulatory/intelligence/generated/[docId]` | GET | document généré par l'analyse d'un dossier CTD : servi à l'écran Enregistrement |
| `/api/regulatory/intelligence/version/[versionId]/original` | GET | archive ZIP d'un dossier entier : un téléchargement d'écran, sans contenu à lire ni à envoyer (l'assistant joint les fichiers eux-mêmes) |
| `/api/regulatory/intelligence/progress/[versionId]` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/regulatory/intelligence/ocr/diagnose` | GET | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/regulatory/intelligence/upload/diagnose` | GET | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/regulatory/intelligence/upload` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/regulatory/intelligence/reserves/upload` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/regulatory/intelligence/upload/direct/[sessionId]/finalize` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/regulatory/intelligence/upload/session` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/regulatory/intelligence/upload/session/[sessionId]` | DELETE,GET | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/regulatory/intelligence/upload/session/[sessionId]/finalize` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/regulatory/intelligence/upload/session/[sessionId]/part` | PUT | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/drive/upload` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/drive/upload/claim` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/drive/upload/direct` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/drive/upload/direct/[id]` | DELETE,GET,POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/documents/upload` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/documents/upload/direct` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/documents/upload/direct/[id]` | DELETE,GET,POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/rh/upload` | POST | plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant |
| `/api/meetings/[id]/recording` | POST | enregistrement d'une réunion vidéo, envoyé par le navigateur pendant l'appel |
| `/api/drive/[id]/zip` | GET | archive ZIP d'un dossier entier : un téléchargement d'écran, sans contenu à lire ni à envoyer (l'assistant joint les fichiers eux-mêmes) |
| `/api/drive/zip` | GET | archive ZIP d'un dossier entier : un téléchargement d'écran, sans contenu à lire ni à envoyer (l'assistant joint les fichiers eux-mêmes) |
| `/api/documents/[id]/zip` | GET | archive ZIP d'un dossier entier : un téléchargement d'écran, sans contenu à lire ni à envoyer (l'assistant joint les fichiers eux-mêmes) |
| `/api/messaging/attachment/[id]` | GET | pièce d'un fil (message, dossier, retour) : elle s'ouvre là où le fil la porte, sous ses droits ; l'assistant lit les pièces jointes à SA conversation |
| `/api/meetings/message-attachment/[id]` | GET | pièce d'un fil (message, dossier, retour) : elle s'ouvre là où le fil la porte, sous ses droits ; l'assistant lit les pièces jointes à SA conversation |
| `/api/dossiers/message-attachment/[id]` | GET | pièce d'un fil (message, dossier, retour) : elle s'ouvre là où le fil la porte, sous ses droits ; l'assistant lit les pièces jointes à SA conversation |
| `/api/feedback/attachment/[id]` | GET | pièce d'un fil (message, dossier, retour) : elle s'ouvre là où le fil la porte, sous ses droits ; l'assistant lit les pièces jointes à SA conversation |
| `/api/field-reports/attachment/[id]` | GET | pièce d'un fil (message, dossier, retour) : elle s'ouvre là où le fil la porte, sous ses droits ; l'assistant lit les pièces jointes à SA conversation |
| `/api/kpi/piece/[id]` | GET | justificatif d'un indicateur : il s'ouvre depuis la fiche KPI, sous ses droits |
| `/api/legal/[id]/fichier` | GET | pièce juridique (contrat, statuts) : elle s'ouvre depuis la fiche Juridique, sous les droits du module ; la Bibliothèque la retrouve si elle y est inscrite |
| `/api/ventes-pch/fichier/[id]` | GET | fichier importé des ventes PCH : servi à l'écran d'import, sous ses droits |
| `/api/site-web/candidatures/[id]/cv` | GET | CV d'un candidat : pièce RH sensible, ouverte à l'écran Recrutement seulement |
| `/api/events/qr/[token]` | GET | QR d'un badge d'inscription : affiché et scanné à l'accueil de l'événement |
| `/api/events/inbound/[source]` | POST | appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière |
| `/api/mail/inbound` | POST | appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière |
| `/api/google/callback` | GET | appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière |
| `/api/google/connect` | GET | appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière |
| `/api/google/pubsub` | POST | appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière |
| `/api/mail/ms/callback` | GET | appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière |
| `/api/mail/ms/connect` | GET | appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière |
| `/api/onlyoffice/callback` | POST | éditeur en ligne (OnlyOffice) : session et enregistrement de l'éditeur ouvert ; l'assistant retouche par l'Atelier |
| `/api/onlyoffice/file` | GET | éditeur en ligne (OnlyOffice) : session et enregistrement de l'éditeur ouvert ; l'assistant retouche par l'Atelier |
| `/api/onlyoffice/session` | GET | éditeur en ligne (OnlyOffice) : session et enregistrement de l'éditeur ouvert ; l'assistant retouche par l'Atelier |
| `/api/mail/attachment` | GET | boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA |
| `/api/mail/contacts` | GET | boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA |
| `/api/mail/message` | GET | boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA |
| `/api/mail/messages` | GET | boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA |
| `/api/mail/ms/attachment` | GET | boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA |
| `/api/mail/ms/data` | GET | boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA |
| `/api/messaging/bookmarks` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/messaging/conversation` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/messaging/messages` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/messaging/sync` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/messaging/typing` | POST | indicateur « en train d'écrire » de la messagerie |
| `/api/notifications/poll` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/annuaire/parties` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/admin/audit` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/consommation/modele` | GET | flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures |
| `/api/artifact/[id]/image/[imageId]` | GET | aperçu d'un document ouvert dans l'Atelier (image d'une page) |
| `/api/artifact/[id]/page/[n]` | GET | aperçu d'un document ouvert dans l'Atelier (une page) |
| `/api/push/key` | GET | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/push/subscribe` | DELETE,POST | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/health` | GET | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/health/worker` | GET | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/uploads/limites` | GET | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/marque/[companyId]/logo` | GET | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/admin/mail-diagnostic` | POST | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/admin/storage/cors-test` | DELETE,PATCH,POST | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/admin/storage/self-test` | POST | route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant |
| `/api/activity` | POST | télémétrie ou signal de sécurité de l'écran |
| `/api/replay` | POST | télémétrie ou signal de sécurité de l'écran |
| `/api/security/screenshot-attempt` | POST | télémétrie ou signal de sécurité de l'écran |
| `/api/auth/[...nextauth]` | — | connexion et session (NextAuth) : se connecter reste un geste de la personne |
| `/api/assistant-ia/atelier` | GET | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/depot-dossier` | GET,POST | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/depot-dossier/[id]` | PATCH | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/fil` | GET | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/terrain` | GET,POST | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/vocal` | POST | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/voix/delegation` | POST | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/voix/journal` | POST | plomberie de l'Assistant IA lui-même |
| `/api/assistant-ia/voix/session` | POST | plomberie de l'Assistant IA lui-même |
| `/api/assistant/stream` | POST | Adam, le Chief of Staff : produit séparé, l'Assistant IA ne l'emprunte pas (décision 0013) |
| `/api/assistant/transcribe` | POST | Adam, le Chief of Staff : produit séparé, l'Assistant IA ne l'emprunte pas (décision 0013) |
| `/api/assistant/voice/log` | POST | Adam, le Chief of Staff : produit séparé, l'Assistant IA ne l'emprunte pas (décision 0013) |
| `/api/assistant/voice/session` | POST | Adam, le Chief of Staff : produit séparé, l'Assistant IA ne l'emprunte pas (décision 0013) |
| `/api/assistant/voice/tool` | POST | Adam, le Chief of Staff : produit séparé, l'Assistant IA ne l'emprunte pas (décision 0013) |
| `/api/assistant/voice/turn` | POST | Adam, le Chief of Staff : produit séparé, l'Assistant IA ne l'emprunte pas (décision 0013) |
| `/api/site-web/v1/audience.js` | GET | API du site web public : visiteurs et candidats, pas un écran de l'ERP |
| `/api/site-web/v1/audience` | POST | API du site web public : visiteurs et candidats, pas un écran de l'ERP |
| `/api/site-web/v1/candidatures` | POST | API du site web public : visiteurs et candidats, pas un écran de l'ERP |
| `/api/site-web/v1/contenus` | GET | API du site web public : visiteurs et candidats, pas un écran de l'ERP |
| `/api/v1/documents/[id]/content` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/entities/[entity]` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/entities/[entity]/[id]` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/entities/[entity]/[id]/[aspect]` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/meta/entities` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/meta/entities/[entity]` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/meta/modules` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/meta/operations` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/openapi.json` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/operations/[operation]` | POST | API publique v1 (jetons d'intégration) : un client externe, pas un écran |
| `/api/v1/search` | GET | API publique v1 (jetons d'intégration) : un client externe, pas un écran |

## 7. Ce qui ne change pas

- Les routes rendent les mêmes fichiers, sous les mêmes noms et types ; les refus gardent leur statut (le corps d'une
  erreur est désormais toujours `{ error }` en JSON — l'événement et la demande de stocks rendaient un corps vide).
- Aucune écriture en base depuis le modèle : l'export dépose un fichier dans le Drive de la personne elle-même ; l'envoi
  à un autre est une carte.
- Les cliquets ne se relèvent pas : frontières du module (aucun import d'Adam), plafonds du socle, garde du bundle client
  (les fonctions d'export sont des modules serveur ; le catalogue est pur).
