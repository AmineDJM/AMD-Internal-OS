# `src/platform/ia/` — le socle IA

Ce que partagent les deux assistants du dépôt : **Adam** (le Chief of Staff du Super Admin, `lib/assistant*`) et
l'**Assistant IA** (« Adventum Brain », chacun selon ses droits, `lib/agent/`). Le socle n'appartient à aucun des deux et
**n'importe ni l'un ni l'autre** — décision [`0013`](../../../docs/assistant/decisions/0013-jarvis-architecture.md),
tenue par `frontieres.test.ts` et ESLint.

| Chemin | Rôle |
|---|---|
| `outil.ts` | `PowerTool` — la forme d'un outil qu'un assistant appelle |
| `outils/arguments.ts` | lecture des arguments du modèle (`asStr`, `asNum`, `fold`), recherche et résolution de personnes |
| `lectures/` | annuaire, Regulatory, circuits de validation, résultats vides, échecs de capacité ; `connaissance.ts` (J4) : Bibliothèque et faits confirmés pour un modèle ; `graphe.ts` (J9) : graphe de l'entreprise et faits datés (module `graphe-entreprise`) |
| `capacites/` | J6 (décision 0020) : le REGISTRE DES CAPACITÉS — pur, dérivé du contrat des actions (reçu du module avec trois ports) : fiche, schéma JSON + zod, risque R0 → R4, famille (`familles.ts`, la liste de la console), simulable, annulation, porte d'écran, refus ; cliché relu `classement.genere.json` |
| `modeles-roles.ts` | J4 : le modèle de chaque geste (rapide, standard, raisonnement) et l'effort de raisonnement adaptatif — OpenAI seul |
| `lectures/` | annuaire, Regulatory, circuits de validation, résultats vides, échecs de capacité ; `connaissance.ts` (J4) : Bibliothèque et faits confirmés pour un modèle |
| `modeles-roles.ts` | J4 : le modèle de chaque geste (rapide, standard, raisonnement) et l'effort de raisonnement adaptatif — OpenAI seul ; J13 : la transcription de terrain (`gpt-transcribe`, mesuré) et la voix (`gpt-live-1`, réglable) |
| `voix/` | J13 (décision 0025) : la session GPT-Live (échange SDP côté serveur, délégation « client ») et le client WebRTC mince (navigateur) — zéro import, Adam garde le sien |
| `intentions/` | une écriture proposée devient une intention en base (`AssistantActionIntent`) ; propositions périmées |
| `drive.ts` | un fichier du Drive désigné par son nom, relu à l'exécution (droits revérifiés) |
| `web-research.ts` | la recherche web (passerelle `lib/models/`) |
| `media/` | ffmpeg (image d'une vidéo), pièces jointes (texte, OCR, transcription), porte des médias |
| `artifact/` | la fabrique de documents (`factory`), les artefacts Live Office (ports, store, rendu) ; `artifact/atelier/` (J3) : gestes → commandes par format, onglets, revue, conversions |
| `teach/store.ts` | les règles enseignées (dont les standards documentaires que lit la fabrique) |
| `proprietaire.ts` | le propriétaire d'un travail (relu en base, droits compris) |
| `hors-requete.ts` | J8 : un geste métier hors requête (`lib/contexte-geste.ts`) ; J7 (décision 0029) : la simulation transactionnelle (`simulerEnDiff`), le journal des effets (`journaliserGeste`), l'annulation honnête (`annulerGeste`, `planDAnnulation`, `gestesDeLAssistant`) — un seul import vers l'ERP, `lib/effets/` derrière |
| `telemetry/usage-sink.ts` | le puits d'usage des modèles — branché par chaque module qui appelle un modèle |
| `analyse/` | K1 (décision 0031) : le moteur d'analyse DÉMÉNAGÉ du bac à sable d'Adam (`analyse`, `pipeline`, `viz`, `porte`, `js`, `python`) ; `bloc.ts` (des lignes calculées au bloc `analyse`), `journal.ts` (les formules lisibles), `affichage.ts` (pur, navigateur compris), `tableur.ts` (XLSX/CSV typés), `drive.ts`, `classeur.ts` (l'Excel vérifié), `lecture.ts`, `sql.ts` (la seule porte vers le SQL de l'ERP) |
| `workspace/`, `ecrans/` | le protocole des blocs de l'espace de travail et leurs composants d'écran ; `workspace/analyse.ts` + `ecrans/blocks/analyse.tsx` : le bloc d'analyse (K1) |

Il connaît l'ERP, comme le pont `in-process/` : ses imports vers l'ERP sont plafonnés à part (`boundary.test.ts`,
`SOCLE_IA_CEILING`). Un besoin neuf passe par un port, pas par un relèvement. Un test qui exerce le socle **à travers**
Adam reste côté Adam.
