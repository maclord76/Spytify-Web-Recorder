# Documentation technique — Spytify Web Recorder

État documentaire : **8 septembre 2026**. Version déclarée : **1.14.4**.

## Périmètre

`Chrome-Extension/` contient une extension Chrome autonome Manifest V3. Elle
capture l'audio de l'onglet Spotify Web actif et l'encode localement en MP3.
Elle ne requiert ni application Windows compagnon, ni serveur, ni compte autre
que la session Spotify Web que l'utilisateur choisit d'utiliser.

## Architecture

| Élément | Rôle |
| --- | --- |
| `manifest.json` | Déclare Manifest V3, Chrome 116 minimum, les permissions, l'action et le panneau latéral. |
| `popup.html`, `popup.css`, `popup.js` | Interface du panneau latéral, URL de morceau, débit MP3, préparation, démarrage et arrêt. |
| `background.js` | Service worker : messages, état, onglet Spotify, document hors écran et téléchargement. |
| `content.js` | Lit le DOM Spotify : métadonnées, progression, fin et changement de morceau. |
| `player-control.js` | Pilote le lecteur avec un attachement temporaire à `chrome.debugger`. |
| `playback-verification.js` | Confirme le démarrage grâce à la progression réelle de lecture. |
| `offscreen.html`, `offscreen.js` | Gèrent la capture et l'encodage dans un document hors écran. |
| `audio-worklet.js` | Reçoit et traite les échantillons PCM via `AudioWorklet`. |
| `core.js` | Fonctions partagées : URL, métadonnées, nom de fichier et balises ID3v2.4. |
| `vendor/` | Encodeur lamejs 1.2.1 ; ses notices doivent rester distribuées. |
| `tests/` | Tests Node.js et contrôles de fumée navigateur. |

## Flux d'enregistrement

1. L'utilisateur ouvre un morceau Spotify depuis son URL.
2. L'extension actualise l'onglet, vérifie le morceau et arme la capture de
   l'onglet sans encoder de silence.
3. Le geste explicite de démarrage commande la lecture et active l'encodage.
4. La progression confirme que la lecture a réellement commencé.
5. La fin, le changement de morceau ou l'arrêt manuel finalise le MP3 ; une
   limite de durée côté encodeur sert de garde-fou complémentaire.

L'audio suit le chemin `chrome.tabCapture` → Web Audio / `AudioWorklet` →
lamejs. Les débits disponibles sont 128, 192, 256 et 320 kbit/s ; la valeur
initiale est 192 kbit/s. Les téléchargements sont placés dans `Spytify Web/`
sous le dossier de téléchargement du navigateur. Les balises peuvent inclure le
titre, l'artiste, l'album et la pochette lorsque Spotify les rend disponibles.

## Données et permissions

`chrome.storage.local` conserve notamment `recorderState`, `lastTrackUrl` et
`bitrate`. L'extension ne transmet pas l'audio à un serveur.

Permissions déclarées : `debugger`, `downloads`, `offscreen`, `scripting`,
`sidePanel`, `storage`, `tabCapture`, `tabs`.

Hôtes autorisés : `https://open.spotify.com/*`, `https://*.scdn.co/*` et
`https://*.spotifycdn.com/*`.

`tabCapture` impose un geste utilisateur sur l'onglet Spotify. Après une erreur
d'autorisation, l'utilisateur doit garder l'onglet Spotify visible puis cliquer
l'action Spytify dans la barre d'outils pour reprendre la préparation sur cet
onglet précis.

## Installation et maintenance

Chargez `Chrome-Extension/` comme extension non empaquetée depuis
`chrome://extensions`, avec le mode développeur activé. Rechargez l'extension
après toute modification. Le guide utilisateur détaillé est
`Chrome-Extension/README.md`.

Les archives ZIP et fichiers MP3 sont des sorties locales et sont exclus de
Git. La source à publier est le contenu du dépôt, notamment
`Chrome-Extension/` et les documents racine.

## Vérifications

Depuis la racine sous PowerShell :

```powershell
npm.cmd --prefix Chrome-Extension test
```

Cette commande lance huit suites Node : fonctions communes, contenu Spotify,
commande du lecteur, confirmation du démarrage, AudioWorklet, capture armée,
panneau latéral et autorisation.

Des contrôles de fumée navigateur sont disponibles avec un navigateur lancé en
débogage distant :

```powershell
node Chrome-Extension/tests/popup-smoke.mjs <port>
node Chrome-Extension/tests/audio-worklet-smoke.mjs <port>
```

Les tests Node et les contrôles de fumée ne prouvent pas un enregistrement réel
dans Spotify Web. Une validation manuelle distincte reste nécessaire pour la
connexion Spotify, l'autorisation de capture, le démarrage de la lecture et le
MP3 téléchargé. L'extension ne contourne ni ne désactive le DRM.

## Publication GitHub

Avant de publier, vérifier la cohérence de version entre `package.json`,
`manifest.json` et les documents ; exécuter les tests ; vérifier les fichiers
staged pour exclure profils Chrome, archives, MP3, secrets et journaux ; et
conserver les notices de dépendances. Le guide technique précédent est conservé
à titre historique dans `docs/HISTORIQUE-TECHNIQUE-v1.13.0.md`.
