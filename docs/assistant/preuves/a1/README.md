# Preuves du lot A1 — « un seul assistant : Adam » (décision 0056)

Captures prises sur un **serveur réel** (`next start`, build de production) branché sur la **base locale**
(`postgresql://amd:amd@localhost:5432/amd_internal_os`, `ADAM_SORTIE_INTERDITE=1`, aucune clé IA : rien ne part), par
`scripts/e2e/a1-adam.ts`. Le script sème quatre comptes de démonstration (domaine `@preuve-a1.local`) et une mission
confiée à Adam par trois d'entre eux, avec le moteur réel (`proposerTravail`), puis **asserte** chaque écran avant de le
photographier : une assertion qui tombe arrête le script.

| Compte | Rôle | Adam |
|---|---|---|
| Samia Benali | Super Admin | oui (d'office) |
| Amina Kaci | Déléguée médicale | ouvert dans la console |
| Bilal Haddad | Délégué médical | ouvert dans la console |
| Chafia Mansouri | Déléguée médicale | **non** |

## Ce qui est vérifié (bureau 1440×900 et iPhone 13)

- **Amina** : menu « Adam » et « Missions d'Adam », aucun « My Chief of Staff » ; accueil « Je suis Adam, l'assistant
  d'Amina » ; aucun onglet du Super Admin ; « Missions d'Adam » montre SA mission et pas celle de Bilal, sans vue globale ;
  la fiche `/missions/<id>` de Bilal rend 404 ; `/chief-of-staff` rend 404 (refus inchangé) ; « Mon espace › Missions
  terrain ». — `*-employe-*.png`
- **Chafia** (sans Adam) : ni Adam ni ses missions au menu ; `/centre-de-missions` rend 404.
- **Samia** : menu Adam + Missions d'Adam, plus de Chief of Staff ; `/chief-of-staff` → `/assistant` avec les onglets
  Conversation · Boîte de réception · Réglages d'Adam · Bureau d'Adam ; `/chief-of-staff/inbox` → `/adam/boite` ;
  `/chief-of-staff/reglages` → `/adam/reglages` ; le bureau dans son onglet ; vue globale nommant Amina et Bilal ; fiche
  de la mission d'Amina lisible, en lecture seule. — `*-sa-*.png`

Rejouer : construire (`npm run build`), démarrer `next start -p 3100` avec `DATABASE_URL` local, `AUTH_SECRET`,
`AUTH_TRUST_HOST=true`, `ADAM_SORTIE_INTERDITE=1`, puis
`DATABASE_URL=… BASE=http://localhost:3100 PW_CHROMIUM=/opt/pw-browsers/chromium npx tsx scripts/e2e/a1-adam.ts`.
