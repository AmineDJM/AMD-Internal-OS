#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# RESTAURER UNE SAUVEGARDE — le geste d'urgence, à la main, depuis un poste qui a `gpg` et le client
# PostgreSQL ≥ 16. Procédure complète : docs/readme/37-sauvegardes-restauration.md.
#
#   SAUVEGARDE_PHRASE=… scripts/sauvegarde/restaurer.sh amd-20261028T021700Z.dump.gpg "postgresql://…/nouvelle_base"
#
# La CIBLE doit être une base VIDE et NEUVE (jamais la production en service) : on vérifie, on bascule ensuite
# `DATABASE_URL` de Render sur elle. Le script refuse une cible qui contient déjà des tables.
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

fichier="${1:?Usage : restaurer.sh <fichier.dump.gpg> <url-de-la-base-cible>}"
cible="${2:?Usage : restaurer.sh <fichier.dump.gpg> <url-de-la-base-cible>}"
: "${SAUVEGARDE_PHRASE:?Poser SAUVEGARDE_PHRASE (la phrase de chiffrement des sauvegardes).}"

if [ -f "$fichier.sha256" ]; then sha256sum --check "$fichier.sha256"; else echo "⚠️  Pas d'empreinte à côté du fichier : intégrité non vérifiée."; fi

deja=$(psql "$cible" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
if [ "$deja" != "0" ]; then
  echo "❌ La base cible contient déjà $deja table(s) : restaurer dans une base VIDE et NEUVE."; exit 1
fi

travail=$(mktemp -d)
trap 'rm -rf "$travail"' EXIT
gpg --batch --yes --decrypt --passphrase-fd 3 --output "$travail/base.dump" "$fichier" 3<<<"$SAUVEGARDE_PHRASE"
pg_restore --no-owner --no-privileges --jobs=4 --dbname="$cible" "$travail/base.dump" || echo "⚠️  pg_restore a signalé des avertissements : lire le journal ci-dessus."

echo "── Contrôles ──"
echo "$(psql "$cible" -tAc 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL') migrations appliquées"
echo "$(psql "$cible" -tAc 'SELECT count(*) FROM "User"') comptes"
echo "$(psql "$cible" -tAc 'SELECT pg_size_pretty(pg_database_size(current_database()))') restaurés"
echo "✅ Restauration terminée. Étape suivante : docs/readme/37-sauvegardes-restauration.md §3 (bascule)."
