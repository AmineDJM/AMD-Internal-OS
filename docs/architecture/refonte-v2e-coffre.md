# Refonte des données — V2-E : le coffre en double lecture

> 27/10/2026. Cadre : [`refonte-vague-2.md`](refonte-vague-2.md) (règles communes),
> [`refonte-p3-inventaire.md`](refonte-p3-inventaire.md) §3 (colonnes sensibles), §5 (point d'accroche), §6 (rang P5).
> Branche `refonte/v2-coffre`. **Rien n'est effacé** : les colonnes en clair restent et restent écrites ; les effacer
> est le palier P5 (§7, accord exprès de la Direction).

## 1. Ce qui est livré

| Pièce | Où | Rôle |
|---|---|---|
| Migration additive | `prisma/migrations/20270131170000_coffre_double_lecture` | `DonneeSensible` : origine de la copie (`origineModele/Id/Champ`), `remplaceeLe`, `cleId`, titulaire facultatif (au moins titulaire OU origine — `CHECK`), **une seule copie courante par colonne** (unicité partielle). `AccesDonneeSensible` : origine, `autorise` (les refus se journalisent), `lecteurNom` (modèle d'IA refusé), `userId` facultatif. `AppSetting.coffreEcriture` / `coffreLecture`, **fermés**. |
| Catalogue | `src/lib/coffre/champs.ts` (pur) | Les 9 colonnes copiées : `Employee.iban` (IBAN ou RIB), `nationalId` (NIN), `baseSalary`, `grossSalary`, `netToPay`, `employerCost` (SALAIRE) ; `CompanyContact.rib` (le RIB des partenaires et fournisseurs de l'annuaire) ; `CompanyLegalIdentity.rib`, `iban`. Classement validé (clé mod-97, clé RIB), masque, « écrire sans lire » (`champsNonSaisis`, `masquerSensibles`). |
| Chemin d'écriture | `copies.ts`, `ecriture.ts` | Copie chiffrée d'une colonne : CREEE / REMPLACEE (l'ancienne datée) / INCHANGEE / LIEE (titulaire posé) / EFFACEE / IGNOREE (mal formée, la colonne reste seule). Ne déchiffre jamais. |
| Contrôle d'accès | `acces.ts` | Politique + **journal d'abord** + comparaison de la copie à la colonne par empreinte HMAC ; `controlerRibDePiece` (RIB reconnu par empreinte au goulot de la fabrique de pièces). Ne déchiffre jamais. |
| Double lecture | `lecture.ts` | `acces.ts` + déchiffrement de la copie à jour. Pour les **écrans** (pages serveur). |
| Déchiffrement isolé | `dechiffrement.ts` | Seul module qui rend une valeur en clair ; jamais atteint par l'assistant (`frontiere.test.ts`). |
| Dépôt Prisma réel | `depot-prisma.ts` | Le dépôt « par titulaire » du service (moteur d'enrichissement V2-A) aligné sur les vraies colonnes (`decomposer`/`recomposer` du chiffré `c1.<clé>.<…>`). |
| Reprise | `src/lib/referentiels/reprises/coffre.ts` | Contrat commun (`types.ts`, `index.ts`) : aperçu à blanc, lots de 100, curseur `Employee:<id>` → `CompanyContact:<id>` → `CompanyLegalIdentity:<id>`, rejouable, rattache aux fiches Personne / Organisation après V2-B / V2-C. |
| Actions | `refonte-reprise-actions.ts` (`apercuReprise`, `executerReprise`), `coffre-actions.ts` (`basculerCoffre`) | Super Admin seul, auditées (module « Refonte des données »). Classées EXCLUDED au registre de l'assistant. |
| Écrans | `/admin/refonte-donnees`, `/admin/acces-donnees-sensibles` | Cartes de reprise (aperçu, lot, jusqu'au bout, journal), interrupteurs, couverture colonne par colonne ; journal des accès filtrable (lecteur, fiche, nature, décision, période). |

## 2. Politique de lecture (`politique.ts`, décisions de la Direction)

| Lecteur | Lit |
|---|---|
| Modèle d'IA (assistant, agent, enrichissement) | **Jamais**, quelle que soit la nature ou l'usage — refus journalisé à son nom. |
| Super Admin | Tout, journalisé. |
| La personne elle-même | Les siennes (compte lié à la fiche salarié). |
| RH (`voitLesSalaires` : modifier ou valider le module RH) | Salaires, NIN, pièces d'identité. |
| Finances (modifier le module) | RIB, IBAN. |
| Pièce officielle (BC, devis, facture, ordre de virement) | Le RIB / IBAN d'une **organisation**, au nom de qui génère la pièce ; jamais une donnée de personne. |

Conséquence voulue : un RH sans droit Finances voit l'IBAN d'un salarié **masqué** (« •••• 1234 ») ; il peut le
**remplacer** sans le lire (le masque renvoyé garde la valeur ; une saisie la remplace).

## 3. Double écriture — où elle est accrochée

`createEmployee` (RH et Finances), `updateEmployee`, `onboardRecruitment` (**même transaction**), `update_salary` de
l'assistant (par le port `@/platform/in-process/capacites` — aucun import Adam → ERP de plus), `createCompanyContact`,
`updateCompanyContact`, `saveCompanyIdentity`. Sans transaction de l'écrivain, la copie a la sienne et un échec est
journalisé sans bloquer (la reprise rattrape) — inventaire §5.1. Garde : `garde-ecrivains.test.ts` (tout écrivain d'une
colonne sensible appelle `doubleEcrireCoffre`, ou figure dans une exception motivée).

## 4. Double lecture — qui lit par le coffre

| Lecteur | Mode |
|---|---|
| `/rh/[id]` (formulaire, salaire, NIN) | `lireSensiblesPour`, geste « Fiche employé — consultation » ; refusé → champ masqué en lecture seule, non envoyé. |
| `/rh/equipe` (colonne salaire) | idem, « Équipe — liste des salaires » ; rien lu quand la colonne est masquée. |
| `/rh/paie` (préremplissage) | idem, « Paie — préremplissage des salaires ». |
| `/legal/identites` (RIB / IBAN des sociétés) | idem, « Identités légales — consultation ». |
| `/mon-espace/annuaire` (RIB des partenaires) | **masque seulement** (rien lu, rien journalisé) ; le RIB se lit là où il sert. |
| BC, devis, factures, avoirs, révisions (`platform/in-process/artifact/factory.ts`) | `controlerRibDePiece` : RIB de la société et RIB du tiers reconnus au coffre par empreinte, politique « pièce officielle », journal ; un refus → la pièce imprime le masque. |
| API v1 | Ne rend **jamais** ces colonnes (`api/query.ts`, éprouvé contre le catalogue par `ia-jamais.test.ts`). Une machine n'est pas un lecteur du coffre. |
| Assistant | Propositions d'ops (`update_employee*`, `update_company_contact`) **masquées** ; bac à sable SQL : salaires masqués en plus d'IBAN/RIB/NIN ; filtre de confidentialité : `netToPay`, `employerCost` ajoutés. |
| Exports CSV / Excel | Aucun export ne sort ces colonnes aujourd'hui (vérifié) ; la grille Équipe n'emporte le salaire que lu par le coffre. |

**Pendant la double lecture, la colonne fait foi** : la copie lui est comparée par empreinte ; à jour, elle est déchiffrée
(écrans) ; absente ou divergente (écriture double fermée à ce moment-là), la colonne est lue et l'écart signalé dans les
journaux serveur, sans valeur. Rejouer la reprise résorbe l'écart.

## 5. Activer en production — gestes du Super Admin

1. **Poser `COFFRE_KEY`** sur Render (32 octets aléatoires, hexadécimal :
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), différente de `DRIVE_ENCRYPTION_KEY`,
   **sauvegardée hors de Render** (sans elle, le coffre est illisible). Redéployer.
2. `Administration › Refonte des données` → carte « Coffre » → **Ouvrir la double écriture** (refusé sans clé).
3. **Aperçu à blanc** : lire le bilan (copies à créer, valeurs mal formées listées par fiche et colonne).
4. **Jusqu'au bout** (lots de 100, arrêt possible, reprise où l'on s'est arrêté). Corriger sur leur fiche les valeurs
   signalées, rejouer. La table de couverture doit montrer « copiées = en clair » (aux valeurs mal formées près).
5. **Ouvrir la double lecture** (refusé si l'écriture double est fermée).
6. Suivre `Administration › Accès aux données sensibles`.
7. Après les reprises Personnes (V2-B) et Organisations (V2-C) : **rejouer la reprise « coffre »** — les copies se
   rattachent à leur fiche (colonne « Rattachées »).

Revenir en arrière : fermer la lecture (les écrans relisent les colonnes), puis l'écriture. Rien n'est perdu.

## 6. Ce qui reste (hors de ce lot)

- **Lectures de salaires agrégées** : masse salariale, budget de campagne, simulations, outils d'Adam (`read_payroll`,
  vue 360°, `what-if`) lisent toujours les colonnes. Adam est en pause (Super Admin seul) ; ses outils de paie devront
  passer par le coffre — ou être retirés — avant tout effacement des salaires.
- **Hors catalogue** : `Employee.cnasNumber` (pas de nature au coffre), `TreasuryAccount.rib` (compte du groupe),
  `CompanyLegalIdentity.swift`, le RIB lu sur un devis (`AdProDevis.fournisseurLu`, JSON) et le RIB **imprimé** recopié
  dans la spécification d'une pièce émise (`LegalDocument.custom`).
- **Copies orphelines** : une fiche supprimée (corbeille) garde ses copies (restaurée, elle les retrouve). Une purge
  définitive devrait les dater — à décider avec P5.
- **Analyse de contrat par l'IA** (`analyzeEmployeeContract`) : le contrat (NIN, salaire) part au modèle — à faire
  passer au traitement local (règle V2-A « pièces d'identité et de paie : local seulement »).
- **Révéler à la demande** dans l'annuaire (bouton journalisé pour les Finances) : non fait, le masque suffit à l'écran.

## 7. Procédure P5 — effacer le clair (prête, NON appliquée)

Condition : accord écrit de la Direction ; double lecture ouverte depuis plusieurs semaines sans écart signalé.

1. **P5-1 (code, petit lot)** : `controlerLecture` lit la **copie** quand la colonne est vide (aujourd'hui « vide = rien ») ;
   les écrivains cessent d'écrire la colonne en clair (ils n'écrivent plus que le coffre) ; `controlerRibDePiece` reçoit
   l'origine plutôt que la valeur. Tests : une fiche dont la colonne est vide se lit entière par le coffre.
2. Sauvegarde de la base **et** de `COFFRE_KEY`, séparément.
3. Rejouer la reprise « coffre » jusqu'au bout ; couverture « copiées = en clair ».
4. Appliquer [`refonte-v2e-coffre-p5.sql`](refonte-v2e-coffre-p5.sql) comme migration (copiée sous
   `prisma/migrations/<horodatage>_coffre_p5_effacer_clair/`, dans le commit de P5-1). Elle **vérifie** d'abord que chaque
   valeur en clair a sa copie courante et **s'arrête** sinon ; puis vide RIB, IBAN et NIN. Les salaires restent (§6).
   Éprouvée à blanc sur la base locale (refus et passage).
5. Le retrait des colonnes (`DROP COLUMN`) est le palier P6, après N semaines sans lecture.

## 8. Bancs

`src/lib/coffre/` : `champs.test.ts`, `politique.test.ts` (pièce officielle), `chiffrement.test.ts` (colonnes),
`service.test.ts` (dépôt réel), `double-lecture.test.ts` (base locale : copie chiffrée et rejouable, remplacement daté,
rattachement, interrupteurs, journal accord/refus, valeur du coffre vs colonne, pièce officielle, IA refusée, double
écriture en transaction), `ia-jamais.test.ts` (politique, API v1, bac à sable, filtre), `frontiere.test.ts` (l'assistant
n'atteint que ce qui ne déchiffre pas), `garde-ecrivains.test.ts`. `src/lib/referentiels/reprises/coffre.test.ts` (à blanc
sans écriture, lots jusqu'au bout, rejouée sans rien recréer, rattachement après V2-B).

## 9. Décisions à prendre

1. **IBAN des salariés et RH** : la politique réserve l'IBAN aux Finances ; les RH le voient masqué (ils peuvent le
   remplacer). Confirmer, ou ouvrir l'IBAN *des salariés* aux RH.
2. **Pièces générées à la demande de l'assistant** : la pièce imprime le RIB d'une organisation au nom de la personne
   pour qui l'assistant agit (journalisé). Confirmer, ou exiger que ces pièces impriment le masque.
3. **Salaires et P5** : les effacer exige de faire passer les calculs agrégés par le coffre. Proposition : P5 limité à
   RIB / IBAN / NIN ; les salaires restent protégés par le RBAC et la politique d'affichage.
4. **Rétention du journal d'accès** (volume : une ligne par valeur lue) : proposition 5 ans, purge planifiée ensuite.
