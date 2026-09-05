# Rejeu d'une conversation dans le Directeur narratif V2

Le harnais `src/lib/ai/evals/live-replay.ts` rejoue une conversation exportée à travers le
VRAI orchestrateur V2 (`executeDirectedBeat`) : chaque message du joueur est conservé, chaque
réponse originale est régénérée comme un beat V2 (Directeur → réflexions → Compositeur →
audit → planificateur) avec la transcription originale pour contexte, puis les deux versions
sont mises côte à côte dans un rapport Markdown.

C'est le premier scénario du corpus d'évaluation prévu par le plan V2. Les autres scénarios
(conflit, humour, calme, arrivée inattendue, canon, détours, refus d'un PNJ) se rejouent avec le
même harnais à partir d'exports ou de fixtures synthétiques.

## Deux modes

| Mode   | Modèle                                                                            | Réseau                | Usage                                               |
| ------ | --------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------- |
| `dry`  | scripté (Directeur, réflexions et Compositeur forgés depuis la réponse originale) | aucun                 | valider la plomberie, le portage d'état, le rapport |
| `live` | NanoGPT via la route `/api/chat` de l'application                                 | serveur de dev requis | évaluer réellement la V2                            |

Le mode `dry` tourne dans la suite de tests standard sur un export synthétique. Le mode
`live` n'est jamais lancé automatiquement.

## Lancer un rejeu réel

1. Démarrer le serveur de dev (`npm run dev`, port 3000).
2. Dans un autre terminal PowerShell, fournir la clé et l'export puis lancer le test :

```powershell
$env:REPLAY_FILE = 'C:\Users\noahc\Downloads\Conversation_Infinite Stratos Rpg_2026-09-03.json'
$env:NANOGPT_API_KEY = '<clé NanoGPT>'
npx vitest run src/lib/__tests__/live-replay.test.ts
```

Variables optionnelles :

| Variable                | Défaut                                     | Rôle                                                           |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `REPLAY_MODE`           | `live` si la clé est présente, sinon `dry` | forcer un mode                                                 |
| `REPLAY_MESSAGES`       | `50`                                       | taille de la fenêtre rejouée                                   |
| `REPLAY_BEATS`          | tous                                       | s'arrêter après N beats (utile pour un premier essai à 3 ou 5) |
| `REPLAY_MODEL`          | choix automatique de l'abonnement          | modèle background (Directeur, réflexions, juge, planificateur) |
| `REPLAY_COMPOSER_MODEL` | = `REPLAY_MODEL`                           | modèle du Compositeur                                          |
| `REPLAY_USER`           | `Noah`                                     | nom du joueur                                                  |
| `REPLAY_BASE_URL`       | `http://localhost:3000`                    | origine du serveur de dev                                      |
| `REPLAY_OUT`            | `./.replay`                                | dossier des sorties (ignoré par git)                           |

Le rapport (`replay-live-<date>.md`) et la trace complète (`.json`) sont réécrits après chaque
beat : un run interrompu garde tout ce qui a été joué. La clé n'est jamais écrite dans ces
fichiers ; elle est chiffrée dans le store de réglages comme dans l'application.

## Ce que compare le rapport

- signaux de l'audit local sur l'original et sur la V2 : contrôle du joueur (dur et à
  confirmer), fin passive, lieu absent ;
- longueur, nombre de voix distinctes, réflexions privées, changement concret déclaré,
  réécritures ;
- distribution des types de beat, des porteurs d'initiative et des statuts d'audit ;
- beat par beat : message du joueur, réponse originale, beat V2, décision du Directeur (but,
  type, initiative, changement visé, cadre joueur, participants, casting, transitions),
  réflexions privées (position, initiative, réponse à la direction, objectif, delta d'état),
  issues d'audit, état après le beat (lieu, temps, résumé, étape active, révision du plan) et
  temps par agent.

## Limites

- Rejeu « teacher-forced » : la V2 lit la transcription originale, pas ses propres beats. L'état
  narratif V2 se transmet de beat en beat, la prose non. Un écart entre l'état V2 et la
  réponse originale suivante est donc possible et se lit dans le rapport.
- Le casting hydrate via la carte et les cartes de casting extraites des sections
  `{{Char N}}` de la description ; aucun dossier canonique n'est disponible pour une carte
  sans `work`.
- Les détecteurs locaux sont volontairement précis plutôt qu'exhaustifs : le juge LLM du
  mode `live` est la vraie mesure du contrôle du joueur et du biais de positivité.
