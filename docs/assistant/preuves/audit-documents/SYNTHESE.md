# Banc DOC- — documents, juridique et Drive (lot T1, décision [0053](../../decisions/0053-documents-juridique-drive.md))

Rejeu RÉEL (`gpt-6.1-terra`, base de banc locale `amd_bench`, `ADAM_SORTIE_INTERDITE=1`, aucune variable d'envoi), limité au
préfixe `DOC-` : **36 tâches** à vérificateur déterministe et **5 attaques** du domaine. Dépense : **2,53 $** pour le lot (plafond 3 $), puis **0,16 $** pour la suite du passage complet Q1 (plafond 1 $).

| Passage | Joué | Tâches réussies | Attaques bloquées | Dépense | Ce qui a été corrigé ENSUITE (par le code) |
|---|---|---|---|---|---|
| [1](passage-1/RAPPORT.md) | 5 attaques + 30 tâches (plafond 1,6 $ atteint, 6 non jouées) | **19 / 30** (63 %) | 5 / 5 | 1,48 $ | gestes nus `attachDriveNodeToLegal` / `moveLegalDocuments` retirés de l'offre (supplantés) ; famille la plus précise (avenant > contrat) ; fichier désigné par ses MOTS, sans extension ni accents (`resolveDriveFile`) ; registre et fiches comparés sans accents ; un dossier du Drive rangé en une carte ; « enregistre » prend l'unique document modifié ; PDF → Excel de secours |
| [2](passage-2/RAPPORT.md) | les 11 échecs + les 6 non jouées + 5 attaques | **11 / 17** | 5 / 5 | 0,80 $ | avenant créé par l'action des avenants de l'ERP sur son contrat ; entité « … SPA » ; image → PDF de secours (et par son nom) ; erreur de page conclue sans question ; mots de sélection des 5 outils |
| [3](passage-3/RAPPORT.md) | les 6 échecs + 2 attaques | **5 / 6** | 2 / 2 | 0,16 $ | « le contrat X » : l'original, ni la copie (même contenu) ni l'avenant (autre famille), hypothèse DITE |
| [4](passage-4/RAPPORT.md) | DOC-30 + non-régression DOC-01, DOC-10, DOC-24 | **4 / 4** | — | 0,09 $ | — |
| Q1 complet | les 36 tâches DOC- dans le passage complet du banc (rapport `docs/assistant/preuves/audit/` de Q1) | **31 / 36** | — | (Q1) | DOC-14 : pièce déjà au registre désignée par son titre ; DOC-30 jugée sur le résultat (dépend de l'ordre) ; DOC-31 / DOC-33 : motif du refus élargi ; DOC-11 : un plan de mission sans outil nomme désormais les lectures et gestes ouverts (`plan.ts`), rangement jusqu'à 30 pièces |
| [5](passage-5/RAPPORT.md) | DOC-11, DOC-14, DOC-30, DOC-31, DOC-33 | **4 / 5** | — | 0,10 $ | DOC-11 (voir ci-dessus) |
| [6](passage-6/RAPPORT.md) | DOC-11 + non-régression DOC-10 | **2 / 2** | — | 0,06 $ | — |

**À leur dernier passage, les 36 tâches DOC- sont RÉUSSIES et les 5 attaques BLOQUÉES** (aucun témoin lu ni livré, aucun
acte). Limite dite : les 19 tâches réussies au passage 1 n'ont pas toutes été rejouées après les correctifs suivants (budget) ;
leurs chemins sont couverts par `src/modules/assistant-ia/documents-t1.test.ts` (exécuté puis annulé contre la base, sans
modèle) et 4 d'entre elles ont été rejouées au passage 4.

**« Avant »** : le domaine n'avait aucune tâche au banc Q1 (52/65 hors documents). Mesure de départ du domaine, avec les
premières capacités T1 : 19/30 au passage 1.

Relancer : `BENCH_SEED_ALLOW=1 npm run audit:assistant -- --semer` puis
`AUDIT_SEULEMENT=DOC- AUDIT_RAPPORT_DIR=docs/assistant/preuves/audit-documents npm run audit:assistant` (les tâches modifient
l'état : resemer avant chaque passage complet ; ≈ 1,9 $ pour les 41 scénarios).
