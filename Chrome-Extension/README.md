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

Choisir **Un morceau** ou **Surveillance** dans le menu **Mode**.

### Surveillance d'une playlist ou des lectures manuelles

1. Afficher l'onglet Spotify Web connecté, puis ouvrir le panneau Spytify.
2. Choisir **Surveillance**, régler la qualité MP3 et cliquer sur
   **Activer la surveillance**. Si Chrome demande une autorisation, garder
   cet onglet affiché et cliquer sur l'icône Spytify dans sa barre d'outils.
3. Démarrer les morceaux directement dans Spotify, ou laisser une playlist
   avancer. L'extension ne recharge pas la page et ne commande pas la lecture.
   Un fichier est téléchargé à chaque fin ou changement de morceau, et le
   compteur affiche les MP3 téléchargés. Le dernier morceau est aussi
   téléchargé quelques secondes après sa fin lorsque Spotify revient à 0:00
   en pause, sans qu'il faille arrêter la surveillance.
4. Une pause conserve le morceau en cours et la surveillance. La reprise
   continue dans le même MP3, sans encoder la longue attente en pause.
   Une publicité détectée finalise le morceau précédent, affiche **Publicité
   ignorée** et suspend l'encodage. La surveillance reprend automatiquement
   au prochain morceau après confirmation de son titre et de sa progression,
   sans créer de MP3 pour les annonces. La remise à zéro après une publicité
   ne crée pas d'extrait intermédiaire.
5. Cliquer sur **Arrêter la surveillance et enregistrer** pour finaliser le
   dernier morceau et libérer la capture, même lorsque Spotify est en pause.
   La fermeture de l'onglet surveillé finalise aussi la session.

Activer la surveillance avant de lancer la lecture permet de conserver le
début du morceau. Une activation en cours de lecture, un saut dans le morceau
ou un passage manuel au suivant peut créer un fichier portant **(extrait)**.
Les répétitions de noms reçoivent automatiquement un nom distinct dans Chrome.
Le nom est fixé automatiquement à **Artiste - Titre.mp3**, ou
**Artiste - Titre (extrait).mp3**, à partir des métadonnées du morceau
enregistré. Un nom très long est raccourci avec « … » (120 caractères au
plus, titre complet conservé dans les balises du MP3). Le panneau affiche le nom prévu puis celui du dernier MP3
téléchargé, suivi de sa durée enregistrée, par exemple
**Dernier MP3 : Daft Punk - Ouverture.mp3 (03:12)**. Aucune saisie de nom n'est demandée par l'extension.

Le flux audio reste ouvert entre les titres. Un tampon de huit secondes de
PCM en mémoire permet de corriger une détection tardive du titre, notamment
après une publicité ;
le téléchargement du précédent n'interrompt pas la capture du suivant.
Le compteur inclut l'audio du morceau encore dans ce tampon. La mention
**(extrait)** compare la durée audio enregistrée à celle du morceau, lorsque
Spotify la fournit, avec une tolérance de deux secondes. Une progression
transitoire au démarrage ne suffit plus à classer une capture complète comme
incomplète. Sans durée connue, l'estimation du début manquant reste utilisée.
La séparation dépend de la précision des métadonnées et de la progression
affichées par Spotify. Lorsque le lecteur n'expose plus le titre et l'artiste,
l'extension lit ceux que Spotify publie pour les commandes multimédias de
Chrome, en pause comme en lecture. Le contrôle de progression fournit une position plus
précise lorsqu'il est disponible. Le découpage ne garantit pas une coupure exacte à l'échantillon,
notamment lorsque le player affiche sa progression en secondes entières.
Le découpage ne repose pas sur la détection d'un silence ou d'un fondu.

La détection des publicités observe les marqueurs et libellés du lecteur
Spotify, y compris lorsque l'ancien titre reste affiché. Elle exclut leur
audio encore présent dans le tampon ; une détection retardée de plus de trois
secondes ne permet pas de retirer l'audio déjà encodé. Une modification du
lecteur Spotify peut nécessiter une adaptation de cette détection.

Une veille du service de fond retrouve la session hors écran existante. Une
relance de Chrome ou un rechargement de l'extension exige une nouvelle activation.
Un refus de téléchargement est affiché et n'arrête pas l'observation des titres.

### Morceau individuel

1. Se connecter à <https://open.spotify.com/> dans Chrome et afficher l'onglet
   Spotify Web.
2. Cliquer sur l'icône de l'extension pour ouvrir le panneau latéral, choisir
   **Un morceau**, coller l'URL du morceau (ou laisser le champ vide si la page
   du morceau est déjà affichée dans Spotify), régler la qualité MP3, puis
   cliquer **Enregistrer le morceau**. C'est le seul clic nécessaire.
3. L'extension commence par écouter l'onglet, puis y charge la page du
   morceau : si Spotify lance le morceau de lui-même après le chargement, son
   début est déjà enregistré et l'extension ne clique sur rien (un clic le
   mettrait en pause). Le panneau affiche **Lancement du morceau** pendant
   cette surveillance.
4. Si le morceau n'a pas démarré quatre secondes après le chargement,
   l'extension le lance automatiquement par un vrai clic : bouton du lecteur
   inférieur si celui-ci affiche ce morceau (ramené d'abord à 0:00 s'il est en
   pause au milieu), sinon gros bouton de lecture de la page. Le démarrage est
   confirmé par la progression du lecteur ; un second essai a lieu si besoin.
   Si la lecture ne démarre toujours pas, l'enregistrement est abandonné sans
   fichier et le message indique l'état du lecteur. Une publicité qui précède
   le morceau est laissée se terminer : elle n'est pas enregistrée.
5. Dès que la lecture est confirmée, le champ URL est vidé et l'ancienne URL
   mémorisée est supprimée. Le panneau affiche **Enregistrement en cours**.
6. La fin du morceau arrête et télécharge le MP3, y compris lorsque Spotify
   revient aussitôt à 0:00 en pause ou relance le morceau en mode répétition :
   l'extension suit le minutage du lecteur. Le passage confirmé à un autre
   morceau fait de même. Le bouton **Arrêter et enregistrer le MP3** reste
   disponible : un arrêt avant la fin produit un fichier portant **(extrait)**.

Seul le morceau demandé est téléchargé : le titre que Spotify affichait avant
le chargement de la page, ou le morceau suivant, est écarté. Une pause
conserve l'enregistrement en cours ; la reprise continue dans le même MP3.

Si le panneau affiche **Autorisation requise**, garder l'onglet Spotify affiché
et cliquer sur l'icône Spytify dans la barre d'outils : une petite fenêtre
**Autorisation Spytify** autorise la capture de cet onglet et lance
l'enregistrement (capture, puis chargement de la page). Elle se ferme d'elle-même
en cas de succès et affiche l'erreur sinon. Ce clic est notamment nécessaire
lorsque l'URL est ouverte dans un nouvel onglet, faute d'onglet Spotify affiché.

Le fichier est placé sous `Téléchargements/Spytify Web/` et reçoit les balises
ID3 du titre, de l'artiste, de l'album et, si Spotify l'autorise, de la pochette.
Si Chrome refuse ce téléchargement, l'extension réessaie sous le nom
**Enregistrement Spotify <date>.mp3**, puis Chrome demande où enregistrer le
fichier : le MP3 n'est plus perdu.

Après une relance complète de Chrome, une autorisation en attente de l'ancienne
session est remise à zéro : afficher Spotify puis relancer l'enregistrement.
Une simple mise en veille du service de fond conserve la possibilité de
reprendre, y compris pendant le lancement du morceau.

## Vérifier une mise à jour

La version chargée est affichée en bas du panneau. Après une mise à jour des
fichiers, cliquer sur **Recharger** dans `chrome://extensions` pour Spytify,
puis rouvrir son panneau et vérifier la version **1.18.5**. Si elle reste ancienne,
l'extension est chargée depuis un autre dossier : sélectionner le dossier
`C:\Codex\Spytify\Chrome-Extension` via **Charger l'extension non empaquetée**.
Si Chrome refuse encore la capture après le clic, le message précise désormais
si ce clic a été reçu par Spytify. L'erreur Chrome d'origine est conservée dans
l'état local pour le diagnostic.

Le bouton de diagnostic (icône en haut du panneau) demande deux clics : le
premier décrit ce que contient le rapport, le second le copie. Il ne contient
ni donnée de compte ni audio ; relisez-le avant de le partager. Il conserve
aussi les étapes du dernier lancement de morceau et leur durée dans la session
Chrome, même après un échec ou la mise en veille du service de fond. Une erreur
de lancement est enregistrée dans l'état du panneau.

## Fonctionnement et limites

- L'audio est capturé avec `chrome.tabCapture`, traité par un `AudioWorkletNode`
  dans un document hors écran de l'extension et encodé en MP3 avec lamejs.
- Le bouton de démarrage doit être cliqué par l'utilisateur : Chrome interdit
  le lancement silencieux d'une capture d'onglet.
- Pour que Spotify accepte réellement la commande audio, le lancement
  automatique attache temporairement le débogueur Chrome à l'onglet, y envoie
  un vrai clic, puis le détache immédiatement. Chrome peut afficher brièvement
  une barre d'information pendant cette opération. Aucun débogueur n'est
  attaché lorsque Spotify lance le morceau de lui-même.
- L'extension reconnaît le lecteur Spotify dans ses 69 langues d'interface.
- Hors enregistrement et surveillance, elle n'observe pas les onglets Spotify.
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
