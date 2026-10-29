# 0014 — La bibliothèque : toute pièce inscrite, lue une fois, retrouvée par son contenu (lot J1, 29/10/2026)

**Décision (Direction, 29/10/2026, proposition validée — lot J1)** : « toute pièce qui entre dans la plateforme, quelle que
soit la porte, est inscrite au même registre et lue une fois pour toutes ; une seule requête la retrouve par son contenu,
filtrée par les droits ». **pgvector est approuvé en production.**

> Code : `src/modules/bibliotheque/` (portes `api-inscription.ts`, `api.ts`, `partage.ts`, `actions.ts` ; `domaine/` pur ;
> `infra/` ; écran `ecrans/` → page `/bibliotheque`), règles d'ouverture partagées `src/lib/entity-access/ouverture-pieces.ts`,
> tâches `bibliotheque.ingestion` et `bibliotheque.rattrapage` (`src/lib/scheduled.ts`). Migration `20270207100000_bibliotheque`.
> Bancs : `bibliotheque.test.ts`, `droits.test.ts`, `inscription-cliquet.test.ts`, `domaine/*.test.ts`, `scripts/bench/bibliotheque.ts`.

## 1. Ce qui existait, et pourquoi ce n'était pas une bibliothèque

Un coffre unique (`drive-storage.ts` : `putBlob`/`getBlob`), ~40 écrivains, un registre R5 (`Piece`/`PieceLien`) alimenté
seulement par l'enrichissement (interrupteur fermé par défaut), et **trois index partiels** sans droits communs : `DriveTextIndex`
(20 000 premiers caractères, vecteurs JSON comparés en mémoire), `Knowledge*` (Drive + courriels), le corpus réglementaire. Une
pièce jointe de la messagerie, d'un sujet, d'une réunion, d'un rapport terrain, d'un dossier RH n'était cherchable nulle part.

## 2. Les choix

| Question | Décision | Pourquoi |
|---|---|---|
| Un registre de plus ? | **Non** : `Piece` (une par empreinte, `piece_<sha256>` — l'identifiant de l'enrichissement) et `PieceLien` (l'endroit). La bibliothèque ajoute `BibliothequeFiche` (une par pièce : métadonnées, clés d'accès, état de file) et `BibliothequePassage`. | « Réutiliser Piece/PieceLien plutôt qu'un 3e registre ». La fiche n'est pas un registre : c'est l'état de lecture et d'index. |
| Une porte d'inscription | `inscrirePiece({ blob, nom, mime, source, objet, confidentialité, propriétaire })` et ses formes (`inscrireDocument`, `inscrireFichierDrive`, `inscrireDocumentRh`…), par la porte ÉTROITE `api-inscription.ts`. **Ne lève jamais.** | Un dépôt réussi reste réussi (même règle que le signalement de l'enrichissement). La porte étroite n'emporte ni recherche ni lecteurs dans le graphe des écrivains. |
| Qui inscrit ? | **Tous les points d'entrée** (≈ 45 sites) : Drive (dépôt, versions, éditeurs texte et OnlyOffice, copies, PDF, documents Office, miroirs Drive des dossiers, archives, exports, fabrique), pièces de module (`Document`, ≈ 15 écrivains), messagerie (à l'envoi), sujets, réunions (pièces, enregistrement), rapports terrain (pièces, vocal), RH (dossier, bulletins, attestations, ordres de mission, miroir des contrats), pièces jointes Microsoft 365, retours, KPI, candidatures du site, Assistant IA (par le Drive). | Le **cliquet** `inscription-cliquet.test.ts` (dans `test:architecture`) : tout `putBlob`/`saveFile` hors du coffre est SUIVI d'une inscription, ou figure parmi 9 exceptions nommées, comptées, justifiées (le corpus réglementaire — index propre, pont J2 —, papier à en-tête et logo, import de valeurs KPI, le téléversement de messagerie inscrit à l'envoi). Vérifié par mutation. |
| Les droits | Chaque fiche porte les **clés d'accès** de ses endroits (`DRIVE_NODE:…`, `DOCUMENT:…`, `MESSAGE_PIECE:…`, 11 familles). La recherche ne rend une pièce qu'à qui peut ouvrir **au moins un** de ses endroits, par la **règle même de la route qui sert le fichier** — appelée, jamais recopiée (`resolveDriveAccess`, `peutOuvrirDocument`, `canAccessConversation`, `canViewMeeting`, `canReadFeedback`, `peutVoirBilan`…). Les règles qui vivaient dans leur route sont sorties dans `entity-access/ouverture-pieces.ts`, que route ET recherche appellent. Famille inconnue, objet disparu, corbeille : rien. | « Même règle que l'ouverture du fichier ». Une clé EXCLUSIVE (version courante d'un fichier, fichier d'un `Document`, enregistrement remplacé) quitte l'ancien contenu : une ancienne version ne ressort plus. |
| Pour un modèle (`pourModele: true`) | Exclut **dans la requête** les pièces `CONFIDENTIAL` et **sensibles** (identité, paie, RIB : classement local `classerPiece` / `estNatureLocale`, ou nom qui l'annonce), puis passe les extraits au **filtre de confidentialité**. Le texte de ces pièces n'est **jamais envoyé au fournisseur d'embeddings** (plein texte local seulement). | La règle de l'Assistant IA pour une pièce jointe (0011) ; la console « Assistant IA — accès » (autre session) réglera la suite. |
| Lire une fois | Une fiche par empreinte : la même pièce rangée ailleurs gagne une clé, sans relecture. Lecteurs **existants** seulement : `lireFichierUneFois` (texte natif, OCR **local** `cloud: false`, scellé, partagé avec l'enrichissement), `parsePptx`, transcription (celle que l'écran a déjà faite pour une réunion / un rapport terrain, sinon `transcribeAudio` sous la bascule « voix » — **jamais** pour une pièce confidentielle). Au-delà de 40 Mo (25 Mo pour un enregistrement), archive, format inconnu : `IGNOREE`, la raison écrite. | Aucun lecteur neuf ; rien ne sort qui ne sortait déjà. |
| La file | Tâche de fond sous **bail** (`TacheDeFond`), prise `FOR UPDATE SKIP LOCKED`, verrou périmé repris (10 min), réessais 1 min → 6 h, `ECHEC` au 6ᵉ (le Super Admin relance). Passages remplacés en une transaction (rejouer = mêmes passages). Rattrapage du stock : 25 lignes par famille et par passage, par la même porte. Version des règles (`VERSION_INGESTION`) : la monter fait relire, par lots. Débrayage : `BIBLIOTHEQUE_INGESTION=off`. | Idempotence par empreinte ; reprise après plantage. |
| Découpage | ~800 jetons estimés (4 car./jeton), chevauchement ~120, coupe sur paragraphe › phrase › ligne › blanc, déterministe. | Assez long pour une idée entière, assez court pour un vecteur et un extrait. |
| Index | `tsvector` **français replié** (configuration `bibliotheque_fr` : `unaccent` + `french_stem`) en colonne générée + GIN ; trigrammes sur le titre replié ; `vector(512)` + **HNSW** si pgvector est disponible. Migration additive et idempotente : sans pgvector, ni colonne ni index, **et elle passe** ; le code détecte (`capacites.ts`) et retombe sur plein texte + trigrammes. | « Ne jamais échouer si pgvector est absent ». |
| Classement | Trois voies — plein texte (en OU, rang `ts_rank_cd`), titre (trigrammes, `LIKE` replié sans pg_trgm), sens (cosinus) — **fusionnées par RRF** (k = 60) ; filtres format, période, source, objet (clé), famille ; extraits **surlignés** calculés en segments (jamais de HTML injecté). | Les scores ne se comparent pas, les rangs si. |

## 3. Ce qui a été mesuré (et corrigé en route)

Banc `npm run bench:bibliotheque` (base locale `amd_bench`, 2 000 pièces semées par la vraie porte du Drive, lues par la vraie
ingestion ; 30 pièces visées dont le titre ne dit rien du contenu ; trois personnes, dont une restreinte à ses 100 pièces et 40
partagées) :

| Configuration | p50 | p95 | Rappel@10 | Hors droits |
|---|---|---|---|---|
| Hybride, faux embedder déterministe (pgvector 0.6, HNSW) | 23 ms | 115 ms | 30/30 | 0 / 120 |
| Repli **sans vecteur** (plein texte + trigrammes) | 20 ms | 124 ms | 30/30 | 0 / 120 |
| Hybride, **text-embedding-3-small réel** (`--vivant`, par le mandataire) | 65 ms | ≈ 360–400 ms | 30/30 | 0 / 200 |

- Ingestion : 2 000 pièces lues et vectorisées en ≈ 30 s (faux embedder), ≈ 25 s (vrai fournisseur, lots de 64).
- **Le dépassement en vivant est l'appel au fournisseur** : ≈ 280 ms par vecteur de requête depuis ce conteneur (800 ms pour le
  premier, la poignée TLS), contre ≈ 15 ms pour la requête vectorielle elle-même. D'où : l'appel part **en parallèle** des voies
  lexicales, son attente est **bornée** (400 ms, `BIBLIOTHEQUE_DELAI_VECTEUR_MS`, au-delà la recherche part sans le sens et le
  dit), et le vecteur d'une requête est **gardé** (une requête répétée ne le repaie pas : p50 65 ms).
- **Piège trouvé** : l'index HNSW ne rend que `hnsw.ef_search` voisins (40) AVANT les filtres — une recherche filtrée en perdait.
  `SET LOCAL hnsw.ef_search = 480` pour la requête vectorielle seule.
- **Bruit trouvé** : avec le vrai modèle, sur un corpus homogène, des centaines de passages passent le seuil absolu (0,3) à quelques
  millièmes l'un de l'autre ; ils noyaient la fusion et faisaient juger des droits pour rien (p95 480 ms). La voie « sens » ne
  garde que ses 50 meilleurs, à moins de 0,1 du meilleur.
- Droits : le juge du Drive lit sans parcours les trois issues que `resolveDriveAccess` rend sans dépendre du nœud (Super Admin,
  portée ALL, propriétaire) ; le reste passe par la fonction. `droits.test.ts` vérifie, pour 7 rôles et 6 familles, que la
  recherche rend EXACTEMENT ce que la règle d'ouverture ouvre.

## 4. Ce qui n'est pas fait (et pourquoi)

- **Pas branché dans l'Assistant IA ni dans Adam** : deux autres sessions modifient leurs outils. La fonction est prête
  (`chercherDocuments(user, requête, filtres, { pourModele: true })`, `ouvrirDocuments(user, ids, { pourModele: true })`).
- **Corpus réglementaire** (dossiers CTD, réserves ANPP, documents générés) : index et droits propres ; le pont (sans relecture)
  est le lot J2. Les miroirs Drive de ces pièces, eux, sont inscrits (ce sont des fichiers du Drive).
- **Vision** d'une image scannée : l'OCR **local** suffit à l'index ; la vision (cloud) reste réservée à l'Assistant IA, qui la
  décide pièce par pièce.
- **pgvector installé après coup** sur un serveur : la migration ne se rejoue pas — une migration de plus, qui rejoue son dernier
  bloc, posera la colonne ; `vectoriserEnRetard` vectorisera alors le stock par lots.
- `DriveTextIndex` et `Knowledge*` restent en place (leurs lecteurs actuels) ; ils pourront lire la bibliothèque au lot suivant.
