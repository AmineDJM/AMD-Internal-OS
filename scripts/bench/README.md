# Mesures de performance — téléversement & ingestion CTD

Ces scripts existent pour **trancher par la mesure** des questions où l'intuition se trompe. Ils
ont déjà servi à annuler une « optimisation » qui ralentissait l'application de moitié.

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" \
  npx tsx scripts/bench/<script>.ts [args]
```

| Script | Question tranchée |
| --- | --- |
| `upload.ts [taillesMo] [enVol]` | Bout en bout : ouverture de session → transfert des parties → finalisation. `npx tsx scripts/bench/upload.ts 4 8` = parties de 4 Mo, 8 en vol. |
| `finalize-phases.ts` | Où part le temps de la finalisation, phase par phase (assemblage, décompression, stockage des fichiers, archive originale). |
| `blob.ts` | Écriture des fichiers du dossier : séquentielle contre pool borné. |
| `ingest-pool.ts` | Effet du parallélisme d'ingestion sur le chemin complet. |
| `big-blob.ts` | Écriture d'UN gros blob : taille de tranche × écritures en vol. |
| `pg-bytea.ts` | Où est le plafond ? disque, chiffrement, Prisma, ou Postgres. |
| `toast.ts` | La compression TOAST de Postgres pénalise-t-elle un contenu chiffré (donc incompressible) ? |

## Ce que les mesures ont établi

**Postgres plafonne à ~11 Mo/s en écriture d'octets** (`pg-bytea.ts`), et c'est un mur : le disque
tient 356 Mo/s, le chiffrement AES-GCM ~800 Mo/s, et l'écriture brute en SQL est aussi lente que via
Prisma. Ni le découpage en tranches, ni le parallélisme, ni la désactivation de la compression TOAST
n'y changent quoi que ce soit (`big-blob.ts`, `toast.ts`). Tout le reste en découle :

- **Grossir les parties ralentit.** Sur 60 Mo à 8 envois en vol : 1 Mo → 8,2 s · 4 Mo → 9,0 s ·
  8 Mo → 10,8 s · 16 Mo → 16,3 s. Une grosse valeur `bytea` s'écrit moins vite, et il faut la relire
  ensuite pour réassembler l'archive (finalisation : 3,5 s à 4 Mo contre 13,8 s à 16 Mo).
- **Le parallélisme, lui, paie** : 9,6 s à un seul envoi, 5,2 s à deux, 4,3 s à quatre, palier ensuite.
- **L'archive originale dominait la finalisation** (~10 s sur 16 pour 60 Mo) : elle est désormais
  écrite en fond, hors du chemin critique.
- **Le seul levier d'un autre ordre de grandeur est le stockage objet** (`REG_S3_*`) : le navigateur
  écrit directement dans le bucket, et les octets cessent de traverser l'application puis Postgres.

⚠️ **Toujours mesurer dans un processus neuf, une taille par exécution.** Deux itérations dans le
même processus se contaminent : la seconde paie l'écriture de fond de la première et paraît deux
fois plus lente qu'elle n'est.

## Le banc de conversation d'Adam (`adam:bench`)

Vingt questions d'un dirigeant — lecture canonique, requête structurée, permission d'une déléguée, raisonnement
causal, documents, agrégation partenaire, mémoire de fil, anti-hallucination, actions, préparation de comité —
jouées contre le VRAI fournisseur, à travers `runAssistantStream` comme le navigateur, sur un jeu de données local
et jetable dont la vérité terrain est connue.

```bash
# 1. Semer le jeu (base LOCALE uniquement : localhost/127.0.0.1 + BENCH_SEED_ALLOW=1 ; manifeste incrémental)
BENCH_SEED_ALLOW=1 npm run adam:bench:seed          # --clean pour tout retirer
# 2. Jouer (clé fournisseur requise)
npm run adam:bench                                  # BENCH_ONLY=id1,id2  BENCH_REPEAT=2  BENCH_TAG=nom
```

Chaque tour rend un verdict déterministe (expressions attendues / interdites), le premier signe de vie, le premier
mot, le total, les appels par rôle, les jetons (entrée, sortie, cache, raisonnement), le coût, les outils appelés
et les phases (contexte, pré-lectures, outils, modèle). Le tableau par catégorie s'affiche en fin de run et le
détail part en JSON dans `bench-out/` (ignoré par git). Les tables AVANT/APRÈS de la campagne de 2026-09 sont dans
`bench-out/BASELINE-conversation.md` → `APRES-4-prompt-compact.md`.

Deux règles : le jeu ne se sème jamais sur une base distante (le script refuse), et un cas qui échoue est une
information — on corrige le produit ou le verdict, jamais le chiffre.

## Le banc « Jarvis » de l'Assistant IA (`assistant-jarvis-live.ts`)

Vingt-six scénarios (annuaire, RH, Regulatory, Ad & Pro, Drive, pièces jointes, vocal, tâche longue) joués en Super
Admin puis en assistante de direction, **par le fil gardé** (`deposerMessage` + `traiterFil`, comme l'écran
`/assistant`), avec verdicts automatiques, latence vue par l'écran et coût lu au journal de consommation. Semis :
`seed-assistant-jarvis.ts`, par-dessus celui d'Adam. Rapport et manques : `docs/bench/assistant-jarvis-live.md`.

```bash
BENCH_SEED_ALLOW=1 npm run adam:bench:seed
BENCH_SEED_ALLOW=1 npm run bench:live -- scripts/bench/seed-assistant-jarvis.ts
npm run bench:live -- scripts/bench/assistant-jarvis-live.ts      # JARVIS_ONLY=01-,17-  JARVIS_BUDGET_USD=5
```
