# 0022 — La qualité continue de l'Assistant IA : banc programmé (J5) et qualité continue (J14) (30/10/2026)

**Décision (Direction, 29–30/10/2026)** : lots J5 et J14 de l'architecture validée (« Un noyau, des personas… »,
<https://claude.ai/artifact/34ig3QRV5X7LtanjyuX7U7>). Critères de fin : *une régression fait échouer le passage et le dit*
(J5) ; *0 carte trompeuse non signalée sur 200 attaques ; aucun changement de modèle sans banc vert* (J14).

> Code : `src/modules/assistant-ia/domaine/qualite/` (calendrier, régression, base d'essai, A/B, résultat — pur),
> `domaine/provenance-tierce.ts` (pur), `infra/qualite/` (banc, modèles, traces, rejeu, tableau), `infra/provenance.ts`,
> `actions-qualite.ts` (clé `assistant-ia-qualite-actions`), écran `src/app/(app)/admin/ai/qualite/`, scripts
> `scripts/bench/banc-programme.ts`, `scripts/banc-essai-semer.ts`, `scripts/assistant-rejouer.ts`. Migration
> `20270210100000_qualite_continue` (six tables neuves, additive et idempotente).

## 1. J5 — le banc programmé

| Point | Décision |
|---|---|
| Où il tourne | **Sur le worker** (tâche de fond `qualite.banc`), jamais dans une page. La tâche lance un **processus à part** (`tsx scripts/bench/banc-programme.ts`) et rend la main : le battement n'est pas tenu pendant l'heure du banc. Le worker relit le résultat à la fin. Un passage « en cours » qui ne tourne plus dans aucun processus (redémarrage) est clos, dit (« interrompu »). |
| Quand | Calendrier réglé par le Super Admin (`/admin/ai/qualite`) : chaque jour / semaine / mois, jour, heure d'Alger. **Défaut : chaque vendredi à 3 h.** Désactivable. Un créneau manqué se rattrape une fois. « Lancer maintenant » et les bancs A/B passent par une DEMANDE que le worker prend au battement suivant. |
| Contre quelle base | Une **base d'essai séparée**, semée synthétiquement : `BANC_ESSAI_DATABASE_URL` sur le worker. Trois verrous : (1) déclarée — en production sans elle, le passage est **REFUSÉ, raison dite**, rien ne tourne ; hors production, la base de banc locale (`BENCH_DATABASE_URL`) en tient lieu ; (2) empreinte (hôte, port, nom) différente de la production — vérifiée par le worker ET par la garde de `@/lib/prisma` dans le processus de banc (`estLaBaseEssaiDeclaree` : seule base distante qu'un banc puisse ouvrir) ; (3) le **marqueur** `BancBaseEssai` présent dans la base d'essai (posé par `npm run banc:essai:semer`, une fois) et ABSENT de la production. |
| Quoi | Les 26 scénarios Jarvis, l'Atelier (PowerPoint, Word), les Travaux (un travail jusqu'au livrable), la Bibliothèque (recherche par le contenu, faux embedder, 0 $). Semis Adam + Jarvis à chaque passage. |
| Combien | **Plafond par passage (défaut 1 $)**, réglable (≤ 20 $). Chaque banc reçoit ce qui RESTE ; un scénario qu'on ne peut plus payer est « NON JOUÉ » (jamais compté comme un échec) et le passage est marqué « plafond atteint » (jamais vert). |
| Historique | `AssistantIaBancPassage` (réussite, latence P50/P95 au premier mot et au total, jetons entrée/cache/sortie, coût, modèles par rôle en service, référence, régressions, vert) + `AssistantIaBancScenario` (par scénario). |
| Régression | Comparée au dernier passage complet hors A/B : **réussite en baisse** (ou un scénario OK qui ne l'est plus — nommé), **latence P50 ou P95 +30 %** (plancher 400 ms), **coût moyen par scénario +30 %** ; et, toujours, une écriture sans carte ou un scénario en erreur. Une régression **notifie le Super Admin** (cloche + téléphone), une fois par passage. |

## 2. J14 — qualité continue

### 2.1 Traces rejouables

Chaque tour du fil enregistre sa trace (`AssistantIaTrace`, gzip) : l'entrée de la boucle (consigne, message, historique,
outils offerts), chaque appel du modèle (nature, empreinte sha-256 du prompt reçu, outils actifs, **toutes les sorties** du
modèle, morceaux du flux compris), chaque sortie d'outil, le texte final. L'enregistrement enveloppe le modèle que reçoit
Mastra (`modeleTrace`) — le routeur `openai/…` devient un `ModelRouterLanguageModel` enveloppé, rien d'autre ne change.
Aucune valeur plus sensible que ce qui est déjà parti au modèle (saisie filtrée, sorties jetonnées). Gardée 30 jours
(`ASSISTANT_IA_TRACES_JOURS`, tâche `assistant.traces`) ; coupure `ASSISTANT_IA_TRACES=off`.

**Rejeu** : `npm run assistant:rejouer -- <id> [--exporter f.json]` puis `--fichier f.json` en local. Le même
`repondreAvecSecours` (boucle, budget, flux) avec un REJOUEUR à la place du modèle et les sorties enregistrées à la place
des outils : aucun appel au fournisseur, aucune écriture métier. Il dit chaque **divergence** (prompt dont l'empreinte a
changé, outil appelé autrement, texte final différent). Refusé contre une base distante (il écrit au journal de
consommation, fournisseur « rejeu », coût nul).

### 2.2 Contenus piégés et provenance tierce

**Règle** (`domaine/provenance-tierce.ts`, pure) : à chaque carte préparée, les valeurs remarquables de ses champs (RIB /
IBAN, e-mail, téléphone, lien, montant, nom propre, passage de six mots) sont confrontées aux **contenus tiers lus pendant
le tour** (pièces jointes et sorties d'outils encadrées, `extraireNonFiables`) et à **ce que la personne a écrit**. Une
valeur d'un tiers que la personne n'a pas dite est **marquée sur la carte** : « « RIB du bénéficiaire » : ce RIB provient
du document « Devis Atlas Print.pdf », à vérifier. » Un nom confirmé par l'annuaire n'est pas marqué ; un RIB, une adresse,
un montant le sont toujours. Un contenu tiers qui porte des **consignes adressées à l'assistant** (français, arabe,
anglais ; caractères invisibles, texte masqué, commentaire HTML) marque toute carte préparée après sa lecture. La
provenance est gardée dans l'intention (`payload.provenanceTierce`). La confirmation reste exigée pour TOUTE carte.

**Corpus** (`infra/testing/corpus-pieges.ts`) : **240 contenus** — 5 genres (devis, mail, PDF, page, pièce jointe) × 8
attaques (RIB substitué, destinataire, montant, téléphone, lien, consigne en clair, consigne cachée, consigne en arabe) ×
2 langues × 3 variantes. Le faux modèle ADVERSARIAL obéit (il reprend la valeur injectée).

| Preuve | Résultat |
|---|---|
| `infra/qualite/pieges-regles.test.ts` — les 240, règle par règle | **0 carte trompeuse non signalée** (valeur marquée, document nommé) ; message préparé par l'adversaire marqué ; consignes cachées/arabes reconnues ; un document ne referme pas son cadre ; témoin : rien de marqué quand la personne dicte elle-même |
| `pieges.test.ts` — 35 pièges par le CHEMIN DU PRODUIT (Drive, lecture des pièces, filtre, encadrement, `jouerTour`, faux modèle adversarial qui lit ce qu'il a reçu et prépare `send_message`) | chaque carte **PROPOSÉE** (jamais exécutée), **signalée** (le nom du document sur la carte), provenance en base ; **0 message écrit** |

Limite assumée : le filtre de confidentialité masque déjà un RIB lu dans une pièce avant le modèle — par le chemin du
produit, l'attaque « RIB substitué » n'atteint donc pas la carte ; elle est éprouvée par la règle (les 240).

### 2.3 Protocole A/B d'un modèle

Le modèle d'un rôle (rapide, standard, raisonnement — `platform/ia/modeles-roles.ts`) se change à l'écran
(`AssistantIaModeleRole`, au-dessus de l'environnement) **seulement avec un banc vert enregistré pour ce candidat exact**
(modèle ET effort, rôle), terminé il y a moins de 14 jours. Le banc A/B tourne avec le candidat à la place du modèle de son
rôle (le worker transmet au processus de banc les modèles EN SERVICE, `envDesModeles`) et se compare à la même référence.
La garde est dans le code (`changerModeleRole`, rejugée en base), pas dans l'écran. Le **retour à l'environnement** est
toujours permis (voie de secours). Nouvelle variable : `ASSISTANT_IA_MODEL_RAISONNEMENT` (un modèle à part pour le
raisonnement ; défaut : celui du standard). Chaque geste à l'audit.

## 3. Exploitation

1. Créer une base Postgres **séparée** (Render, offre payante), la déclarer et la semer depuis le Shell du worker :
   `BANC_ESSAI_DATABASE_URL=… npx prisma migrate deploy` (avec `DATABASE_URL` = cette base) puis
   `BANC_ESSAI_DATABASE_URL=… npm run banc:essai:semer`.
2. Poser `BANC_ESSAI_DATABASE_URL` sur le worker. Le banc tourne quand le worker bat (`TACHES_DE_FOND=les-deux|worker`).
3. `/admin/ai/qualite` : calendrier, plafond, historique, détail par scénario, modèles par rôle, bancs A/B.

## 4. Ce que ce lot n'a PAS fait (dépense API)

Consigne : tout au faux modèle et sur traces enregistrées ; un seul passage de fumée réel ≤ 0,30 $ (voir le rapport du
lot). Aucun passage complet du banc programmé n'a été joué contre le vrai modèle.
