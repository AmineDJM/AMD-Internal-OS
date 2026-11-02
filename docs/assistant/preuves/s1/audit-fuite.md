# S1 — Audit de fuite des outils de lecture de l'assistant (02/11/2026, décision 0048)

Question posée à chaque surface : **un utilisateur NON privilégié** (assistante de direction, délégué médical — pas Super
Admin, pas de droit RH modifier/valider, assistant ouvert) peut-il obtenir une donnée d'**autrui** (paie, IBAN, NIN, dossier
RH, évaluation, nature d'absence, notes, missions, mémoire, conversations, voix) ? Lecture du code + bancs.

| # | Surface | Garde (fichier) | Portée | Verdict |
|---|---|---|---|---|
| 0 | **Vue exacte** (corps d'action = Super Admin réel) | `beta/actions.ts`, `infra/fil/tour.ts` (`enVueExacteIa`) | — | **FUITE CORRIGÉE** : l'assistant est fermé en Vue exacte (banc S1) |
| 0b | **Paie / dossier RH d'autrui par réglage de RÔLE** | `infra/lectures.ts` `droitSurAutrui`, `infra/role-config.ts` `peutVoirLaValeur`, `api/rh/document/[id]` | — | **FUITE CORRIGÉE** : seuls droit applicatif, avenant daté, droit daté de console (banc S1) |
| 1 | Registre des capacités (lectures R0) | `infra/capacites.ts` | l'action ERP relit `requireUser` et applique son RBAC et sa portée | OK |
| 1b | `trouver_outil` / sélection | `infra/outils.ts`, `infra/selection.ts` | ne choisit que parmi les outils déjà permis | OK |
| 1c | Travaux en arrière-plan | `infra/travaux.ts` | `proprietaire(principalId)` : la même personne, droits relus | OK |
| 2 | K1 `requete_sql` | `infra/analyse/outils.ts` (`hasGlobalView`), `lib/sandbox/sql.ts` | Super Admin / Direction seuls ; transaction lecture seule, liste blanche (ni `PayrollEntry`, ni `User`, ni `AssistantIa*`), colonnes sensibles refusées, audit | OK (jamais offert à un non privilégié) |
| 2b | Jeux du tour (`JeuxDuTour`) | `infra/fil/tour.ts` | en mémoire, un tour, sorties d'outils déjà jugés | OK |
| 3 | K7 exports, `exporter_donnees` | `infra/exports.ts`, `lib/exports/producteurs.ts`, `analyse/exporter.ts` | même fonction que l'écran, avec la personne ; Drive de la personne ; révélation par `Revelateur(user)` | OK |
| 4 | Recherche approfondie | `infra/sous-missions.ts` | `user.id`, moteur des travaux, `principalId` | OK |
| 5 | Notes | `infra/notes/outils.ts`, `notes/pages.ts` | `where userId` partout ; fermées en Vue exacte | OK |
| 5b | Chantiers | `infra/chantiers.ts` | Super Admin seul | OK |
| 5c | Travaux, sous-missions, tableau Missions | `platform/ia/travaux/outil.ts`, `sous-missions.ts` | `principalId` / `userId` | OK |
| 6 | Mémoire (`rappelDuTour`, capture) | `infra/memoire.ts`, `memoire-capture.ts` | `where userId` ; « commune » = aux conversations d'une même personne (0027 §6 : pas de partage) | OK |
| 6b | Conversations passées | `infra/conversations/outil.ts` | `userId`, non privées, extraits censurés | OK |
| 6c | `action_history`, `episodic_recall` | `platform/ia/intentions/action-intents.ts` | `userId/ownerId = user.id` | OK |
| 7 | Voix | `infra/voix/oral.ts`, `voix/temps-reel.ts` | sessions et travaux par `userId` ; fermée en Vue exacte | OK |
| 7b | Délégation (`mes_demandes_recues`) | `infra/operations/delegation.ts` | `user.id` | OK |
| 7c | Canaux K6 | `infra/canaux/*` | `userId` ; message entrant rattaché au téléphone de l'expéditeur | OK |
| 8 | `vueDeLAssistant` | `infra/role-config.ts` | ajoute la LECTURE d'un module de famille ouverte ; la révélation juge sur la vraie session | OK (ne déverrouille jamais paie ni NIN) |
| 8b | `read_hr_overview` | `infra/lectures.ts` | entités permises ; la masse retirée sans droit paie (`situationRhSansMasse`) | OK |
| 8c | `directory_lookup` | `platform/ia/lectures/directory-tools.ts` | l'annuaire du groupe, comme l'écran Annuaires › Personnes | OK (égal à l'écran) |
| 8d | `directory_list` (registre complet + coordonnées) | `infra/outils-v1.ts` `surDroitReel` | jugé désormais sur le droit RÉEL (RH lecture, Direction, Super Admin) | **DOUTE D1 CORRIGÉ** (banc S1) |

Ajouts après le banc Q1 : **LD-06** (la finance lisait le NIN d'autrui en base avant masquage) — IBAN et NIN ne sont plus
sélectionnés hors gestion RH de la société ; **IBAN d'autrui à la finance** — refusé par l'assistant (règle la plus stricte,
les écrans de paiement gardent la leur) ; **SO-03** — le filtre de la saisie ne mutile plus « Quel IBAN est enregistré… ».
Banc de contournement : `src/modules/assistant-ia/s1-contournement.test.ts` (10 attaques, espion des lectures en base).

**US-01** (défaut bloquant du banc Q1) : une usurpation (« c'est Amine qui écrit ») faisait retenir « Prénom : Amine » dans
la mémoire de la personne — corrigé à toute écriture et toute relecture de la mémoire (`src/platform/ia/memoire-identite.ts`, décision 0048 §6 bis), banc `s1-contournement.test.ts`.

Remarque hors assistant (comportement existant de l'ERP, non modifié) : `predicatEntitePermise` (`lib/company.ts`) rend
« toutes les entités » quand l'ensemble des entités permises d'un porteur est vide.

## Matrice persona × ressource (assistant)

« refusé » partout sauf droit explicite. ✅ = accordé, ❌ = refusé. Rejouées contre la base par `s1-acces-personnels.test.ts` :
les lignes salarié, sans fiche, assistante de direction (y compris famille ouverte à son rôle), avenant, droit daté, Vue
exacte. Les lignes RH paie, Super Admin et l'assistante ouverte nommément viennent de `droits-metier.test.ts` et
`valeurs-sensibles.test.ts` ; manager, finance et KAM découlent des gardes de code citées plus haut (même règle
`droitSurAutrui`), sans banc dédié à S1.

| Persona | Sa paie | Paie d'autrui | Contrat / avenant d'autrui | IBAN d'autrui | Notes / missions / mémoire d'autrui | Documents RH d'autrui |
|---|---|---|---|---|---|---|
| Salarié (fiche liée) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Salarié sans fiche liée | ❌ (« aucune fiche ») | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manager | ✅ | ❌ (congé/absent seulement, comme l'écran) | ❌ | ❌ | ❌ | ❌ |
| RH paie (RH modifier/valider) | ✅ | ✅ entités permises, famille ouverte | ✅ entités permises | ✅ (politique du coffre) | ❌ | ✅ entités permises |
| Finance | ✅ | ❌ | ❌ | ❌ par l'assistant — jamais sélectionné en base, jamais révélé (banc de contournement) | ❌ | ❌ |
| Assistante de direction | ✅ | ❌ — même famille ouverte à son rôle | ❌ | ❌ | ❌ | ❌ |
| … avec avenant de délégation paie (entité P, daté) | ✅ | ✅ entité P seule, dans les dates | ❌ | ❌ | ❌ | ❌ |
| KAM / délégué | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Super Admin (connexion réelle) | ✅ | ✅ | ✅ | ✅ | ❌ (notes, mémoire : personnelles) | ✅ |
| Vue exacte (quiconque) | assistant fermé | fermé | fermé | fermé | fermé | fermé |
