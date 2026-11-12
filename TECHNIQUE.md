# Documentation technique — Spytify Web Recorder

État documentaire : **23 octobre 2026**. Version déclarée : **1.18.5**.

## Périmètre

`Chrome-Extension/` contient une extension Chrome autonome Manifest V3. Elle
capture l'audio de l'onglet Spotify Web actif et l'encode localement en MP3.
Elle ne requiert ni application Windows compagnon, ni serveur, ni compte autre
que la session Spotify Web que l'utilisateur choisit d'utiliser.

## Architecture

| Élément | Rôle |
| --- | --- |
| `manifest.json` | Déclare Manifest V3, Chrome 116 minimum, les permissions, l'action et le panneau latéral. |
| `popup.html`, `popup.css`, `popup.js` | Interface du panneau latéral, URL de morceau, débit MP3, démarrage et arrêt. Les couleurs reprennent les variables du thème sombre « Encore » de Spotify Web (surface `#121212`, éléments surélevés `#1f1f1f`). |
| `background.js` | Service worker : messages, état, onglet Spotify, lancement d'un morceau, document hors écran et téléchargement. |
| `content.js` | Lit le DOM Spotify : métadonnées, progression, fin et changement de morceau, uniquement pendant une session. |
| `spotify-player.js` | Connaissance partagée du lecteur Spotify : libellés lecture/pause de ses 69 langues, sélecteurs du titre, lecture du minutage et comparaison des titres. |
| `player-control.js` | Lance le morceau (et le ramène au début si besoin) par un vrai clic, avec un attachement temporaire à `chrome.debugger`. |
| `playback-verification.js` | Confirme le démarrage grâce à la progression réelle de lecture. |
| `offscreen.html`, `offscreen.js` | Gèrent la capture continue et l'encodage dans un document hors écran, pour les deux modes. |
| `monitoring.js` | Attribue les PCM aux titres, conserve trois secondes pour corriger les transitions, exclut les pauses et publicités détectées et finalise les segments. |
| `audio-worklet.js` | Reçoit et traite les échantillons PCM via `AudioWorklet`. |
| `core.js` | Fonctions partagées : URL, métadonnées, nom de fichier et balises ID3v2.4. |
| `vendor/` | Encodeur lamejs 1.2.1 ; ses notices doivent rester distribuées. |
| `tests/` | Tests Node.js et contrôles de fumée navigateur. |

## Flux d'enregistrement

Le mode « Un morceau » est une surveillance limitée au morceau demandé :

1. L'utilisateur colle l'URL d'un morceau (ou affiche sa page dans Spotify) et
   clique sur **Enregistrer le morceau**.
2. La capture continue de l'onglet est armée **avant** le chargement : un
   morceau que Spotify lance de lui-même dès l'ouverture de sa page est
   enregistré depuis son début.
3. L'onglet charge l'URL du morceau. Le service de fond attend la fin de ce
   chargement (passage par `loading` puis `complete`), puis lit le titre dans
   la page elle-même : le lecteur inférieur peut encore afficher le titre
   écouté précédemment.
4. Surveillance du démarrage : Spotify dispose de quatre secondes pour lancer
   le morceau. Une lecture confirmée (titre attendu et progression) ou une
   publicité en cours suffit : aucun clic n'est alors envoyé, car il mettrait
   le morceau en pause.
5. Sinon, l'extension lance le morceau par un vrai clic : bouton du lecteur
   inférieur s'il affiche ce morceau (ramené d'abord à 0:00 s'il est en pause
   au milieu), sinon gros bouton de la page. Chaque lancement est confirmé
   pendant huit secondes ; après deux essais, la session est abandonnée sans
   télécharger d'extrait.
6. La fin du morceau, le passage à un autre titre ou l'arrêt manuel arrête la
   session ; le MP3 du morceau demandé est alors téléchargé.

Seul le premier enregistrement du titre demandé est téléchargé. Les segments
d'un autre titre sont écartés, ainsi que les extraits finalisés en cours de
session (reste du titre affiché avant le chargement, saut dans le morceau) ;
un extrait n'est gardé qu'à l'arrêt de la session, avec la mention
`(extrait)`. Une mise en veille du service de fond pendant le lancement le
reprend sans recharger la page.

L'audio suit le chemin `chrome.tabCapture` → Web Audio / `AudioWorklet` →
lamejs. Les débits disponibles sont 128, 192, 256 et 320 kbit/s ; la valeur
initiale est 192 kbit/s. Les téléchargements sont placés dans `Spytify Web/`
sous le dossier de téléchargement du navigateur. Les balises peuvent inclure le
titre, l'artiste, l'album et la pochette lorsque Spotify les rend disponibles.

## Données et permissions

### Surveillance

L'activation arme une seule capture continue sans actualiser Spotify ou piloter
son player. Pendant la session, le content script observe le lecteur toutes les 250 ms et envoie
les changements horodatés de métadonnées, progression et lecture au document
hors écran. Celui-ci reçoit directement les messages de l'onglet surveillé :
le découpage continue pendant la veille du service worker. Une nouvelle
identité de titre doit être confirmée par deux observations séparées d'au
moins 200 ms pour éviter les métadonnées transitoires du rendu Spotify.

L'AudioWorklet horodate chaque bloc dans le temps de l'AudioContext. Les trois
dernières secondes de PCM sont conservées avant encodage. Une transition
attribue ces échantillons au titre approprié selon la progression observée ;
chaque segment a son propre encodeur lamejs. Les pauses ferment un intervalle
d'encodage et la reprise rouvre celui du même segment. Les sauts de progression
créent un nouveau segment. Aucun silence obligatoire ou fondu n'est supposé.
La progression arrondie de Spotify peut limiter la précision de la coupure.

Spotify n'affiche pas la fin d'un morceau terminé : il revient aussitôt à 0:00
en pause. Ce retour, depuis les trois dernières secondes, termine le segment
sans seconde observation. Le content script n'envoie ensuite plus rien et
Chrome ne livre aucun PCM tant que l'onglet se tait : le document hors écran
appelle donc `settle()` chaque seconde. Un changement affiché à l'arrêt
(titre ou saut) stable depuis deux secondes est confirmé ; sans PCM reçu
depuis deux secondes, le tampon est vidé et les segments terminés sont
exportés. Le dernier morceau est ainsi téléchargé deux à trois secondes après
sa fin, sans arrêt de la surveillance. L'AudioWorklet envoie son bloc entamé
dès que l'entrée devient vide : la fin du morceau n'attend pas le son suivant,
qui garde son propre horodatage. L'onglet peut aussi continuer à livrer du
silence après la fin (observé le 23 octobre 2026, avec un clip muet dans la
page) : la coupe ne dépend donc que du lecteur.

Le titre, l'artiste, l'album et la pochette sont lus dans le lecteur inférieur,
puis dans `navigator.mediaSession.metadata`, que Spotify renseigne pour les
commandes multimédias de Chrome, et en dernier recours dans le titre de
l'onglet, qui ne nomme le morceau que pendant la lecture. Une annonce y est
publiée sous son libellé traduit, sans artiste, ce qui suffit à la signaler.
Un relevé sans artiste, au titre vide ou identique, décrit encore le morceau
en cours : sa pause et sa fin sont prises en compte, et le journal le note
une fois par morceau (`identity_inherited`). Le 23 octobre 2026, aucun
sélecteur de titre ne trouvait le lecteur inférieur ; en pause à 0:00, le
morceau n'était plus identifié et restait ouvert jusqu'à l'arrêt.

Le signal `isAdvertisement` est prioritaire sur les métadonnées musicales.
Les marqueurs visibles et libellés publicitaires sont recherchés seulement
dans le lecteur inférieur ; un MutationObserver complète la minuterie pour
notifier leur apparition immédiatement. Une annonce ferme le segment musical
à son début estimé : d'après le dernier compteur du morceau et sa durée, sauf
si le compteur affiché par l'annonce a encore avancé. Resté figé sur la
dernière seconde, il ne prolonge pas le morceau : celui-ci a fini avant le
repérage, parfois plus d'une seconde avant (« Awake », 23 octobre 2026). Dans
cette dernière seconde, la position estimée ne dépasse pas la durée. Les PCM
publicitaires sont ensuite écartés sans interrompre le flux audible. La sortie attend un titre et des artistes identifiés dans
le lecteur, puis ouvre un nouveau segment au début estimé du morceau. Le
statut `advertisement` reste disponible pendant la veille du service worker.
La sortie exige deux observations séparées d'au moins 200 ms, avec une
identité, une durée et une progression cohérentes. Un retour à zéro ou une
durée publicitaire encore affichée recommence cette confirmation avant toute
création d'encodeur. La progression et la fin sont lues dans le lecteur
visible lorsque disponible, car l'élément audio peut conserver l'horloge et
l'état `ended` de l'annonce. Lorsque la durée du morceau est connue, la mention
`(extrait)` compare celle-ci à la durée des PCM récupérés, avec une tolérance
de deux secondes. Une estimation initiale de début manquant ne peut donc plus
imposer ce suffixe à une capture complète. Sans durée connue, cette estimation
reste utilisée. Le compteur additionne
les échantillons encodés et ceux du morceau encore en PCM, en excluant les
intervalles en pause et publicitaires.
Ce filtrage dépend du DOM Spotify et du tampon de trois secondes : de l'audio
déjà encodé avant une détection trop tardive ne peut pas être retiré.

Les exports MP3 et pochettes sont exécutés dans une file distincte de la
réception des PCM. La récupération d'une pochette expire après huit secondes.
Un refus de téléchargement est remonté au panneau et les exports suivants
continuent. L'arrêt finalise le dernier segment, attend les exports, ferme
le flux et l'AudioContext. Un identifiant de session empêche les anciens
messages de modifier le compteur d'une nouvelle surveillance. Le compteur
mesure les téléchargements acceptés par Chrome, sans garantir leur écriture
finale sur disque. Les titres incomplets reçoivent le suffixe `(extrait)`.
Le service worker fixe le nom demandé à Chrome à partir des métadonnées du
segment finalisé, même lorsque le player lit déjà le suivant. Le nom accepté
est conservé dans `lastMonitoredFilename` et affiché dans le panneau. L'API
de téléchargement reçoit `saveAs: false` et `conflictAction: "uniquify"`.

La restauration interroge le document hors écran et vérifie l'identifiant de
session. Un document absent ne provoque aucune nouvelle capture silencieuse.

### Stockage

`chrome.storage.local` conserve notamment `recorderState`, `lastTrackUrl` et
`bitrate`. L'extension ne transmet pas l'audio à un serveur.

Permissions déclarées : `debugger`, `downloads`, `offscreen`, `scripting`,
`sidePanel`, `storage`, `tabCapture`. La permission `tabs` n'est pas requise :
les permissions d'hôte fournissent l'adresse et le titre des onglets Spotify,
seuls consultés.

Hôtes autorisés : `https://open.spotify.com/*`, `https://*.scdn.co/*` et
`https://*.spotifycdn.com/*`.

`tabCapture` impose un geste utilisateur sur l'onglet Spotify. Après une erreur
d'autorisation, l'utilisateur doit garder l'onglet Spotify visible puis cliquer
l'action Spytify dans la barre d'outils pour reprendre l'enregistrement sur cet
onglet précis : la capture est armée, puis la page du morceau est rechargée.

### Contrôle des émetteurs

Le service de fond n'accepte chaque message que de son émetteur légitime : le
panneau (`popup.html`) pour les commandes et le diagnostic, `authorize.html`
pour l'autorisation, le document hors écran pour la progression et les MP3, et
le script de contenu d'un onglet `https://open.spotify.com/` pour l'état du
lecteur uniquement. Un téléchargement exige une URL `blob:` de l'extension ;
son nom est recalculé à partir des métadonnées. Le document hors écran refuse
les commandes venant d'un onglet et n'écoute que l'onglet capturé.

`chrome.debugger` n'est pas limité aux hôtes du manifeste : chaque attachement
vérifie d'abord que l'onglet affiche Spotify Web, et la lecture du bouton ciblé
refuse toute autre origine pendant l'attachement.

### Fin d'un morceau individuel

Spotify n'affiche pas la dernière seconde d'un morceau terminé : il revient
aussitôt à 0:00 en pause, ou relance le morceau en mode répétition. Le service
de fond retient la position la plus avancée ; si elle a atteint les trois
dernières secondes et que la position repart en arrière, le morceau est
terminé et le MP3 enregistré. Un nouveau titre apparu dans ces trois dernières
secondes arrête aussi l'enregistrement sans attendre de seconde confirmation.
En cours de morceau, un autre titre doit être observé deux fois de suite pour
arrêter l'enregistrement ; une publicité ne le termine pas. Le découpage de la
surveillance finalise aussi le segment à la fin réelle du morceau : son MP3
complet arrête alors la session, même sans détection par le service de fond.

### Reprise après échec

Un téléchargement n'est considéré comme réussi qu'une fois terminé par Chrome
(ou toujours en cours après 20 secondes). En cas d'échec, un nom de secours
`Enregistrement Spotify <date>.mp3` est essayé, puis Chrome demande où
enregistrer le fichier ; seule une annulation par l'utilisateur arrête ces
essais. Le document hors écran libère un MP3 dès que Chrome a confirmé son
enregistrement, et le conserve sinon dix minutes. Tant qu'il garde un MP3 en
attente, le service de fond ne le ferme pas lors de l'armement d'une nouvelle
capture : le fichier resterait sinon illisible.

Si l'arrêt d'une session échoue, l'état est réconcilié avec le document hors
écran : une capture encore active laisse le bouton d'arrêt disponible pour un
nouvel essai, une capture disparue clôt la session avec l'erreur. Une
erreur audio ne marque la surveillance ou l'enregistrement comme terminés que
si la capture a réellement disparu ; une capture que l'état ne suit plus est
finalisée au lieu de rester active.

### Langues du lecteur Spotify

`spotify-player.js` contient les libellés du bouton lecture/pause dans les 69
langues du lecteur Spotify Web, relevés le 9 octobre 2026 dans ses traductions
officielles (`open.spotifycdn.com/cdn/generated-locales/web-player/<langue>.json`,
clés `play`, `pause`, `playback-control.play` et `playback-control.pause`).
Aucun libellé n'a un sens différent d'une langue à l'autre. Ce script classique
est chargé avant `content.js` et importé par les modules ; la fonction évaluée
par le débogueur reçoit libellés et sélecteurs en argument et garde ses propres
copies de `normalizeTitle` et `parseTime`, une fonction ne pouvant lui être
transmise. Le gros bouton du morceau est
trouvé dans `[data-testid="action-bar-row"]`, indépendamment de la langue. Un
libellé inconnu laisse l'élément audio décider de l'état de lecture. Pour
ajouter une langue, relever ces quatre clés dans sa traduction.

### Observation du lecteur

Le script de contenu reste en veille hors session : aucune minuterie, aucun
`MutationObserver`, aucun message. Le service de fond écrit
`playerObservation` dans `chrome.storage.local` uniquement lorsqu'il change
(vrai pendant un enregistrement ou une surveillance), et chaque onglet Spotify
active ou arrête son observation en conséquence.

### Noms de fichier

Le nom, hors dossier et extension, est limité à 120 unités UTF-16 (artiste
au plus 60, le titre reçoit le reste, au moins 47). La coupe se fait entre deux
caractères visibles, avec « … », sans séparer emoji, drapeaux ni lettres
accentuées. Les caractères de contrôle et les marques de direction Unicode sont
retirés. Les balises ID3 conservent le titre complet.

### Diagnostic

Le bouton de diagnostic demande deux clics : le premier décrit le contenu, le
second, dans les dix secondes, copie le rapport. Celui-ci contient l'état de
l'enregistrement, le titre et le chemin du morceau affiché, la version de Chrome
et l'état technique du lecteur (dont les métadonnées multimédias publiées par
Spotify), ainsi que les étapes du dernier lancement de morceau et leur durée. Les adresses des cadres et des médias sont
réduites à leur origine ; le stockage n'est pas copié en entier et l'URL de
morceau mémorisée n'est signalée que par sa présence.

## Installation et maintenance

Chargez `Chrome-Extension/` comme extension non empaquetée depuis
`chrome://extensions`, avec le mode développeur activé. Rechargez l'extension
après toute modification. Le guide utilisateur détaillé est
`Chrome-Extension/README.md`.

Retour à une version antérieure : `sauvegardes/restaurer.ps1 -Version <x>`
restaure la copie locale `sauvegardes/v<x>/` (1.16.4 à 1.16.7, et 1.16.9 :
dernière version avec la préparation en trois étapes) après avoir
archivé l'état courant. Le tag Git local `v1.16.4` désigne aussi le commit
initial.

Les archives ZIP, fichiers MP3 et sauvegardes locales sont exclus de
Git. La source à publier est le contenu du dépôt, notamment
`Chrome-Extension/` et les documents racine.

## Vérifications

Depuis la racine sous PowerShell :

```powershell
npm.cmd --prefix Chrome-Extension test
```

Cette commande commence par `tests/project-check.mjs` (syntaxe de chaque
script, fichiers du manifeste, version identique dans le manifeste, le paquet et
la documentation, suites toutes enregistrées, empreinte de lamejs), puis lance
seize suites Node : huit suites du parcours
individuel (dont le lancement en un clic et la capture hors écran), cinq suites pour le
découpage PCM, la capture continue, le service de surveillance, son panneau
et la détection des publicités, une suite de reprise après échec
(téléchargement, arrêt, capture orpheline, document conservé), une suite pour
les langues du lecteur et une pour la veille du script de contenu. La même
commande est exécutée par GitHub Actions (`.github/workflows/tests.yml`) à
chaque envoi sur `main` et à chaque pull request.

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
