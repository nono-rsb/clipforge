# ✂ ClipForge

Application de clipping inspirée d'Opus Clip : importez une vidéo longue et obtenez automatiquement des clips courts prêts pour TikTok, Reels et Shorts.

Tout tourne **dans votre navigateur**, et aucune vidéo n'est envoyée sur Internet. La connexion n'est nécessaire qu'une fois, pour télécharger le modèle de transcription.

## Lancer

**Le plus simple : l'app PC.** Téléchargez `ClipForge-Setup.exe` dans les [Releases](https://github.com/nono-rsb/clipforge/releases/latest) et double-cliquez dessus. ClipForge s'installe en un clic (raccourcis sur le bureau et dans le menu Démarrer), s'ouvre dans sa propre fenêtre, enregistre les exports dans `Téléchargements\ClipForge` et se met à jour tout seul à chaque nouvelle version.

**Sans installation :** `ClipForge.exe` (même page) s'ouvre dans votre navigateur (Chrome ou Edge).

**Sur iPhone :** ouvrez l'adresse du site (version en ligne) dans **Safari**, touchez le bouton Partager (le carré avec la flèche), puis « Sur l'écran d'accueil ». ClipForge s'ouvre alors en plein écran comme une app, marche hors connexion une fois chargé, et les exports s'enregistrent dans Photos via « Enregistrer la vidéo ». Même chose sur Android avec Chrome (« Installer l'application »).

Aucun des deux n'est signé, donc Windows peut afficher « Windows a protégé votre ordinateur » : cliquez sur « Informations complémentaires », puis « Exécuter quand même ».

Avec Node.js : double-cliquez sur **`Lancer ClipForge.bat`**, ou lancez `node server.js`, puis ouvrez http://localhost:5173.

L'import par lien (YouTube…) marche avec l'exe et avec Node.js, mais pas sur la version en ligne. Au premier import, yt-dlp et ffmpeg s'installent tout seuls (avec l'exe, dans `%LOCALAPPDATA%\ClipForge` ; avec l'app PC, dans `%APPDATA%\ClipForge`).

## Fonctions

| Fonction | Détail |
|---|---|
| Détection des moments forts | Sujets qui t'intéressent (favorisés), énergie de la voix, dynamique, accroche des 3 premières secondes, débit de parole, mots-clés (« secret », « pourquoi », « erreur »…), questions, rythme du montage |
| Score de viralité | Note de 48 à 99 pour chaque clip, avec les raisons (🔥 Démarrage fort, ❓ Accroche…) |
| Coupes naturelles | Les clips commencent et finissent sur des fins de phrases ou des pauses |
| Suivi des visages | Détection des visages (MediaPipe) toutes les 0,5 s sur les clips. Le cadre 9:16 reste sur la personne, reste sur le même visage s'il y en a plusieurs, et ne bouge pas pour des petits mouvements. Sans visage, il suit le mouvement |
| Mode podcast | Quand 2 personnes sont dans le même plan : **Orateur actif** (plein cadre qui coupe sur la personne qui parle) ou **Écran partagé** (gauche en haut, droite en bas, celle qui écoute légèrement assombrie). L'orateur est détecté par l'ouverture de la bouche (MediaPipe FaceLandmarker). Si le visage est flou, l'app utilise à la place le mouvement des pixels de la bouche |
| Recadrage | Mode auto ou manuel, zoom (le visage est placé dans le tiers supérieur), mode « ajusté + fond flou » |
| Sous-titres IA | Whisper (tiny / base / small) dans le navigateur, 8 styles animés (Karaoké, Surligné, Impact, Néon, Minimal, Mot à mot, Beast, Rétro), 4 polices, couleur du mot actif, 1 à 4 mots à la fois, texte modifiable, export `.srt` |
| Emojis automatiques | Environ 50 thèmes (argent 💰, peur 😱, gagner 🏆, secret 🤫…) en français et en anglais, affichés en grand au-dessus des sous-titres. Tu peux aussi taper tes propres emojis dans le texte |
| Import par lien | Colle un lien YouTube (ou TikTok, Twitch, X…) : le serveur local le télécharge avec yt-dlp, jusqu'en 1080p avec ffmpeg. Les deux outils s'installent en un clic dans `bin/`. Les vidéos téléchargées vont dans `downloads/` et sont effacées après 24 h |
| Titre d'accroche | Bandeau affiché pendant les 3 premières secondes |
| Éditeur | Découpe ±30 s avec forme d'onde, légende et hashtags suggérés, « appliquer à tous », raccourcis clavier (Espace, ←/→, I/O, M), annuler / rétablir (Ctrl+Z / Ctrl+Y) |
| Effets | Zoom dynamique sur les mots forts, filtres couleur (Vif, Cinéma, Chaud, Froid, N&B), vitesse 1× à 1,5×, volume de la voix, fondu d'entrée et de sortie, musique de fond, filigrane @pseudo |
| Accroche | Texte (ou proposé automatiquement), couleurs (blanc, noir, jaune), durée 2 à 5 s, miniature PNG |
| Sous-titres malins | Fond derrière le texte, palette d'emojis, mots-clés toujours en couleur, censure des gros mots (masqués et bipés), préréglages de style enregistrés |
| Résultats | Recherche d'un mot dans la transcription (crée un clip autour), clip manuel, dupliquer, supprimer (avec annulation), sélection pour l'export, copie de toutes les légendes, clips retouchés retrouvés à la relance, filtre par score, tri par score, date ou durée |
| Rapidité | L'analyse est gardée dans le navigateur : relancer la même vidéo est instantané. Notification quand l'analyse ou l'export finit, temps restant pendant l'export |
| **Montage** (onglet) | Plusieurs vidéos et photos sur une timeline avec miniatures, zoom, glisser-déposer pour réordonner, couper (S), raccourcir en tirant les bords, supprimer, dupliquer, annuler/rétablir. **Retrait automatique des silences** (seuil et durée réglables), **volume égalisé** entre les segments. Par segment : début/fin, vitesse 0,5× à 2×, volume, filtre, fondu au noir, mise en page remplie ou ajustée. Textes (Titre, Encadré, Bandeau ; animations Fondu, Pop, Glissé, Machine à écrire) glissables dans le temps, **sous-titres automatiques**, zoom et effet Ken Burns, chapitres YouTube, export du son seul ou d'une image, sauvegarde automatique du projet, **piste musique** (plusieurs morceaux avec forme d'onde, déplaçables et découpables, volume, fondus, boucle, baisse automatique sous la voix), fondus de début et de fin, export 16:9, 9:16, 1:1 ou 4:5 en 1080p/720p |
| Export | MP4 (ou WebM selon le navigateur) en 1080p ou 720p, 30 ou 60 images/s, un clip, une sélection ou tous d'un coup |
| Confort | Aperçu animé au survol des clips, sous-titres déplaçables à la souris, plein écran, thème clair/sombre, aide des raccourcis (touche ?), montage exporté renvoyé au Clipping en un clic |

## Bon à savoir

- L'export se fait **en temps réel** : un clip de 45 s prend environ 45 s. Gardez l'onglet visible pendant l'export.
- Le modèle « base » offre un bon compromis. Le modèle « small » est plus précis mais plus lent. La transcription utilise la carte graphique (WebGPU) si elle est disponible.
- Pour les vidéos longues (plus de 300 Mo), la version PC extrait le son avec ffmpeg, ce qui économise beaucoup de mémoire. Sur la version en ligne, l'audio est décodé entièrement : prévoyez assez de mémoire vive au-delà d'une heure.

## Partager l'app ou la mettre sur GitHub

N'envoie pas les dossiers `bin/` et `downloads/` (le fichier `.gitignore` s'en charge). `bin/` contient ffmpeg (159 Mo), trop lourd pour GitHub. ClipForge le réinstalle tout seul au premier import YouTube.

## Structure

- `js/analyzer.js` : analyse audio et vidéo, détection et notation des clips
- `js/renderer.js` : recadrage, fond flou, sous-titres, accroche
- `js/exporter.js` : rendu et enregistrement MP4/WebM
- `js/faces.js` : détection des visages (MediaPipe BlazeFace, image découpée en carrés)
- `js/whisper-worker.js` : transcription Whisper (Transformers.js)
- `js/app.js` : interface
- `js/montage.js` : onglet Montage (timeline, silences, textes, export)
- `js/transcribe.js` : lance Whisper (partagé entre Clipping et Montage)
- `js/tour.js` : visite guidée (tuto du montage)
- `js/save.js` : enregistrement des exports (feuille de partage sur téléphone) et écran gardé allumé pendant l'export
- `manifest.webmanifest`, `sw.js`, `icons/` : installation sur l'écran d'accueil et fonctionnement hors ligne
- `js/cache.js` : analyses gardées dans le navigateur (IndexedDB)
- `build/build-exe.js` : fabrique `ClipForge.exe` (Node SEA)
- `desktop/` : l'app PC (Electron) : fenêtre, téléchargements, mises à jour automatiques ; `npm start` pour la lancer, `npm run dist` pour l'installateur
- `.github/workflows/exe.yml` : GitHub fabrique et publie les deux à chaque modification de l'app
