# 0040 — Toute action réversible : communications, effets sortants, suppressions (lot K10b, 31/10/2026)

Demande de la Direction (31/10/2026, verbatim) : « Je veux que toutes les actions soient réversibles. Même celles qui ne le
sont pas : tu dois modifier l'ERP pour qu'elles le soient. Toute action qui a été faite peut être réversible. Ça doit être
dans n'importe quelle action du registre. » Contexte : la voix de l'Assistant IA exécute sur un « vas-y » oral (K9) ; la
sécurité vient de la réversibilité. Lot en trois sessions : K10a (argent), **K10b (communications, effets sortants,
suppressions — ce document)**, K10c (le reste, décision 0039). Suit [0029](0029-simulation-annulation.md) (J7 : journal
des effets, annulation honnête) — **aucun second système** : tout passe par le journal J7.

Migration additive et idempotente `20270217110000_fenetre_annulation_effets_sortants` : table `EffetSortantDiffere`,
colonnes `AssistantIaReglage.fenetreAnnulationSecondes` (défaut 120) et `AssistantEffet.effetSortantId`.

> Code : `src/lib/effets/` (`fenetre.ts`, `executeurs.ts`, `ecran.ts`, `retablissement.ts`, `declarations.ts`,
> `declarations/communications.ts`, README) ; ports `mail.ts`, `mail-smart.ts`, `mail/graph/provider.ts`, `push.ts`,
> `site-web/file.ts` ; `mail/executeur-sortant.ts` (Graph) ; barre `modules/assistant-ia/ecrans/barre-annulation.tsx`
> (coque) et ses actions (`actions-gestes.ts`) ; réglage `/admin/ai/acces` ; tests `src/lib/effets/fenetre.test.ts`,
> `src/lib/actions/reversibilite/` (banc + cas + cliquet).

## 1. Définition tenue

Une action est RÉVERSIBLE quand la personne qui l'a faite (ou le Super Admin — RBAC inchangé) l'annule d'un geste et que
l'ERP revient à l'état d'avant (**retour**), ou applique une **compensation** métier tracée quand l'effacement serait
faux, jamais une écriture effacée en silence. Une annulation se **rétablit**. Le journal des effets et l'audit gardent
qui, quand, quoi.

## 2. La fenêtre d'annulation des effets sortants — `differerEffetSortant`

Un courriel (SMTP, Microsoft Graph, API), une notification poussée, une publication au site, une diffusion, un appel
externe ne part pas au moment du geste : il attend `fenetreAnnulationSecondes` (**défaut proposé 120 s — décision de la
Direction à confirmer**, réglable de 10 s à 15 min dans Administration › IA › Accès, à l'audit).

| Moment | Issue |
|---|---|
| annulé dans la fenêtre | ANNULÉ — **rien n'est parti** (audit) ; se rétablit (fenêtre neuve) |
| fenêtre passée | le worker (tâche `effets.sortants`, réveil du web) l'exécute — réclamation atomique, jamais deux envois ; 3 essais puis ÉCHEC |
| annulé après le départ | COMPENSÉ — rectificatif au même destinataire (différé, annulable) ; une poussée affichée : IMPOSSIBLE, dit. **Jamais « effacé chez le destinataire »** |

Deux entrées : `differerEffetSortant(demande)` (appel explicite — **l'interface que K10a et K10c adoptent**) et
`differerSiFenetre` (le port, appelé par chaque primitive de sortie après `noterEffetExterne` : sous un geste journalisé,
fenêtre armée par défaut, l'effet est différé ; hors geste — le worker — il sort). Un nouveau type d'effet = une ligne
dans `executeurs.ts` (`executer`, `compensation`), ou `enregistrerExecuteur` depuis son domaine. La file du site web
(`SitePublication`) porte la même fenêtre (`nextAttemptAt` repoussé) ; partie, l'annulation renvoie la version d'avant
ou retire la page.

Les gestes externes **immédiats qui ont un inverse** (Microsoft : marquer lu, déplacer, brouillon) ne sont pas différés
(l'écran montre leur résultat) : `noterEffetFait` les trace PARTIS avec leur geste inverse, exécuté à l'annulation et
rejoué au rétablissement.

## 3. Le geste d'écran réversible — `gesteReversible`

Le corps d'une action de l'ERP s'exécute sous le journal des effets (origine `ecran`) ; l'action rend ce qu'elle rendait.
La **barre « Annuler »** de la coque propose le geste une minute (compte rendu honnête, puis « Rétablir ») et « Annuler
l'envoi » avec le compte à rebours pendant la fenêtre ; l'**historique de la fiche** (`HistoriqueAnnulable`, posé sur la
fiche courrier) garde les gestes et les envois de l'objet. Sous une carte de l'assistant, rien n'est ouvert en double.

## 4. Ce que J7 apprend (règles ajoutées à `annulation.ts`)

- **Tout ou rien pour un geste d'écran** (cascades) : si une écriture ne se défait pas (l'ordre de dépense né d'une
  approbation est déjà payé, une valeur a été changée par un autre), rien n'est annulé et la liste dit pourquoi — jamais
  d'état incohérent. Un effet externe impossible (poussée affichée) ne bloque pas : il est dit.
- **Pièces numérotées** (`LegalDocument` : facture, devis, BC, avoir) : jamais retirées, passées à ANNULÉE ; les
  **compteurs** (`DocumentSequence`, `DocumentReference`) ne reculent jamais — la série n'a ni trou ni doublon.
- **Notification déjà lue** : compensée par un rectificatif dans l'ERP (« n'en tenez plus compte »), au lieu d'« impossible ».
- **Rétablir** (`retablirGeste`) : refait ce que l'annulation avait défait, sous la même règle (verrou, relecture) ;
  ce qui a bougé depuis est dit, jamais écrasé. Le geste redevient annulable.
- La déconnexion Microsoft retire les liens de provenance un par un (journalisés) au lieu de la cascade invisible.

## 5. Le registre

Port `PortsRegistre.annulationDeclaree` (types.ts, sans toucher `ANNULATIONS`) ; table ERP `src/lib/effets/declarations.ts`
fusionnant une table par périmètre (`declarations/communications.ts` pour K10b). `capacites:classement` ne classe plus
« aucune » une action déclarée. Chaque déclaration a son cas « exécuter → annuler → rétablir → ré-annuler » contre la base
(`src/lib/actions/reversibilite/`), et le **cliquet** exige que les actions écrivantes du périmètre ne soient plus
« aucune » et que chaque déclaration ait son cas.

## 6. Limites et décisions de la Direction

- **Délai de la fenêtre** : 120 s proposé, à confirmer.
- Un courriel parti ne se reprend pas : la compensation est un rectificatif ; une notification poussée affichée ne se
  compense pas (dit).
- Les annulations par l'Assistant IA (voix) : l'assistant n'appelle pas les actions de la barre (surface hors assistant,
  décision 0029 §5) ; brancher un outil « annuler mon dernier geste » relève du lot voix (K9).
- Le portail fournisseur (connexion / déconnexion) n'a pas de session ERP : sa compensation est le geste inverse
  (se déconnecter / se reconnecter), la trace de sécurité reste.
