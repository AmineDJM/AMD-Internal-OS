# 0056 — « Un seul assistant : Adam » — le nom, le menu, les routes et les missions (lot A1, 02/11/2026)

**Décision (Direction, 02/11/2026, validée)** : « je veux merge Adam et l'assistant IA. L'assistant IA de la plateforme,
c'est Adam. (…) dans l'ERP, tu enlèves my chief of staff, le module. (…) garde toutes les fonctionnalités d'Adam, tous,
réellement tous, mais uniquement pour le super admin. L'assistant IA pour les autres employés, tu les laisses comme ça.
(…) l'assistant IA de tous s'appellera dorénavant Adam, en termes de nom. (…) tout le monde verra les missions d'Adam,
chacun selon les missions qu'il lui a données. (…) ne supprime rien dans le code, quitte à tout masquer. »

Le chantier est coupé en deux lots parallèles. **A1 (celui-ci)** : le nom, le menu, les routes, les écrans de missions.
**A2** (`jarvis/a2-adam-complet`, décision 0055) : les capacités de l'ancien Adam branchées dans le moteur de l'Assistant IA, pour le
Super Admin seul. A1 ne touche ni au moteur ni aux outils — seule la ligne d'identité de la consigne change (le nom).

## Ce que cette décision RÉVISE de la décision 0013

0013 posait « deux produits, un socle » : **Adam** (Super Admin, `/chief-of-staff`) et **l'Assistant IA** (chacun, selon
ses droits, `/assistant`). Elle change de sens :

| | 0013 (29/10) | 0056 (02/11) |
|---|---|---|
| Le nom | « Adam » = le chief of staff du Super Admin ; « Assistant IA » = celui de tous | **« Adam » pour tous** — l'assistant de chacun, ouvert personne par personne |
| L'écran | deux entrées de menu (« Assistant IA », « My Chief of Staff ») | **une** : « Adam » (`/assistant`) ; le Super Admin y a des onglets (Boîte de réception, Réglages d'Adam, Bureau d'Adam) |
| Le moteur | deux moteurs | un seul, celui de l'Assistant IA — les capacités de l'ancien Adam s'y branchent pour le Super Admin (A2) |

La **frontière de code** de 0013 reste en vigueur tant que l'ancien moteur existe (A2 la fait évoluer) : `src/platform/ia/
frontieres.test.ts` et `boundary-scan.ts` comptent les mêmes choses. Les écrans de l'ancien Adam ont déménagé de
`app/(app)/chief-of-staff/` dans `app/(app)/adam/`, ajouté au périmètre « Adam » des deux mesures : même code, même dette.

## Ce qui change

**Pour un employé (à qui Adam est ouvert)** — le NOM seulement, plus ses missions :
- menu « Adam » (ex-« Assistant IA ») ; l'accueil dit « Je suis Adam, l'assistant de <prénom> » — le prénom vient du COMPTE
  (`prenomDe(user.name)`), jamais du modèle ; la consigne du modèle l'ouvre par « Tu t'appelles « Adam » » (préfixe stable,
  identique pour tous, mis en cache) et la section INTERLOCUTEUR porte « Ta présentation : … » ; la voix aussi ;
- notifications (« Adam : réponse prête — … »), messages de refus, libellés d'écran et de l'app Adventum IA (`/ia`) ;
- **« Missions d'Adam »** (`/centre-de-missions`) au menu : SES missions (`Mission.ownerId`), leur état réel, pause / reprise
  / arrêt quand l'état les permet (`gestesPermis`), par les actions du module, cloisonnées par la personne ;
- **« Missions terrain »** : l'ex-onglet « Mes missions » de Mon espace (missions d'ÉQUIPE, `MissionAssignment`) — onglet,
  titres, notifications. Données, adresse (`/mon-espace/missions`) et droits inchangés.

Ses droits ne bougent pas : la clé de module `ASSISTANT_IA` est inchangée (aucune migration), la console règle toujours qui
a Adam, personne par personne ; seul son **libellé** devient « Adam » (Administration › Accès, `/admin/ai/acces`).

**Pour le Super Admin** :
- « My Chief of Staff » quitte son menu aussi ; `/chief-of-staff` le mène à l'écran d'Adam : `/assistant`, ou
  `/adam/bureau` quand le lien porte `?q=`, `?ref=`, `?call=` ou `?apercu=` ; `/chief-of-staff/inbox` → `/adam/boite` ;
  `/chief-of-staff/reglages` → `/adam/reglages` (le retour de la connexion Google suit, paramètres compris) ;
- sur `/assistant` et `/adam/*`, une barre d'onglets : **Conversation · Boîte de réception · Réglages d'Adam · Bureau
  d'Adam** (l'ancien bureau, intact) ;
- « Demander à Adam » dans la palette (⌘K) mène au bureau ;
- « Missions d'Adam » : ses missions, plus la **vue globale** (toutes les personnes, propriétaire nommé), l'interrupteur
  général, les accords et les gestes de masse (`peutPiloterMissionsAdam`, inchangé pour CES gestes) ; il lit la fiche
  `/missions/<id>` de quiconque, en lecture seule quand elle n'est pas la sienne.

**Pour un non-Super-Admin sur `/chief-of-staff` ou `/adam/*`** : rien ne change — le gabarit du segment
(`exigerAdamVisible`) répond comme une adresse inconnue, avant toute redirection.

## Ce qui est masqué, et comment le rétablir

| Masqué | Comment | Rétablir |
|---|---|---|
| L'entrée « My Chief of Staff » | `masque: "…"` sur l'entrée `CHIEF_OF_STAFF` (`lib/labels/navigation.ts`), filtré par `navigationFor` et l'onboarding | retirer le champ `masque` |
| L'écran `/chief-of-staff` | la page redirige (`versEcranAdam`) ; le corps est dans `app/(app)/adam/bureau/page.tsx` (`git mv`) | faire rendre `adam/bureau/page.tsx` par `chief-of-staff/page.tsx` |
| « Missions d'Adam » réservé au SA | l'entrée suit `ASSISTANT_IA`, la garde `adamMissions` existe toujours (`nav-access.ts`) | remettre `gate: "adamMissions"` et le module `WORKSPACE` sur l'entrée |

Rien n'est supprimé : clé `CHIEF_OF_STAFF`, droits, gardes, routes, composants du bureau, réglages, boîte de décision.

## Isolation des missions (S1)

Chaque lecture reste filtrée par l'identifiant de la session : `mesMissions(user.id)` (travaux de l'assistant, `principalId`),
`centreDeMissions(user.id)` (exécution), `vueMission(id, user.id)` (fiche). Seul le Super Admin résout le propriétaire d'une
autre mission (`proprietaireDeMission`, sous `peutPiloterMissionsAdam`). Les gestes de conduite d'une mission d'exécution
restent au Super Admin propriétaire (`pilotable` dans `MissionRuntimePanel`) ; ailleurs, la fiche se lit.

## Preuves

- `src/modules/assistant-ia/a1-adam-nom-menu.test.ts` — contre la base locale : menu d'un employé (Adam, pas de Chief of
  Staff), d'un employé sans Adam, du Super Admin ; règle des onglets ; redirections (pure) ; isolation des missions entre
  deux employés (liste, exécution, fiche) ; vue globale du Super Admin ; « Missions terrain ».
- `src/app/(app)/adam/redirections.test.ts` — les trois pages `/chief-of-staff/*` exécutées, cible de la redirection lue.
- Mis à jour à la nouvelle règle : `acces-super-admin.test.ts` (points d'appel), `adam-visibilite.test.ts`,
  `coque-adam.test.ts`, `nav-access-parcours.test.ts`, `s1-acces-personnels.test.ts`, `fil.test.ts`, `frontieres.test.ts`.
- Captures Playwright (serveur réel, iPhone et bureau) : `docs/assistant/preuves/a1/`.
