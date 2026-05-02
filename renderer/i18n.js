/**
 * i18n.js — internationalisation
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:
 *   window.t('key')             — get translation string
 *   window.t('key', {x: val})  — with variable substitution
 *   window.tArr('key')          — get translation array (loading messages etc.)
 *   window.i18n.setLang('es')  — switch language + re-render DOM
 *   window.i18n.currentLang    — active language code
 *   window.i18n.systemLang     — detected OS language code
 *
 * Supported: en · es · fr · de · pt
 * Falls back to 'en' for any unsupported locale.
 */

const SUPPORTED  = ['en', 'es', 'fr', 'de', 'pt']
const LANG_NAMES = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português' }

// ── Translations ──────────────────────────────────────────────────────────────

const T = {

  en: {
    'drop.headline':  "Drag your song here",
    'drop.hint':      "mp3 · wav · flac · ogg · m4a",

    'bpm.play':                  "Play",
    'bpm.pause':                 "Pause",
    'bpm.kb_hint':               "Space",
    'bpm.unit':                  "BPM",
    'bpm.custom.placeholder':    "Custom…",
    'bpm.section.candidates':    "Candidates",
    'bpm.section.modifiers':     "Modifiers",
    'bpm.mod.halfbeat':          "Shift Grid +½ Beat",
    'bpm.mod.double':            "Double BPM",
    'bpm.cancel':                "Cancel",
    'bpm.create':                "Create Map →",
    'bpm.creating':              "Creating…",
    'bpm.building':              "Building Beat Saber folder…",
    'bpm.status.ready':          "Press Play or Space to preview with metronome",
    'bpm.status.audio_error':    "Audio error: {msg}",

    'vol.song':           "Song",
    'vol.metro':          "Metronome",

    'offset.pad':         "pad",
    'offset.beat1':       "beat 1",
    'offset.beats_added': "beats added",

    'settings.title':        "Settings",
    'settings.export_dir':   "Export folder",
    'settings.export_hint':  "Beat Saber project folders are saved here.",
    'settings.mapper':       "Mapper name",
    'settings.mapper_hint':  "Written into Info.dat as the level author.",
    'settings.mapper_ph':    "YourName",
    'settings.language':     "Language",
    'settings.lang_system':  "System ({lang})",
    'settings.browse':       "Browse…",
    'settings.cancel':       "Cancel",
    'settings.save':         "Save",

    'credits.made': "Made with",

    'analysis.msgs': [
      "Converting audio…",
      "Decoding waveform…",
      "Firing up the neural network…",
      "Detecting beats…",
      "Asking madmom nicely…",
      "Running the RNN…",
      "Crunching 16,000 BPM candidates…",
      "Consulting the beat oracle…",
      "Scanning for the downbeat…",
      "Measuring grid alignment…",
      "Finding beat 1…",
      "Optimizing the tempo grid…",
      "Almost done lying to you…",
      "Counting every single beat…",
      "Minimizing alignment error…",
      "Detecting musical accents…",
    ],

    'audio.msgs': [
      "Rythmering…",
      "Counting beats on fingers…",
      "Waking up the tempo gremlins…",
      "Asking the metronome nicely…",
      "Listening very carefully…",
      "Consulting the BPM oracle…",
      "Teaching the algorithm to dance…",
      "Doing math I didn't agree to…",
      "Arguing with the waveform…",
      "Calibrating the vibe detector…",
      "This track slaps, btw…",
      "Definitely not guessing…",
      "Pretending to understand jazz…",
      "Found some beats, need more…",
      "Aligning the cosmic grid…",
      "Summoning the downbeat…",
      "Negotiating with the kick drum…",
      "Almost done lying to you…",
    ],
  },

  // ────────────────────────────────────────────────────────────────────────────

  es: {
    'drop.headline':  "Arrastra tu canción aquí",
    'drop.hint':      "mp3 · wav · flac · ogg · m4a",

    'bpm.play':                  "Reproducir",
    'bpm.pause':                 "Pausar",
    'bpm.kb_hint':               "Espacio",
    'bpm.unit':                  "BPM",
    'bpm.custom.placeholder':    "Personalizado…",
    'bpm.section.candidates':    "Candidatos",
    'bpm.section.modifiers':     "Modificadores",
    'bpm.mod.halfbeat':          "Desplazar +½ Beat",
    'bpm.mod.double':            "Doblar BPM",
    'bpm.cancel':                "Cancelar",
    'bpm.create':                "Crear Mapa →",
    'bpm.creating':              "Creando…",
    'bpm.building':              "Generando carpeta Beat Saber…",
    'bpm.status.ready':          "Pulsa Play o Espacio para previsualizar con metrónomo",
    'bpm.status.audio_error':    "Error de audio: {msg}",

    'vol.song':           "Canción",
    'vol.metro':          "Metrónomo",

    'offset.pad':         "silencio",
    'offset.beat1':       "beat 1",
    'offset.beats_added': "beats añadidos",

    'settings.title':        "Ajustes",
    'settings.export_dir':   "Carpeta de exportación",
    'settings.export_hint':  "Las carpetas del proyecto se guardan aquí.",
    'settings.mapper':       "Nombre del mapper",
    'settings.mapper_hint':  "Se escribe en Info.dat como autor del nivel.",
    'settings.mapper_ph':    "TuNombre",
    'settings.language':     "Idioma",
    'settings.lang_system':  "Sistema ({lang})",
    'settings.browse':       "Explorar…",
    'settings.cancel':       "Cancelar",
    'settings.save':         "Guardar",

    'credits.made': "Hecho con",

    'analysis.msgs': [
      "Convirtiendo el audio…",
      "Descifrando la onda…",
      "Encendiendo la red neuronal…",
      "Detectando los beats…",
      "Preguntándole a madmom amablemente…",
      "Ejecutando la RNN…",
      "Masticando 16.000 candidatos de BPM…",
      "Consultando al oráculo del tempo…",
      "Buscando el downbeat…",
      "Midiendo el error de rejilla…",
      "Encontrando el beat 1…",
      "Optimizando la rejilla de tempo…",
      "Casi listo, te juro…",
      "Contando cada beat uno a uno…",
      "Minimizando el error de alineación…",
      "Detectando acentos musicales…",
    ],

    'audio.msgs': [
      "Ritmando…",
      "Contando beats con los dedos…",
      "Despertando a los duendes del tempo…",
      "Pidiéndole al metrónomo por favor…",
      "Escuchando muy atentamente…",
      "Consultando al oráculo del BPM…",
      "Enseñando al algoritmo a bailar…",
      "Haciendo matemáticas sin permiso…",
      "Discutiendo con la forma de onda…",
      "Calibrando el detector de vibraciones…",
      "Este tema está bastante bien, oye…",
      "Definitivamente no estoy inventando…",
      "Fingiendo entender el jazz…",
      "Encontré algunos beats, necesito más…",
      "Alineando la rejilla cósmica…",
      "Invocando el downbeat…",
      "Negociando con el bombo…",
      "Casi terminado, en serio…",
    ],
  },

  // ────────────────────────────────────────────────────────────────────────────

  fr: {
    'drop.headline':  "Glissez votre chanson ici",
    'drop.hint':      "mp3 · wav · flac · ogg · m4a",

    'bpm.play':                  "Lecture",
    'bpm.pause':                 "Pause",
    'bpm.kb_hint':               "Espace",
    'bpm.unit':                  "BPM",
    'bpm.custom.placeholder':    "Personnalisé…",
    'bpm.section.candidates':    "Candidats",
    'bpm.section.modifiers':     "Modificateurs",
    'bpm.mod.halfbeat':          "Décaler +½ Temps",
    'bpm.mod.double':            "Doubler le BPM",
    'bpm.cancel':                "Annuler",
    'bpm.create':                "Créer la Map →",
    'bpm.creating':              "Création…",
    'bpm.building':              "Génération du dossier Beat Saber…",
    'bpm.status.ready':          "Appuyez sur Lecture ou Espace pour prévisualiser",
    'bpm.status.audio_error':    "Erreur audio : {msg}",

    'vol.song':           "Chanson",
    'vol.metro':          "Métronome",

    'offset.pad':         "silence",
    'offset.beat1':       "temps 1",
    'offset.beats_added': "temps ajoutés",

    'settings.title':        "Paramètres",
    'settings.export_dir':   "Dossier d'export",
    'settings.export_hint':  "Les projets Beat Saber sont enregistrés ici.",
    'settings.mapper':       "Nom du mapper",
    'settings.mapper_hint':  "Écrit dans Info.dat comme auteur du niveau.",
    'settings.mapper_ph':    "VotreNom",
    'settings.language':     "Langue",
    'settings.lang_system':  "Système ({lang})",
    'settings.browse':       "Parcourir…",
    'settings.cancel':       "Annuler",
    'settings.save':         "Enregistrer",

    'credits.made': "Fait avec",

    'analysis.msgs': [
      "Conversion de l'audio…",
      "Décodage de la forme d'onde…",
      "Lancement du réseau neuronal…",
      "Détection des temps…",
      "Interrogation de madmom…",
      "Exécution du RNN…",
      "Analyse de 16 000 candidats BPM…",
      "Consultation de l'oracle du tempo…",
      "Recherche du temps fort…",
      "Mesure de l'alignement de grille…",
      "Recherche du temps 1…",
      "Optimisation de la grille de tempo…",
      "Presque terminé, promis…",
      "Comptage de chaque temps…",
      "Minimisation de l'erreur d'alignement…",
      "Détection des accents musicaux…",
    ],

    'audio.msgs': [
      "Rythmisation en cours…",
      "Comptage des temps sur les doigts…",
      "Réveil des lutins du tempo…",
      "Négociation avec le métronome…",
      "Écoute très attentive…",
      "Consultation de l'oracle BPM…",
      "Apprentissage de la danse à l'algorithme…",
      "Calculs non consentis…",
      "Dispute avec la forme d'onde…",
      "Calibrage du détecteur de vibrations…",
      "Ce morceau envoie, au fait…",
      "Pas du tout en train de deviner…",
      "Semblant de comprendre le jazz…",
      "Quelques temps trouvés, il en faut plus…",
      "Alignement de la grille cosmique…",
      "Invocation du temps fort…",
      "Négociation avec la grosse caisse…",
      "Presque fini, vraiment…",
    ],
  },

  // ────────────────────────────────────────────────────────────────────────────

  de: {
    'drop.headline':  "Song hier ablegen",
    'drop.hint':      "mp3 · wav · flac · ogg · m4a",

    'bpm.play':                  "Abspielen",
    'bpm.pause':                 "Pause",
    'bpm.kb_hint':               "Leertaste",
    'bpm.unit':                  "BPM",
    'bpm.custom.placeholder':    "Eigener Wert…",
    'bpm.section.candidates':    "Kandidaten",
    'bpm.section.modifiers':     "Modifikatoren",
    'bpm.mod.halfbeat':          "Raster +½ Beat verschieben",
    'bpm.mod.double':            "BPM verdoppeln",
    'bpm.cancel':                "Abbrechen",
    'bpm.create':                "Map erstellen →",
    'bpm.creating':              "Wird erstellt…",
    'bpm.building':              "Beat Saber-Ordner wird generiert…",
    'bpm.status.ready':          "Play oder Leertaste für Vorschau mit Metronom",
    'bpm.status.audio_error':    "Audiofehler: {msg}",

    'vol.song':           "Song",
    'vol.metro':          "Metronom",

    'offset.pad':         "Stille",
    'offset.beat1':       "Beat 1",
    'offset.beats_added': "Beats hinzugefügt",

    'settings.title':        "Einstellungen",
    'settings.export_dir':   "Exportordner",
    'settings.export_hint':  "Beat Saber-Projektordner werden hier gespeichert.",
    'settings.mapper':       "Mapper-Name",
    'settings.mapper_hint':  "Wird in Info.dat als Level-Autor geschrieben.",
    'settings.mapper_ph':    "DeinName",
    'settings.language':     "Sprache",
    'settings.lang_system':  "System ({lang})",
    'settings.browse':       "Durchsuchen…",
    'settings.cancel':       "Abbrechen",
    'settings.save':         "Speichern",

    'credits.made': "Gemacht mit",

    'analysis.msgs': [
      "Audio konvertieren…",
      "Wellenform dekodieren…",
      "Neuronales Netz starten…",
      "Beats erkennen…",
      "Madmom höflich befragen…",
      "RNN ausführen…",
      "16.000 BPM-Kandidaten verarbeiten…",
      "Das Tempo-Orakel befragen…",
      "Downbeat suchen…",
      "Rasterausrichtung messen…",
      "Beat 1 finden…",
      "Temporaster optimieren…",
      "Fast fertig, versprochen…",
      "Jeden einzelnen Beat zählen…",
      "Ausrichtungsfehler minimieren…",
      "Musikalische Akzente erkennen…",
    ],

    'audio.msgs': [
      "Rhythmisierung läuft…",
      "Beats an den Fingern zählen…",
      "Tempo-Kobolde wecken…",
      "Das Metronom nett fragen…",
      "Sehr aufmerksam zuhören…",
      "Das BPM-Orakel befragen…",
      "Dem Algorithmus Tanzen beibringen…",
      "Unerlaubte Mathematik betreiben…",
      "Mit der Wellenform streiten…",
      "Vibrationsdetektor kalibrieren…",
      "Dieser Track haut rein, übrigens…",
      "Definitiv nicht raten…",
      "So tun als ob man Jazz versteht…",
      "Ein paar Beats gefunden, brauche mehr…",
      "Kosmisches Raster ausrichten…",
      "Downbeat beschwören…",
      "Mit der Bassdrum verhandeln…",
      "Fast fertig, wirklich…",
    ],
  },

  // ────────────────────────────────────────────────────────────────────────────

  pt: {
    'drop.headline':  "Arraste sua música aqui",
    'drop.hint':      "mp3 · wav · flac · ogg · m4a",

    'bpm.play':                  "Reproduzir",
    'bpm.pause':                 "Pausar",
    'bpm.kb_hint':               "Espaço",
    'bpm.unit':                  "BPM",
    'bpm.custom.placeholder':    "Personalizado…",
    'bpm.section.candidates':    "Candidatos",
    'bpm.section.modifiers':     "Modificadores",
    'bpm.mod.halfbeat':          "Deslocar +½ Beat",
    'bpm.mod.double':            "Dobrar BPM",
    'bpm.cancel':                "Cancelar",
    'bpm.create':                "Criar Mapa →",
    'bpm.creating':              "Criando…",
    'bpm.building':              "Gerando pasta Beat Saber…",
    'bpm.status.ready':          "Pressione Play ou Espaço para visualizar com metrônomo",
    'bpm.status.audio_error':    "Erro de áudio: {msg}",

    'vol.song':           "Música",
    'vol.metro':          "Metrônomo",

    'offset.pad':         "silêncio",
    'offset.beat1':       "beat 1",
    'offset.beats_added': "beats adicionados",

    'settings.title':        "Configurações",
    'settings.export_dir':   "Pasta de exportação",
    'settings.export_hint':  "As pastas do projeto Beat Saber são salvas aqui.",
    'settings.mapper':       "Nome do mapper",
    'settings.mapper_hint':  "Escrito no Info.dat como autor do nível.",
    'settings.mapper_ph':    "SeuNome",
    'settings.language':     "Idioma",
    'settings.lang_system':  "Sistema ({lang})",
    'settings.browse':       "Procurar…",
    'settings.cancel':       "Cancelar",
    'settings.save':         "Salvar",

    'credits.made': "Feito com",

    'analysis.msgs': [
      "Convertendo áudio…",
      "Decodificando forma de onda…",
      "Iniciando rede neural…",
      "Detectando beats…",
      "Perguntando ao madmom…",
      "Executando RNN…",
      "Processando 16.000 candidatos de BPM…",
      "Consultando o oráculo do tempo…",
      "Procurando o downbeat…",
      "Medindo alinhamento de grade…",
      "Encontrando o beat 1…",
      "Otimizando grade de tempo…",
      "Quase pronto, juro…",
      "Contando cada beat…",
      "Minimizando erro de alinhamento…",
      "Detectando acentos musicais…",
    ],

    'audio.msgs': [
      "Ritmando…",
      "Contando beats nos dedos…",
      "Acordando os duendes do tempo…",
      "Pedindo ao metrônomo por favor…",
      "Ouvindo com muita atenção…",
      "Consultando o oráculo do BPM…",
      "Ensinando o algoritmo a dançar…",
      "Fazendo matemática sem permissão…",
      "Discutindo com a forma de onda…",
      "Calibrando detector de vibrações…",
      "Essa música está boa, hein…",
      "Definitivamente não estou chutando…",
      "Fingindo entender jazz…",
      "Encontrei alguns beats, preciso de mais…",
      "Alinhando grade cósmica…",
      "Invocando o downbeat…",
      "Negociando com o bumbo…",
      "Quase terminando, de verdade…",
    ],
  },

}

// ── Runtime ───────────────────────────────────────────────────────────────────

function _detectSystem() {
  const nav = (navigator.language || 'en').toLowerCase()
  for (const code of SUPPORTED) {
    if (nav === code || nav.startsWith(code + '-')) return code
  }
  return 'en'
}

let _systemLang = _detectSystem()
let _lang       = _systemLang

function setLang(code) {
  const resolved = (code === 'system') ? _systemLang : code
  _lang = SUPPORTED.includes(resolved) ? resolved : 'en'
  apply()
}

function t(key, vars = {}) {
  const dict = T[_lang] || T.en
  let str    = dict[key]
  if (str === undefined) str = T.en[key]
  if (str === undefined) return key
  if (typeof str !== 'string') return str
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, v)
  }
  return str
}

function tArr(key) {
  const dict = T[_lang] || T.en
  return Array.isArray(dict[key]) ? dict[key]
       : Array.isArray(T.en[key]) ? T.en[key]
       : []
}

function apply() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'))
  })
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-ph'))
  })
  // Refresh system option label in language selector
  const sysOpt = document.querySelector('#lang-select option[value="system"]')
  if (sysOpt) {
    sysOpt.textContent = t('settings.lang_system', { lang: LANG_NAMES[_systemLang] || _systemLang })
  }
}

window.i18n = {
  get currentLang() { return _lang },
  get systemLang()  { return _systemLang },
  setLang,
  apply,
  SUPPORTED,
  LANG_NAMES,
}

window.t    = t
window.tArr = tArr
