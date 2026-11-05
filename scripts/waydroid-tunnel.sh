#!/bin/bash
# Tunnel SSH inverse : expose un appareil Android (Waydroid, ou tout hôte adb)
# de la machine locale au Codespace, pour que `adb` y fonctionne alors que
# l'appareil n'est joignable que depuis le réseau local.
#
# Principe : `gh codespace ssh -R` ouvre un tunnel inverse. Le port 5555 de
# l'appareil (côté machine locale) devient joignable sur le Codespace sous
# `localhost:5555`. Côté Codespace, on branche ensuite `adb connect localhost:5555`.
#
# À exécuter SUR LA MACHINE LOCALE (celle qui voit l'appareil Waydroid), pas
# dans le Codespace. Exemple MX Linux :
#
#   bruneel@bruneel:~$ gh codespace ssh -c fuzzy-palm-tree-g4rr9w5wj574c54x \
#                        -- -N -R 5555:192.168.240.112:5555
#
# Usage :
#   ./scripts/waydroid-tunnel.sh                      # codespace courant, appareil par défaut
#   ./scripts/waydroid-tunnel.sh -c <codespace>       # nom explicite du codespace
#   ./scripts/waydroid-tunnel.sh -d <hote:port>       # appareil adb explicite
#   ./scripts/waydroid-tunnel.sh -p 5555              # port d'écoute côté Codespace
#
# Variables d'environnement équivalentes : CODESPACE, ADB_DEVICE, REMOTE_PORT.
#
# Note : -N n'exécute aucune commande distante (tunnel seul) ; -R crée le
# tunnel inverse. Le tunnel reste ouvert au premier plan : Ctrl+C pour fermer.
set -euo pipefail

# --- valeurs par défaut ----------------------------------------------------
CODESPACE="${CODESPACE:-}"
ADB_DEVICE="${ADB_DEVICE:-192.168.240.112:5555}"
REMOTE_PORT="${REMOTE_PORT:-5555}"

# --- analyse des options ---------------------------------------------------
while getopts ":c:d:p:h" opt; do
  case "$opt" in
    c) CODESPACE="$OPTARG" ;;
    d) ADB_DEVICE="$OPTARG" ;;
    p) REMOTE_PORT="$OPTARG" ;;
    h)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    :)
      echo "❌ Option -$OPTARG attend un argument." >&2
      exit 2
      ;;
    \?)
      echo "❌ Option inconnue : -$OPTARG" >&2
      exit 2
      ;;
  esac
done
shift $((OPTIND - 1))

# --- vérifications ---------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  echo "❌ La commande 'gh' (GitHub CLI) est introuvable." >&2
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "⚠️  'adb' absent en local : le tunnel fonctionnera quand même," >&2
  echo "    mais la vérification de l'appareil sera ignorée." >&2
  ADB_PRESENT=0
else
  ADB_PRESENT=1
fi

# Le nom du codespace est facultatif : sans lui, gh utilise le codespace courant
# du dépôt (utile quand on est déjà dans le dépôt, hors du Codespace).
CODESPACE_ARGS=()
if [[ -n "$CODESPACE" ]]; then
  CODESPACE_ARGS=(-c "$CODESPACE")
fi

echo "→ Tunnel inverse : appareil ${ADB_DEVICE} → localhost:${REMOTE_PORT} du Codespace"

# --- contrôle de l'appareil (facultatif) -----------------------------------
if [[ "$ADB_PRESENT" == "1" ]]; then
  if adb connect "$ADB_DEVICE" >/dev/null 2>&1; then
    echo "  appareil joignable en local (adb connect ${ADB_DEVICE})"
  else
    echo "  ⚠️  'adb connect ${ADB_DEVICE}' a échoué : l'appareil est peut-être éteint." >&2
    echo "      Le tunnel sera tout de même ouvert." >&2
  fi
fi

echo
echo "→ Ouverture du tunnel (Ctrl+C pour fermer)…"
echo "  Côté Codespace, brancher ensuite :  adb connect localhost:${REMOTE_PORT}"
echo "  Puis :                              adb devices"
echo

# --- tunnel ----------------------------------------------------------------
# -N : pas de commande distante ; -R : redirection inverse ; -o : robustesse.
exec gh codespace ssh "${CODESPACE_ARGS[@]}" -- \
  -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R "${REMOTE_PORT}:${ADB_DEVICE}"
