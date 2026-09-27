# ✂ ClipForge

Application de clipping inspirée d'Opus Clip : importez une vidéo longue et obtenez automatiquement des clips courts prêts pour TikTok, Reels et Shorts.

Tout tourne **dans votre navigateur**, et aucune vidéo n'est envoyée sur Internet. La connexion n'est nécessaire qu'une fois, pour télécharger le modèle de transcription.

## Lancer

Double-cliquez sur **`Lancer ClipForge.bat`** (Node.js est requis), ou lancez :

```
node server.js
```

Ouvrez ensuite http://localhost:5173 dans Chrome ou Edge.

## Fonctions

| Fonction | Détail |
|---|---|
| Détection des moments forts | Énergie de la voix, dynamique, accroche des 3 premières secondes, débit de parole, mots-clés (« secret », « pourquoi », « erreur »…), questions, rythme du montage |
| Score de viralité | Note de 48 à 99 pour chaque clip, avec les raisons (🔥 Démarrage fort, ❓ Accroche…) |
| Coupes naturelles | Les clips commencent et finissent sur des fins de phrases ou des pauses |
| Suivi des visages | Détection des visages (MediaPipe) toutes les 0,5 s sur les clips. Le cadre 9:16 reste sur la personne, reste sur le même visage s'il y en a plusieurs, et ne bouge pas pour des petits mouvements. Sans visage, il suit le mouvement |
| Mode podcast | Quand 2 personnes sont dans le même plan : **Orateur actif** (plein cadre qui coupe sur la personne qui parle) ou **Écran partagé** (gauche en haut, droite en bas, celle qui écoute légèrement assombrie). L'orateur est détecté par l'ouverture de la bouche (MediaPipe FaceLandmarker). Si le visage est flou, l'app utilise à la place le mouvement des pixels de la bouche |
| Recadrage | Mode auto ou manuel, zoom (le visage est placé dans le tiers supérieur), mode « ajusté + fond flou » |
| Sous-titres IA | Whisper (tiny / base / small) dans le navigateur, 5 styles animés mot à mot, texte modifiable |
| Emojis automatiques | Environ 50 thèmes (argent 💰, peur 😱, gagner 🏆, secret 🤫…) en français et en anglais, affichés en grand au-dessus des sous-titres. Tu peux aussi taper tes propres emojis dans le texte |
| Import par lien | Colle un lien YouTube (ou TikTok, Twitch, X…) : le serveur local le télécharge avec yt-dlp, jusqu'en 1080p avec ffmpeg. Les deux outils s'installent en un clic dans `bin/`. Les vidéos téléchargées vont dans `downloads/` et sont effacées après 24 h |
| Titre d'accroche | Bandeau affiché pendant les 3 premières secondes |
| Éditeur | Découpe ±30 s avec forme d'onde, légende et hashtags suggérés, « appliquer à tous » |
| Export | MP4 (ou WebM selon le navigateur) en 1080p ou 720p, un clip ou tous d'un coup |

## Bon à savoir

- L'export se fait **en temps réel** : un clip de 45 s prend environ 45 s. Gardez l'onglet visible pendant l'export.
- Le modèle « base » offre un bon compromis. Le modèle « small » est plus précis mais plus lent. La transcription utilise la carte graphique (WebGPU) si elle est disponible.
- Pour les vidéos de plus d'une heure, prévoyez assez de mémoire vive, car l'audio est décodé entièrement.

## Partager l'app ou la mettre sur GitHub

N'envoie pas les dossiers `bin/` et `downloads/` (le fichier `.gitignore` s'en charge). `bin/` contient ffmpeg (159 Mo), trop lourd pour GitHub. ClipForge le réinstalle tout seul au premier import YouTube.

## Structure

- `js/analyzer.js` : analyse audio et vidéo, détection et notation des clips
- `js/renderer.js` : recadrage, fond flou, sous-titres, accroche
- `js/exporter.js` : rendu et enregistrement MP4/WebM
- `js/faces.js` : détection des visages (MediaPipe BlazeFace, image découpée en carrés)
- `js/whisper-worker.js` : transcription Whisper (Transformers.js)
- `js/app.js` : interface
