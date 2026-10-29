## 🏗️ Architecture du code

```
src/                                  # ~434 fichiers TS/TSX (hors tests) · 40 composants · 21 tests
├── app/
│   ├── (auth)/login/                  # connexion
│   ├── (app)/                         # shell authentifié (sidebar + topbar) — 86 pages
│   │   ├── mon-travail · mon-espace · messages · courrier · directives · assistant
│   │   ├── dashboard · regulatory · sponsoring · budgets · finances · rh
│   │   ├── congress-international · congress-national · events · sales · promo-material
│   │   ├── logistics · pch · stocks · medical · information-medicale · calendar · meetings
│   │   ├── business-development · validations · drive · documents · dossiers
│   │   ├── demandes (+ corbeille) · support · feedback · mon-dossier · missions
│   │   ├── adventum-brain · process-intelligence · admin · search
│   │   └── …                          # chaque module = liste + détail
│   ├── (portal)/portail/              # portail fournisseur (auth séparée)
│   ├── inscription/[id]/              # billetterie publique (hors auth)
│   └── api/                            # 32 routes
│       ├── auth/[...nextauth] · documents/[id] · drive/* · mail/*
│       ├── messaging/* · events/qr/[token] · field-reports/*
│       └── onlyoffice/{file,callback} · process-intelligence/synthesis
├── components/   ui/ · shared/ (DataTable, StatusBadge, DocumentPreview, ModuleTabs, ThirdPartyInvolveButton…) · layout/ · documents/ · dashboard/
├── lib/                                # 134 fichiers
│   ├── rbac.ts            # matrice + scoping row-level (cœur de la sécurité)
│   ├── session.ts         # requireUser / requireModule (gardes serveur)
│   ├── entity-access.ts   # contrôle d'accès par ligne (polymorphe) + ENTITY_MODULE
│   ├── refs.ts            # génération de références robuste (anti-collision P2002)
│   ├── third-party.ts     # « impliquer une tierce personne » (validation + dossier auto)
│   ├── dossiers-core.ts · medical-info.ts · expense-orders.ts · validation.ts
│   ├── audit.ts · notify.ts · labels.ts (libellés + navigation)
│   ├── ai.ts · assistant.ts          # couche IA + boucle agent
│   ├── mail.ts · onlyoffice.ts · print-document.ts · drive-storage.ts (chiffrement)
│   ├── actions/           # 54 fichiers de server actions par module
│   └── queries/           # 27 fichiers de requêtes agrégées (dashboard, action-center, budget…)
└── prisma/
    ├── schema.prisma      # 93 modèles, 86 enums, relations, index
    └── bootstrap.ts       # Super Admin initial (idempotent, aucune donnée de démo)
```

### Monolithe modulaire — `src/modules/` (depuis le lot V3-G, 2026-10-28)

Les métiers quittent progressivement `src/lib/` pour un dossier chacun, `src/modules/<module>/` : `api.ts` (porte
serveur), `partage.ts` (porte pure), `actions.ts`, `domaine/` (règles pures), `infra/` (base, fichiers), `ecrans/`.
Hors d'un module on n'importe que ses portes — tenu par ESLint et `src/modules/frontieres.test.ts`. Modules migrés :
`lieux`, `coffre`, `referentiels` (socle métier), `consommation` (pilote), `finances` (lot V4 : ordres de dépense,
centre de paiement, demandes de paiement, règlement, trésorerie — ex-`lib/finance/`, `lib/finances/`, `lib/payments/`), `ad-pro` (lot V4 : sponsoring, congrès,
événements, « autres », prise en charge, postes, porte du DG, centre, clôture — voir `src/modules/ad-pro/README.md`). Carte (`src/modules/carte.ts`), règles et
guide pas à pas « migrer un module » : [`docs/architecture/MODULES.md`](../architecture/MODULES.md).

> 🐍 Un prototype historique **Streamlit + SQLite** subsiste dans [`streamlit_app/`](streamlit_app/) — l'édition
> **Next.js + PostgreSQL** (ce dossier racine) est **le** produit de référence.

---

