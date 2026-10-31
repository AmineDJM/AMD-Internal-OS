# 0036 — Pièces reçues par WhatsApp et par mail, dans le contexte de la conversation (lot K6, 31/10/2026)

**Direction, 31/10/2026 (résumé fidèle)** : « Si je suis en appel avec l'assistant IA et que je lui dis "attends, je vais
t'envoyer les pièces jointes" (ou qu'il me les demande), par mail ou par WhatsApp, il s'attend à les recevoir. Si je lui
transfère une pièce pendant ou juste après l'appel, il comprend le contexte : je lui ai parlé d'une demande de sponsoring,
donc c'est la lettre de demande du médecin. Il garde ce contexte en tête, sans inonder les requêtes de jetons. Il doit
pouvoir enregistrer depuis Gmail et WhatsApp, et ranger dans l'ERP là où il faut. »

> Code : socle `src/platform/ia/canaux/whatsapp.ts` (signature, abonnement, lecture de la notification, médias, réponse —
> zéro import de l'ERP) et `courrier.ts` (destinataires, en-têtes, pièces d'un webhook mail) ; module
> `src/modules/assistant-ia/` — `domaine/canaux/attentes.ts` (règles pures), `infra/canaux/reception.ts` (attente,
> réception), `infra/canaux/section.ts` (la section de la consigne), `infra/canaux/outil.ts` (`attendre_pieces`) ;
> routes `app/api/canaux/whatsapp` (neuve) et `app/api/mail/inbound` (étendue) ; `lib/google/gmail/ingest.ts`
> (`remettreAlAssistant`). Migration additive `20270216140000_assistant_ia_canaux_entrants` (deux tables).
> Banc : `src/app/api/canaux/canaux.test.ts`.

## 1. L'attente de pièces — courte, structurée, liée

- Table `AssistantIaAttentePieces` : **quoi** (≤ 200 caractères), **canaux** (WhatsApp, mail ; vide = l'un ou l'autre),
  **fiche visée** (type, identifiant, libellé, lien), **catégorie** de document, **conversation**, **origine** (écrit,
  voix, assistant), **état** (OUVERTE → RECUE → CLOSE / ANNULEE / EXPIREE), **expiration** (48 h,
  `ASSISTANT_IA_ATTENTE_HEURES`).
- Créée par l'outil **`attendre_pieces`** quand la personne l'annonce ou que l'assistant la demande. La fiche est
  **résolue sous les droits** de la personne (`trouverDemande` pour une demande Ad & Pro : une demande invisible n'est
  jamais nommée ; `ficheVisible` pour une autre fiche). Cinq attentes ouvertes au plus (la plus ancienne se clôt).
- **À la voix** : GPT-Live délègue au fil (J13) ; sa consigne lui dit de déléguer l'annonce d'une pièce. L'attente est
  donc créée par le même outil, origine VOIX.
- Une pièce arrivée la marque **REÇUE** ; elle reste rattachable **30 min** (WhatsApp envoie une pièce par message).

## 2. Le contexte sans inonder les jetons

La consigne n'a une section « PIÈCES ATTENDUES » **que si une attente est ouverte** — une ligne par attente (≈ 40 jetons),
trois au plus, dans la **partie variable** (le préfixe stable et son cache ne bougent pas). Sans attente : zéro jeton.
Aucun historique de réception n'entre dans la consigne ; la pièce reçue, elle, est un tour de la conversation
(`[Reçu par WhatsApp] « légende »` + pièce) que le modèle relit comme toute pièce jointe.

## 3. La réception — une seule porte, `recevoirPieces`

1. **Idempotence** : `AssistantIaReception` unique par (canal, identifiant du message) ; une relivraison sort en DOUBLON
   sans rien refaire ni répondre.
2. **La personne** : par son **numéro** (neuf derniers chiffres ; fiche utilisateur, sinon fiche employé liée à un
   compte ; deux candidats = personne) ou son **adresse**. Inconnue → **refus poli, rien n'est stocké** (le média n'est
   même pas téléchargé : chargement différé) ; le journal ne garde qu'un expéditeur **masqué**.
3. **Gardes** : Assistant IA ouvert au compte ; expéditeur automatique écarté (mail) ; taille (réglage du Drive, 25 Mo
   au plus) ; exécutables refusés ; le texte joint (légende, objet) est **contenu non fiable** — porteur de consignes, il
   est écarté (`detecterInjection`).
4. **Dépôt** au Drive **privé** de la personne, dossier « Assistant IA — pièces reçues » (la pile des vocaux :
   chiffrement, quotas, version, audit).
5. **Conversation** : celle de l'attente, sinon la courante. L'assistant répond **sans appel au modèle** :
   « J'ai reçu la lettre du Dr Mansouri par WhatsApp ; je l'ajoute à SP-… ? » avec la **carte** de rangement
   (`preparer_depot_piece`, le même `proposer` que l'outil du modèle) ; sans fiche : « Où dois-je la ranger ? » ; sans
   attente : « À quoi la rattacher ? ».
6. **Notification** (cloche + téléphone, `notifierConversation`) ; accusé WhatsApp (« Bien reçu ») ; journal complet.

## 4. Sécurité

- **Aucune action sans carte** : la réception n'écrit que dans le Drive de la personne et la conversation ; le rangement
  dans l'ERP passe par `confirmerIntentionAssistantIA` → `uploadDocument`, qui **revérifie le droit** de déposer.
- **Pièces confidentielles** (identité, banque, paie, santé — ou une fiche RH visée) : la carte range en
  `CONFIDENTIAL` (`preparer_depot_piece`, champ `confidentiel`) ; elles ne sont jamais lues au modèle d'office (la lecture
  à la demande garde ses règles : coffre refusé, valeurs masquées).
- Les webhooks sont publics mais **jamais ouverts** : signature vérifiée avant toute lecture, refus sans secret. Le mode
  app (`app-mode.ts` `PERMIS`) et `auth.config.ts` les laissent passer sans session.

## 5. Gmail

Une pièce que le **dirigeant s'envoie** (ou se transfère) dans sa boîte Gmail connectée est remise à l'assistant
**seulement** si une attente « mail » est ouverte (sinon l'ingestion d'Adam ne change pas). Chargement du module à la
demande (`import()`), pas de dépendance d'Adam vers le module à l'import.

## 6. Ce qui n'est pas fait (dit)

- **Confirmation orale pendant l'appel** (lot K4) : la carte se confirme à l'écran ; la voix ne l'annonce pas d'elle-même
  quand la pièce arrive en plein appel (elle le saura au prochain échange délégué, par le fil).
- **Resend / Brevo** : leur webhook ne porte pas le contenu des pièces — la réception le dit ; Postmark le porte.
- Un message WhatsApp **texte** n'est pas une conversation avec l'assistant : réponse courte, rien n'est déposé.
