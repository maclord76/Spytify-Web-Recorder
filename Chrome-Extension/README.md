# Spytify Web Recorder — extension Chrome autonome

Cette extension Manifest V3 enregistre le son de l'onglet Spotify Web actif et
fabrique localement un fichier MP3. Elle ne lance aucun programme compagnon et
n'envoie pas l'audio vers un serveur.

## Installation

1. Ouvrir `chrome://extensions` dans Google Chrome.
2. Activer **Mode développeur**.
3. Cliquer **Charger l'extension non empaquetée**.
4. Sélectionner le dossier `Chrome-Extension`.
5. Épingler **Spytify Web Recorder** dans la barre d'outils.

Chrome 116 ou une version plus récente est nécessaire.

## Utilisation

1. Se connecter à <https://open.spotify.com/> dans Chrome.
2. Cliquer sur l'icône de l'extension pour ouvrir le panneau latéral,
   coller l'URL d'un morceau, puis cliquer
   **1. Ouvrir le morceau**.
   Le panneau reste ouvert pendant l'ouverture du morceau et les changements d'onglet.
3. Une fois la page Spotify affichée, cliquer dans le panneau sur
   **2. Préparer le morceau**. Cette action actualise d'abord l'onglet Spotify
   et attend son chargement complet afin de repartir d'un player propre, puis
   charge le titre affiché dans le lecteur inférieur. L'extension vérifie que
   les deux titres correspondent et
   ne démarre encore aucune capture. Si Spotify lance spontanément la lecture
   pendant cette préparation, l'extension remet immédiatement le morceau en
   pause avant d'autoriser l'étape suivante. Le flux de l'onglet est alors armé,
   mais aucun échantillon ni silence n'est encore encodé.
   Si le panneau affiche **Autorisation requise**, garder l'onglet Spotify
   affiché et cliquer sur l'icône Spytify dans la barre d'outils : Chrome
   autorise alors la capture de cet onglet et la préparation reprend
   automatiquement sur cet onglet, sans actualiser Spotify ni fermer le panneau.
   Une petite fenêtre **Autorisation Spytify** s'affiche pendant cette reprise.
   Elle se ferme lorsque le morceau est prêt ; en cas d'échec, elle affiche
   l'erreur. L'étape 2 reste accessible pour recommencer. Ce clic est nécessaire lorsqu'un
   nouvel onglet a été ouvert depuis le panneau.
4. Le bouton devient **3. Démarrer l'enregistrement**. Cliquer dessus une seule
   fois : l'extension clique directement sur le bouton lecture central du
   lecteur inférieur Spotify à partir de ce même geste utilisateur, active
   l'encodage du flux déjà prêt, réessaie une seconde fois après 1,2 seconde si
   le player affiche toujours **Lecture**, puis vérifie pendant huit secondes
   que le compteur du morceau progresse réellement. Si le premier ordre a
   fonctionné, le second ne clique pas et ne remet donc pas le titre en pause.
   Dès que le démarrage est confirmé, le champ URL est vidé et l'ancienne URL
   mémorisée est supprimée.
5. La fin réelle du lecteur arrête et télécharge le MP3. Le changement détecté
   vers le morceau suivant fait de même. Le bouton **Arrêter et enregistrer le
   MP3** reste disponible pour un arrêt manuel.

L'arrêt automatique possède deux sécurités indépendantes : la détection de fin
ou de changement de titre dans Spotify, et une limite de durée gérée directement
par l'encodeur audio. Cette seconde sécurité ne modifie pas le démarrage du
player : elle commence au premier échantillon audio réel et finalise le fichier
à la durée annoncée par Spotify.

Le fichier est placé sous `Téléchargements/Spytify Web/` et reçoit les balises
ID3 du titre, de l'artiste, de l'album et, si Spotify l'autorise, de la pochette.

Après une relance complète de Chrome, une autorisation en attente de l'ancienne
session est remise à zéro : afficher Spotify puis reprendre l'étape 2. Une
simple mise en veille du service de fond conserve la possibilité de reprendre.

## Vérifier une mise à jour

La version chargée est affichée en bas du panneau. Après une mise à jour des
fichiers, cliquer sur **Recharger** dans `chrome://extensions` pour Spytify,
puis rouvrir son panneau et vérifier la version **1.14.4**. Si elle reste ancienne,
l'extension est chargée depuis un autre dossier : sélectionner le dossier
`C:\Codex\Spytify\Chrome-Extension` via **Charger l'extension non empaquetée**.
Si Chrome refuse encore la capture après le clic, le message précise désormais
si ce clic a été reçu par Spytify. L'erreur Chrome d'origine est conservée dans
l'état local pour le diagnostic.

## Fonctionnement et limites

- L'audio est capturé avec `chrome.tabCapture`, traité par un `AudioWorkletNode`
  dans un document hors écran de l'extension et encodé en MP3 avec lamejs.
- Le bouton de démarrage doit être cliqué par l'utilisateur : Chrome interdit
  le lancement silencieux d'une capture d'onglet.
- Pour que Spotify accepte réellement la commande audio, l'action 3 attache
  temporairement le débogueur Chrome à l'onglet, exécute le clic avec
  `userGesture: true`, puis le détache immédiatement. Chrome peut afficher
  brièvement une barre d'information pendant cette opération.
- Spotify peut modifier les attributs de son interface. La capture manuelle
  continuera de fonctionner, mais la récupération des titres ou l'arrêt
  automatique pourront nécessiter une mise à jour.
- Le fonctionnement avec le flux protégé de Spotify doit être confirmé dans un
  vrai compte Spotify Web. L'extension ne contourne ni ne désactive le DRM.
- Utiliser uniquement cette extension pour des contenus que vous avez le droit
  d'enregistrer, conformément aux conditions de Spotify et au droit applicable.

## Dépendance incluse

`vendor/lame.min.js` provient de `lamejs` 1.2.1. Voir
`THIRD_PARTY_NOTICES.md` et `vendor/LAMEJS-LICENSE.txt`.
