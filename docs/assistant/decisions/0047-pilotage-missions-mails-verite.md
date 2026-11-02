# 0047 — L'assistant pilote vraiment ses missions et ses mails, et ne dit jamais avoir fait ce qu'il n'a pas fait (lot P1, 02/11/2026)

> Construit sur K3 ([0033](0033-sous-missions.md) — sous-missions, tableau « Missions »), K9 ([0039](0039-voix-orale.md) —
> commandes orales de mission), K10b ([0040](0040-reversibilite-communications.md) — fenêtre d'annulation des effets sortants) et K1
> ([0031](0031-analyse-donnees.md) — `noteChiffresNonSources`, dont la garde de vérité reprend la forme).

**Constat de la Direction (app Adventum IA en production, 02/11, verbatim)** : elle demande un classeur de suivi AMD, puis
un planning Redouane/Nesrine, puis « Non, merge-les dans le même tableau, plus précis pour que chacun ait quoi faire, et
prépare même des mails à envoyer aux 2. Tu as accès à ton Gmail ? ». L'assistant lance une TROISIÈME mission ; à « je
t'ai déjà merge les missions en une seule » il répond « Je prends en compte la mission unique que tu as déjà fusionnée »
(rien n'a été lu) ; à « je vois 3 missions » il lui demande les titres. Les trois missions restent « En cours · 0 % »
(« 0/4 étapes · 0,00 $ »). Les cartes « Enregistrer brouillon » exigent de ressaisir « ENREGISTRER » ; « Pour Gmail, je
n'ai pas de confirmation d'accès ». Question : « T'es sûr qu'il peut contrôler les missions ? Et envoyer un mail si je
lui confirme ? ». Précision de la Direction pendant le lot : **la boîte mail, c'est celle d'Adam** (le Gmail d'Adam).

## 1. Les missions à 0 % — la cause, mesurée

Rejoué sur serveur réel (base locale, `scripts/worker.ts` lancé comme en production avec `TACHES_DE_FOND=worker`) : une
mission « démarrée d'office » de trois étapes se termine en ~1 min (3/3, 0,0023 $). **Le moteur n'est pas en cause : à 0 %,
personne ne conduisait les missions.**

- **Défaut de code corrigé** — le battement du web ne s'armait qu'au chargement de `lib/scheduled.ts`, c'est-à-dire à la
  première requête qui l'importe (le badge des messages d'une page de l'ERP, `/api/messaging/sync`). Après chaque
  déploiement, tant que personne n'ouvrait l'ERP, le web ne conduisait rien. L'app Adventum IA (`TACHES_DE_FOND=worker`)
  ne bat jamais par conception. Sans service worker, les missions lancées depuis l'app restaient donc à 0 %. **Remède** :
  `src/instrumentation.ts` arme le battement au démarrage, là où `battementWebArme()` l'autorise (web, les-deux ; jamais en
  test ni à la compilation ; l'app n'importe rien de plus).
- **Défaut de code corrigé** — une étape de modèle en flux qui échouait (clé refusée, crédit épuisé) rendait « aucune
  réponse » : l'erreur du fournisseur était avalée (`generer.ts enFlux` relit `stream.error`). L'étape dit maintenant
  « crédit du compte OpenAI épuisé ».
- **Réglage de déploiement à vérifier sur Render** : le service `amd-worker` existe-t-il et tourne-t-il
  (`TACHES_DE_FOND=les-deux`, mêmes `DATABASE_URL`/`OPENAI_API_KEY`) ? Le web de l'ERP porte-t-il `TACHES_DE_FOND=les-deux` ?
  `GET /api/health/worker`. Administration › IA (« Missions de l'Assistant IA — qui les conduit ») le montre.

## 2. L'état HONNÊTE, à l'écran et dans la conversation

`domaine/missions/pilotage.ts diagnostiquerMission` (pur) : « en attente du worker (aucun battement depuis N min) »,
« attend ton approbation », « plafond atteint », « bloquée : l'étape « X » a échoué — … », « l'étape « X » réessaie : … »,
« arrêtée (fusionnée dans « … ») » — jamais « En cours · 0 % » indéfiniment. Le battement est lu sur les baux
(`infra/missions/executants.ts` : dernier passage EFFECTIF de `travaux.balayage`, dernier battement du worker ; seuil 3 min).
Le tableau « Missions » montre le diagnostic sous chaque titre, la pastille « En attente du worker », et une alerte en
tête avec ce qu'il faut vérifier ; une étape qui réessaie montre sa dernière erreur (`tableau.ts`).

## 3. Piloter ses missions À L'ÉCRIT (et la voix réutilise les mêmes fonctions)

- `mes_missions` : la liste réelle (titre, identifiant, état, étapes faites/total, coût, ce qui bloque).
- `piloter_mission` : pause / reprendre / arreter / renommer, par identifiant ou par nom (`designerMission` : identifiant
  exact, titre exact, puis le plus de mots communs ; à égalité, la réponse NOMME les candidates).
- `fusionner_missions` (carte, opération `infra/operations/missions-fusion.ts`) : N missions → une. La carte liste ce qui
  RESTE (la plus avancée par défaut, renommée si un titre est donné — ou une NOUVELLE mission si le modèle donne un `plan`
  qui couvre l'union des objectifs, relu contre le catalogue) et ce qui SERA ARRÊTÉ. Confirmée : les autres sont arrêtées
  avec leurs sous-missions ; la conversation ne reçoit qu'UNE synthèse (une mission arrêtée ne retient ni ne figure dans
  la synthèse de son tour ; la nouvelle mission rejoint le tour de la plus récente des fusionnées).
- **Arrêter se défait** : `CANCELLED` est terminal dans le moteur ; l'arrêt par l'assistant est donc une PAUSE marquée
  (`MOTIF_ARRET`, `MOTIF_FUSION`, état affiché « Arrêtée », rangée avec les finies, retirée du tableau après 3 jours) que
  « reprendre » relance, sous-missions comprises (`service.ts arreterTravail`, `reprendreMonTravail`). Un plan jamais
  approuvé est retiré (rien n'avait tourné). L'« Annuler » de l'écran reste définitif.
- La voix (`voix/oral.ts commandeMission`) passe par `piloterMission`.
- Présélection (`outilsPilotageVoulus`) : missions, tâches de fond, travaux, fusionne/merge, arrête, reprend, en cours…
  Consigne `CONSIGNE_MISSIONS` : lire avant de parler, ne jamais demander un titre lisible, fusionner plutôt que relancer.

## 4. La garde de VÉRITÉ (serveur)

`noteActionsNonVerifiees(message, outilsRéussis, carteAffichée)` — comme `noteChiffresNonSources` : une réponse qui affirme
une fusion, un pilotage, un envoi, un enregistrement ou une vérification (« j'ai fusionné », « c'est envoyé », « je prends
en compte la mission que tu as déjà fusionnée », « c'est enregistré ») sans l'outil réussi qui le prouve DANS LE TOUR
reçoit la note « ⚠️ Non vérifié : … rien n'a été exécuté » (journal `[assistant] actions non vérifiées`). Une carte affichée
n'est pas une action faite : « c'est envoyé » sur une carte est repris. Un `piloter_mission` refusé n'est pas une preuve.

## 5. Les mails de bout en bout

- `mes_boites_mail` (lecture, sans jeton) : le **Gmail d'Adam** (l'unique connexion Google, `GOOGLE_ADAM_EMAIL`), la boîte
  Microsoft et la boîte SMTP de la personne — reliée, adresse, envoi possible, boîte par défaut.
- `envoyer_mail` : carte « Envoyer » qui NOMME la boîte. Ordre : Gmail d'Adam (Direction et Super Admin — mêmes portes que
  les outils Gmail d'Adam : `EXEC`, freins anti-boucle `checkRateLimits`), sinon Microsoft de la personne
  (`microsoft-mail-actions:sendMessage`), sinon SMTP de l'ERP (`mail-actions:sendMailAction`). Brouillon seulement sur
  demande (Microsoft `saveDraft`).
- **Gmail par la fenêtre d'annulation** : nouvel effet sortant `courriel.gmail` (`lib/google/gmail/envoi.ts`) — sous le
  geste confirmé, le mail est différé (2 min par défaut), annulable ; parti, un rectificatif le compense. Exécuteur
  enregistré par la tâche `effets.sortants` et par l'opération.
- **Décision de la Direction appliquée** : une action R3 RÉVERSIBLE (annulation ≠ « aucune ») se confirme d'un bouton —
  plus de ressaisie (`niveauDeCarte(risque, annulation)`). La ressaisie reste pour R4 (argent, production) et pour un R3
  sans annulation. Les 61 R3 du registre sont toutes réversibles.

## 6. Le libellé « aucune donnée »

Un calcul en code sans source lue (le rétroplanning de ses dates) disait « aucune donnée (paramètres de la demande
seulement) » ; il dit « calculé à partir de tes dates et paramètres (rien de lu dans l'ERP) ».

## Tests

`domaine/missions/pilotage.test.ts` (diagnostic, désignation, garde sur les phrases de la Direction, présélection, niveau de
carte) ; `missions-mails.test.ts` (contre la base : 3 missions → `mes_missions` les lit, « en attente du worker » ; carte
de fusion → une seule reste, deux arrêtées avec la sous-mission, « reprendre » défait l'arrêt, renommer ; carte
« Envoyer » SMTP sans ressaisie ; Gmail d'Adam → fenêtre d'annulation → annulé, rien ne part).
