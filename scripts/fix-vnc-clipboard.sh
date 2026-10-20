#!/bin/bash
# Correctif du presse-papiers pour l'environnement VNC (noVNC).
#
# Problème : noVNC 1.1.0 ne synchronise pas le presse-papiers avec le navigateur.
# Le texte copié dans le bureau distant arrive dans un simple <textarea> qu'il faut
# ouvrir et copier à la main ; inversement, coller depuis le navigateur est fastidieux.
#
# Correctif appliqué :
#   1. le texte reçu du serveur est copié automatiquement dans le presse-papiers du navigateur ;
#   2. un bouton « Coller » envoie le presse-papiers du navigateur vers la session distante ;
#   3. les raccourcis Ctrl+Shift+V / Ctrl+Shift+C font la même chose au clavier.
#
# Usage : ./scripts/fix-vnc-clipboard.sh [nom_du_conteneur]   (défaut : relaxed_vaughan)
set -euo pipefail

CONTAINER="${1:-relaxed_vaughan}"
NOVNC_DIR="/usr/local/lib/web/frontend/static/novnc"

if ! docker exec "$CONTAINER" test -d "$NOVNC_DIR"; then
  echo "❌ noVNC introuvable dans $CONTAINER ($NOVNC_DIR)" >&2
  exit 1
fi

echo "→ Application du correctif presse-papiers dans $CONTAINER"

docker exec -i "$CONTAINER" python3 - "$NOVNC_DIR" <<'PYTHON'
import os
import sys

novnc = sys.argv[1]
ui_path = os.path.join(novnc, "app", "ui.js")
html_path = os.path.join(novnc, "vnc.html")
sync_path = os.path.join(novnc, "app", "clipboard-sync.js")

# --- sauvegardes -----------------------------------------------------------
for path in (ui_path, html_path):
    if os.path.exists(path) and not os.path.exists(path + ".orig"):
        with open(path, "rb") as src, open(path + ".orig", "wb") as dst:
            dst.write(src.read())

# --- ui.js ----------------------------------------------------------------
with open(ui_path, encoding="utf-8") as fh:
    ui = fh.read()

if "window.UI = UI;" not in ui:
    ui = ui.replace("export default UI;", "window.UI = UI;\n\nexport default UI;", 1)

old_receive = """    clipboardReceive(e) {
        Log.Debug(">> UI.clipboardReceive: " + e.detail.text.substr(0, 40) + "...");
        document.getElementById('noVNC_clipboard_text').value = e.detail.text;
        Log.Debug("<< UI.clipboardReceive");
    },"""
new_receive = """    clipboardReceive(e) {
        Log.Debug(">> UI.clipboardReceive: " + e.detail.text.substr(0, 40) + "...");
        document.getElementById('noVNC_clipboard_text').value = e.detail.text;
        // Copie automatique vers le presse-papiers du navigateur local.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(e.detail.text).catch(() => {});
        }
        Log.Debug("<< UI.clipboardReceive");
    },"""
if old_receive in ui:
    ui = ui.replace(old_receive, new_receive, 1)

old_send = """    clipboardSend() {
        const text = document.getElementById('noVNC_clipboard_text').value;
        Log.Debug(">> UI.clipboardSend: " + text.substr(0, 40) + "...");
        UI.rfb.clipboardPasteFrom(text);
        Log.Debug("<< UI.clipboardSend");
    },"""
new_send = old_send + """

    // Envoie le presse-papiers du navigateur local vers la session distante.
    clipboardPasteFromBrowser() {
        const field = document.getElementById('noVNC_clipboard_text');
        const send = (text) => {
            field.value = text;
            UI.rfb.clipboardPasteFrom(text);
        };
        if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(send).catch(() => {
                field.focus();
                field.select();
            });
        } else {
            field.focus();
            field.select();
        }
    },

    // Copie le presse-papiers de la session distante vers le navigateur local.
    copyClipboardToBrowser() {
        const text = document.getElementById('noVNC_clipboard_text').value;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    },"""
if "clipboardPasteFromBrowser()" not in ui:
    if old_send in ui:
        ui = ui.replace(old_send, new_send, 1)
    else:
        raise SystemExit("❌ Impossible de repérer clipboardSend() dans ui.js")

with open(ui_path, "w", encoding="utf-8") as fh:
    fh.write(ui)

# --- script d'appoint ------------------------------------------------------
sync = """// Ajout local : synchronisation du presse-papiers entre le navigateur et noVNC.
(function () {
    function whenReady(callback) {
        if (window.UI) {
            callback(window.UI);
            return;
        }
        const timer = setInterval(function () {
            if (window.UI) {
                clearInterval(timer);
                callback(window.UI);
            }
        }, 100);
    }

    whenReady(function (UI) {
        const panel = document.getElementById("noVNC_clipboard");
        const clearButton = document.getElementById("noVNC_clipboard_clear_button");
        if (panel && clearButton && !document.getElementById("noVNC_clipboard_paste_button")) {
            const pasteButton = document.createElement("input");
            pasteButton.id = "noVNC_clipboard_paste_button";
            pasteButton.type = "button";
            pasteButton.value = "Coller";
            pasteButton.title = "Envoyer le presse-papiers du navigateur vers la session";
            pasteButton.className = "noVNC_submit";
            pasteButton.addEventListener("click", function () {
                UI.clipboardPasteFromBrowser();
            });
            clearButton.parentNode.insertBefore(pasteButton, clearButton);
        }

        window.addEventListener(
            "keydown",
            function (event) {
                if (!event.ctrlKey || !event.shiftKey) {
                    return;
                }
                const key = (event.key || "").toLowerCase();
                if (key === "v") {
                    event.preventDefault();
                    UI.clipboardPasteFromBrowser();
                } else if (key === "c") {
                    event.preventDefault();
                    UI.copyClipboardToBrowser();
                }
            },
            true,
        );
    });
})();
"""
with open(sync_path, "w", encoding="utf-8") as fh:
    fh.write(sync)

# --- vnc.html --------------------------------------------------------------
with open(html_path, encoding="utf-8") as fh:
    html = fh.read()

if "clipboard-sync.js" not in html:
    html = html.replace(
        "</body>",
        '    <script src="app/clipboard-sync.js"></script>\n</body>',
        1,
    )
    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(html)

print("✔ ui.js, vnc.html et app/clipboard-sync.js mis à jour")
PYTHON

echo "✔ Correctif appliqué. Recharge la page noVNC dans ton navigateur (Ctrl+Shift+R)."
