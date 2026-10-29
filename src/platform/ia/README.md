# `src/platform/ia/` — le socle IA

Ce que partagent les deux assistants du dépôt : **Adam** (le Chief of Staff du Super Admin, `lib/assistant*`) et
l'**Assistant IA** (« Adventum Brain », chacun selon ses droits, `lib/agent/`). Le socle n'appartient à aucun des deux et
**n'importe ni l'un ni l'autre** — décision [`0013`](../../../docs/assistant/decisions/0013-jarvis-architecture.md),
tenue par `frontieres.test.ts` et ESLint.

| Chemin | Rôle |
|---|---|
| `outil.ts` | `PowerTool` — la forme d'un outil qu'un assistant appelle |
| `outils/partages.ts` | les 5 outils qu'Adam prête à l'Assistant IA : schémas, 3 lectures, 2 propositions, résolution de personne |
| `outils/arguments.ts` | lecture des arguments du modèle (`asStr`, `asNum`, dates, priorités), recherche et résolution de personnes |
| `lectures/` | annuaire, Regulatory, circuits de validation, résultats vides, échecs de capacité |
| `intentions/` | une écriture proposée devient une intention en base (`AssistantActionIntent`) ; propositions périmées |
| `drive.ts` | un fichier du Drive désigné par son nom, relu à l'exécution (droits revérifiés) |
| `web-research.ts` | la recherche web (passerelle `lib/models/`) |
| `media/` | ffmpeg (image d'une vidéo), pièces jointes (texte, OCR, transcription), porte des médias |
| `artifact/` | la fabrique de documents (`factory`), les artefacts Live Office (ports, store, rendu) |
| `teach/store.ts` | les règles enseignées (dont les standards documentaires que lit la fabrique) |
| `proprietaire.ts` | le propriétaire d'un travail (relu en base, droits compris) |
| `telemetry/usage-sink.ts` | le puits d'usage des modèles — branché par chaque module qui appelle un modèle |
| `workspace/`, `ecrans/` | le protocole des blocs de l'espace de travail et leurs composants d'écran |

Il connaît l'ERP, comme le pont `in-process/` : ses imports vers l'ERP sont plafonnés à part (`boundary.test.ts`,
`SOCLE_IA_CEILING`). Un besoin neuf passe par un port, pas par un relèvement. Un test qui exerce le socle **à travers**
Adam reste côté Adam.
