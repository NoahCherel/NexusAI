# Investigation des pertes de réglages

## Constat vérifié dans le code

Les presets, personas, modèles ajoutés, moteurs personnalisés et clés API chiffrées
partageaient une seule entrée `localStorage`, `nexusai-settings`. Chaque action du
store Zustand réécrivait cet ensemble. Les personnages et conversations sont dans
IndexedDB, séparément. Leur présence ne démontre donc pas que les réglages sont intacts.

La page `/rescue` exportait les bases IndexedDB, mais pas cette entrée de réglages.
Un export de base ne constituait donc pas une sauvegarde des personas/presets/modèles.

## Mécanismes reproduits avec des données fictives

1. **Onglet périmé** : deux onglets chargent le même état. Le premier ajoute des
   données ; le second change simplement une préférence. Le second réenregistre
   tout son ancien état et fait disparaître les ajouts du premier.
2. **Ancienne application et nouveau format** : le code antérieur à `bacef77`
   utilisait le format 0 sans migration. Face à une sauvegarde de format 2, la
   version installée de Zustand ignore l'état incompatible. L'application conserve
   ses collections vides, puis sa prochaine écriture remplace la sauvegarde.
   Le format est passé à 1 dans `bacef77`, puis à 2 dans `59a4368` (5 septembre 2026).
3. **Lecture impossible** : la persistance précédente n'avait aucune protection
   empêchant les actions suivantes d'écrire après un échec de chargement.

Les deux premiers mécanismes sont reproduits dans
`src/lib/__tests__/settings-storage.test.ts`, à partir du middleware réellement installé.
Cela prouve les défauts, **pas le déclencheur exact des deux incidents signalés**.
Il manque l'adresse exacte, le navigateur/profil et les données de l'instance touchée.
La session de navigateur disponible pendant l'enquête ne contenait aucun onglet utilisateur.

## Correction locale

- Nouvelle destination `nexusai-settings-protected`, hors de portée des écritures
  des anciens bundles. Lecture initiale de l'ancienne entrée sans la supprimer.
- Comparaison avec la copie lue par l'onglet avant chaque écriture ; en cas de
  divergence, arrêt des écritures et alerte persistante permettant l'export mémoire.
- Arrêt des écritures après erreur de lecture, format futur/illisible ou erreur
  d'enregistrement, y compris manque de place. Aucun remplacement par défaut silencieux.
- Copie avant remplacement : conservation du premier état sauvegardé et de quatre
  révisions récentes des collections. Les changements de préférences ou dépenses
  ne font pas tourner cet historique. Si la copie échoue, l'écriture est interrompue.
- `/rescue` inspecte et exporte les réglages actuels, l'ancienne entrée et l'historique
  sans charger le store. Restauration explicite des identifiants absents uniquement ;
  les éléments existants et clés API ne sont pas remplacés par l'import.

## Limites et récupération

La correction ne reconstitue pas une ancienne entrée déjà écrasée avant son installation.
L'ancienne entrée conservée peut être une source de récupération si elle contient encore
des éléments manquants. Les anciennes sauvegardes IndexedDB seules ne contiennent pas
les réglages, sauf si ceux-ci y avaient été ajoutés par un autre outil.

Le contrôle entre onglets est une comparaison synchrone de `localStorage`, pas une
transaction multi-onglets. L'historique fournit une protection supplémentaire ; il
ne faut pas considérer cette solution comme une sauvegarde externe ou une garantie
contre toutes les écritures simultanées possibles.

Les copies restent dans le même navigateur et consomment son espace de stockage.
Un effacement complet de ses données peut toutes les supprimer. Télécharger les
exports et les conserver ailleurs reste nécessaire. Un autre domaine, protocole,
port ou profil peut aussi rendre des données invisibles sans les avoir supprimées.

Le code est modifié localement ; aucun déploiement ni aucune restauration des données
personnelles n'ont été effectués pendant cette enquête.
