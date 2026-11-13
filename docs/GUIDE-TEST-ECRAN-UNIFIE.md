# Guide de test — écran de conversation unifié (B.3.5)

Version 1.0 — 2026-11-13. Ce guide active l'écran unifié **sans rebuild**, sur un build de développement existant, puis liste les scénarios à passer en premier.

## Préparation mémoire (HP ProBook 4 Go)

État relevé le 2026-11-13 :

- `free -h` : **3,3 Gi** de RAM, ~503 Mi libres, ~901 Mi disponibles ; **2,4 Gi utilisés** (Metro/API arrêtés).
- `swapon --show` : swap fichier **2 G** (`/swap/swap`, ~10 Mo utilisés) + **zram 1,6 G** actif (~1,3 G utilisés).
- Conclusion : **aucun ajout nécessaire** ; zram et swap sont déjà en place. Ne pas lancer Waydroid avant d'avoir libéré de la RAM.

Avant de démarrer : fermer navigateurs, éditeurs lourds et applications Electron non utilisées. Garder ZCode uniquement si nécessaire (il consomme plusieurs centaines de Mo). Vérifier avec `free -h` avant l'étape 4.

Si le swap venait à manquer (commandes sans redirection de sortie) :

```bash
sudo fallocate -l 2G /swap/swap2
sudo chmod 600 /swap/swap2
sudo mkswap /swap/swap2
sudo swapon /swap/swap2
printf '/swap/swap2 none swap sw 0 0\n' | sudo tee -a /etc/fstab
```

Pour zram, préférer l'outil déjà installé (`zramctl`, `systemctl status systemd-zram-setup@zram0`), ne pas reconfigurer à chaud pendant les tests.

### Ordre de lancement

1. **PostgreSQL** (déjà natif) : `pg_isready -h localhost -p 5432`.
2. **API** : `cd api && npm run start:dev`, attendre « Nest application successfully started ».
3. **Metro** : `cd mobile && EXPO_PUBLIC_API_URL=http://192.168.240.1:3001 npx expo start --dev-client`, attendre `Waiting on http://localhost:8081`.
4. **Waydroid en dernier** : `waydroid session start` puis lancement de l'app ; ne jamais démarrer Waydroid avant l'API et Metro.

Entre deux sessions de test : arrêter Metro et l'API (`Ctrl+C`), laisser Waydroid tourner uniquement si nécessaire.

## Dix premiers scénarios (dans l'ordre)

1. **Conversation historique en clair** : ouverture, historique, envoi texte, réception.
2. Clair : accusés (coches), réponse/citation, suppression pour moi.
3. Clair : photo + document (ouverture, fermeture, retour).
4. Clair : notes vocales (envoi, lecture).
5. Clair : brouillon (quitter/revenir), défilement long, pastille de retour.
6. **Conversation chiffrée** : ouverture, historique local, envoi texte, réception.
7. Chiffré : « Reçu » puis « Ouvert » (visibilité réelle 50 %/400 ms), jamais à la réception seule.
8. Chiffré : photo puis document ; vérifier la libération du clair à la fermeture et au retour de la route document.
9. Chiffré : transfert de texte vers une autre conversation chiffrée ; cible claire absente.
10. Chiffré : défilement inversé, mode inconnu hors ligne (attente sans compositeur), retour réseau.

Passer ensuite les scénarios 10 à 18 de la checklist principale (groupes, appels, TalkBack, FLAG_SECURE).

## Prérequis

- Un **development build** MboloChat installé (Waydroid ou appareil réel) : `expo-dev-client` est requis pour charger le bundle Metro. Un build EAS `development` convient.
- API et Metro démarrés, application connectée à Metro (`npx expo start --dev-client`).
- **Aucun build lourd local** n'est nécessaire : le drapeau est lu dans AsyncStorage au runtime.

## Activer le drapeau

1. Lancer l'application (elle affiche l'écran habituel).
2. Ouvrir la route développeur par deep link :

```bash
adb shell am start -a android.intent.action.VIEW -d "mbolochat://dev-flags"
```

> Sur un appareil physique, la même commande fonctionne avec `adb -s <serial>`. Depuis Expo, ouvrir `mbolochat://dev-flags` dans le navigateur de l'appareil fonctionne aussi.

3. Basculer **« Écran de conversation unifié »** sur activé.
4. Ouvrir n'importe quelle discussion : l'écran unifié remplace l'ancien. L'en-tête affiche la mention de sécurité (« Conversation chiffrée » ou « Historique en clair »).

La route `/dev-flags` redirige vers `/chats` hors build de développement : aucun utilisateur normal ne peut l'atteindre.

## Désactiver / revenir en arrière

- Rebourser le même interrupteur, **ou** effacer les données de l'application (le drapeau revient à « désactivé »).
- Drapeau désactivé = comportement strictement identique à aujourd'hui, y compris la redirection de `chat/[id]` vers `e2ee-chat/[id]`.
- Drapeau activé = `e2ee-chat/[id]` redirige vers `chat/[id]` ; l'écran unifié résout lui-même le mode.

## Scénarios prioritaires (extraits de `docs/CHECKLIST-VALIDATION-APPAREIL.md`)

| Priorité | Scénario | Attendu |
|---|---|---|
| 1 | Envoi texte clair, puis chiffré ; couper le réseau, écrire, rétablir | Bulle immédiate, reprise sans doublon |
| 2 | Réception dans les deux modes, app en arrière-plan puis retour | Un seul message, ordre correct |
| 3 | Média clair : photo, vidéo, PDF, album | Vignettes et visionneuses, aucune régression |
| 4 | Média chiffré : photo puis document ; fermer la visionneuse | Clair libéré (`closeMedia`), aucun média résiduel au démontage |
| 5 | « Supprimer pour moi » dans les deux modes ; « pour tous » en clair | Clair : disparition locale / « Message supprimé » chez le pair. Chiffré : aucune action « pour tous » |
| 6 | Accusés : envoi en clair (coches) ; envoi chiffré (Reçu/Ouvert) | « Ouvert » seulement si la bulle est réellement visible (50 %, 400 ms) ; jamais à la réception seule |
| 7 | Brouillon : taper, quitter, revenir, dans les deux modes | Clair : restauré. Chiffré : restauré depuis SQLCipher, aucune copie claire |
| 8 | Défilement chiffré : long historique, remonter, recevoir | Liste inversée, pas de saut, pastille de retour, « Ouvert » non déclenché par un message qui traverse l'écran |
| 9 | Menu d'appui long : texte, média, sticker | Actions filtrées par capacités ; réactions en clair uniquement |
| 10 | Groupes : rôle admin/membre, `whoCanSend=admins`, mentions | Permissions conservées, aucun groupe chiffré |
| 11 | Mode inconnu hors ligne : conversation jamais mise en cache | État d'attente **sans compositeur**, puis résolution au retour réseau |
| 12 | Anti-downgrade : lien/notification vers une conversation chiffrée | Jamais de compositeur clair |
| 13 | Sécurité d'écran chiffrée : sélecteur d'applications, capture | Aperçu neutre (`FLAG_SECURE`), selon le réglage existant |
| 14 | Appels : actifs en clair, refus explicite en chiffré | Aucun appel non chiffré depuis une conversation chiffrée |
| 15 | TalkBack : parcourir liste, coches, menus, erreurs | Tout est annoncé ; voir `docs/ACCESSIBILITE-FUSION-CHAT.md` |

## Limites connues de cette bascule

- Indicateur de frappe : présent en clair ; absent en chiffré (capacité `typing=false`).
- Transfert chiffré et fiche d'informations : non portés dans l'écran unifié à ce stade ; l'action n'est pas affichée.
- Galerie d'album : grille simplifiée (pas de visionneuse d'album unifiée).
- Pagination chiffrée : comportement actuel conservé (pas de chargement supplémentaire).

Consigner chaque KO avec une capture et le commit testé. La bascule ne doit être activée par défaut qu'après la validation complète et le retrait des anciens écrans (B.3.6).
