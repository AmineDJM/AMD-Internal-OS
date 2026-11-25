#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# LA RECETTE UTILISATEUR DE BOUT EN BOUT — build de production, serveur local, base dédiée, rapport.
#
#   scripts/recette/lancer.sh                 # tout : build propre + serveur + graine + tous les parcours
#   scripts/recette/lancer.sh --prets         # seulement les parcours des lots déjà fusionnés
#   scripts/recette/lancer.sh --attente       # seulement les parcours marqués @attend-fusion:<lot>
#   scripts/recette/lancer.sh --sans-build    # réutilise le .next existant (déjà construit)
#   RECETTE_BASE=<base du serveur> scripts/recette/lancer.sh --url http://localhost:3217   # serveur déjà démarré
#     (la graine écrit dans la base que ce serveur lit ; RECETTE_LENT=1 si c'est `next dev`)
#   scripts/recette/lancer.sh -- --grep "Centre de paiement"  # options passées telles quelles à Playwright
#
# Variables : RECETTE_BASE (amd_recette), RECETTE_PG (postgresql://amd:amd@localhost:5432),
#             RECETTE_SORTIE (recette-sortie/<date>), RECETTE_PORT (premier port libre à partir de 3200).
#
# JAMAIS LA PRODUCTION : la base est locale et dédiée (créée si absente, migrée) ; la graine
# (e2e/recette/seed.ts) refuse toute base non locale ; le serveur démarre sorties INTERDITES
# (ADAM_SORTIE_INTERDITE=1 : aucun courriel, aucune notification poussée, aucun appel sortant), tâches de
# fond ÉTEINTES (TACHES_DE_FOND=worker sans worker : ni rappels, ni briefings IA, ni balayages pendant la recette),
# et des clés IA FACTICES — sauf si ANTHROPIC_API_KEY / OPENAI_API_KEY sont fournies (parcours « détection PV »).
# ═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE="tout"
CONSTRUIRE=1
URL_EXISTANTE=""
PW_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prets) MODE="prets" ;;
    --attente) MODE="attente" ;;
    --sans-build) CONSTRUIRE=0 ;;
    --url) URL_EXISTANTE="$2"; shift ;;
    --) shift; PW_ARGS=("$@"); break ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
  shift
done

# La SÉLECTION : `@attend-fusion` selon le mode ; `@ia-reelle` (détection PV par le modèle) seulement si une vraie clé
# ANTHROPIC_API_KEY est fournie — sinon il échouerait sur une clé factice sans rien dire du produit.
EXCLUS=()
[[ "$MODE" == "prets" ]] && EXCLUS+=("@attend-fusion")
[[ -z "${ANTHROPIC_API_KEY:-}" ]] && EXCLUS+=("@ia-reelle")
SELECTION=()
[[ "$MODE" == "attente" ]] && SELECTION+=(--grep "@attend-fusion")
if [[ ${#EXCLUS[@]} -gt 0 ]]; then SELECTION+=(--grep-invert "$(IFS='|'; echo "${EXCLUS[*]}")"); fi

BASE="${RECETTE_BASE:-amd_recette}"
PG="${RECETTE_PG:-postgresql://amd:amd@localhost:5432}"
export DATABASE_URL="$PG/$BASE"
export RECETTE_SORTIE="${RECETTE_SORTIE:-$PWD/recette-sortie/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$RECETTE_SORTIE"
SECRET="${NEXTAUTH_SECRET:-recette-secret-local-uniquement}"

case "$PG" in
  *@localhost*|*@127.0.0.1*) ;;
  *) echo "Recette refusée : $PG n'est pas un serveur PostgreSQL local." >&2; exit 1 ;;
esac

echo "▶ PostgreSQL"
if ! pg_isready -q -d "$PG/postgres" 2>/dev/null; then
  pg_ctlcluster 16 main start || true
  sleep 2
fi
if ! psql "$PG/postgres" -tAc "select 1 from pg_database where datname='$BASE'" | grep -q 1; then
  psql "$PG/postgres" -c "create database \"$BASE\"" >/dev/null
  echo "  base $BASE créée"
fi
echo "▶ Migrations sur $BASE"
npx prisma migrate deploy >/dev/null

SERVEUR_PID=""
# `npx` lance `next start` comme ENFANT : tuer npx seul laissait le serveur tourner (et tenir sa mémoire) après la recette.
arreter() { if [[ -n "$SERVEUR_PID" ]]; then pkill -TERM -P "$SERVEUR_PID" 2>/dev/null || true; kill "$SERVEUR_PID" 2>/dev/null || true; wait "$SERVEUR_PID" 2>/dev/null || true; fi; }
trap arreter EXIT

if [[ -n "$URL_EXISTANTE" ]]; then
  export RECETTE_URL="$URL_EXISTANTE"
else
  if [[ "$CONSTRUIRE" == "1" ]]; then
    # Build PROPRE : le cache .next peut masquer une erreur que le serveur de déploiement verrait (CLAUDE.md).
    echo "▶ Build de production (rm -rf .next && next build)"
    rm -rf .next
    npx prisma generate >/dev/null
    NODE_OPTIONS=--max-old-space-size=3584 npx next build > "$RECETTE_SORTIE/build.log" 2>&1 || { tail -40 "$RECETTE_SORTIE/build.log"; exit 1; }
  fi
  PORT="${RECETTE_PORT:-$(node -e '
    const net = require("net");
    const essayer = (p) => { const s = net.createServer(); s.once("error", () => essayer(p + 1)); s.listen(p, () => { s.close(() => console.log(p)); }); };
    essayer(3200);')}"
  export RECETTE_URL="http://localhost:$PORT"
  echo "▶ Serveur de production locale sur $RECETTE_URL"
  env NEXTAUTH_URL="$RECETTE_URL" NEXTAUTH_SECRET="$SECRET" \
    DRIVE_ENCRYPTION_KEY="${DRIVE_ENCRYPTION_KEY:-$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$SECRET")}" \
    ADAM_SORTIE_INTERDITE=1 TACHES_DE_FOND=worker SCHEDULER_DISABLED=1 WORKFLOW_SCHEDULER=off TRAVAUX_SWEEP=off \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-recette-cle-presente-non-utilisee}" OPENAI_API_KEY="${OPENAI_API_KEY:-recette-cle-presente-non-utilisee}" \
    npx next start -p "$PORT" > "$RECETTE_SORTIE/serveur.log" 2>&1 &
  SERVEUR_PID=$!
  for _ in $(seq 1 120); do
    if curl -fs -o /dev/null "$RECETTE_URL/login"; then break; fi
    sleep 1
  done
  curl -fs -o /dev/null "$RECETTE_URL/login" || { echo "Le serveur ne répond pas — voir $RECETTE_SORTIE/serveur.log" >&2; exit 1; }
fi

echo "▶ Parcours de recette (graine + navigateur) → $RECETTE_SORTIE"
set +e
npx playwright test -c playwright.recette.config.ts "${SELECTION[@]}" "${PW_ARGS[@]}"
CODE=$?
set -e
echo ""
echo "Rapport : $RECETTE_SORTIE/rapport.md  (JSON : rapport.json, captures : captures/)"
exit $CODE
