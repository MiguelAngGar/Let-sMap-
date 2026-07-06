# Let'sMap! v0.2.0

Esta versión arregla la calidad del audio exportado y añade control sobre ella.

## 🐛 Arreglos

- **Calidad del `song.ogg`**: el audio exportado salía a bitrate bajo (Vorbis q6 ≈ 192 kbps) y forzaba 44.1 kHz, haciendo *downsample* de fuentes a 48 kHz. Ahora se conserva el sample rate original y se encoda con mucha mayor calidad. El silencio inicial se genera al mismo sample rate para mantener la sincronía exacta.

## ✨ Novedades

- **Mantener la calidad del archivo original** (activado por defecto): iguala el bitrate del archivo subido, así el audio del mapa mantiene tamaño y calidad prácticamente idénticos a la entrada, en vez de inflarse. Para fuentes sin pérdida (WAV/FLAC) usa la calidad máxima.
- **Selector de calidad OGG** (q3–q10) en Ajustes, para elegir una calidad fija cuando desactivas la opción anterior. Se deshabilita mientras "mantener calidad original" está activo.
- Textos traducidos a los 5 idiomas (en · es · fr · de · pt).

## 📥 Descargas

- **Windows**: `Let'sMap! Setup 0.2.0.exe` (instalador NSIS, x64)
- **macOS**: `Let'sMap!-0.2.0.dmg` (Apple Silicon / arm64)

> Nota: Beat Saber requiere audio en formato Ogg Vorbis, por lo que el archivo se reencoda; "mantener calidad original" iguala el bitrate de origen para que la pérdida sea inapreciable.
