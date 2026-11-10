# claude-code-mods

Mods pour [Claude Code](https://claude.com/claude-code), publiés sous forme de marketplace de plugins.

## music-player

Un panneau « Lecteur » à côté de la conversation, qui affiche ce qui joue sur ton Mac :

- titre, artiste, album et l'app qui joue (Music, Spotify, Chrome, Safari, Qobuz…) ;
- barre de progression avec le temps écoulé et la durée ;
- boutons précédent, lecture/pause et suivant (raccourcis `b`, `p`, `n` dans le terminal) ;
- le visualiseur **Bars** façon Windows Media Player, en dégradé vert ou en monochrome (petit bouton `◐` à côté du statut).

Il fonctionne dans le terminal comme dans Claude Desktop. La commande `/lecteur` rouvre le panneau.

### Installation

```bash
claude plugin marketplace add codingcastor/claude-code-mods && claude plugin install music-player@codingcastor
```

Ou depuis une session Claude Code :

```
/plugin install music-player --marketplace codingcastor/claude-code-mods
```

Réponds `y` pour ajouter la marketplace, puis choisis la portée de l'installation.

### Prérequis

- **macOS uniquement.** Le mod lit le « Now Playing » du système via `osascript` (framework MediaRemote), sans rien à installer.
- **Qobuz** ne publie rien dans le « Now Playing » de macOS : le mod lit ses fichiers locaux (journal, position, base de titres), et le pilote en simulant les touches média du clavier. Pour les contrôles de Qobuz, macOS demande d'autoriser l'app qui fait tourner Claude Code dans *Réglages Système → Confidentialité et sécurité → Accessibilité*.
- Le visualiseur est une animation : il ne réagit pas au son réel.

## Licence

MIT
