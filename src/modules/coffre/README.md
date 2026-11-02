# Module `coffre` — données sensibles chiffrées (socle métier, refonte R6 / V2-E)

IBAN, RIB, NIN, salaires : chaque écriture d'une colonne sensible écrit aussi sa copie chiffrée
(`DonneeSensible`), et chaque lecture en clair passe par la politique et laisse une trace
(`AccesDonneeSensible`). **Un modèle d'IA ne lit jamais le coffre** (décision de la Direction).

| Porte / dossier | Rôle | Qui l'importe |
|---|---|---|
| `partage.ts` | **Porte pure** : natures, colonnes sensibles, politique `peutLire`, types du dépôt | partout, navigateur compris |
| `api.ts` | **Porte d'écriture** (serveur) : clés, chiffrement, empreinte, `doubleEcrireCoffre`, contrôle d'accès. **Ne déchiffre jamais.** | actions serveur, pont d'Adam (`platform/in-process`) |
| `api-lecture.ts` | **Porte de lecture** (serveur) : tout `api.ts` + déchiffrement, service, lecture journalisée, journal, couverture | écrans RH / Legal / administration, porte d'écriture de l'enrichissement |
| `actions.ts` | Les interrupteurs `coffreEcriture` / `coffreLecture` (Super Admin), clé `coffre-actions` | `admin/refonte-donnees` |
| `domaine/` | `natures.ts`, `champs.ts`, `politique.ts`, `depot.ts` (le port) | — |
| `infra/` | `cle`, `chiffrement`, `dechiffrement`, `copies`, `ecriture`, `acces`, `lecteur`, `lecture`, `service`, `depot-prisma`, `depot-referentiel`, `journal`, `couverture` | — |

- **Pourquoi deux portes serveur** : les actions sont atteignables par l'assistant. Si elles importaient
  une porte unique qui réexporte aussi le déchiffrement, l'assistant l'atteindrait. `frontiere.test.ts`
  remonte les imports depuis l'assistant et les agents et refuse tout chemin vers `api-lecture.ts`.
- **Tables** : `DonneeSensible`, `AccesDonneeSensible` ; interrupteurs dans `AppSetting`.
- **Gardes** : `frontiere.test.ts` (client, IA), `garde-ecrivains.test.ts` (tout écrivain d'une colonne
  sensible appelle la double écriture), `ia-jamais.test.ts` (API v1, bac à sable SQL, filtre de contexte).
