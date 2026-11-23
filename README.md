# SwapStudio Video

Offline face swap for **videos and photos**. Pick one photo of a face, pick a video, and the app
replaces the face in every frame. The original audio is kept. Everything runs on the device;
nothing is uploaded.

Builds:
- **Android APK** (`SwapStudioVideo.apk`, Android 8.0+)
- **Windows installer** (`SwapStudioVideo-Setup-1.0.0.exe`, Start menu + desktop shortcut)
- **Windows portable EXE** (`SwapStudioVideo-1.0.0.exe`, no install needed)

## How to get the APK and EXE

1. Create a new GitHub repo (e.g. `swapstudio-video`) and push this folder to `main`:
   ```bash
   git init && git add . && git commit -m "SwapStudio Video"
   git branch -M main
   git remote add origin https://github.com/<you>/swapstudio-video.git
   git push -u origin main
   ```
2. Open the repo → **Actions** → "Build APK and EXE". It runs automatically (~6–10 min).
3. When it finishes, download the two artifacts at the bottom of the run page:
   `SwapStudioVideo-android` and `SwapStudioVideo-windows`.
4. Optional: push a tag (`git tag v1.0 && git push --tags`) to get both files attached to a GitHub Release.

## Using it

1. **Source face** – clear, front-facing, well-lit photo.
2. **Target** – a video (mp4/webm/mov that the device can play) or a photo.
3. **Preview** to check, then **Render & save**. The video plays through once while recording.
   - Android: saved to `Download/SwapStudioVideo/`
   - Windows: a Save dialog appears.

Settings: largest face vs all faces, output resolution, strength, edge softness, jitter
stabilisation, skin-colour matching, keep the target's mouth opening (natural talking),
keep the target's eyes (natural blinking), and the "AI face swap" label.

## How it works

- MediaPipe Face Landmarker finds 468 face points per frame (GPU, falls back to CPU).
- The source face is triangulated (Delaunay) and drawn with WebGL onto the target's points,
  with feathered edges and per-face colour matching.
- The canvas is recorded with MediaRecorder together with the video's audio track.

Layout: `web/` (the app), `android/` (WebView wrapper), `desktop/` (Electron wrapper),
`scripts/fetch-assets.sh` (downloads the engine + model at build time).

## Limits

- Rendering is real-time: slow phones drop frames instead of slowing down. Use 720p for long clips.
- Best with faces looking roughly at the camera; strong side profiles look warped.
- It's a 2D mesh warp, not a trained deepfake model: expressions follow the target,
  but identity transfer is weaker than GPU-trained tools.

Use only with the consent of the people whose faces you use.
