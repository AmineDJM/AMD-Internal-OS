# Refonte des données — vague 2 : remplir, brancher, double écrire

> 27/10/2026. Cadre : [`refonte-donnees-et-monolithe-modulaire.md`](refonte-donnees-et-monolithe-modulaire.md) §3-§4.
> La vague 1 (P0 outillage, P1 tables vides, extracteurs, classement, décision des faits, coffre, lieux, dédoublonnage,
> inventaire des écrivains P3, points de dépôt P4) est intégrée. La vague 2 met les référentiels en service,
> **sans rien détruire** : aucune colonne historique n'est retirée, aucune donnée n'est effacée (P5 « effacer le
> clair » et P6 « retrait » exigent un accord explicite de la Direction).

## Règles communes à tous les lots

- **Additif et réversible.** Migrations SQL manuelles idempotentes ; colonnes nouvelles nullables ; un interrupteur
  (`AppSetting` ou constante documentée) pour couper chaque nouveauté en production.
- **La reprise ne tourne jamais toute seule au déploiement.** Elle s'exécute dans l'application (la base de
  production n'est jamais atteinte depuis un poste de développement) : un **service de reprise** idempotent, lancé
  par le Super Admin depuis `Administration › Refonte des données` (aperçu chiffré à blanc, puis exécution par lots,
  journal), et rejouable sans effet de bord (identifiants déterministes ou clés uniques).
- **Les doublons sont PROPOSÉS, jamais fusionnés d'office.** Une fusion est un geste humain tracé (`fusionneeDansId`).
- **Données sensibles** : jamais vers un modèle d'IA ; lues par le coffre (`src/lib/coffre`) avec journal d'accès.
- **Frontière client/serveur** (CLAUDE.md) et contrat des actions (`npm run actions:contrat` + registre) respectés.
- Tests : base locale uniquement ; chaque lot a ses bancs (reprise idempotente rejouée deux fois, double écriture,
  absence de fuite sensible).

## Les lots

| Lot | Contenu | Livrable vérifiable |
|---|---|---|
| **V2-A Dépôt → enrichissement** | Brancher `emettrePieceDeposee` aux trois goulots (`refonte-p4-points-de-depot.md` §2 : `saveFile` rend `{ blobId, sha256 }`) ; file de traitement (outbox) : classement → extraction par nature → `FaitPropose` → décision (`enrichissement/decision.ts`) → `FaitConfirme` / `ConflitDeFait` ; écran « À confirmer » du responsable de la fiche. Pièces d'identité et de paie : traitement LOCAL seulement. | Un passeport déposé sur un poste propose nom/prénoms/nationalité sur la Personne et range le numéro au coffre. |
| **V2-B Personnes** | Reprise R1 depuis `User`, `Employee`, `MedicalDoctor`, `CareBeneficiary`, `AdProVoyageur`, `AdProHebergement`, `RecruitmentCandidate`, `DirectoryEntry`, `SupplierUser` (rôles `PersonneRole`, liens `personneId`) ; doublons proposés (`refonte/dedoublonnage`) ; double écriture aux écrivains listés par `refonte-p3-inventaire.md` §1 ; fiche Personne 360° (lecture). | Le Dr Benali = une Personne, ses prises en charge, voyages et pièces sur sa fiche. |
| **V2-C Organisations** | Reprise R2 depuis `Company`(+`CompanyLegalIdentity`), `CompanyContact`, `Supplier`, `MedicalInstitution`, textes `institution` ; identifiants NIF/NIS/RC uniques (`OrganisationIdentifiant`) ; `Affiliation` ; double écriture (§2 de l'inventaire) ; fiche Organisation 360°. | Un NIF identifie un tiers ; la société savante d'un sponsoring est une Organisation. |
| **V2-D Lieux et coordonnées** | `Wilaya` chargée (69) ; rattachement des colonnes texte `wilaya`/`city` par `lieux/normaliser.ts` (colonnes `wilayaCode` nullables) ; `Adresse` et `PointDeContact` repris des fiches ; communes : table vide tant qu'aucune source officielle complète n'est chargée. | « Par wilaya » se compte sans nettoyage manuel. |
| **V2-E Coffre en double lecture** | Copier `Employee.iban`, `Employee.nationalId`, `CompanyContact.rib`, `CompanyLegalIdentity.rib/iban`, salaires vers `DonneeSensible` (chiffré, HMAC, 4 derniers) ; les écrans et exports lisent par le coffre avec `AccesDonneeSensible` ; écriture double. Le clair RESTE (P5 = accord). | Qui a lu l'IBAN de qui, quand, pour quel geste. |
| **V2-F Worker séparé** | Point d'entrée `worker` (même code) pour `runScheduledJobs`, l'enrichissement et les routines ; service Render `worker` ; le web ne porte plus le battement. Interrupteur pour revenir au battement web. | Une extraction lourde ne ralentit plus une page. |

## État du lot V2-B « Personnes » (27/10/2026, branche `refonte/v2-personnes`)

**Livré** — code `src/lib/referentiels/personnes/`, contrat commun `src/lib/referentiels/reprises/`, écrans
`/admin/refonte-donnees`, `/personnes/[id]`, `/personnes/doublons`, migration `20270131170000_personnes_reprise`.
Carte détaillée : `docs/knowledge-base/03-data-model-and-migrations.md` §4.13.

**Activer en production (Super Admin)**, après déploiement :
1. `Administration › Refonte des données` : « Aperçu à blanc » de chaque reprise « Personnes — … », dans l'ordre affiché
   (comptes, salariés, praticiens, bénéficiaires, voyageurs, hébergements, candidats, annuaire, portail) ; lire les chiffres.
2. « Tout exécuter » sur chacune, dans le même ordre (lots de 200, s'arrête à la première erreur ; rejouable).
3. « Personnes — doublons proposés » : aperçu, puis exécution ; trancher dans `Personnes › Doublons`.
4. Allumer la **double écriture des Personnes** (même écran). L'éteindre suffit pour revenir en arrière.

**Reste** : les écrivains d'IMPORT (`importDirectorySheet`, imports de segmentation), `creerProfilMedecin`,
`redeemInvite`/`createAccountWithInvite` et les candidatures du site public ne font pas encore la double écriture (la
reprise rejouée les rattrape) ; les mises à jour d'identité (nom corrigé) ne remontent pas à la Personne (lot V2-A,
décision des faits) ; le coffre (`DonneeSensible`), les faits (`FaitPropose`/`FaitConfirme`) ne suivent pas encore une
fusion ; la fiche n'a ni recherche ni liste des Personnes.

**Décisions attendues** : qui tranche une fusion (aujourd'hui : Super Admin seul ; proposition « responsable du module +
Super Admin ») ; faut-il ouvrir la fiche Personne aux porteurs de l'annuaire interne pour les collègues (aujourd'hui oui,
comme l'annuaire) ; un hébergement est-il un rôle VOYAGEUR (choix actuel) ou BENEFICIAIRE.
