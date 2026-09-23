# Bundled engine

The application looks for a UCI engine here and registers it on first start, so a local engine is
something that is simply there rather than something a person has to set up. Its own name — and
therefore its version — is read from the engine itself, so nothing here has to be kept in step
with it.

```
resources/engines/win32-x64/stockfish.exe        this machine's folder, looked at first
resources/engines/darwin-arm64/stockfish
resources/engines/linux-x64/stockfish
resources/engines/stockfish.exe                  the flat fallback
```

A compiled engine is a program for one operating system and one processor architecture, and
packaging it with Electron does not change that: what runs is a process, not anything the runtime
abstracts. Stockfish publishes one universal binary per platform and architecture — Windows x86-64
and ARM64, one file for both Macs, Linux x86-64, ARM64 and RISC-V — and each detects its CPU's
instruction sets at startup. So it is one file per target, not one per CPU generation, and the
targets are exactly the ones `electron-builder` already builds installers for.

`electron-builder.yml` copies this folder beside the packaged application's resources, outside the
asar archive — a process cannot be started from inside one. The whole folder is copied, and each
installer is built on the platform it is for, with `npm run engine` having fetched that platform's
binary and nothing else. A machine holding several of them would put all of them in every
installer; give each target its own `extraResources` entry if that ever matters.

Nothing is committed here. Stockfish is GPL-3.0-or-later: the binary is downloaded from
stockfishchess.org, and conveying it means conveying its licence and its source offer with the
build. `Copying.txt` and `AUTHORS` from the same download are committed here and ship with the
binary, because `electron-builder.yml` copies this whole folder.

Without a binary here, the engine list simply has no bundled entry, and Local resources is where a
person points at one of their own.
