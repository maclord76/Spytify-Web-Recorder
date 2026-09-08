# Contribuer à Spytify Web Recorder

Merci de contribuer au projet. Les modifications doivent rester ciblées, compréhensibles et compatibles avec Chrome 116 ou plus récent.

## Avant de commencer

- Consultez [TECHNIQUE.md](TECHNIQUE.md) et le guide utilisateur de `Chrome-Extension/README.md`.
- N'ajoutez pas de programme compagnon, de serveur ou de télémétrie sans une décision explicite du mainteneur.
- Ne supprimez pas les notices de dépendances présentes dans `Chrome-Extension/vendor/`.
- Ne commitez ni profils de navigateur, ni fichiers téléchargés, ni MP3, ni archives de publication générées localement.

## Modifier et vérifier

1. Créez une branche descriptive à partir de la branche principale.
2. Gardez une modification limitée à son objectif ; documentez tout changement de permission Chrome ou de comportement visible.
3. Exécutez depuis la racine du dépôt :

   ```powershell
   npm.cmd --prefix Chrome-Extension test
   ```

4. Si votre modification touche l'interface, le lecteur, la capture ou la finalisation MP3, testez aussi manuellement le parcours pertinent dans Chrome avec Spotify Web lorsque c'est possible.
5. Indiquez dans la proposition de modification ce qui a été testé et ce qui ne l'a pas été. Les tests Node ne valident pas une capture Spotify réelle.

## Proposition de modification

Décrivez le problème, la solution, les fichiers affectés et les résultats de vérification. Ajoutez des tests de régression quand un comportement peut être reproduit hors d'un compte Spotify. Ne publiez jamais de jetons, identifiants, journaux contenant des données personnelles ou enregistrements audio.

## Signaler un défaut

Utilisez une issue pour les défauts non sensibles : version de Chrome, version de l'extension, étapes de reproduction, résultat attendu et résultat obtenu. Pour une vulnérabilité, suivez [SECURITY.md](SECURITY.md).
