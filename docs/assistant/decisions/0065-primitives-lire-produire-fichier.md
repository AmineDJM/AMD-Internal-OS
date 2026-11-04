# 0065 — Les primitives d'Adam : `lire`, `produire`, `fichier`, `observer`, l'espace d'Adam (lot I3, 03/11/2026)

Mise en œuvre de l'architecture cible de l'audit AU2 (`docs/assistant/audit-2026-11-03/au2-primitives.md`, branche
`jarvis/au2-primitives`), étape **M0** (la lecture par vues déclarées) et la partie **fichier** des étapes **M1/M2**
(observer un fichier, produire un fichier, modifier / convertir / copier un fichier, l'espace d'Adam). Lu avec AU1
(l'observation comme primitive) et AU3 (un moteur, des accès).

> Direction, 03/11 : « Je veux que tu implémentes cette architecture cible. […] à la fois, il faut laisser une totale
> liberté, créativité […] Mais également, il faut que ça soit pro et bien. Mais des fois, je peux demander des choses qui
> ne sont pas forcément très pro et qu'il les fasse. » — « je veux aussi qu'il accède aux annuaires, qu'il puisse copier
> les annuaires, les exporter, modifier leurs Excel, avoir des copies, les ranger quelque part, avoir son propre drive à
> lui pour qu'il puisse cacher ses documents ; qu'il puisse modifier les documents, des Word, convertir. »

Hors de ce lot : `produire(mail)` et le contrat d'observation d'une **carte** (lot I1, branche `jarvis/i1-observation`),
`agir` en un outil et le masquage des exports d'écran / `preparer_*` 1:1 (étape M4), la garde de sortie sur la forme (M3).

## 1. Ce qui est construit

| Primitive | Fichiers | Contrat |
|---|---|---|
| `lire` | `domaine/primitives/vues.ts` (pur), `infra/primitives/vues.ts` (registre), `infra/primitives/lire.ts` | `{vue, filtres[], champs[], tri, compter_par, limite, jeu}` → un JEU nommé (partagé avec `produire` et `analyser_donnees`, K1) + un aperçu borné ; chaque ligne porte son lien d'écran |
| `produire` | `infra/primitives/produire.ts`, `domaine/primitives/html.ts` | `{format: xlsx \| csv \| docx \| pdf, nom, jeu \| lignes \| html, colonnes, colonnesAjoutees, renommer, totaux, presentation, dossier}` → un fichier dans l'espace d'Adam, et son OBSERVATION |
| `fichier` | `infra/primitives/fichier.ts` | `{fichier, remplacements[], gestes[], versFormat, copier, nom, dossier}` → nouvelle version Drive (la précédente reste), conversion, copie — en UN appel |
| `observer` | `infra/primitives/observer.ts`, `domaine/primitives/observation.ts` | `{fichier}` → ce que la personne verra : feuilles, colonnes, lignes, totaux, anomalies, texte, tableaux, pages, versions |
| espace d'Adam | `src/lib/drive/espace-adam.ts` (pur), `src/lib/actions/internes/primitives/espace.ts` | un `DriveSpace` « Espace d'Adam » par personne (`accessUserIds` = `managerUserIds` = [elle], aucun rôle), dossiers « Brouillons » et « Copies », **aucune migration** |

Les cinq vues de M0 : **produits**, **établissements**, **missions**, **tâches**, **demandes** (administratives).

## 2. Les invariants (dans le moteur, jamais en consigne)

1. **La portée est obligatoire par type.** `VueLisible.portee(user)` est la fonction `where` de l'écran, importée, jamais
   recopiée : `clauseProduitAuCatalogue` (Produits 360), `voitEtablissements` (annuaire), `ownerId` de `mesMissions`
   (Centre de missions), le cercle de « Mon espace › Tâches », `scopeAdminRequests` (Demandes). La lecture ne reçoit que la
   portée calculée par l'exécuteur (`executerVue`). Les dossiers lus d'un produit passent `regulatoryLockWhere`.
2. **Une vue fermée refuse en nommant le droit.** `portee` rend `null` → `{statut: "FERMEE", droit, raison}` ; l'outil
   reste offert ; rien n'est lu (prouvé par l'espion de Prisma). Jamais un jeu vide qui ferait dire « aucun produit ».
3. **Les colonnes du coffre ne se déclarent pas.** `problemesDeDeclaration` refuse une source copiée au coffre
   (`champSensible`, module coffre) et un nom de rémunération, de coordonnée bancaire ou de pièce d'identité ; le test de
   registre l'exige pour chaque vue. Un champ demandé hors déclaration revient « inconnu », nommé.
4. **Les champs calculés le sont par les règles de l'ERP** : `etape` = `etapeCycle` (la frise, Direction 06/10),
   `commercialise` = `clauseCommercialises` (l'onglet de l'écran, réutilisée — AU2 §3.4 point 1), `enRetard`, `diagnostic`.
   L'aire thérapeutique se lit sur les dossiers (`therapeuticSegments`, `therapeuticClass`), jamais sur la BU (faux ami).
5. **Le serveur normalise les entrées naturelles** (`normaliserFiltre`) : dates et mois dits en français (« octobre 2026 »
   → 2026-10, « 3 novembre », « 03/11/2026 », « le mois dernier »), choix par code, libellé d'écran ou mot naturel, accents
   et casse, alias de champs, opérateurs dits autrement, nombres « 1 200,50 », racines (« infectieux » trouve
   « Infectiologie »). La robustesse ne dépend pas de la force du modèle.
6. **La sortie passe le filtre du catalogue** comme toute lecture (`outils-v1.ts` : jetonnée, encadrée, consignée) ; les
   observations de `fichier` et `observer` portent un texte de document : elles sont **encadrées** comme contenu tiers
   (`OUTILS_A_CONTENU_TIERS`).
7. **Écrire un fichier est réversible par nature (K10).** `produire` et `fichier` écrivent sous `journaliserGeste` : une
   nouvelle version (même nom = version suivante), un fichier créé, une conversion rangée. « Annuler » rétablit la version
   précédente et retire les fichiers créés (testé). C'est pourquoi l'écriture se fait **sans carte** — comme
   `assembler_pdf` (T1) — alors que les écritures métier restent des cartes. L'Atelier reste l'écran où la personne relit et
   retouche **si elle le veut** (`ouvrir_dans_l_atelier` reste offert). Sans droit d'écrire l'original (fichier partagé en
   lecture), la modification va dans une copie de l'espace d'Adam ; l'original n'est jamais touché.
8. **L'observation est calculée par le code depuis le fichier écrit** (rouvert par les adaptateurs de l'Atelier) : un total
   qui additionne un téléphone est une ANOMALIE dite, un tableau sérialisé (« ["Ouest — Oran"] ») aussi ; un remplacement
   qui n'a rien trouvé se voit (`remplacementsVerifies` : `encorePresent`, `nouveauPresent`). Le modèle confronte et se
   corrige — sans consigne.
9. **HTML libre, assaini** : liste blanche de balises et de propriétés CSS en ligne ; `script`, `iframe`, `url(`,
   `expression(`, `javascript:`, `position` retirés ; liens http(s) ou de l'ERP seulement. **Défaut professionnel** : la
   charte (`charte:adventum`, #087084) sur les titres et en-têtes de tableau quand rien n'est écrit ; **liberté sur demande** :
   `presentation: "libre"` n'ajoute rien ; `class="charte"` habille là, et seulement là.
10. **Aucun total inventé** : une ligne « Total » ne s'écrit que sur les colonnes demandées (`totaux`). Les listes sont
    écrites en texte lisible, jamais en JSON (défaut C8 de l'audit).
11. **L'espace d'Adam est à la personne seule** : `estEspaceAdamDAutrui` le retire des onglets et de la liste du Drive de
    tout autre compte, Super Admin compris (`getDriveSpacesForUser`, `getDriveListing`). Il n'est pas dans « Mon Drive ».

## 3. L'interrupteur et ce qui est masqué

`ADAM_PRIMITIVES=0` (lu à chaque tour) rend le catalogue d'avant **à l'identique** : aucune primitive, rien de masqué
(testé). Par défaut, les primitives sont offertes et ce qu'elles couvrent **entièrement** est **masqué** (retiré du
catalogue, pas du code — 0055 : « ne supprime rien, quitte à tout masquer ») — `MASQUES_PAR_LES_PRIMITIVES` :

| Masqué | Remplacé par |
|---|---|
| `exporter_donnees` | `produire(xlsx \| csv \| pdf)` sur un jeu du tour |
| `modifier_document`, `convertir_document` (couche d'outils de l'Atelier) | `fichier` |
| `list_my_tasks`, `list_my_requests`, `search_products` | `lire` (vues tâches, demandes, produits) |
| `format_convertir`, `document_build`, `sheet_build` (ancien Adam, Super Admin) | `fichier`, `produire` |

**Restent offerts, exprès** : les 17 exports d'écran (suivi Regulatory, budgets, PCH, coaching…) — aucune vue ne lit
encore leurs données, les masquer ferait perdre une capacité (M4) ; les `preparer_*` (M4, avec `agir`) ;
`ouvrir_dans_l_atelier` (la relecture humaine). `couvertParUnePrimitive` fait dire aux bancs d'inventaire (équivalents
d'avant J6, fonctions d'Adam, corpus de sélection) qu'aucune capacité n'est perdue.

`lire` entre au **socle** de la sélection (toujours offert) avec un schéma COURT (1 271 caractères : noms des champs,
valeurs des choix, `*` = calculé) ; le schéma long revient à la première erreur de filtre. `produire`, `fichier`,
`observer` se présélectionnent par la demande (mots de `selection-outils.ts`). Budget de jetons fixes par étape tenu :
pire étape 3 795 ≤ 4 000 (J6). Les primitives qui écrivent ne vont ni aux routines ni aux travaux (`ECRITURES_DU_MOTEUR`).

## 4. Mesures

**Vrai modèle** (`gpt-6.1-terra`, rôle standard, chemin du produit `jouerTour`, Super Admin, base de banc locale,
`ADAM_SORTIE_INTERDITE=1`) — `scripts/bench/i3-primitives/rejouer.ts`, preuves `docs/assistant/preuves/i3/rejeu-vrai-modele.json`,
**0,22 $** :

| Demande | Avant (`ADAM_PRIMITIVES=0`) | Après |
|---|---|---|
| « nos produits commercialisés en infectiologie » | « je ne peux pas confirmer […] posaconazole, pré-soumission » — **faux** (4 appels, 0,042 $) | Amoxil 1 g et Azitrom 500 mg, liens cliquables (2 appels, 0,020 $) |
| « copie l'annuaire des pharmacies d'Oran en Excel, ajoute une colonne statut, range-le dans ton Drive » | une carte « Copier éléments du Drive » à confirmer, colonne promise « ensuite » — **rien n'est fait** (3 appels, 0,048 $) | 3 pharmacies, colonne « statut », aucun total, rangé dans « Espace d'Adam › Copies › Annuaires » (3 appels, 0,026 $) |
| « convertis le Word en PDF et remplace la date » | une question (quel fichier ?) — **rien n'est fait** (2 appels, 0,034 $) | date remplacée (copie dans l'espace d'Adam, v2), PDF produit (5 appels, 0,048 $) |

Réserve honnête : le passage « avant » a joué après le passage « après » sur la même base ; il a vu les fichiers que le
premier avait produits (d'où la question « lequel des deux Word ? »). Les deux autres demandes ne dépendent pas de cet état.

**Catalogue** (outils offerts dans une conversation, `outilsV1(…, {capacites: true})`) :

| | Avant | Après |
|---|---:|---:|
| Super Admin | 1 249 outils (230 propres), 585 292 caractères | 1 245 (226 propres), 579 336 caractères |
| Délégué médical | 718 (92 propres), 287 535 | 718 (92 propres), 290 587 |
| Assistante de direction | 600 (75 propres), 236 980 | 600 (75 propres), 240 032 |

La baisse forte du catalogue viendra de M4 (`agir` en un outil, exports d'écran et `preparer_*` 1:1 masqués quand leurs vues
existent) ; ce lot pose les primitives qui la rendent possible.

**Sécurité** : le banc d'audit déterministe (`audit-assistant.test.ts`) rejoue toutes ses sondes avec les primitives actives,
plus 10 sondes neuves visant `lire` (chaque vue sur la victime, une vue inventée « Employee », des champs du coffre),
`observer`, `fichier` (copier, convertir le bulletin d'autrui) et `produire` — aucun témoin interdit rendu ni parti au
modèle. `primitives-i3.test.ts` : la ligne d'un dossier verrouillé et la tâche d'autrui ne **sortent pas de la base**
(espion de Prisma) ; une vue fermée ne lit rien.

## 5. Revenir en arrière

`ADAM_PRIMITIVES=0` (Render › variables) : catalogue d'avant à l'identique, l'espace d'Adam reste (une catégorie du Drive,
supprimable vide). Tout fichier produit ou modifié s'annule depuis « Ce que l'assistant a fait ».
