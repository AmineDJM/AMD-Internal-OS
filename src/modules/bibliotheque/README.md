# Module `bibliotheque` — toute pièce inscrite, lue une fois, retrouvée par son contenu (J1)

Décision du 29/10/2026 : « toute pièce qui entre dans la plateforme, quelle que soit la porte, est inscrite au
même registre et lue une fois pour toutes ; une seule requête la retrouve par son contenu, filtrée par les droits ».
Décision d'architecture : [`docs/assistant/decisions/0014-bibliotheque.md`](../../../docs/assistant/decisions/0014-bibliotheque.md).

| Porte / dossier | Rôle |
|---|---|
| `api-inscription.ts` | **Porte d'inscription** (étroite) : `inscrirePiece`, `inscrireDocument`, `inscrireFichierDrive` — appelée par chaque point d'entrée après `putBlob` / `saveFile` |
| `api.ts` | **Porte serveur** : l'inscription + `chercherDocuments(user, requête, filtres, { pourModele })`, `ouvrirDocuments(user, ids)`, la file (`traiterFile`, `rattraper`) |
| `partage.ts` | **Porte pure** : familles d'endroits, formats, sources, extraits, politique « pour modèle » |
| `actions.ts` | `relancerFicheBibliotheque`, `rattraperBibliotheque` (Super Admin) |
| `domaine/` | clés d'accès (`familles.ts`), découpage (`decoupage.ts`), formats et repli, fusion RRF, extraits surlignés, politique, requête, règles d'ingestion |
| `infra/` | inscription, ingestion (lecteurs existants, OCR local, transcription, embeddings), rattrapage, capacités (pgvector ?), droits (`acces.ts`), recherche |
| `ecrans/` | l'écran de vérification `/bibliotheque` |

- **Tables** : `BibliothequeFiche`, `BibliothequePassage` (en propre) ; le registre `Piece` / `PieceLien` (partagé avec l'enrichissement).
- **Tâches de fond** : `bibliotheque.ingestion`, `bibliotheque.rattrapage` (`src/lib/scheduled.ts`, sous bail `TacheDeFond`).
- **Règles tenues** : `inscription-cliquet.test.ts` (tout écrivain du coffre inscrit, ou figure parmi les exceptions nommées) ;
  `droits.test.ts` (aucun résultat hors droits, refus par rôle) ; un modèle ne reçoit ni pièce confidentielle ni pièce du coffre.
- **Consommateurs** : ~40 points d'entrée (inscription), l'écran `/bibliotheque`, l'Assistant IA par le socle (`connaissance.ts`, J4), le module `graphe-entreprise` (J9 : `piecesOuvrables`, `faitsVisibles` — la règle de lecture d'un fait, une seule écriture).
