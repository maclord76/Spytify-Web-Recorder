# Éléments techniques du projet Spytify

État vérifié le 5 septembre 2026.

## Projet actif

Le travail actuel porte sur `Chrome-Extension/`, l'extension autonome **Spytify Web Recorder**, version déclarée **1.13.0**. Le dernier ajout est le lien-bouton « Spotify ↗ » dans l'en-tête : il ouvre `https://open.spotify.com/` dans un nouvel onglet.

L'extension utilise du JavaScript natif, HTML et CSS, sans compilation ni installation npm nécessaire pour son utilisation.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `manifest.json` | Manifest V3, permissions, scripts et fenêtre de l'extension ; Chrome minimum 116 déclaré. |
| `popup.html`, `popup.css`, `popup.js` | Interface, saisie de l'URL, débit MP3, préparation, démarrage et arrêt. |
| `background.js` | Service worker : coordination des messages, état, onglet Spotify, document hors écran et téléchargement. |
| `content.js` | Lecture du DOM Spotify, métadonnées, progression, détection de fin ou changement de morceau. |
| `player-control.js` | Commande du lecteur via un attachement temporaire de `chrome.debugger`. |
| `playback-verification.js` | Confirmation du démarrage par la progression réelle de la lecture. |
| `offscreen.html`, `offscreen.js` | Capture et encodage dans un document hors écran. |
| `audio-worklet.js` | Traitement des échantillons PCM avec AudioWorklet. |
| `core.js` | Fonctions partagées : URL, métadonnées, nom de fichier et balises ID3v2.4. |
| `vendor/` | Encodeur lamejs 1.2.1 et licence LGPL ; conserver les notices. |
| `icons/` | Icônes de l'extension. |
| `tests/` | Tests Node et scripts de vérification dans Edge. |

## Parcours et données

1. Ouvrir un morceau Spotify depuis son URL.
2. Préparer le morceau : actualiser la page, vérifier le titre et armer le flux.
3. Sur le geste utilisateur de démarrage, commander la lecture et lancer l'encodage.
4. Confirmer la progression du lecteur ; effacer l'ancienne URL mémorisée.
5. Finaliser à la fin du morceau, au changement de titre ou sur arrêt manuel. Une limite de durée côté encodeur complète la détection du lecteur.

L'audio de l'onglet passe par `chrome.tabCapture`, Web Audio / AudioWorklet, puis lamejs. Débits proposés : 128, 192, 256 et 320 kbit/s ; valeur initiale 192 kbit/s. Les MP3 sont téléchargés dans `Spytify Web/` sous le dossier de téléchargement du navigateur. Les balises peuvent inclure titre, artiste, album et pochette.

`chrome.storage.local` conserve notamment `recorderState`, `lastTrackUrl` et `bitrate`. Aucun serveur compagnon n'est nécessaire.

## Permissions déclarées

`debugger`, `downloads`, `offscreen`, `scripting`, `storage`, `tabCapture`, `tabs`.
Les hôtes autorisés sont `open.spotify.com`, `*.scdn.co` et `*.spotifycdn.com`.

## Installation et maintenance

Dans `chrome://extensions`, activer le mode développeur, puis charger le dossier `Chrome-Extension` comme extension non empaquetée. Après modification, recharger l'extension et rouvrir sa fenêtre. Le guide utilisateur détaillé est `Chrome-Extension/README.md`.

L'archive `Spytify-Web-Recorder-Chrome-v1.13.0.zip` à la racine est reconstruite à partir du dossier courant. Le numéro de version reste 1.13.0 ; le contenu comprend le bouton Spotify ajouté après l'ancienne archive de cette version.

### Vérifications

Depuis la racine, sous PowerShell :

```powershell
npm.cmd --prefix Chrome-Extension test
```

Les six suites réussissent avec Node **24.15.0** : fonctions communes, lecteur et fin de lecture, commande du lecteur, confirmation du démarrage, AudioWorklet et capture armée.

Les contrôles dans Edge nécessitent un navigateur de test avec débogage local actif et une page appropriée ouverte. Remplacer `<port>` par son port de débogage :

```powershell
node Chrome-Extension/tests/popup-smoke.mjs <port>
node Chrome-Extension/tests/audio-worklet-smoke.mjs <port>
```

Ces contrôles navigateur et un enregistrement réel sur Spotify n'ont pas été rejoués pendant ce nettoyage. Les changements du DOM Spotify peuvent nécessiter une adaptation de `content.js` et des commandes du lecteur.

## État du dossier après nettoyage

La racine contient uniquement le dossier source `Chrome-Extension/`, l'archive courante `Spytify-Web-Recorder-Chrome-v1.13.0.zip` et ce document. Les fichiers de l'ancienne application Windows, les anciens profils Edge de test et les archives antérieures ont été retirés du projet.
