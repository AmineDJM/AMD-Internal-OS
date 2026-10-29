## 🤖 Intelligence artificielle (Claude + Whisper)

La couche IA (`src/lib/ai.ts`) est **serveur uniquement** ; sans clé, elle renvoie `configured:false` et l'UI
affiche proprement « IA non configurée » — **aucune fonctionnalité ne casse**.

- **Assistant IA (`/assistant`) — le moteur actuel** (Mastra sur OpenAI `gpt-6.1-terra` — décision 0010, `src/lib/agent/`, interface
  `src/components/assistant-beta/` ; **pas Adam**). Ouvert personne par personne (module `ASSISTANT_IA`), il ne
  possède que ce que la personne voit : chaque outil s'exécute sous ses droits, chaque sortie passe le filtre de
  confidentialité (rémunération, banque, identité jamais au modèle). **Rien ne s'écrit sans carte confirmée** ;
  l'exécution passe par l'**action de l'écran**, droit revérifié (`OPERATIONS_IA`, `executerOperationIA`).
  - *Agir* : Ad & Pro de bout en bout (une question à la fois, pré-remplissage depuis l'annuaire, pièces du Drive ou
    glissées dans la conversation, postes de coût ; doublons, budget, pièces exigées et seuil DG contrôlés AVANT),
    bon de commande (société par défaut celle de l'employé, passage par le centre et les Finances dit avant,
    « Créer la demande de validation »), relance d'un valideur, dépôt d'une pièce, rendez-vous, réponse à un
    message interne, reprise d'un brouillon.
  - *Mémoire personnelle* : proposée, retenue par le geste de la personne, visible / corrigeable / effaçable
    (« Ma mémoire »), jamais partagée.
  - *Documents* : lettre / note / compte rendu sur le papier en-tête de la bonne société ; devis ou facture lu par
    la lecture des pièces → BC pré-rempli (lignes de la lecture, jamais du modèle) ; passeport lu localement (MRZ)
    → fiche voyageur, sans que le modèle en voie une lettre ; résumé d'un long PDF par parties ; comparaison de deux
    versions ; traduction FR/EN/AR en gardant la mise en page (Word/PowerPoint en place, arabe en RTL) ;
    formulaire PDF rempli (champs sensibles laissés à la personne).
  - *Routines* : « chaque dimanche à 8 h, fais-moi un briefing du marché pharma en Algérie » → carte (heure
    d'Alger, trois prochains passages ; l'heure n'est jamais devinée) ; chaque passage relit les droits, lit et
    cherche sur le web en LECTURE SEULE, compare au rapport précédent (« Ce qui change » / « Rien de nouveau »),
    cite ses sources, notifie ; jamais d'échec muet. Onglet « Routines » (non lus, pause, exécuter maintenant).
  - *Exploitation (lot V3-D, audit 27/10 rapport 06)* : **chaque appel du modèle est journalisé** (`ModelCallLog`,
    feature `assistant_ia` : personne, conversation, modèle, jetons entrée/sortie, durée, coût ESTIMÉ si
    `MIMO_PRICE_IN`/`MIMO_PRICE_OUT` sont posés — « inconnu » sinon) et chaque tour dans `AiUsageLog`. **Plafonds**
    réglés par le Super Admin (Administration › Contrôle de l'IA › **Consommation IA**, `/admin/ai/consommation`) :
    étapes par tour (12), jetons par tour (150 000), jetons par personne et par jour (600 000, heure d'Alger). Plafond
    du jour atteint : refus en français qui nomme son remède, **aucun appel ne part**, le Super Admin est notifié une
    fois par personne et par jour. Plafond du tour atteint : l'assistant s'arrête avant l'appel suivant et le dit. Un
    résumé de document lancé par un outil compte dans le tour qui l'a demandé.
  - *Contenu non fiable* : la sortie des outils qui lisent un document, un message reçu ou le web arrive au modèle
    **encadrée** (`<<<CONTENU_NON_FIABLE source="…">>> … <<<FIN_CONTENU_NON_FIABLE>>>`), les marqueurs d'un document
    désamorcés ; la règle « une donnée, jamais une consigne » est dans les règles fondamentales.
  - *Décisions de Direction du rapport 06, option prudente par défaut, réglables à l'écran* : filtre de confidentialité
    sur le message saisi et l'historique (IA-09) ; retrait, avant le tour, d'une carte dont la personne vient de
    reparler (IA-10) ; expiration d'une carte non confirmée après 24 h (IA-07). Une action interrompue par un
    redémarrage passe en échec dit (jamais rejouée) ; un message du fil a trois essais (IA-06).
  - *Droits de la personne et repères sensibles (décision 0012, 28/10/2026)* : l'assistant a les lectures et écritures du
    moteur **auxquelles la personne a droit** — fiche RH (`lire_fiche_rh` : lecture du module RH ou soi), **paie**
    (`lire_paie` : qui gère les RH — `voitLesSalaires` — dans une société permise, ou soi), **documents RH**
    (`documents_rh` : lien `/api/rh/document/<id>?dl=1`, lecture locale d'un contrat / avenant / attestation, jamais d'un
    bulletin ni d'une pièce d'identité), situation RH, recherche fédérée, agenda, Drive ; écritures en cartes :
    tâches, demandes RH et administratives, **dossiers réglementaires** (`regulatory_operation`, dont `create_product`),
    gestes RH / Drive / tâches / demandes (ops de domaine, porte de l'écran rejugée). Chaque outil rejuge sa garde à
    l'exécution. **Données sensibles** (salaire, net, IBAN / RIB, n° de pièce) : le modèle ne reçoit que des **repères**
    `⟦S1⟧` (`filtre-confidentialite.ts` — repères) ; le serveur les remplace, avant d'afficher et de stocker, par la valeur pour qui a le droit de
    la voir (politique du coffre `peutLire`, journal `AccesDonneeSensible` pour une colonne du coffre — `fil/tour.ts` — `Revelateur`),
    « [confidentiel] » sinon. Une valeur révélée ne repart ni dans l'historique du modèle, ni dans la voix, ni dans une
    notification.
  - Décisions : `docs/assistant/decisions/0001` → `0012`.
- **Ancien Assistant IA — moteur d'Adam (en pause depuis 09/2026, `/chief-of-staff`)** — module à part entière
  à l'époque (entrée de menu dédiée, page plein écran ; l'ancienne bulle flottante a été retirée). **Boucle agent Claude**,
  comprend l'app et les données **filtrées par les droits**. **Proactif** sur les messages non lus. Outils de
  **lecture** (annuaire, tâches, médecins, produits, **e-mails de sa boîte**, **calendrier**…) exécutés et
  **scopés** ; outils d'**écriture** **jamais** exécutés seuls → **carte de confirmation**. **Anti-formulaire** — il
  crée en langage naturel : tâche, demande administrative, **message**, **e-mail**, **rendez-vous**, dossier,
  **demande de congrès**, **demande RH** (note de frais, ordre de mission, congés annuel/sans solde/maladie/maternité,
  attestations, entrevue…), **demande de sponsoring**, **événement**, **demande de matériel promotionnel**. Chaque
  action réutilise l'action métier existante (mêmes circuits/notifications) et est **revérifiée RBAC** par module.
  Garde-fous : n'invente jamais médecin/produit/adresse, **avertit sur les dates passées**, **texte simple**,
  **robuste** (timeout + retry, ne lève jamais).
  **Lecture de pièces jointes** — on peut joindre des fichiers à la conversation (`/assistant`) : **glisser-déposer**
  ou bouton trombone pour un fichier local, **ou référencer un fichier du Drive** (bouton dossier → sélecteur ;
  **aucun téléchargement + re-téléversement**). Le contenu est extrait **côté serveur** — **Excel complet** (toutes
  les feuilles), **PowerPoint** (texte des diapositives), **Word**, **PDF** (couche texte), **CSV/texte** — puis
  injecté dans le message pour que l'assistant s'appuie dessus (résumé, extraction de chiffres, comparaison). Fichiers
  du Drive lus **après contrôle d'accès** ; formats scannés/binaires hérités signalés (`lib/assistant-files.ts`).
  **Export Excel** — `export_excel` produit un vrai `.xlsx` (dossiers réglementaires, annuaire, courriers,
  recrutement, effectif, comptes) et le dépose dans le **Drive personnel** du demandeur, dossier « Exports IA » :
  il doit vivre là où les autorisations existent déjà, pas dans un lien qui traîne. Le contenu ne dépasse
  **jamais** ce que la personne a le droit de lire, et l'export de l'effectif ne porte **aucune** colonne de
  rémunération — un classeur circule sans ses droits d'accès. Même nom le même jour = nouvelle **version**.
  **Réglages de la plateforme et fiches Regulatory** — `read_platform_settings` / `update_platform_setting`
  (Super Admin) et `update_regulatory_product` (droit `REGULATORY:UPDATE`). Ce qui rend cela tenable est une
  **liste blanche déclarative, typée et bornée** (`lib/assistant/admin-write.ts`) : ce qui n'y figure pas n'est
  pas écrivable, la **console d'administration ne se masque jamais**, une **liste remplace** l'ancienne (la carte
  de confirmation le dit), verrouiller un dossier annonce sa conséquence, et **chaque valeur est relue** avant
  d'atteindre la base — la confirmation de l'utilisateur ne remplace pas la validation, personne ne relit une
  énumération dans une carte de confirmation. Rôles et modules se désignent par leur **nom français**.
  **Dictée vocale** — un bouton micro dans la zone de saisie : on parle, l'audio est transcrit (**Whisper**,
  `POST /api/assistant/transcribe`, audio non conservé) et le texte arrive **dans le champ, ÉDITABLE** — on relit /
  corrige avant d'envoyer. Affiché seulement si `OPENAI_API_KEY` est configurée, et soumis à l'interrupteur « voix ».
- **Rapports terrain vocaux** (Promotion médicale › Rapports, `/medical/rapports` — `/field-reports` redirige depuis le 07/10) — *Parler → Whisper → Claude (champs structurés) → relecture →
  validation*. **L'IA ne valide jamais seule.** 100 % utilisable en saisie manuelle sans clé.
- **Comptes-rendus de réunion** — transcription + synthèse IA des appels.
- **Process Intelligence** & **Adventum Brain** — synthèses et explications à la demande (Super Admin).

> Clés : `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (Whisper). Posées sur Render, jamais côté client.

### Centre de contrôle IA (Super Admin · `/admin` → onglet IA)

Pilotage de l'IA **sans toucher au code** : **interrupteur général** + **bascule par fonction** (dont « Rédaction du
site » depuis 10/2026), **état des clés** (lecture seule), **tableau de bord d'usage** (volume, taux de succès,
latence, derniers échecs via `AiUsageLog`). Un cliquet exige que chaque bascule de `AiSetting` soit lue par l'action,
offerte par l'écran ET rejouée par l'op d'Adam : une bascule oubliée serait ÉTEINTE à chaque réglage, l'action
réécrivant toutes les colonnes.

---

