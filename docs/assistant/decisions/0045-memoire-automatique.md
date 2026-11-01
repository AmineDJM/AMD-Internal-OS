# 0045 — Une vraie mémoire pour Adventum IA (lot M1, 01/11/2026)

Constat de la Direction (verbatim) : « J'ai fait une longue conversation avec Adventum IA, j'ai parlé de moi, de ma
famille, de mes voyages, de mes études… J'aurais voulu qu'il les retienne dans sa mémoire, mais quand je suis allé
cliquer sur ce qu'il retient, je n'ai rien trouvé. Pourtant il doit avoir une super mémoire. C'est hyper important. »

Suit [0013](0013-jarvis-architecture.md) (mémoire personnelle, à la personne seule), [0018](0018-vitesse-memoire.md)
(assembleur, enveloppes), [0027](0027-adventum-ia.md) (conversations privées : ni mémoire lue ni écrite).

> Code : `domaine/memoire-ui.ts` (sortes, groupes, libellés), `domaine/memoire/capture.ts` (filtre, consigne, lecture,
> garde), `domaine/memoire/rappel.ts` (BM25, profil, enveloppes), `infra/memoire.ts` (stockage, historique, annulation,
> réglage), `infra/memoire-capture.ts` (capture après tour, rappel du tour, voix), `infra/generer.ts` (`plongerTextes`) ;
> écran : `ecrans/memoire-panel.tsx`, `ecrans/memoires-retenues.tsx`. Migration `20270219100000_assistant_ia_memoire_auto`.

## 1. Les causes, confirmées dans le code

1. **Rien ne s'écrivait sans un clic.** La seule porte d'écriture était l'outil `proposer_memoire` → carte « Retenir » ;
   la règle 11 disait « rien n'est retenu avant son geste ». Une carte non cliquée = rien en base.
2. **La règle ne visait que le travail** (« sa société, ses produits, une préférence, une habitude ») et les sortes
   (`SORTES_MEMOIRE`) n'avaient aucune place pour la famille, les voyages, les études.
3. **L'outil n'était presque jamais offert** : la présélection (J4) ne le proposait que sur « retiens / souviens /
   mémoire / rappelle-toi ».
4. **À l'oral**, aucune carte « Retenir » n'est montrée ni confirmée : une conversation vocale ne pouvait rien retenir.
5. **Le rappel** prenait les 30 plus récents et les triait par mots partagés dans 500 jetons : « mon voyage » ne
   trouvait pas « Part à Lyon le 12 » (aucun mot commun).

## 2. Ce qui est décidé

**Capture automatique, visible et réversible.** Après chaque tour (et à la fin d'une conversation vocale), le dernier
message de la personne passe trois portes, la moins chère d'abord :

| Porte | Ce qu'elle fait | Coût |
|---|---|---|
| Filtre déterministe (`faitDurablePossible`) | première personne + un thème de vie ou de travail durable ; une demande sur l'ERP, « merci », « tu te souviens… ? » s'arrêtent là | 0 |
| Extracteur (modèle `rapide`, JSON strict) | lit le SEUL message de la personne (≤ 1 500 car.) et ≤ 12 souvenirs proches (pour remplacer plutôt qu'ajouter) | ≈ 0,0002 $ |
| Garde (`garderCandidat`) | un chiffre ou un nom propre absent du message est refusé ; salaire, prime, IBAN, matricule, pièce d'identité, évaluation : jamais | 0 |

La **réponse de l'assistant n'entre pas** chez l'extracteur : elle porte des données de l'ERP (un salaire lu pour la
personne, un tiers). La mémoire porte sur la personne et sur ce qu'ELLE dit.

Les souvenirs sont **enregistrés d'office** (la Direction veut qu'il retienne). Sous la réponse, une ligne discrète :
« Retenu : Part à Lyon le 12 novembre avec sa fille Lina — annuler · voir ». **Annuler** défait exactement l'ajout ; s'il
remplaçait un fait, l'ancien revient (`annulerSouvenir`). Une annulation propre à la mémoire plutôt que le journal des
effets J7 : la mémoire n'est pas une écriture métier, elle est à la personne seule, et l'annulation doit restaurer
l'ancienne version du fait — ce que la chaîne `remplaceId` porte directement.

**Mise à jour, pas d'empilement.** Un fait qui change (désigné `remplace` par l'extracteur, ou de même `sujet`, ex.
`voyage:lyon`) passe l'ancien à l'historique (`active = false`, `remplaceLe`), le nouveau porte `remplaceId`. Un doublon
(même phrase, ou Jaccard des racines ≥ 0,8) n'écrit rien. Chaque souvenir garde sa date, sa conversation et son message
d'origine (`sourceThreadId`, `sourceTourId`), son origine (`manuel`, `propose`, `auto`, `voix`).

**Sortes de la vie personnelle** : `PERSONNEL_IDENTITE`, `FAMILLE`, `ETUDES_PARCOURS`, `SANTE_DECLAREE`, `VOYAGES`,
`GOUTS_LOISIRS`, `PROJETS`, `CONTRAINTES`, `PERSONNES_CITEES` — à côté des sortes du travail. Le panneau les groupe :
Moi, Ma vie, Mon travail, Comment me répondre.

**Rappel par pertinence.** À chaque tour : un **profil** stable (identité, famille, préférences de réponse ; 250 jetons)
toujours présent, puis les **souvenirs pertinents** (600 jetons) — BM25 sur les racines du souvenir ET les mots de sa
sorte (« voyage » trouve un souvenir rangé sous VOYAGES), mêlé au cosinus des plongements (text-embedding-3-small, 512,
calculés à l'écriture) **seulement si la mémoire ne tient pas entière** : sinon aucun appel. La voix reçoit le même
profil dans sa consigne de session et dit, une fois, « je le retiens ».

**Ce qui ne change pas.** Conversation privée : rien n'est lu, rien n'est retenu (dit au modèle et dans l'écran). La
mémoire est à la personne seule : chaque lecture et écriture filtre sur l'identité de la session — Super Admin compris
(aucun outil d'admin ne lit la mémoire d'autrui ; Adam garde son propre `forgetMyAssistantMemory`). Rien de sensible
(filtre de confidentialité à l'écriture et à la relecture).

**Réglage par personne** : « Mémoire automatique » (`AssistantIaPreference.memoireAuto`, défaut oui) dans le panneau.
Coupée, l'outil `proposer_memoire` et sa carte reviennent (`CONSIGNE_MEMOIRE_A_LA_CARTE`). « Tout effacer » efface tout,
historique compris.

## 3. Coût mesuré (serveur réel, 01/11/2026)

Une capture qui retient : 1 appel `gpt-6-luna` (≈ 570 jetons d'entrée, ≈ 220 de sortie) = **0,000168 $**, + 1
plongement (≈ 150 jetons) = **0,000003 $**. Un tour sans fait durable : **0 $** (filtre). Le journal K8 la range sous
l'usage « Mémoire (capture automatique) » (`role = memoire`). Ordre de grandeur : < 1 % du tour qu'elle suit
(≈ 0,0066 $ pour un tour `gpt-6.1-terra`).

## 4. Décisions laissées à la Direction

- **Durée de l'historique** des faits remplacés : gardé sans limite aujourd'hui (effacé avec le souvenir). Purger
  au-delà de N versions ou de 12 mois ?
- **Santé déclarée** : retenue quand la personne la dit d'elle-même (allergie, régime). La garder, ou exiger « retiens »
  pour cette sorte ?
- **Plafond** : 300 souvenirs actifs par personne (au-delà, la capture s'arrête et le panneau le dit). Le relever ?
