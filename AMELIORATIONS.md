# Journal des améliorations

Les plus récentes en haut. Sert aussi à la tâche quotidienne pour ne pas refaire deux fois la même chose.

## 2026-11-14

107. Cadrage animé : en recadrage manuel, l'option « Cadrage animé » pose un point clé à chaque réglage (curseur ou image glissée) à l'instant affiché, et le cadre glisse en douceur d'un point à l'autre pendant le clip (pour suivre quelqu'un qui bouge ou passer d'une personne à l'autre) ; bouton pour retirer le point le plus proche, Ctrl+Z, inclus dans l'export

## 2026-11-13

106. Montage : zoom de la timeline avec Ctrl + molette (ou en pinçant le pavé tactile) et en pinçant à deux doigts sur téléphone et tablette, centré sur l'endroit visé, comme dans les logiciels de montage

## 2026-11-12

105. Durée des clips « Sur mesure » : en plus des choix tout faits, on peut donner sa propre durée minimum et maximum (de 5 s à 3 min), remise dans l'ordre si besoin et mémorisée

## 2026-11-11

104. Résultats : bouton « ＋ Plus de clips » qui cherche d'autres moments dans la même vidéo sans refaire l'analyse ; il ajoute jusqu'à 4 clips qui ne recoupent pas ceux déjà là (même retouchés), ou prévient quand il n'y a plus de passage assez différent

## 2026-11-10

103. Montage : choix de la police des sous-titres (Montserrat, Anton, Bangers, Poppins) et du nombre de mots affichés à la fois (1 à 4), comme dans le Clipping ; retenus avec le projet

## 2026-11-09

102. Éditeur : lecture enchaînée (bouton ⏭ ou touche C) : à la fin d'un clip, ClipForge passe tout seul au suivant et continue la lecture, pour revoir tous les clips d'affilée comme un fil TikTok ; le choix est mémorisé

## 2026-11-08

101. Appel à l'action en fin de clip : dans l'onglet Accroche de l'éditeur, une option affiche « 🔔 Abonne-toi pour la suite ! » (texte modifiable et mémorisé) dans une bulle aux couleurs des sous-titres qui apparaît en rebondissant pendant les 2,5 dernières secondes ; inclus dans l'export, les préréglages et « Appliquer à tous les clips »

## 2026-11-07

100. Éditeur : boutons ‹ › (et touches Page précédente / Page suivante) pour passer au clip précédent ou suivant sans fermer l'éditeur, dans l'ordre affiché sur la page des résultats, avec le numéro du clip (« 2/6 ») ; le clip quitté est enregistré

## 2026-11-06

99. Montage : aperçu en plein écran (bouton ⛶ ou touche F), dessiné à la taille d'export pour rester net ; touche M pour couper ou remettre le son ; le son coupé reste coupé après un export

## 2026-11-05

98. Corrections des sous-titres : sur l'accueil, un champ « Corrections des sous-titres » (une par ligne, ex. « squizi → Squeezie », « mine craft → Minecraft ») corrige automatiquement les noms, pseudos et mots que Whisper écrit mal, dans les sous-titres, les titres des clips et le montage. Le champ est mémorisé et s'applique aussi en relançant une vidéo déjà analysée

## 2026-11-04

97. Montage : « ⚡ Zoom sur les mots forts », le petit zoom dynamique du Clipping, maintenant aussi sur les longues vidéos (dans Sous-titres, une fois les sous-titres générés) ; visible dans l'aperçu et à l'export, retenu avec le projet

## 2026-11-03

96. Zones cachées par TikTok, Reels et Shorts : dans l'éditeur, le bouton 📱 (ou la touche Z) affiche par-dessus l'aperçu 9:16 les parties recouvertes par l'interface des applis (barre du haut, boutons à droite, pseudo et description en bas) ; elles passent en rouge avec un avertissement si les sous-titres tombent dedans. Rien n'est ajouté à la vidéo exportée ; le choix est mémorisé

## 2026-11-02

95. Les vidéos sans durée enregistrée (MKV d'un enregistrement OBS interrompu, WebM en direct) ne bloquent plus le montage : leur durée est lue directement dans le fichier (0,4 s au lieu d'un montage figé) ; le Clipping s'en sert aussi au lieu de faire parcourir toute la vidéo au navigateur

## 2026-11-01

94. Export et analyse rapides aussi pour les fichiers MKV et WebM (enregistrements OBS, vidéos WebM) : ClipForge lit maintenant ces fichiers directement au lieu de repasser par la lecture en temps réel. Sur une vidéo MKV de 10 min, l'analyse passe de 22 s à 9,5 s (et de plus de 10 min à 10 s pour un MKV sans index, comme après un enregistrement OBS interrompu) ; l'export d'un clip est 2 à 3 fois plus rapide comme pour les MP4

## 2026-10-31 (2e série) — Vitesse

90. Export rapide des clips : au lieu de rejouer la vidéo en temps réel, ClipForge lit directement les images du fichier, les dessine et les encode aussi vite que l'ordinateur le permet (carte graphique utilisée quand elle est disponible). Sur la machine de test, un clip de 46 s s'exporte en 16 s au lieu de 47 s, sans écran à garder visible pour le son. Mêmes réglages (vitesse avec voix inchangée, musique, fondus, bips, rotation des vidéos de téléphone). Les fichiers MP4/MOV en profitent ; les autres formats (WebM, MKV…) gardent l'export en temps réel
91. Le temps restant affiché pendant l'export est calculé sur la vitesse réelle de l'export
92. Export rapide du montage (vidéo et « Son seul ») : images lues directement dans les fichiers, son mixé hors temps réel avec les mêmes réglages (vitesses, fondus, textes, sous-titres, photos, musiques et leur baisse sous la voix). Sur la machine de test, un montage de 37 s s'exporte en 17 s au lieu de 38 s, et le son seul en 1,5 s au lieu de 38 s. Les longs montages sont écrits au fil de l'eau pour ne pas saturer la mémoire
93. Analyse plus rapide : les images sont lues directement dans le fichier (images clés) au lieu de déplacer la vidéo 400 fois (12 s → 1,4 s sur une vidéo de 10 min), et la transcription Whisper tourne en même temps que l'analyse des images au lieu d'attendre la fin

## 2026-10-31

89. Recadrage à la main directement sur l'image : dans l'éditeur, glisser l'aperçu de gauche à droite déplace le cadre (passe en recadrage manuel en partant de la position suivie automatiquement) ; glisser de haut en bas déplace toujours les sous-titres, un clic lance ou met en pause ; Ctrl+Z annule

## 2026-10-30 — Ne plus perdre son travail

87. Si on ferme ou recharge la page (ou l'app PC) pendant une analyse, un export ou une transcription, ClipForge demande confirmation au lieu de tout perdre ; l'écran reste aussi allumé pendant l'analyse et la transcription, plus seulement pendant l'export
88. ClipForge demande au navigateur de garder ses données (analyses, clips retouchés, projets de montage) : Safari sur iPhone ne les efface plus au bout de quelques jours sans ouvrir l'app

## 2026-10-29

86. Détection des clips plus propre : un clip ne commence plus par un mot de liaison ou une hésitation (« donc », « et », « mais », « euh »…), ne se termine plus sur un mot qui annonce la suite (« le », « de », « pour »…) et évite les blancs avant la première phrase. Sur des transcriptions de test, les débuts « coupés » passent de 37 % à 0 %

## 2026-10-28

85. Montage : export des sous-titres en fichier `.srt` (bouton « ⬇ Sous-titres .srt ») pour YouTube, TikTok ou un logiciel de montage ; phrases courtes coupées aux pauses, à la ponctuation et aux coupes, calées sur la timeline (vitesses comprises)

## 2026-10-27 — Accessibilité

84. Utilisable au clavier et avec un lecteur d'écran : contour bien visible sur l'élément sélectionné avec Tab, zone d'import ouverte avec Entrée, case de sélection des clips atteignable au clavier, noms lisibles pour tous les boutons-icônes, menus et curseurs, boutons de choix annoncés comme activés ou non, messages annoncés, fenêtre d'aide reconnue comme dialogue ; animations coupées si « réduire les animations » est activé dans le système

## 2026-10-26

83. Magnétisme sur la timeline du montage : en glissant un texte ou une musique (ou en tirant les bords d'une musique), il s'accroche à la tête de lecture, aux coupes, au début et à la fin de la vidéo et aux bords des autres éléments, avec un trait jaune pointillé ; maintenir Alt pour placer librement

## 2026-10-25 (11e série) — Protection

80. Page « Confidentialité et conditions » (legal.html) : politique de confidentialité, conditions d'utilisation, mentions légales, logiciels tiers ; liens en bas de l'accueil et dans l'aide
81. Message d'acceptation des conditions au premier lancement
82. Licence propriétaire (LICENSE) : le code est visible mais ne peut pas être copié ni redistribué sans autorisation

## 2026-10-25 (10e série)

79. Tuto intégré au montage : visite guidée en 13 étapes qui met chaque outil en lumière, lancée automatiquement la première fois puis avec le bouton « 🎓 Tuto » (marche aussi sur téléphone)

## 2026-10-25 (9e série) — Version téléphone (iPhone)

73. Installable sur l'écran d'accueil de l'iPhone (et Android) : icône, plein écran, nom « ClipForge », barre d'état intégrée, encoche respectée
74. Fonctionne hors connexion une fois chargée (l'app est gardée en cache, toujours mise à jour quand il y a du réseau)
75. Sur téléphone, les exports passent par la feuille de partage : « Enregistrer la vidéo » les met directement dans Photos, ou envoi direct vers TikTok, Instagram…
76. L'écran reste allumé pendant les exports (sinon le téléphone se met en veille et l'export s'arrête)
77. Mise en page téléphone revue : boutons des résultats sur deux lignes, recherche pleine largeur, éditeur et onglets qui tiennent dans l'écran, messages à la largeur de l'écran, raccourcis clavier masqués
78. Sur iPhone dans Safari, un message explique comment ajouter ClipForge à l'écran d'accueil

## 2026-10-25 (8e série) — Vraie app PC

69. Application Windows (Electron) avec installateur `ClipForge-Setup.exe` : propre fenêtre, icône, raccourcis bureau et menu Démarrer, désinstallation depuis Windows
70. Mises à jour automatiques de l'app PC à chaque nouvelle version publiée
71. Les exports de l'app PC sont enregistrés directement dans Téléchargements\ClipForge, avec un bouton « Ouvrir le dossier »
72. L'app PC se rouvre à la même taille et position, et une seule fenêtre à la fois

## 2026-10-25 (7e série) — Musique de fond du montage

64. Piste musique sur la timeline du montage : plusieurs musiques possibles, chacune posée où on veut, avec sa forme d'onde
65. Glisser un morceau pour le déplacer, tirer ses bords pour le raccourcir (le bord gauche avance dans la musique)
66. Par morceau : volume, fondu d'entrée et de sortie, point de départ dans la musique, boucle, raccourcis « Toute la vidéo », « Commencer ici », « Finir ici » ; dupliquer, supprimer, annuler
67. La musique baisse toute seule quand quelqu'un parle (ducking), puis remonte doucement ; désactivable par morceau
68. On peut déposer des fichiers audio avec les vidéos : ils vont directement sur la piste musique ; la musique est retrouvée avec le projet sauvegardé

## 2026-10-25 (6e série)

62. Annuler / rétablir dans l'éditeur de clip (Ctrl+Z / Ctrl+Y), pour tous les réglages, la découpe et le texte
63. Montage : « Égaliser le volume » ramène tous les segments au même niveau de voix (utile quand on assemble des sources différentes)

## 2026-10-25 (5e série) — Vidéos très longues

61. Dans la version PC (exe ou Node.js), le son des vidéos de plus de 300 Mo est extrait par ffmpeg au lieu d'être décodé entièrement par le navigateur : beaucoup moins de mémoire, les vidéos de plusieurs heures passent. Sert aussi de secours si le navigateur n'arrive pas à lire le son. Utilisé par l'analyse, la transcription et le retrait des silences.

## 2026-10-25 (4e série) — Photos et précision

55. Photos dans le montage (4 s par défaut avec effet Ken Burns, durée réglable)
56. Poignées sur les bords des segments de la timeline : tirer pour raccourcir ou rallonger
57. Position horizontale par segment (pour bien cadrer en passant du 16:9 au 9:16)
58. La musique suit les fondus de début et de fin du montage
59. Fond sombre derrière les sous-titres, pour la lisibilité
60. Palette d'emojis à insérer dans le texte des sous-titres

## 2026-10-25 (3e série) — Confort et finitions

46. Zoom dynamique ⚡ : petit zoom (« punch-in ») sur les mots forts, comme les créateurs pros
47. Aperçu animé du clip au survol de sa carte (recadrage et sous-titres compris)
48. Sous-titres déplaçables en glissant directement sur l'image
49. Plein écran dans l'éditeur (bouton ou touche F)
50. Export à 60 images/s pour des clips plus fluides
51. « Sujets qui t'intéressent » : la détection favorise les passages qui en parlent (raison « 🎯 Ton sujet »)
52. Thème clair / sombre, mémorisé
53. Fenêtre d'aide des raccourcis clavier (bouton ? ou touche ?)
54. Un montage exporté peut repartir directement dans le Clipping (« ✂ En faire des clips »)

## 2026-10-25 (2e série) — Montage plus complet et finitions du clipping

### Montage
31. Sous-titres automatiques (Whisper) sur tout le montage, recalés sur les coupes et les vitesses, 8 styles, position et taille
32. Zoom par segment et effet Ken Burns (zoom lent)
33. Animations des textes : Fondu, Pop, Glissé, Machine à écrire
34. Chapitres YouTube générés à partir des textes, copiés en un clic
35. Export du son seul (podcast)
36. Image PNG de l'instant affiché
37. Aller à la coupe précédente / suivante (↑ / ↓), bouton « Tout voir » pour ajuster le zoom de la timeline
38. Sauvegarde automatique du projet : en rajoutant les mêmes vidéos, on reprend où on s'était arrêté

### Clipping
39. Censure des gros mots : masqués à l'écran (p****n) et bipés à l'export
40. Mots-clés toujours en couleur dans les sous-titres
41. Accroche proposée automatiquement (la phrase la plus accrocheuse du clip)
42. Préréglages de style enregistrés et réutilisables d'une vidéo à l'autre
43. Sélection de clips pour n'exporter que ceux-là
44. Copier les titres et hashtags de tous les clips en un clic
45. Les clips retouchés sont retrouvés quand on relance la même vidéo (avec « Nouvelle détection » pour repartir de zéro)

## 2026-10-25 — Grosse mise à jour : onglet Montage + 24 nouveautés pour le clipping

### Nouvel onglet Montage (vidéos longues)
1. Plusieurs vidéos sur une timeline, avec miniatures et zoom
2. Couper à la tête de lecture (S), supprimer, dupliquer, déplacer (boutons ou glisser-déposer)
3. Annuler / rétablir (Ctrl+Z / Ctrl+Y)
4. Retrait automatique des silences (« jump cut »), avec seuil et durée minimum réglables, sur un segment ou toute la vidéo
5. Réglages par segment : début et fin, vitesse 0,5× à 2×, volume, filtre couleur, mise en page remplie ou ajustée avec fond flou
6. Transitions en fondu au noir entre les segments, fondus de début et de fin de vidéo
7. Textes à l'écran (Titre, Encadré, Bandeau), glissables dans le temps, taille, position, couleur
8. Musique de fond avec volume
9. Export 16:9, 9:16, 1:1 ou 4:5 en 1080p ou 720p, avec temps restant

### Clipping
10. 3 nouveaux styles de sous-titres : Mot à mot, Beast, Rétro
11. 4 polices pour les sous-titres (Montserrat, Anton, Bangers, Poppins)
12. Couleur du mot actif au choix
13. Nombre de mots affichés à la fois (1 à 4)
14. Taille des emojis réglable
15. Filtres couleur (Vif, Cinéma, Chaud, Froid, N&B)
16. Vitesse du clip (1× à 1,5×, la voix garde son ton)
17. Volume de la voix
18. Fondu d'entrée et de sortie (image et son)
19. Musique de fond, mixée sous la voix
20. Filigrane @pseudo (mémorisé)
21. Accroche : 3 couleurs et durée de 2 à 5 s
22. Export des sous-titres en `.srt`
23. Miniature PNG de l'image affichée
24. Raccourcis clavier dans l'éditeur (←/→, Maj, I/O, M)
25. Recherche d'un mot dans la transcription, qui crée un clip autour
26. Clip manuel, dupliquer, supprimer avec annulation
27. Filtre par score minimum, tri par durée
28. Analyse gardée dans le navigateur : relancer la même vidéo est instantané
29. Notification quand l'analyse ou l'export finit (onglet en arrière-plan) et temps restant pendant l'export
30. Nouvelle navigation Clipping / Montage dans la barre du haut
