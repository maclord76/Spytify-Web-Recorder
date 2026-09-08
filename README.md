# Spytify Web Recorder

Extension Chrome autonome qui enregistre localement l'audio de l'onglet Spotify Web actif et génère un fichier MP3. Aucun programme compagnon et aucun serveur ne sont utilisés.

> **Statut — version 1.14.4.** Le code et les tests automatisés couvrent le parcours de l'extension. Un enregistrement réel reste à valider dans Chrome, avec un compte Spotify Web, après chaque évolution importante du lecteur Spotify ou de Chrome.

## Ce que fait l'extension

- ouvre une URL de morceau Spotify dans un onglet Chrome ;
- prépare la capture de cet onglet à la demande de l'utilisateur ;
- pilote la lecture puis encode localement l'audio en MP3 ;
- renseigne les balises du fichier quand les métadonnées sont disponibles ;
- arrête l'enregistrement à la fin du morceau, lors du passage au suivant, ou à l'arrêt manuel.

Les fichiers sont téléchargés dans `Téléchargements/Spytify Web/`.

## Installation locale

Cette extension n'est pas empaquetée pour le Chrome Web Store. Pour la charger depuis ce dépôt :

1. Ouvrez `chrome://extensions` dans Chrome 116 ou plus récent.
2. Activez le **Mode développeur**.
3. Cliquez sur **Charger l'extension non empaquetée**.
4. Sélectionnez le dossier `Chrome-Extension` de ce dépôt.
5. Épinglez **Spytify Web Recorder** dans la barre d'outils.

Le guide d'utilisation complet, y compris le parcours d'autorisation de la capture, est dans [Chrome-Extension/README.md](Chrome-Extension/README.md).

## Vérifier le projet

Node.js est requis uniquement pour les vérifications automatisées :

```powershell
npm.cmd --prefix Chrome-Extension test
```

Deux contrôles de fumée navigateur sont aussi disponibles lorsqu'un navigateur de test est lancé avec le débogage distant :

```powershell
node Chrome-Extension/tests/popup-smoke.mjs <port>
node Chrome-Extension/tests/audio-worklet-smoke.mjs <port>
```

Ces contrôles ne remplacent pas une session réelle de Spotify Web : ils ne peuvent pas valider l'autorisation `tabCapture`, la lecture avec un compte connecté, ni la production finale d'un MP3.

## Structure du dépôt

| Chemin | Contenu |
| --- | --- |
| `Chrome-Extension/` | Source de l'extension et sa documentation utilisateur. |
| `Chrome-Extension/tests/` | Tests Node.js et contrôles de fumée navigateur. |
| `Chrome-Extension/vendor/` | Dépendance lamejs et sa licence. |
| `TECHNIQUE.md` | Architecture, permissions, flux et maintenance. |
| `CONTRIBUTING.md` | Règles pour proposer une modification. |
| `SECURITY.md` | Signalement responsable de vulnérabilités. |

## Respect des droits et confidentialité

Utilisez cette extension uniquement pour les contenus que vous êtes autorisé à enregistrer et conformément aux conditions de Spotify ainsi qu'au droit applicable. L'extension ne contourne ni ne désactive le DRM. L'audio est traité localement ; l'extension ne transmet pas l'audio à un serveur.

## Licence

La licence du code du projet n'est pas encore définie. En l'absence d'un fichier `LICENSE`, aucun droit de réutilisation n'est accordé par ce dépôt. La dépendance incluse lamejs est couverte séparément : voir [Chrome-Extension/THIRD_PARTY_NOTICES.md](Chrome-Extension/THIRD_PARTY_NOTICES.md).

## Contribuer et sécurité

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) avant de proposer une modification, et [SECURITY.md](SECURITY.md) pour signaler un problème de sécurité sans le publier dans les issues.
