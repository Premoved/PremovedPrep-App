# Comment policy

Code and names carry the meaning. A comment exists only for what the code cannot say.

## When

- A constraint or reason that is not visible in the code: security, protocol or library quirk,
  workaround, required ordering, units, a chosen status code, a magic number.
- A non-obvious contract of an exported/public API.
- Nothing else. No comment is the default.

Never:

- one per function, field, or class by habit;
- restating the name, type, or next line;
- narrative, history ("used to", "now", "no longer"), rationale essays, examples of usage;
- first/second person, rhetorical questions, metaphors, conversational tone;
- references to tickets, chats, or people.

## Form

- One line, max ~100 characters. Two lines only when unavoidable.
- Terse technical fragment, present tense: `// 404, not 403: hides whether the item exists.`
- TS/JS/Java: `//` in bodies; single-line `/** ... */` only on an exported declaration whose
  contract is not obvious.
- Density: 0-3 per ordinary file; long, branching files at most about one per 40 lines.
- HTML: none, except third-party attribution (Boxicons). SCSS/CSS: none, except a
  non-obvious value or hack.
- Config (YAML, Dockerfile, shell): one short line per setting that needs it.
- Must be true for the current code. Update or delete a comment in the same change that
  invalidates it.

## Examples

    // Refresh cookie is HttpOnly; the access token stays in memory only.
    // Loopback only: the Host header is checked against DNS rebinding.
    // Minor units: 124 = EUR 1.24.

Not:

    /** The service that manages plans. */
    // Now we loop over the items and add each one.
    /** A check inside a public binary is a check with a patch next to it. */

## Longer explanations

Design reasoning belongs in `docs/` (ADRs and reference pages), not in code.
