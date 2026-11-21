# Read broken CSV files faster

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/lions0810/csv-reader-speed-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/lions0810/csv-reader-speed-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

Entry to make.fun's [csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121) bounty: a faster drop-in for csv-reader 1.0.0 that answers exactly as it does on every case — same `{columns, rows, errors}`, same error codes (`stray_cr`, `quote_junk`, `unterminated_quote`, `short_row`, `long_row`), same line counting, BOM drop and CRLF handling.

## How it is faster

The reference walks the text one character at a time, building every field a character at a time. This entry scans instead:

- Every field is cut out whole with `indexOf` jumps to its next delimiter (comma or line break); quoted fields are cut out with `indexOf` jumps to the next quote. Only a field that actually holds a stray CR, or a quoted span that actually holds a line break, takes a slower clean-up pass.
- The record's line end is computed once per record, so an unquoted field usually needs a single comma search to find its end, and a record known to hold no stray CR skips the per-field CR check. Both shortcuts are dropped the moment a quoted field swallows a line break.
- A line with no quote and no stray CR is split in one go.

On the practice set (6 cases, ~10.2 MB of CSV) the driver runs in ~0.84 s of CPU against the house baseline's ~1.92 s on this machine, with byte-identical answers (scorer: 6/6, `grade-local` L1 regrade reproduced byte for byte). Solve-only: ~0.2 s vs ~0.85 s.

## Layout

- `solve.js` — the entry: `run(input)` returns csv-reader's answer for `{text, header}`. ES module, dependency-free, no WASM or native code.
- `main.ts` — the harness program: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`. Turns V8's incremental marking off before importing `solve.js`, as the house driver does.
- `package.json` — `{"type": "module"}`.

## License

MIT. See [LICENSE](LICENSE).
