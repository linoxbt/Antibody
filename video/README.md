# Demo video source

The 2:55 demo video (`media/antibody-demo.mp4`, not committed: 131 MB) is built
from these files. Everything is deterministic: picture, captions and sound
cues all key off one timeline built from the narration.

| Step | File | What it does |
| --- | --- | --- |
| 1 | `script.json` | Narration, scene by scene |
| 2 | `tts.py` | One WAV per line with Kokoro-82M, voice `af_heart` (only new or edited lines are re-voiced; `--all` redoes every line) |
| 3 | `timeline.py` | Scene and line timings from the real voice lengths |
| 4 | `capture.mjs` | Screenshots of the live site and hosted sandbox (test wallet, real attack flow) |
| 5 | `stage.html` | The motion compositor: every element is a function of time `t`; also exports the sound cues |
| 6 | `cues.cjs` | Writes the cue sheet from the compositor |
| 7 | `audio.py` | Original sound design and score (synthesised), voice polish, ducking, mix |
| 8 | `preview.cjs` / `render.cjs` | Stills for QA / frame-accurate render to MP4 segments (1920×1080, 30 fps) |
| 9 | `mux.sh` | Joins segments, masters audio to −14 LUFS / −1 dBTP, muxes AAC 320k |

Web copy (`media/antibody-demo-web.mp4`): `ffmpeg -i antibody-demo.mp4 -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart antibody-demo-web.mp4`.

Copy the brand fonts and `mark.svg` from `web/assets/` into `assets/` first.
Sandbox screens are simulated by design; the mainnet scene uses the identifiers
in `docs/mainnet-evidence.md`.

## 44-second teaser (no voice)

`intro.html` (beat-synced compositor, 120 BPM; exports its own cue sheet),
`intro_audio.py` (trailer score + braam + sound design, built on `sfxlib.py`),
`intro_tool.cjs` (`stills` / `cues` / `render`). Output: `media/antibody-intro.mp4`.
