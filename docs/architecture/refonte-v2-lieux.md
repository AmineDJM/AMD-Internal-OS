# Refonte des données — vague 2, lot V2-D « Lieux et coordonnées »

> 27/10/2026 · branche `refonte/v2-lieux`. Cadre : [`refonte-vague-2.md`](refonte-vague-2.md) (règles communes),
> [`refonte-donnees-et-monolithe-modulaire.md`](refonte-donnees-et-monolithe-modulaire.md) §3 R3.
> Livrable vérifiable : **« Par wilaya » se compte sans nettoyage manuel.**

## 1. Ce qui est livré

| Pièce | Où | Ce qu'elle fait |
|---|---|---|
| Wilayas | migration vague 1 `20270130110000_lieux_reference` | **Vérifié** : 69 lignes (01 à 69), sources JO citées dans la migration (loi n° 26-06, décret 26-206). Rien à recharger. |
| Communes | même migration | Table **vide**, laissée vide : aucune source officielle complète (1 541 communes, codes, rattachements 2026) n'a été chargée. Aucune adresse ne cite de commune (FK posée : impossible d'en inventer une). |
| Colonnes `wilayaCode` | migration `20270131170000_lieux_wilaya_code` | Nullables, FK → `Wilaya` (`ON DELETE SET NULL`), indexées, sur `MedicalDoctor`, `MedicalInstitution`, `CompanyContact`, `Supplier`, `SalesSector`. FK `Adresse.wilayaCode` → `Wilaya`, `Adresse.communeCode` → `Commune`. `AppSetting.lieuxDoubleEcriture` (vrai par défaut). Additive, idempotente (rejouée ×2 sans erreur). |
| La règle | `src/lib/lieux/rattachement.ts` (pur) | Quelles colonnes lire par modèle (`COLONNES_LIEU`), `rattacherFiche` : la colonne wilaya prime, la ville puis la région parlent si elle est vide ; ambigu → `null` + raison ; pays étranger → pas de wilaya. Une seule règle pour la reprise ET la double écriture. |
| L'accès base | `src/lib/lieux/rattachement-prisma.ts` | Lecture par lots, écriture **sans toucher `updatedAt`** (SQL à identifiants constants), interrupteur, `reposerWilayaCode(modele, ids)` (double écriture **non bloquante**, P3 §5.1). |
| Reprise `lieux-wilaya` | `src/lib/referentiels/reprises/lieux-wilaya.ts` | Pose le code de chaque fiche ; liste les cas ambigus ; remet à nul un code que le texte ne justifie plus ; rejouable (le code suit le texte). |
| Reprise `adresses` | `src/lib/referentiels/reprises/adresses.ts` | `Adresse` depuis `MedicalDoctor`, `Employee` (domicile), `MedicalInstitution`, `CompanyContact`, `Supplier`, `CompanyLegalIdentity.headOffice` — pour les seules fiches **déjà** rattachées à une Personne / Organisation. |
| Reprise `points-de-contact` | `src/lib/referentiels/reprises/points-de-contact.ts` | `PointDeContact` (E.164, e-mail en minuscules, hôte du site) depuis dix sources, dont `DirectoryEndpoint`. Valeurs illisibles listées, jamais reprises. Aucun « principal » posé. |
| Traduction fiche → R3 | `src/lib/referentiels/coordonnees.ts` (pur) | Candidats et **clés** (titulaire + nature + valeur normalisée) → identifiants déterministes `adr_…` / `pdc_…` (SHA-256) : une ligne par chose réelle, quel que soit le nombre de sources ou de passages. |
| Contrat commun | `src/lib/referentiels/reprises/{types,index,curseur,par-sources,pagination}.ts` | Le type `Reprise` / `BilanReprise` du contrat ; curseur multi-sources `"<Table>:<id>"`. |
| Écran | `/admin/refonte-donnees` (Super Admin) | Une carte par reprise (aperçu à blanc, lot de 500, journal relu d'`AuditLog`, reprise au dernier curseur) + l'interrupteur de la double écriture. |
| Actions | `refonte-reprise-actions.ts` (`apercuReprise`, `executerReprise`), `lieux-actions.ts` (`reglerDoubleEcritureLieux`) | Super Admin seul, audit (module « Refonte des données », champ = clé), `revalidatePath`. Classées EXCLUDED dans `action-registry.ts`. |
| Double écriture | les écrivains | `createInstitution`, `updateInstitution`, `createDoctor`, `updateDoctor`, `addDirectoryDoctor`, `saveDirectoryCell`, `importDirectorySheet`, `createCompanyContact`, `updateCompanyContact`, `creerFournisseurAnnuaire`, `modifierFournisseurAnnuaire`, `createSupplier`, `createRegulatorySupplier`, enregistrement d'un secteur et wilaya pivot d'un KAM (`sales-planning-actions.ts`), imports de segmentation (`segmentation/service.ts`, `import-direction.ts`). |
| Garde | `src/lib/lieux/double-ecriture-garde.test.ts` | Tout fichier qui écrit une des cinq fiches appelle `reposerWilayaCode` ou figure dans une liste d'exceptions **motivées** (qui ne nomment aucune colonne de lieu). |
| Lecture « par wilaya » | `/annuaires/etablissements` | Bandeau « Par wilaya » : `groupBy wilayaCode` des établissements actifs, la part « sans wilaya reconnue » dite à côté (`lib/lieux/par-wilaya.ts`, pur, option découpage 58). |

## 2. L'activer en production (gestes du Super Admin)

1. Déployer : la migration ajoute les colonnes, vides. Rien d'autre ne change ; la double écriture est allumée.
2. Administration › **Refonte des données** › « Lieux — rattacher chaque fiche à sa wilaya » : **Aperçu à blanc**,
   lire les cas ambigus ; puis **Exécuter un lot** jusqu'à « Reprise terminée ». Corriger les fiches listées (la
   double écriture pose le code à l'enregistrement).
3. **Après** les reprises des personnes (V2-B) et des organisations (V2-C) : « Coordonnées — adresses » puis
   « téléphones, e-mails et sites », aperçu puis lots. À relancer à chaque nouveau passage V2-B / V2-C : seules les
   lignes manquantes sont créées.
4. Repli : « Éteindre » la double écriture (le texte reste écrit ; une reprise remet les codes en accord).

## 3. Ce qui reste

- **Communes** : charger une source officielle complète (ONS / ministère de l'Intérieur, avec les rattachements de la
  loi 26-06) ; alors `normaliserCommune` rattache la ville et `Adresse.communeCode` se remplit.
- **Double écriture des coordonnées** (Adresse / PointDeContact à chaque saisie de téléphone, d'adresse) : non faite —
  elle suppose que l'écrivain connaisse la Personne / Organisation de la fiche, ce que posent les crochets
  `assurerPersonne` / `assurerOrganisation` des lots V2-B / V2-C. La reprise, rejouable, rattrape en attendant.
- **Lectures** : un seul écran lit `wilayaCode` (établissements). À basculer ensuite : feuille des praticiens (filtre
  wilaya), IN / OUT de la segmentation (`segmentation/in-out.ts` compare encore des textes), fournisseurs.
- `StockCountRequestHospital.wilaya` (copie figée) et les lieux d'événements (`Event`, `CongressNational`,
  `SponsoringRequest.city`…) ne sont pas rattachés : ce sont des lieux d'événement, pas de fiche.
- Les listes de l'application (`ALGERIA_WILAYAS`, `canonicalWilaya`) ne connaissent que **58** wilayas : saisir
  « Bou Saâda » au formulaire reste impossible jusqu'au passage à 69 (à décider, cf. §4).

## 4. Décisions à prendre

1. **Découpage des formulaires** : passer les menus de 58 à 69 wilayas au 1er janvier 2027 (entrée en fonction des
   nouvelles) ou dès maintenant ? Le code (`wilayaCode`) suit déjà la loi 26-06 ; les comptages peuvent ramener à 58.
2. **Coordonnées principales** : qui désigne le téléphone / l'adresse principale d'une Personne (la fiche d'origine,
   la plus récente, un humain) ? Aujourd'hui : aucune n'est marquée.
3. **Adresses à l'étranger** : faut-il un référentiel pays (texte libre → ISO 3166) pour reprendre les adresses des
   fournisseurs étrangers, aujourd'hui listées et non reprises ?
4. **Domicile des collaborateurs** : l'adresse personnelle (`Employee.address`) est reprise en `DOMICILE`. Faut-il la
   traiter comme donnée sensible (coffre, V2-E) plutôt qu'en clair dans R3 ?
