# omp-hashline-edit-hybrid

A fail-closed, hash-anchored text mutation system for [Oh My Pi](https://github.com/can1357/oh-my-pi). Copied from pi-hashline-edit-hybrid; OMP-only, no pi support.

It combines the state/anchor safety of `pi-hashline-edit-pro` (persistent stable line identities, served-range authorization, persistent stale-safe undo, atomic temp/rename writes, SQLite state) with the strict semantics and transactional multi-edit ergonomics of `pi-hashline-edit` (dedicated `edit`/`insert`, integrated anchored `grep`, literal payloads, warnings instead of heuristic rewriting).

## Defining guarantees

1. Every editable line has a short, unique, persistent 4-character anchor (`A-Za-z0-9`, spec §3).
2. An agent may destructively modify a line only if that exact line was previously shown in the current session — and only if it still contains exactly what was shown (§2.2, §10).
3. The editor never silently changes requested replacement text (§2.3).
4. Multiple edits to one file are validated together and committed as one transaction (§19).
5. Untouched lines retain their anchors through edits, external changes, and restarts (§6, §7).
6. External modifications inside an intended edit range cause the operation to fail (§10).
7. Undo never overwrites later modifications — it restores exact previous bytes and exact previous anchors (§33–§35).
8. Normal file replacement is crash-resistant and atomic: journal → temp → fsync → precommit recheck → rename → parent-dir fsync → SQLite finalize, with startup recovery for interrupted transactions (§29–§31).
9. No fuzzy matching, heuristic relocation, silent prefix stripping, automatic range reversal, or automatic boundary deletion (§24, §66).

## Tools

The extension registers `read`, `grep`, `edit`, `insert`, `write`, and `undo`, overriding pi's generic `read`/`grep`/`edit`/`write` by name. A successful `write` clears hybrid undo, reconciles anchors, invalidates only the served lines that no longer match, and (by default) returns an anchored auto-read preview.

```text
read → edit / insert → anchored diff → edit / insert → ...   (no unnecessary rereads)
grep → edit                                                  (grep output is edit-ready)
```

### `read`

`{ path, offset?, limit? }` → rows of `anchor│content`. Reconciles persistent anchors, rejects non-UTF-8/binary/oversized files, omits (and never serves) lines above 200 KiB, and exposes the current `revision` (SHA-256 of raw bytes) in details. Output is paged like the built-in read: without `limit`, at most 2000 lines are returned and the result carries a `nextOffset` continuation hint.

### `edit`

```json
{
  "path": "src/main.ts",
  "edits": [
    { "range": ["a81F", "Bs20"], "lines": ["new first line", "new second line"] },
    { "range": ["7azP", "7azP"], "lines": ["  return better();"] }
  ]
}
```

`range` is exactly two inclusive anchors; `lines` are literal logical lines (`[]` deletes). All ranges resolve against the same pre-edit document; every line of every range must be served and exact; overlapping ranges (even sharing an endpoint line) are rejected; a non-empty file can never be emptied via `edit` (`E_WOULD_EMPTY`); no-op transactions change nothing and report `No changes made.` The result is one combined anchored diff whose `" "` and `"+"` rows are immediately editable.

Optional top-level fields: `allow_display_like_content` (writes pasted `ANCHOR│...` content literally instead of rejecting it with `E_DISPLAY_LIKE_CONTENT`), `final_newline` (`preserve` | `present` | `absent`), and `expected_revision` (strict whole-file compare-and-swap mode; exactly 64 lowercase hexadecimal characters copied from `read`/`write` `details.revision` or `edit`/`insert` `details.metrics.after_revision`; omit when CAS is unused).

### `insert`

```json
{
  "path": "src/main.ts",
  "inserts": [
    { "anchor": "Ab31", "direction": "after", "lines": ["new line 1", "new line 2"] }
  ]
}
```

The anchor line itself must have been served and must still match. Multiple inserts are transactional; same anchor + direction keep request order. In an empty file (one empty line), `insert after` produces a leading blank line (`"\ncontent"`), while `insert before` produces the natural `"content\n"`. `expected_revision` is optional strict CAS: pass exactly 64 lowercase hexadecimal characters from `read`/`write` `details.revision` or `edit`/`insert` `details.metrics.after_revision`, or omit it when CAS is unused.

### `write`

`{ path, content, replace_existing?, expected_revision?, allow_display_like_content? }` → atomically creates or fully replaces a file. Overwriting an existing file requires a prior full-file `read` in the current epoch (or the explicit high-risk `replace_existing: true`); `expected_revision` is optional strict CAS and must be exactly 64 lowercase hexadecimal characters copied from `read`/`write` `details.revision` or `edit`/`insert` `details.metrics.after_revision`. Omit it when CAS is unused. Content that looks like pasted hashline display output (`ANCHOR│...` rows) is rejected with `E_DISPLAY_LIKE_CONTENT` unless `allow_display_like_content: true` is set. Enforces the global byte/line limits (`E_FILE_TOO_LARGE`) and returns a bounded anchored preview whose rows are edit-ready.

### `undo`

Reverts the last hybrid transaction on one file (all sub-edits together), persisted across restarts. Succeeds only if the file's current checksum exactly matches the transaction's result; otherwise `E_UNDO_STALE` and nothing is overwritten. Restores exact bytes (BOM, CRLF/CR/LF, final newline, trailing whitespace) and exact anchors — anchors from before the transaction return exactly; anchors introduced by the undone transaction are retired.

### `grep`

Runs ripgrep when available and renders matches with anchors from the same persistent engine as `read` — never independently fabricated hashes. Supports literal/regex patterns, file or directory roots, globs, `ignoreCase`, context, and a bounded limit. Full match and context lines become served. Rows that would exceed the 50 KiB output budget are cut at a row boundary and are **not** served — authorization is only ever granted for complete rows the model actually received. Files that cannot be decoded as anchored text (binary, non-UTF-8, oversized) are skipped with a notice, and CR-only files are reported without anchors because ripgrep line numbers cannot be aligned with the logical line model.

## State and safety model

- **Persistent state** (`~/.config/omp-hashline-edit-hybrid/state.sqlite`, honoring `XDG_CONFIG_HOME`): per-file anchor snapshots (compact blobs), one undo record per file, and a `pending_transactions` crash-recovery journal. WAL mode, `synchronous=NORMAL` (committed rows survive app crashes; a power loss may lose the most recent journal commits — accepted tradeoff for lower fsync latency), busy timeout with bounded retries, schema versioning, quick integrity check, and corruption quarantine (§48–§49).
- **Served authorization is session-scoped** (§8.1): anchors and undo survive restarts; permission to destructively edit previously viewed lines does not. A restart requires `read`/`grep` again. The served window is capped (5,000 lines per file, 20,000 session-wide); rows evicted by the cap are reported with `W_SERVED_WINDOW_EXCEEDED` and must be re-read before editing.
- **Stale vs unseen.** A range referencing lines never shown fails with `E_ANCHOR_NOT_SERVED`; a previously shown line that changed externally fails with `E_RANGE_STALE`. Both return a bounded fresh anchored view that becomes served, so retries work immediately (§10, §71).
- **Line identity is exact.** Fingerprints are SHA-256 of the exact logical line text — trailing whitespace is significant (§4.2). Untouched lines preserve their exact terminators; new lines use the file's dominant ending; the final newline follows the `final_newline` policy (§40–§41). UTF-8 BOM is document metadata, never line 1 (§42).
- **Symlinks** are followed (the target is edited, the link preserved; the mutation queue keys on the resolved target); **hard links** are preserved with an in-place write and a `W_HARDLINK_NONATOMIC` warning; file mode bits survive atomic renames (§43–§46). There is no silent non-atomic fallback (§45).

## Loading under Oh My Pi

OMP-only: `package.json` declares `omp.extensions: ["./index.ts"]`, with no `pi` key. Load the extension with `omp --extension ./index.ts`, or drop this package into `<cwd>/.omp/extensions/` or `~/.omp/agent/extensions/`.

## Development

Requires Node.js ≥ 22.19 (for `node:sqlite`).

```bash
npm install
npm test          # full suite
npm run typecheck
npm run test:coverage
```

The suite covers the spec's required areas (§61–§62): anchor engine (unique allocation, duplicate runs, determinism, retirement, reconciliation), served state (unseen/stale ranges, error feedback becoming served, restart clearing), strict payload handling (suspicious hashline content and the escape hatch), range semantics, multi-edit atomicity, undo byte fidelity, filesystem behaviors (symlinks, hard links, modes, precommit races, temp cleanup), crash recovery, and property/fuzz tests — thousands of chained random mutations and external-modification fuzz runs, with every outcome required to be either a safe successful edit or a clean rejection.

Coverage gates in `test:coverage` are lines 92 / statements 91 / functions 90 / branches 85; the safety-critical engine modules (mutation, anchors, served, render) run well above the spec's recommended 95 % meaningful-branch coverage.

## License

[MIT](LICENSE)
