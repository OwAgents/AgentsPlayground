# Web File Browser & Viewer / Editor

A standalone web-based file manager with a Windows 11 File Explorer UI.

## Features

- **Explorer at `/`**: Windows 11 Explorer UI is the default route.
- **Starts in your home dir**: a fresh Explorer open lands in the current
  user's home directory (`/root` on workers), with full system access one
  breadcrumb away.
- **Path routing**: directories open at `/browse/<path>`, files stream at
  `/browse/<path>`, and text files open in the editor at `/edit/<path>`.
- **Full Media Viewer & Editor**:
  - Image preview thumbnails & full view (PNG, JPG, SVG, WebP, GIF)
  - Audio playback controls (WAV, MP3, OGG, AAC)
  - Video playback controls (MP4, WebM, MOV)
  - Live text editor with save support (`.txt`, `.js`, `.json`, `.md`, `.css`, `.html`, etc.)
- **File Management**:
  - File upload & creation
  - Directory creation & navigation
  - File & folder deletion
  - Icon & details list view toggles
- **Full System Access**: Rooted at `/` with no login and no sandbox. Reads,
  edits, uploads, and deletes anywhere the OS user has permissions.

## Setup & Running

```bash
cd filebrowser
npm install
npm start
```

The server serves the entire filesystem from `/` by default. Set `STORAGE_DIR`
to serve only a subtree (for example `STORAGE_DIR=$HOME`).

The Explorer opens on the current user's home directory by default
(`process.env.HOME` / `os.homedir()`). Set `START_DIR` to change the landing
folder (for example `START_DIR=/`) while keeping full system access.

Default access points:
- Explorer UI: `http://localhost:3000/`
- Browse a folder: `http://localhost:3000/browse/work`
- Edit a text file: `http://localhost:3000/edit/README.md`

Run the backend sanity checks with `npm test` (starts its own server on :3847
and verifies routing plus full system access).
