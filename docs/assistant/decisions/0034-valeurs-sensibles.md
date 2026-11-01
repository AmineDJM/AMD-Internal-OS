# 0034 — Les valeurs sensibles en clair pour qui a le droit, et rien de conservé chez OpenAI (lot K4, 31/10/2026)

**Décision de la Direction (31/10/2026, mot pour mot)** : « Même pour les chiffres sensibles, l'assistant IA peut les lire
à haute voix ; ils peuvent être envoyés à l'IA, mais fais attention en disant à OpenAI de ne pas s'entraîner sur mes
données. »

Elle amende la partie B de la décision [0012](0012-droits-de-la-personne-et-reperes-sensibles.md) (« les données sensibles montrées à qui a le
droit, jamais envoyées au modèle »). La partie A — **les droits** — ne change pas.

> Code : réglage `src/modules/assistant-ia/domaine/consommation-regles.ts` (`ModeValeursSensibles`, défaut `EN_CLAIR`),
> colonne `AssistantIaReglage.valeursSensibles` (migration additive `20270216130000_assistant_ia_valeurs_sensibles`),
> action `enregistrerValeursSensibles` (`actions-consommation.ts`, Super Admin, audit, EXCLUDED au registre), console
> `/admin/ai/acces` (`acces-form.tsx`, carte « Valeurs sensibles ») ; révélation au modèle `Revelateur.enClair`
> (`infra/role-config.ts`, geste `GESTE_MODELE_EN_CLAIR`), branchée dans le filtre de sortie des outils (`infra/outils-v1.ts`,
> option `revelerAuModele`) par le tour (`infra/fil/tour.ts`) ; consignes `CONSIGNE_EN_CLAIR`
> (`domaine/filtre-confidentialite.ts`) et `REGLE_CONFIDENTIALITE_EN_CLAIR` (`infra/contexte.ts`, règle 2) ; voix
> `consignesVoix`, `NON_OUVERTE` (`domaine/terrain/voix.ts`), `reponsePourVoix(contenu, enClair)` (`infra/voix/temps-reel.ts`),
> réponse vocale et notification du fil (`infra/fil/service.ts`, `retirerBornes`, `horsEcranSansValeur`) ;
> `store: false` dans `optionsFournisseur` (`infra/modele.ts`). Banc : `src/modules/assistant-ia/valeurs-sensibles.test.ts`.

## 1. Le réglage — Administration › Contrôle de l'IA › Assistant IA — accès (`/admin/ai/acces`)

« **Valeurs sensibles** » (salaire, net, coût employeur, masse salariale, IBAN / RIB / CCP, n° de pièce d'identité) :

| Mode | Ce que le modèle reçoit | Voix |
|---|---|---|
| **En clair, pour qui a le droit de les voir** — **défaut** (décision de la Direction) | la valeur, si la personne a le droit de la voir ; « [confidentiel] » sinon | la prononce |
| **Masquées (repères ⟦Sn⟧)** — la décision 0012, intacte | des repères ; le serveur montre la valeur à l'écran à qui a le droit | ne la prononce jamais (« affichée à l'écran ») |

Super Admin seul ; chaque changement à l'audit (`field` « Assistant IA — valeurs sensibles », avant → après). Relu à
chaque tour (`lireReglagesAssistantIa`, sans cache). Le formulaire des bornes (`/admin/ai/consommation`) n'y touche pas.

## 2. Rien ne change aux DROITS

Une personne ne reçoit que ce que le RBAC et la console lui ouvrent déjà. Le mode « en clair » ne retire que le
**masquage vis-à-vis du modèle** pour ce qu'elle a le droit de voir :

- les outils gardent leurs gardes (familles « Salaires & paie » et « Contrats & documents RH » fermées par défaut,
  `voitLesSalaires`, sociétés permises) : **une assistante de direction sans droit RH est toujours refusée** — le modèle
  ne reçoit que le refus ;
- la sortie d'un outil est toujours **jetonnée** d'abord (coffret du tour) ; en clair, chaque repère est ensuite jugé par
  **le même juge que l'affichage** (`peutVoirLaValeur` : politique du coffre, familles, ouverture explicite tracée) et
  remplacé par la valeur, ou « [confidentiel] ». Chaque décision est journalisée (`journaliserLectureHorsColonne`, ou le
  contrôle du coffre pour une colonne quand l'interrupteur `coffreLecture` est ouvert) sous le geste
  « Assistant IA — valeur transmise au modèle (mode en clair) » ;
- la **carte** et la **ressaisie** des actions sensibles (R3/R4) restent : une écriture qui transmet une valeur est une
  carte confirmée à l'écran, jamais un « oui » oral. *(Amendé par [0039](0039-voix-orale.md), lot K9 : la carte se conclut
  à l'oral — résumé dit, relecture de la valeur, « vas-y » jugé par le serveur.)*

## 3. Ce qui suit le mode, ce qui ne le suit pas (décidé)

| Circuit | En clair | Pourquoi |
|---|---|---|
| Sortie des outils de la conversation (texte et délégation vocale) | valeur | le cœur de la décision |
| Règle 2 de la consigne, consigne des données confidentielles | réécrites | le modèle ne doit plus refuser ni chercher des repères |
| Voix temps réel (consignes GPT-Live), réponse vocale d'une réponse écrite | prononcée | « peut les lire à haute voix » |
| Historique renvoyé au tour suivant | la réponse de l'assistant repart telle qu'il l'a écrite ; une valeur **bornée** (révélée à l'écran du temps des repères) reste masquée | ce que le modèle a écrit, il l'a reçu ; une valeur jamais envoyée ne part pas a posteriori |
| Filtre de la SAISIE (`censurerSaisie`) | inchangé, réglage à part | il vise ce que la personne colle (un IBAN dans un e-mail) |
| Notification (cloche, téléphone) | **sans valeur** (motifs et montants retirés) | elle sort de l'écran par des services tiers |
| Résumé roulant, mémoire, titres et extraits de conversations | **masqués, comme avant** | persistants, réinjectés plus tard alors que les droits ont pu changer |
| Routines et travaux en arrière-plan | **masqués, comme avant** (pas de coffret) | personne n'est devant l'écran pour qui juger |
| Recherche web (la question partie au web) | **masquée, comme avant** | elle quitte l'entreprise vers des sites tiers |
| Pièces jointes : OCR, vision, transcription | **leur propre garde, inchangée** : pièces du coffre (passeport, CNI, bulletin, RIB…) et pièces CONFIDENTIELLES refusées sans être lues ; le texte lu passe le filtre | une pièce n'a pas de titulaire établi : aucun juge ne peut dire qui a le droit de voir la valeur qu'elle porte |
| Pièces du dossier RH lues par `documents_rh` | valeur, si la personne a le droit | jetonnées puis jugées comme toute sortie d'outil |

## 4. Aucune conservation chez OpenAI — `store: false`

**Ce que dit OpenAI** — page officielle « Data controls in the OpenAI platform »,
<https://developers.openai.com/api/docs/guides/your-data> (consultée le **31/10/2026** ; l'ancienne adresse
`platform.openai.com/docs/guides/your-data` y redirige) :

- « As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models » (sauf adhésion
  volontaire au partage) — **les données de l'API ne servent pas à l'entraînement, par défaut** ; rien à activer pour cela ;
- « By default, abuse monitoring logs are generated for all API feature usage and retained for up to 30 days » ;
- la Responses API a « a 30 day Application State retention period by default » : une réponse **conservée**
  (`store` vrai, le défaut de l'API) reste au moins 30 jours chez OpenAI ;
- la **Zero Data Retention** (ZDR) « excludes customer content from abuse monitoring logs » ; « these controls are subject
  to prior approval by OpenAI and acceptance of additional requirements » — elle se **demande à OpenAI** (équipe
  commerciale, contrat entreprise). Elle n'est pas activée ici et ce lot ne prétend pas l'avoir.

**Ce que `store: false` ajoute** : la réponse et ses étapes ne sont plus conservées comme « état d'application » (les
30 jours ci-dessus). Il ne supprime PAS les journaux de surveillance des abus (jusqu'à 30 jours) : seule la ZDR le fait.

**Où** : `optionsFournisseur` (`infra/modele.ts`) pose `store: false` sur **tous** les appels de l'Assistant IA par Mastra —
conversation et fil, délégation vocale (c'est le fil), résumé roulant, titres, vision / OCR par la vision, travaux,
veille, rédaction, traduction. La recherche web passe par la passerelle (rôle `worker`) **sans chaînage** : la passerelle
y pose déjà `store: false` (`buildResponsesBody` : `store` = chaînage) ; aucun changement global, Adam garde son
chaînage (`previous_response_id` → `store: true`) — le banc le tient des deux côtés. La transcription et la synthèse vocale
(`/v1/audio/*`) n'ont pas de paramètre `store`. La voix temps réel (`/v1/live/sessions`, `gpt-live-1`) : **non posé** —
aucun paramètre de conservation n'y est vérifié ; l'ajouter sans preuve risquerait un refus de la session. Les visuels de
K2 (décision [0032](0032-visuels.md), `infra/visuels/fournisseurs.ts`) : `/images/generations`, `/images/edits` et `/videos`
n'ont **pas** de paramètre `store` ; rien à poser — leur consigne passe déjà son propre filtre (`filtrerConsigne`). Le
secours Gemini des images (Google) n'est pas couvert par ce paramètre d'OpenAI.

**Mesuré** : l'Assistant IA n'enchaîne aucune réponse (`previous_response_id` absent du module : l'historique est renvoyé
à chaque tour). Le SDK (Mastra 1.79, adaptateur OpenAI Responses) renvoyait jusqu'ici les étapes d'un tour à outils par
**référence** (`item_reference`, qui suppose la réponse conservée) ; avec `store: false` il les renvoie **en entier** et
demande le raisonnement chiffré (`include: reasoning.encrypted_content`). Le banc le vérifie sur la requête réelle
envoyée (fetch intercepté) ; le passage réel ci-dessous l'a fait sur `gpt-6.1-terra`.

## 5. Preuves

- Banc `valeurs-sensibles.test.ts` (14 cas) : mode en clair (le modèle reçoit 185 000 / 152 340, les écrit ; consigne et
  règle 2 réécrites), droits inchangés (assistante de direction et KAM refusés, rien de reçu ; une valeur non ouverte
  arrive « [confidentiel] » ; journal accord / refus), mode masqué (repères, valeur à l'écran), délégation vocale qui dit le
  salaire, réglage Super Admin seul et audité, `store: false` dans la requête d'un tour à outils (sans `item_reference`).
- Bancs de la décision 0012 (`droits-metier.test.ts`) et de la voix (`temps-reel.test.ts`) : passés en mode « masquées »
  explicite, inchangés et verts.
- **Passage réel (31/10/2026, base locale, Super Admin du banc, `gpt-6.1-terra`)** — texte : « Le salaire de base d'Assia …
  est de **185 000 DZD**. » ; délégation vocale (`deleguerALaVoix`, ce que GPT-Live prononce) : « Le salaire net d'Assia
  Benali est de 152 340 DZD. » 4 appels (2 par tour), 19 704 jetons d'entrée, 177 de sortie : **≈ 0,024 $**.
