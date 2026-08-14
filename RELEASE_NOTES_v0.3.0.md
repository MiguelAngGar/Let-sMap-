# Let'sMap! v0.3.0

La versión del motor nuevo: análisis en segundos, instalador mucho más ligero, y el audio exportado cumple los criterios de ranking de ScoreSaber.

## ✨ Novedades

- **Nuevo motor de detección de BPM y offset**, escrito en JavaScript puro (implementa el algoritmo del paper *"Non-causal Beat Tracking for Rhythm Games"* de Bram van de Wetering). El análisis pasa de 30–90 s a **~2–4 s por canción**, con precisión a resolución de muestra (±0.01 BPM en tempo fijo, exacto en BPMs enteros). Ya no necesita Python.
- **Instalador mucho más ligero**: el runtime de Python/madmom ya no se incluye en el paquete. El motor antiguo sigue en el repo como motor *legacy* para desarrollo (`LETSMAP_ENGINE=madmom`).
- **Autodetección de Beat Saber** (Windows, Steam y Oculus): la carpeta de exportación apunta automáticamente a `Beat Saber_Data\CustomWIPLevels` hasta que elijas una carpeta manualmente. Botón «Autodetectar» en Ajustes, y el campo de ruta ahora también se puede escribir a mano.
- **Cold end**: el audio exportado garantiza ≥2 s de silencio tras la música (regla de outro de ScoreSaber), añadiendo solo lo que falte. Junto al lead-in de ≥1.5 s, el audio del mapa cumple los criterios de intro y outro.
- **Previsualización fiel al mapa final**: la vista de validación muestra el silencio inicial que se añadirá, y el metrónomo suena desde el primer beat con audio.
- **Click para buscar**: la zona de drop también abre el explorador de archivos al hacer click.
- **Icono nuevo**, con forma de waveform y el beat destacado.

## 🐛 Arreglos

- El metrónomo empezaba a sonar varios beats tarde (anclaba en el compás 1 en vez de en el primer beat audible).
- Los ajustes se cortaban con el tamaño de ventana por defecto; ahora la ventana abre más grande y el panel tiene scroll propio, así que nunca se corta.
- Seleccionar texto en Ajustes y soltar el ratón fuera del panel ya no lo cierra.
- La barra de scroll ya no se solapa con el texto de créditos.
- Textos de Ajustes más claros y feedback de la autodetección junto a su botón (en los 5 idiomas).

## 📥 Descargas

- **Windows**: `Let'sMap! Setup 0.3.0.exe` (instalador NSIS, x64)
- **macOS**: `Let'sMap!-0.3.0.dmg` (Apple Silicon / arm64)

> El mismo audio en formatos distintos (WAV/FLAC/MP3/OGG) produce el mismo BPM; los mapas quedan siempre sincronizados internamente sea cual sea el formato de entrada.
