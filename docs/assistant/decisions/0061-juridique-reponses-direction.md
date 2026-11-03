# 0061 — Juridique : les réponses de la Direction du 03/11 (partenaire manquant, natures du registre, dossier vide à l'annulation) — lot T1

Suite de la décision [0053](0053-documents-juridique-drive.md) (§ 6, « décisions Direction à prendre »).

## 1. Le partenaire manquant — le directeur administratif et financier

**Direction (03/11)** : « Oui, l'équipe juridique peut créer un partenaire manquant, mais il n'y a pas d'équipe juridique
aujourd'hui, donc c'est le directeur administratif et financier. »

- **Le rôle de l'ERP qui porte le DAF** : il n'existe aucun rôle « DAF ». Le plus proche est `FINANCE_BUDGET_MANAGER`
  (« Responsable Finance / Budget » ; le cockpit du DAF a rejoint la Comptabilité). Aucun rôle n'est créé.
- **Le droit qui l'ouvre** : ce rôle tient par défaut les **Moyens généraux** (`GENERAL_MEANS: MANAGE`,
  `rbac/permissions.ts`), qui écrivent l'annuaire des partenaires (`annuaires/acces.ts`). Le geste `ranger_au_juridique`
  ajoute donc le partenaire manquant pour lui, par l'action de l'écran (`createCompanyContact`), sans porte nouvelle ni
  droit élargi. Pour **ranger** au Juridique, le DAF doit avoir le module Juridique (création) dans la console d'accès : ce
  droit n'est pas dans les défauts de son rôle. **À poser par le Super Admin** (le banc le pose, comme la console).
- **Les autres** (la juriste, l'assistante, tout rôle sans l'annuaire des partenaires) : **refus propre**, dit sur la carte
  (« c'est le directeur administratif et financier (ou les Moyens généraux) qui ajoute un partenaire manquant… rien n'a été
  rangé »). Rien n'est créé.
- **Le nom développé** d'une partie (« ANPP — Agence nationale des produits pharmaceutiques ») désigne la fiche « ANPP » de
  l'annuaire : un partenaire existant n'est jamais déclaré manquant pour une variante de son nom (mesuré, DOC-02).

## 2. Les nouvelles natures du registre

**Direction** : « Oui, on pourrait ajouter d'autres documents juridiques comme les agréments, etc. »

`LegalDocKind` reçoit **`APPROVAL`** (agrément), **`MARKETING_AUTHORIZATION`** (AMM, décision d'enregistrement),
**`STATUTES`** (statuts), **`MINUTES`** (procès-verbal) — migration additive et idempotente
`20270223100000_t1_natures_juridiques` (`ALTER TYPE … ADD VALUE IF NOT EXISTS`). Créables au formulaire et **filtrables**
à l'écran Juridique (`LEGAL_DOC_KIND`, `lib/labels/juridique.ts` ; `KINDS`, `actions/internes/legal/regles.ts`), reconnues
au rangement (`domaine/juridique/classement.ts` : agrément et licence deviennent deux familles, rangées dans le même
dossier « Agréments et autorisations »), lisibles et filtrables par l'assistant (`registre_juridique`, nature « AMM »…).

## 3. Annuler un rangement retire le dossier vide qu'il avait créé

**Direction** : « Un dossier vide est supprimé quand on annule un rangement. »

Le moteur d'annulation K10 (`lib/effets/annulation.ts`, `defaireCreation`) : un **dossier de classement juridique**
(`LegalFolder`) **créé par le geste**, qui ne contient plus que les pièces annulées par ce même geste et **aucun
sous-dossier**, est **retiré** ; ses pièces annulées passent « non classées » (elles restent, comme la trace K10b). Un dossier
qui contient une autre pièce, ou qui **existait avant** le geste (il n'est pas une création du geste), n'est **jamais**
touché. Le rangement ne crée pas de dossier du Drive (les fichiers restent où ils sont) : la règle porte sur les dossiers du
Juridique, les seuls qu'il crée.

## 4. Sans réponse

« Un lecteur du registre juridique ouvre-t-il aussi le fichier du Drive ? » — comportement actuel gardé (le lien n'est remis
que si le Drive l'ouvre), question reposée à la Direction.

## 5. Preuves

- Exécuté puis annulé contre la base locale (`documents-t1.test.ts`) : le DAF range un contrat et ajoute « Medilog
  Services » ; la juriste reçoit le refus qui nomme le DAF, aucun contact ne naît ; agrément et AMM rangés et filtrés ; le
  nom développé de l'ANPP ; l'annulation d'un lot retire les trois dossiers qu'il avait créés et garde « Contrats », qui
  existait.
- Banc DOC- : 4 tâches nouvelles (DOC-37 le DAF et le partenaire, DOC-38 le refus de la juriste, DOC-39 l'agrément, DOC-40 le
  filtre des AMM) et 4 tâches revues pour les nouvelles natures (DOC-02, 03, 04, 08). Rejeu réel (passages 7 et 8, 0,24 $) :
  **8 / 8 réussies**.
