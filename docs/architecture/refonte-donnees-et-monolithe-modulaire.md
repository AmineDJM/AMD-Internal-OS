# Refonte des données et monolithe modulaire — proposition

> 27/10/2026. Statut : **PROPOSITION À VALIDER**. Rien n'est appliqué à la base de production.
> Mesures prises sur le code (`prisma/schema.prisma`, `docs/knowledge-base/03-*`, `src/platform/domains.ts`).

## 1. Ce qui a été mesuré

| Constat | Chiffre | Conséquence |
|---|---|---|
| Un seul fichier de schéma | 16 648 lignes, **433 modèles**, 206 enums, 462 migrations | Personne ne peut relire un domaine sans tout lire ; les bannières de section ne sont pas fiables (`Product` est rangé chez Adam). |
| `User` est le moyeu | **170 clés étrangères** pointent vers lui | Toute évolution du compte touche tout l'ERP. |
| Une même personne vit dans plusieurs tables | `User`, `Employee`, `DirectoryEntry`, `MedicalDoctor`, `CareBeneficiary`, `AdProVoyageur`, `AdProHebergement`, `AdProMedecin`, `RecruitmentCandidate`, `SupplierUser`, `CompanyContact.contactName` | Le Dr Benali peut être 4 lignes sans lien : sa fiche ne sait rien de ses prises en charge, de ses voyages ni de ses pièces. |
| Une même organisation vit dans plusieurs tables | `Company` (+ `CompanyLegalIdentity`), `CompanyContact`, `Supplier`, `MedicalInstitution`, `PchDirectionRegionale`, et des **textes libres** (`SponsoringRequest.institution`, `MedicalDoctor.institution`, `CareBeneficiary.institution`) | Aucun NIF / RC n'identifie un tiers de façon unique ; la société savante d'un sponsoring n'est qu'un mot. |
| Adresses et lieux en texte libre | `wilaya`, `city`, `address` en `String` sur ≥ 8 modèles | Impossible de compter « par wilaya » sans nettoyer à la main. |
| Données sensibles en clair dans des colonnes ordinaires | `Employee.iban`, `Employee.nationalId`, `CompanyContact.rib`, `CompanyLegalIdentity.rib/iban` | Une requête oubliée ou un export suffit à les exposer ; rien ne journalise qui les a lues. |
| Pièces jointes éparpillées | `Document` (polymorphe, **sans clé étrangère**), `DriveNode`/`FileVersion`/`FileBlob`, `EmployeeDocument`, `AdProItemPiece`, `FieldReportAttachment`, `EmailAttachmentRecord`… | Une pièce n'appartient qu'à UNE entité ; un passeport déposé sur un poste ne « remonte » pas sur la personne. |
| L'extraction existe, mais n'enrichit aucune fiche | `LecturePiece`, `RegulatoryExtraction`, `PchTenderExtraction`, `KnowledgeEntity`/`Alias`, `EntityMention` | Chaque upload est lu… puis oublié : le NIF lu sur un devis ne complète pas la fiche du fournisseur. |
| Références sans intégrité | **680** colonnes `…Id` sans `@relation` | L'intégrité repose sur le code applicatif. |
| Dette d'architecture mesurée | frontière Adam ↔ ERP : **433** franchissements (plafond 425) ; traversées inter-domaines : **71** (plafond 68) | Les modules se fouillent mutuellement ; les cliquets sont déjà dépassés. |

## 2. Ce qui est bon et qu'on garde

- Identifiants `cuid`, argent en `Decimal(14,2)`, migrations SQL **manuelles et idempotentes**, aucune `DROP COLUMN`.
- La corbeille (`DeletedRecord`, instantané puis suppression, restauration en lot).
- La numérotation officielle atomique (`DocumentSequence`, `NNN/DG/AAAA`) et les références `PREFIX-AAAA-NNN`.
- `LegalDocument` chaîné (devis → BC → facture → avoir) : une seule table pour les pièces commerciales.
- `Product` canonique + `ProductAlias` : le modèle à suivre pour tous les référentiels.
- `FileBlob` chiffré AES-256-GCM, dédupliqué par empreinte.
- Les droits `UserAccess` / `RowGrant` / `UserCompanyAccess` et `companyScopedWhere`.
- La lecture « une fois par empreinte » (`LecturePiece`) et la résolution d'entités (`KnowledgeEntity` / `KnowledgeAlias`).
- Le journal d'audit et le registre d'événements (`BusinessEvent`).

## 3. Le modèle cible — six référentiels et un moteur d'enrichissement

Principe : **une chose réelle = une ligne**, reconnue par ses identifiants, à laquelle tout le reste se rattache.
Les tables métier existantes **restent** et gagnent une clé vers le référentiel (colonne nullable, ajoutée).

### R1 — Personnes
- `Personne` : civilité, nom, prénoms, nom replié (recherche), date de naissance, nationalité, langues, photo,
  score de complétude, `fusionneeDansId` (fusion tracée, jamais silencieuse), créée par / le.
- `PersonneRole` : COLLABORATEUR, PROFESSIONNEL_SANTE, BENEFICIAIRE, VOYAGEUR, CANDIDAT, CONTACT_TIERS,
  INTERVENANT… (une personne peut en avoir plusieurs, avec dates).
- Liens ajoutés : `User.personneId`, `Employee.personneId`, `MedicalDoctor.personneId`, `CareBeneficiary.personneId`,
  `AdProVoyageur.personneId`, `AdProHebergement.personneId`, `RecruitmentCandidate.personneId`,
  `DirectoryEntry.personneId`, `SupplierUser.personneId`.

### R2 — Organisations
- `Organisation` : raison sociale, nom court, forme juridique, capital, pays, statut, site web, logo.
- `OrganisationRole` : SOCIETE_DU_GROUPE, FOURNISSEUR, CLIENT, ETABLISSEMENT_SANTE, SOCIETE_SAVANTE, AUTORITE,
  LABORATOIRE, AGENCE, BANQUE, TRANSPORTEUR…
- `OrganisationIdentifiant` : NIF, NIS, RC, article d'imposition, n° d'agrément, code PCH — **unique par (type, valeur)**.
- `Affiliation` (Personne ↔ Organisation) : fonction, service, depuis, jusqu'à, principale — remplace les champs
  texte `institution`.
- Liens ajoutés : `Company.organisationId`, `CompanyContact.organisationId`, `Supplier.organisationId`,
  `MedicalInstitution.organisationId`, et sur les demandes (sponsoring, congrès) `organisationId` à côté du texte.

### R3 — Lieux et coordonnées
- `Wilaya` et `Commune` : le découpage administratif officiel, chargé par migration (données de référence datées).
- `Adresse` : lignes, commune, wilaya, code postal, géolocalisation, type (siège, livraison, domicile).
- `PointDeContact` : téléphone, e-mail, site — de qui (personne ou organisation), principal, vérifié le, source.

### R4 — Produits
- `Product` reste le référentiel ; les champs texte `product` (sponsoring, demandes) gagnent un `productId`
  résolu par `ProductAlias`.

### R5 — Pièces
- `Piece` : le fichier une fois pour toutes — blob, empreinte, nom, type MIME, taille, pages, langue,
  **nature classée** (PASSEPORT, CNI, DEVIS, FACTURE, BC, CONTRAT, CV, RIB, KBIS/RC, PROGRAMME, ATTESTATION…),
  confidentialité, déposée par / le, **source** (Drive, conversation, e-mail, portail fournisseur, poste Ad & Pro).
- `PieceLien` : une pièce rattachée à **plusieurs** sujets avec un rôle (« passeport de » une Personne, « devis du »
  poste, « pièce de » la demande). `Document` et `DriveNode` restent le stockage et les vues de l'écran.

### R6 — Coffre des données sensibles
- `DonneeSensible` : titulaire (personne ou organisation), nature (IBAN, RIB, NIN, N° de passeport, salaire…),
  valeur **chiffrée** avec une clé dédiée, empreinte de recherche (HMAC), quatre derniers caractères affichables,
  pièce source, validité.
- `AccesDonneeSensible` : qui a lu quoi, quand, pour quel geste.
- Les colonnes en clair actuelles migrent ici (double lecture d'abord). L'assistant et les modèles n'y ont jamais accès.

### E — Le moteur d'enrichissement (chaque upload nourrit les fiches)
1. **Dépôt** — tout upload (Drive, conversation, e-mail, portail, poste) émet `PieceDeposee`.
2. **Classement** — la nature de la pièce est reconnue (règles, puis modèle si la Direction l'a ouvert ; pièces
   d'identité et de paie : **local seulement**).
3. **Extraction** — par nature, avec les lecteurs qui existent déjà : passeport → MRZ locale ; devis / facture →
   lecture des pièces ; registre de commerce → identifiants ; CV → parcours ; carte de visite → coordonnées ;
   contrat → parties et échéances ; programme de congrès → organisateur et dates.
4. **Faits proposés** — `FaitPropose` : sujet, attribut (catalogue `Attribut`), valeur, valeur normalisée, confiance,
   preuve (page, extrait), sensibilité.
5. **Décision** — confirmé d'office si l'attribut l'autorise, que la confiance dépasse le seuil et qu'il n'y a pas de
   conflit ; sinon file « À confirmer » de la personne responsable de la fiche. Un fait sensible va au coffre.
6. **Fiche** — `FaitConfirme` garde l'historique (source, confirmé par, valide du / au) et met à jour les colonnes de
   la fiche. Un désaccord crée un `ConflitDeFait`, jamais un écrasement.

**Exemples concrets.** Le passeport du Dr Benali, déposé sur un poste billetterie : nom, prénoms et nationalité
complètent sa fiche Personne ; le numéro et l'expiration vont au coffre ; la pièce apparaît sur sa fiche, sur le
poste et sur la demande. Un devis de l'Imprimerie du Centre : NIF, RC, adresse et téléphone complètent la fiche
de l'organisation ; les prix unitaires alimentent l'historique d'achat par produit.

## 4. Plan de migration — additif, réversible, par paliers

| Palier | Contenu | Production |
|---|---|---|
| P0 Fondations | Schéma découpé en fichiers par module (`prismaSchemaFolder`, étudié) ; contrôle de dérive `prisma migrate diff` dans les tests (fait) ; lint, typecheck et build **avant** `migrate deploy` sur Render (fait) — voir [`refonte-p0-outillage.md`](refonte-p0-outillage.md) | Aucun changement de données |
| P1 Référentiels | Tables R1-R6 créées vides ; colonnes de lien nullables ajoutées | Additif |
| P2 Reprise | Remplissage idempotent depuis l'existant (identifiants déterministes) ; doublons **proposés** (par NIF, RC, e-mail, nom + wilaya), jamais fusionnés d'office | Additif |
| P3 Double écriture | Les actions écrivent le référentiel ET les colonnes historiques ; les lectures basculent écran par écran | Additif |
| P4 Enrichissement | Moteur E sur les nouveaux uploads (nature par nature), puis rattrapage des pièces existantes par lots, coût plafonné | Additif |
| P5 Coffre | Données sensibles copiées au coffre, lues de là ; **effacer les colonnes en clair = accord explicite** | Destructif → accord |
| P6 Retrait | Colonnes texte historiques retirées après N semaines sans lecture | Destructif → accord |

Chaque palier : tests, mesure, interrupteur pour revenir en arrière.

## 5. Système — vers un monolithe modulaire

**Aujourd'hui** : des domaines déclarés dans `src/platform/domains.ts` mais des cliquets dépassés, 186 fichiers d'actions dans un
même dossier, un schéma unique, les tâches de fond dans le processus web (battement `setInterval`).

**Proposition**
1. **Un module = un dossier** `src/modules/<module>/` : `api.ts` (seule porte : requêtes, commandes, types),
   `domaine/`, `infra/`, `ecrans/`. Le module possède ses tables (`prisma/schema/<module>.prisma`), ses actions,
   ses événements.
2. **Entre modules** : par `api.ts` ou par événement (registre `BusinessEvent` → événements typés avec *outbox*).
   Jamais d'import profond — règle ESLint et cliquet à zéro pour chaque module découpé.
3. **Le socle** = les référentiels (personnes, organisations, lieux, produits, pièces, coffre) : tout le monde le lit,
   lui ne lit personne.
4. **Un worker séparé** sur Render (même code, autre point d'entrée) pour l'extraction, les routines, les missions :
   le web reste réactif, un passage lourd ne bloque plus une page.
5. **Fiches 360°** en modèles de lecture (projections mises à jour par événements) plutôt qu'en jointures à
   la volée.
6. **Défense en profondeur multi-société** : Row Level Security Postgres sur les tables portant `companyId`, en plus
   de `companyScopedWhere`.
7. **Ordre de découpe** : socle → pièces et enrichissement → Ad & Pro → Finances / BC → RH → Regulatory → Adam.

## 6. Décisions attendues de la Direction

1. Valider le modèle cible (R1-R6 + moteur E).
2. Fusion de deux fiches : qui tranche (proposition : responsable du module + Super Admin).
3. Confirmation d'office d'un fait extrait : jamais pour un identifiant ou une donnée sensible ; seuil 0,9 pour
   adresse et téléphone lus sur une pièce officielle ?
4. Coffre : qui lit quoi (RH : salaires, NIN ; Finances : RIB, IBAN).
5. Worker séparé sur Render (un service de plus).
6. Feu vert pour P0 + P1 (aucune donnée modifiée).
