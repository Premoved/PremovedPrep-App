# PremovedPrep — desktop application

PremovedPrep is a tournament preparation platform, designed for chess analysis, exploring database games, studying opponents and building repertoires. This is its desktop application: the same interface, plus a native chess engine, your own PGN databases indexed on your computer, and collections kept on disk.

The website is free and lives at **[premovedprep.com](https://premovedprep.com)**; the application is downloaded from **[its Desktop App page](https://premovedprep.com/app)** and access to its tools
requires an active subscription plan.

## Requirements

- Node 24
- npm 10 or newer

## How to run

```bash
npm ci
npm start # builds the bundle, then opens the application
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | production build, then the application window |
| `npm run electron` | opens the application against the bundle already in `dist/` |
| `npm run serve` | `ng serve` in a browser against a backend on `localhost:8080` |
| `npm run engine` | downloads the Stockfish build for this machine into `resources/engines/` |
| `npm run pack` | an unpacked build in `release/`, no installer |
| `npm run dist` | Windows installer and portable executable |
| `npm run dist:mac` | macOS disk image (only on macOS) |
| `npm run dist:linux` | Linux AppImage (only on Linux) |
| `npm test` | unit tests (Vitest) |
| `npm run lint` | ESLint, over TypeScript and templates |
| `npm run check` | everything CI runs: signal calls, bindings, UCI session, replay, lint, both tsconfigs |

## Packaging and releases

Each installer is built on the platform it is for: `npm run dist` on Windows, `npm run dist:mac` on macOS, `npm run dist:linux` on Linux. `.github/workflows/release.yml` does all three on a pushed `v*` tag and attaches them, with their checksums, to the GitHub release the website links to.

`npm run engine` downloads the Stockfish build for the machine it runs on. The binary is not committed: it is GPL-3.0-or-later and travels with its own licence, which is why `Copying.txt` and `AUTHORS` sit beside it.

**The binaries are not signed.** Windows SmartScreen shows the unknown-publisher warning on first run — "More info" → "Run anyway" — and macOS asks for the application to be opened from the context menu the first time.

## Licence

AGPL-3.0-only. See `LICENSE`.

- **Network Interaction Clause:** If you deploy a modified version of this application for public network use, the AGPL requires you to provide users with access to your modified source code.
- **Third-Party Assets:** Third-party code, icons, engines and downloaded assets operate under their own specific terms, which are listed in [`THIRD-PARTY.md`](THIRD-PARTY.md). Stockfish and Chessground are GPL-3.0-or-later and their notices travel inside the build.
- PremovedPrep's custom icons and SVG logos are proprietary to the app's identity and are not covered by the project's primary license.
- The move, capture and castling recordings in `public/sound/premoved/` are Premoved's own and are covered by this project's licence.

## Trademarks and Copyrights

PremovedPrep is an independent project.
Lichess® and the Lichess artwork are registered trademarks of Lichess.org.
Stockfish is a trademark of the Stockfish developers.
FIDE is a registered trademark of the International Chess Federation.
All other software components, trademarks, and logos mentioned are the property of their respective owners. PremovedPrep is not affiliated with, endorsed by, or sponsored by any of these organizations.
