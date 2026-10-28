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
| **V2-D Lieux et coordonnées** | `Wilaya` chargée (69) ; rattachement des colonnes texte `wilaya`/`city` par `lieux/normaliser.ts` (colonnes `wilayaCode` nullables) ; `Adresse` et `PointDeContact` repris des fiches ; communes : table vide tant qu'aucune source officielle complète n'est chargée. | « Par wilaya » se compte sans nettoyage manuel. Livré : [`refonte-v2-lieux.md`](refonte-v2-lieux.md). |
| **V2-E Coffre en double lecture** | Copier `Employee.iban`, `Employee.nationalId`, `CompanyContact.rib`, `CompanyLegalIdentity.rib/iban`, salaires vers `DonneeSensible` (chiffré, HMAC, 4 derniers) ; les écrans et exports lisent par le coffre avec `AccesDonneeSensible` ; écriture double. Le clair RESTE (P5 = accord). | Qui a lu l'IBAN de qui, quand, pour quel geste. |
| **V2-F Worker séparé** | Point d'entrée `worker` (même code) pour `runScheduledJobs`, l'enrichissement et les routines ; service Render `worker` ; le web ne porte plus le battement. Interrupteur pour revenir au battement web. | Une extraction lourde ne ralentit plus une page. **Livré (prêt, non activé)** : `npm run worker`, bail par tâche (`TacheDeFond`), `TACHES_DE_FOND=web\|worker\|les-deux` (défaut `web`), `/api/health/worker` ; activation : `docs/readme/24-deploiement-render.md`. |
| **V2-F Worker séparé** | Point d'entrée `worker` (même code) pour `runScheduledJobs`, l'enrichissement et les routines ; service Render `worker` ; le web ne porte plus le battement. Interrupteur pour revenir au battement web. | Une extraction lourde ne ralentit plus une page. |

## État des lots

### V2-A — livré (branche `refonte/v2-depot-enrichissement`)

- **Branché** : `persistUploadedDocument`, `inscrireDocumentDirect`, `attachFiles`, `enregistrerFichierDrive` (route
  `/api/drive/upload` et finalisation du dépôt direct) → `enrichissement/signalement.ts` (fait `PIECE_DEPOSEE` + file).
- **File** `TacheEnrichissement` (migration `20270131170000_enrichissement_file`), passage `traiterLaFile({ max })` au
  battement ; identifiants dérivés : rejouer ne duplique rien (banc `enrichissement/traitement.test.ts`).
- **Écrans** : `/admin/refonte-donnees` (interrupteur, file, reprises), `/a-confirmer`.
- **Activation en production (geste du Super Admin)** : déployer ; poser `COFFRE_KEY` (32 octets hex, ≠
  `DRIVE_ENCRYPTION_KEY`) — sans elle, les faits sensibles échouent et la tâche le dit ; ouvrir l'interrupteur ;
  surveiller la file ; lancer, si voulu, la reprise « Rattrapage des pièces existantes » par lots.
- **Reste** : points de dépôt hors goulots (`refonte-p4-points-de-depot.md` §3 : RH `/api/rh/upload`, paie, messagerie,
  OnlyOffice, livrables) ; rattrapage des fichiers Drive existants ; projection des coordonnées confirmées vers
  `Adresse` / `PointDeContact` (V2-D) et de la nationalité (ISO alpha-3 lu → alpha-2 de la fiche) ; rattachement des
  faits « produit » au catalogue ; lecture par modèle des pièces ordinaires (jamais `NATURES_LOCALES`), si la Direction l'ouvre.
- **Décisions à prendre** : (1) qui est le « responsable d'une fiche » — aujourd'hui le dépositaire de la pièce et le
  Super Admin ; (2) la création d'une Personne depuis une fiche porteuse non rapprochée (faite, avec la saisie de la
  fiche, en attendant R1) ; (3) la porte d'écriture seule du coffre reconnue par `coffre/frontiere.test.ts` — déposer et
  calculer une empreinte ne sont pas lire ; (4) l'adaptateur `coffre/depot-referentiel.ts` remplace, pour les tables
  réelles, `coffre/depot-prisma.ts` écrit avant elles (V2-E doit s'en servir).
