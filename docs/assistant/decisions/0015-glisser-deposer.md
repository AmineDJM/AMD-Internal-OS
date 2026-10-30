# 0015 — Glisser-déposer des fichiers et des dossiers, aperçu des pièces, demande de modification (29/10/2026)

**Demande (Direction, 29/10/2026)** : « glisser-déposer depuis l'ordinateur, fichiers et dossiers, sur toute la zone du chat ;
chaque fichier devient une puce ; rien n'est envoyé avant Entrée ; ouvrir les fichiers de la conversation — envoyés et renvoyés
— dans un aperçu ; demander une modification d'un Word ».

> Code : `src/lib/agent/lecture/depot.ts` (règles PURES, au socle : parcours, fichiers système, bornes, phrases, liens cités),
> `src/components/assistant-beta/depot-navigateur.ts` (entrées du navigateur, presse-papiers, téléversement avec progression),
> `pieces-jointes.tsx` (trombone, puces, pièces des bulles), `apercu-piece.tsx` (panneau d'aperçu), `assistant-workspace.tsx`
> (zone de dépôt, collage, envoi), `command-pill-bar.tsx` (brouillon, texte rendu si rien n'est parti) ; serveur :
> `operations/pieces.ts` (`piecesCitees`), `fil/service.ts` (borne partagée), `app/api/assistant-ia/fil/route.ts`
> (`piecesRendues`). Bancs : `lecture/depot.test.ts`, `fil/depot-multi.test.ts`, `e2e/assistant-glisser-deposer.spec.ts`.

## 1. Déposer

| Geste | Ce qui se passe |
|---|---|
| Des **fichiers** survolent la fenêtre | une zone de dépôt couvre la conversation : « Déposez vos fichiers ou dossiers », les bornes rappelées. Un texte ou un lien glissé ne la montre pas. |
| **Dépôt** | fichiers et **dossiers** mêlés ; un dossier est parcouru **récursivement** (`webkitGetAsEntry` → `FileSystemDirectoryEntry`, lu lot après lot), le **chemin relatif** est gardé et affiché (« Congrès Oran/devis/imprimeur.pdf »). Profondeur ≤ 12, 500 entrées au plus — au-delà, c'est dit. |
| **Ctrl+V** | une image ou un fichier du presse-papiers devient une puce (une capture prend un nom daté) ; un texte collé reste du texte. |
| **Trombone** | « Des fichiers… » ou « Un dossier… » (`webkitdirectory`). Sur téléphone (pas de glisser-déposer), il ouvre directement le choix des fichiers. |
| Ignorés | `.DS_Store`, `Thumbs.db`, `desktop.ini`, verrous d'Office `~$…`, tout nom caché (`.…`, `._…`), et ce qui vit sous `__MACOSX/`, `.git/`… — **comptés et dits**. |

**Bornes** (alignées sur l'existant, une seule source : `depot.ts` lit `regles.ts`) : **10 pièces** par message (la borne que le fil
appliquait déjà, `deposerMessage` / `piecesDuMessage`, désormais `PIECES_PAR_ENVOI_MAX`) ; **40 Mo** par fichier (`OCTETS_MAX_LECTURE` :
au-delà, il ne serait pas lu) ; fichier vide et doublon (même chemin, même taille) refusés. Chaque refus **nomme** le fichier et sa
raison (zone `aria-live`). **Au-delà de 6 pièces**, la barre le dit AVANT l'envoi : « les 6 premières seront lues ; les autres
jointes et rangées dans votre Drive, sans être lues » — et la lecture le redit sous chaque pièce (statut `NOMMEE`). Un nom qui
annonce le coffre (passeport, RIB, paie) est signalé sur la puce : jointe, non lue.

## 2. Rien ne part avant Entrée — la voie retenue

**Le téléversement se fait À L'ENVOI, pas au dépôt.** C'est la voie la plus sûre : une puce retirée n'a jamais touché le Drive —
rien à mettre à la corbeille, rien d'orphelin si l'onglet se ferme, aucun quota consommé pour un fichier abandonné. Le prix : la
progression s'affiche à l'envoi (barre et pourcentage sur chaque puce, `XMLHttpRequest.upload`) au lieu de pendant la frappe.

À l'envoi (Entrée, bouton, ou vocal), chaque fichier part par `/api/drive/upload` (droits, quotas, formats, chiffrement — inchangé),
puis le message rejoint le fil avec les identifiants. **Un échec arrête l'envoi** : le message ne part pas avec une pièce manquante,
la puce dit l'erreur, le texte revient dans le champ ; on retire la puce ou l'on renvoie (seuls les fichiers non encore téléversés
repartent).

Puces : un clic ou Espace **sélectionne** ; **Suppr** / Retour arrière retire la sélection (ou la puce qui a le focus), le focus
passe à la voisine ; ← → passent d'une puce à l'autre ; la croix retire une puce ; « Retirer la sélection (n) », « Tout retirer ».
Miniature locale (`blob:`) pour une image, libérée au retrait et à l'envoi.

## 3. Ouvrir les pièces de la conversation

- **Envoyées** : sous la bulle, chaque pièce est un bouton (avec ce que la lecture a donné, comme avant) → aperçu.
- **Renvoyées par l'assistant** : la route du fil cite les fichiers du Drive liés par la réponse (`/drive/<id>` dans le texte ou dans
  le `resultLink` d'une action exécutée — document créé, traduction, formulaire rempli) et les **revérifie** sous les droits de la
  personne (`piecesCitees` → `resoudrePiece`) : un fichier invisible ou retiré n'apparaît pas. Ils s'affichent sous la réponse.
- **Aperçu** : panneau latéral, en lecture (`ApercuUniversel` **sans** cible d'édition, chargé à la première ouverture — la page ne
  le paie pas avant) : PDF, images, vidéo, son tels que le navigateur les lit ; Word / Excel / PowerPoint par les visionneuses
  de l'aperçu universel ; texte lu ; sinon téléchargement. « Télécharger », « Ouvrir dans le Drive ». Échap ferme, le focus revient.
  Les octets viennent de `/api/drive/<id>/raw` : droits revérifiés à chaque lecture.

## 4. Demander une modification

Sur une pièce **Word** (et PowerPoint), « Demander une modification » joint la pièce au message (sans re-téléversement : elle est
déjà dans le Drive) et pré-remplit : « Modifie ce document « … » — produis une nouvelle version dans mon Drive, sans écraser
l'original : ». La pièce est LUE par le tour (décision 0011), et l'assistant produit la nouvelle version par l'outil existant
`preparer_document` (`operations/document-modele.ts`, `composerDocx`) : un **nouveau fichier** du Drive, après la carte de
confirmation — jamais d'écrasement. Le fichier créé revient comme pièce ouvrable (§ 3). Pour une présentation, la phrase demande à
l'assistant de **dire** qu'il n'a pas d'outil pour ce format.

## Sécurité — inchangée

Mêmes portes que les pièces de la décision 0011 : droits Drive revérifiés à chaque étape (dépôt, tour, aperçu), coffre et
`CONFIDENTIAL` jamais envoyés au modèle, contenu encadré comme non fiable (`contenu-non-fiable.ts`), filtre de confidentialité,
bornes. Aucun import Node dans les composants client (`client-bundle-guard.test.ts`).

## Limites restantes / à confirmer par la Direction

1. **Nouvelle version ≠ mise en page d'origine** : `preparer_document` recompose un Word (lettre, note, compte rendu) sur le papier
   en-tête ; il ne reprend pas les styles et tableaux du document modifié. Un outil « modifier ce Word en place » (comme la
   traduction le fait déjà) est du ressort des outils serveur (lot V4-G).
2. **PowerPoint** : aucun outil de modification — l'assistant doit le dire.
3. **Dossiers dans le Drive** : les fichiers d'un dossier déposé atterrissent à la racine du Drive personnel ; le chemin relatif est
   gardé dans le message (écran et fil), pas recréé en dossiers du Drive.
4. **Thème sombre** : les classes `dark:` suivent la convention des composants voisins, mais l'ERP n'a pas encore de thème sombre
   (KB 05 § 2) — elles prendront effet avec lui.
