# `src/lib/effets/` — simulation, journal des effets, annulation, fenêtre d'annulation

Décisions : [0029](../../../docs/assistant/decisions/0029-simulation-annulation.md) (J7 : simulation, journal, annulation
honnête) et [0038](../../../docs/assistant/decisions/0038-reversibilite-communications.md) (K10b : fenêtre d'annulation des
effets sortants, geste d'écran réversible, rétablissement).

| Fichier | Rôle |
|---|---|
| `magasin.ts` | Le contexte du geste (`AsyncLocalStorage` sans dépendance) : mode, principal, capture, `gesteId` réservé, `fenetre`. |
| `geste.ts` | Le geste hors requête (J8) ; `etatPour` fait hériter un geste imbriqué (simulation, capture, fenêtre). |
| `capture.ts`, `client.ts` | L'extension Prisma qui note chaque écriture (avant / après). |
| `simulation.ts`, `diff.ts` | La simulation dans une transaction annulée ; le diff et son empreinte. |
| `journal.ts` | `journaliserGeste` : le geste en réel, sous capture, inscrit au journal (`AssistantGesteJournal`, `AssistantEffet`). |
| `annulation.ts` | `annulerGeste` / `planDAnnulation` : une issue par effet (annulé, compensé, impossible, sans objet). |
| `retablissement.ts` | `retablirGeste` : une annulation s'annule (ce qui a bougé depuis est dit, jamais écrasé). |
| `fenetre.ts` | **La fenêtre d'annulation des effets sortants** (ci-dessous). |
| `executeurs.ts` | Ce que le worker appelle quand la fenêtre est passée, et la compensation de chaque type. |
| `ecran.ts` | `gesteReversible` : le corps d'une action de l'ERP sous le journal → bouton « Annuler » de la barre. |

## La fenêtre d'annulation — `differerEffetSortant`

Un courriel, une notification poussée, une publication, une diffusion, un appel d'API externe ou un ordre transmis
**ne part pas au moment du geste** : il attend `AssistantIaReglage.fenetreAnnulationSecondes` (défaut **120 s**, réglable
par le Super Admin dans Administration › IA › Accès, 10 s à 15 min) dans la table `EffetSortantDiffere`.

```ts
import { differerEffetSortant } from "@/lib/effets/fenetre"; // ou "@/lib/contexte-geste"

const { id, executeLe, delaiSecondes } = await differerEffetSortant({
  type: "courriel.api",              // la clé de l'exécuteur (executeurs.ts) — ajoutez la vôtre
  acte: "COURRIEL",                  // COURRIEL | NOTIFICATION_PUSH | ECRITURE_EXTERNE | RESEAU | PAIEMENT…
  cible: "fournisseur@exemple.dz",   // ce que l'écran affiche (« Courriel à … part dans 1:42 »)
  apercu: "« Bon de commande BC-42 »",
  charge: { to: ["fournisseur@exemple.dz"], subject: "…", text: "…" }, // sérialisée (les Buffer en base64)
  objet: { modele: "PurchaseOrder", id: bc.id },  // facultatif : l'historique de la fiche le montre
  // principalId : défaut, le principal du geste en cours ; delaiSecondes : défaut, le réglage
});
```

| Moment | Geste | Issue |
|---|---|---|
| dans la fenêtre | `annulerEffetSortant(id, user)` | **ANNULE** — rien n'est parti (audit). |
| après une annulation | `retablirEffetSortant(id, user)` | **RETABLI** — repart pour une fenêtre neuve. |
| fenêtre passée | worker : `executerEffetsSortantsDus()` (tâche `effets.sortants` + réveil du web) | **PARTI** (réclamation atomique : jamais deux envois ; 3 tentatives puis **ECHEC**). |
| après le départ | `annulerEffetSortant` → `compenserEffetSortant` | **COMPENSE** — la compensation de l'exécuteur (un rectificatif, lui-même différé et annulable), ou **IMPOSSIBLE** avec la phrase honnête. Jamais « effacé chez le destinataire ». |

**Le port** — `differerSiFenetre(demande)` est appelé par chaque primitive de sortie juste après `noterEffetExterne`
(`mail.ts` `sendMail`, `mail-smart.ts` `sendSmartEmail`, `mail/graph/provider.ts` `send`, `push.ts` `sendPushToUser`). Sous
un geste journalisé (`journaliserGeste`, fenêtre armée par défaut — `{ fenetre: false }` pour s'en passer), il diffère et
la primitive rend un succès sans sortir ; hors geste (le worker qui exécute), elle sort. L'effet capturé porte
`differeId` → colonne `AssistantEffet.effetSortantId` : `annulerGeste` annule l'envoi avec le reste du geste.

**Ajouter un type** (K10a : ordre de paiement ; K10c : appel externe…) : une ligne dans `EXECUTEURS` (`executeurs.ts`)
— `executer(charge, ligne)` (lève en cas d'échec), et `compensation(charge, ligne, motif)` qui rend `{ charge, phrase }`
(un effet inverse à différer), `{ fait }` (déjà fait) ou `null` + `sansCompensation` (la phrase qui dit pourquoi rien).
Pour un test : `enregistrerExecuteur(type, executeur)`.

## Le geste d'écran réversible — `gesteReversible`

```ts
export async function createMailEntry(fd: FormData) {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "mail-register-actions:createMailEntry", libelle: "Courrier enregistré" }, async () => {
    // … le corps d'origine, inchangé
  });
}
```

Le corps s'exécute sous le journal des effets (origine `ecran`) ; la barre « Annuler » de l'application
(`modules/assistant-ia/ecrans/barre-annulation.tsx`) le propose une minute, l'historique de la fiche
(`HistoriqueAnnulable modele="MailEntry" id=…`) le garde. Sous une carte de l'assistant, rien n'est ouvert en double.
