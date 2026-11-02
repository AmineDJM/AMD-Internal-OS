#!/usr/bin/env bash
#
# MESURE DU PIC MÉMOIRE DU BUILD — la garde contre le retour de l'OOM Render.
#
# Render tue le build à 8 Go. La machine de développement, elle, a 16 Go et ne dit rien :
# une régression mémoire y passe inaperçue jusqu'au déploiement. Ce script rend le pic
# VISIBLE et le compare à un plafond.
#
# Il échantillonne le RSS de TOUT l'arbre de processus node (le parent ET ses workers) —
# c'est bien la somme qui compte, puisque c'est ce que le conteneur de build additionne.
#
#   npm run build:measure              # plafond par défaut : 4200 Mo
#   BUILD_MEM_LIMIT_MB=3800 npm run build:measure
#
# Sortie non nulle si le pic dépasse le plafond, pour qu'une CI puisse s'en servir.
set -u

# Plafond : 4200 Mo sous Next 14. Next 15 mesure 5150 Mo (tas 3584, ci-dessous) : le plafond suit
# la mesure avec ~8 % de marge, et reste sous la ligne utile de Render (8 Go moins node_modules
# 1,3 Go et .next ~0,6 Go dans le même conteneur).
LIMIT_MB="${BUILD_MEM_LIMIT_MB:-5600}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# ── ON MESURE LA CONFIGURATION QUI PART EN PRODUCTION, PAS UNE AUTRE ────────────────────
#
# C'est le défaut qui a laissé passer la régression d'août : le script mesurait un `next
# build` NU, tandis que Render lance `build:render` avec un plafond de tas explicite. Deux
# configurations différentes, donc deux chiffres qui ne se comparent pas — et une garde qui
# annonçait « sous le plafond » pendant que le déploiement mourait à 8 Go.
#
# Le plafond de tas est le levier lui-même : V8 laisse un processus grossir jusqu'à sa limite
# avant de ramasser sérieusement. Mesuré sur un build propre, un seul chiffre changé :
#   4096 Mo → pic 5272 Mo (un worker de compilation à 5114)
#   3072 Mo → pic 3743 Mo, build OK      ← retenu sous Next 14
#   2048 Mo → le worker de compilation MEURT (SIGABRT, « heap out of memory »)
# Next 15.5.28 (10/2026) : le worker de compilation serveur MEURT à 3072 Mo ; 3584 Mo → pic
# 5150 Mo, build OK ← retenu ; 4096 Mo → pic 5612 Mo. Détail : `TAS_DU_BUILD_MO`, next.config.mjs.
# La valeur retenue doit donc rester alignée sur celle de `build:render` dans package.json.
HEAP_MB="${BUILD_HEAP_MB:-3584}"
export NODE_OPTIONS="--max-old-space-size=${HEAP_MB}"

# Un build PROPRE : le cache .next masquerait le vrai coût, et Render part d'un dossier vide.
rm -rf .next

echo "Build propre en cours (tas : ${HEAP_MB} Mo/processus — plafond : ${LIMIT_MB} Mo)..."
LOG="$(mktemp)"
npx next build > "$LOG" 2>&1 &
BUILD_PID=$!

PEAK=0
PEAK_PROCS=0
while kill -0 "$BUILD_PID" 2>/dev/null; do
  READING=$(ps -eo rss,comm --no-headers 2>/dev/null \
    | awk '$2 ~ /^(node|next)/ { s += $1; n += 1 } END { printf "%d %d", int(s/1024), n }')
  TOTAL=${READING% *}
  PROCS=${READING#* }
  [ "${TOTAL:-0}" -gt "$PEAK" ] && PEAK=$TOTAL
  [ "${PROCS:-0}" -gt "$PEAK_PROCS" ] && PEAK_PROCS=$PROCS
  sleep 0.5
done

wait "$BUILD_PID"; CODE=$?
tail -5 "$LOG"; rm -f "$LOG"

# ── LA SECONDE FACE DU PLAFOND RENDER : les OCTETS ÉCRITS comptent aussi ────────────────
#
# Le « over 8GB » de Render est un plafond de CONTENEUR : processus + fichiers du workspace
# (node_modules, cache npm, .next). Un pic processus sous 4 Go peut donc mourir quand même
# si le build écrit 1 Go de cache webpack non compressé par-dessus. On affiche les octets
# pour que la garde voie les deux faces.
NEXT_MB=$(du -sm .next 2>/dev/null | cut -f1)
WPCACHE_MB=$(du -sm .next/cache/webpack 2>/dev/null | cut -f1)

echo
echo "─────────────────────────────────────────────"
echo "PIC MÉMOIRE (arbre node) : ${PEAK} Mo"
echo "PROCESSUS NODE MAX       : ${PEAK_PROCS}"
echo "TAS PAR PROCESSUS        : ${HEAP_MB} Mo (comme build:render)"
echo "PLAFOND                  : ${LIMIT_MB} Mo"
echo ".next ÉCRIT              : ${NEXT_MB:-?} Mo (cache webpack : ${WPCACHE_MB:-?} Mo)"
echo "BUILD                    : code de sortie ${CODE}"
echo "─────────────────────────────────────────────"

if [ "$CODE" -ne 0 ]; then
  echo "ECHEC : le build lui-meme a echoue."
  echo "Si le journal dit « heap out of memory » ou « build worker exited ... SIGABRT »,"
  echo "c'est le TAS qui est trop bas, pas le code : le graphe a grossi. Remonter"
  echo "BUILD_HEAP_MB *et* la valeur de build:render, puis re-mesurer le pic."
  exit "$CODE"
fi

if [ "$PEAK" -gt "$LIMIT_MB" ]; then
  echo "ECHEC : pic ${PEAK} Mo > plafond ${LIMIT_MB} Mo."
  echo "Pistes verifiees par le passe : plafond de tas par processus (build:render),"
  echo "parallelisme (experimental.cpus), minification serveur"
  echo "(experimental.serverMinification), taille des gros modules de src/lib."
  exit 1
fi

echo "OK : pic sous le plafond."
