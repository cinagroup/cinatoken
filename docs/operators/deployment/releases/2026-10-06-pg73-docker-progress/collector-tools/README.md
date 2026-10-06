# Durable evidence collector (Temp only)

This tooling prepares immutable release evidence. Collection or a successful verifier does not mark a product gate passed. The final source commit, each actual CI source commit, and the unchanged production source commit are separate fields.

`collect-evidence.mjs audit CONFIG.json new-audit.json` reads every explicitly configured Temp input root and reports missing command closure. Audit writes a new report and exits 1 when any blocker remains. Nonzero command exits and historical nonterminal reports are preserved; neither is upgraded to a successful command. A historical nonterminal report does not authorize its raw logs. Ordinary stdout/stderr still require an explicit supported terminal receipt.

`collect-evidence.mjs collect CONFIG.json` requires the final full SHA, required roots, and zero blockers. Its new output directory must stay under Temp and cannot overlap a source root. Every file and report uses `wx`. All files above the configured threshold (minimum 100000 bytes) use lossless gzip with both original and stored byte counts and SHA256. Collection checks decompression and the original current Temp bytes. It refuses directory/file symlinks, duplicate or overlapping roots, traversal and compression path collisions.

`verify-evidence.mjs REPORT.json new-verification.json with-source` rechecks the exact stored file set, all stored bytes/SHA, decoded original bytes/SHA, current Temp source bytes, and totals. `stored-only` is reserved for later source expiry and explicitly reports source verification false.

The v364 executor dialect requires its exact schema, an actual numeric process exit, `groupGone=true` and `directChildReaped=true`. All declared output descriptors must match original bytes/SHA. The Node baseline stdout/stderr descriptors are also matched. Forced cleanup flags, process exit and runner outcome remain distinct; this collector does not derive cooperative cleanup or runtime success from group removal.

The exact historical non-Linux preflight RuntimeError has a separate negative-only dialect: actual exit must be 1, no package/run metadata, no subreaper or child reaping, and exactly two original stdout/stderr descriptors. It retains the historical misnamed process field as an observation; it proves no Linux runtime or actual child exit and cannot become a pass.

Copied historical GH job logs require an explicit immutable-copy binding in the configuration. It validates the included original receipt, all copy provenance descriptors and byte-exact copies, exact GH job log argument, full source SHA, run/job IDs and a completed CI status. A GH download exiting zero does not make the downloaded job's tests pass.

Historical local preparation logs may have only one retained outer tool receipt. An explicit producer binding pins the entire original script, original tool receipt, original FINAL and provenance. It checks exact synchronous status assertion lines, recorded program exits and each original/copy byte fingerprint. These statuses are labeled producer-observed local preparation; they are not invented separate child tool receipts, Linux runtime proof, or native group closure. The two original expected negatives remain actual exit 1. Flattened copies of a schema receipt require an explicit pinned link to the included original receipt; the copy is never parsed as a second execution.

Sources and raw receipts from failed preliminary audits and the original tool version stay in the tooling input root. Final audit/collection wrappers must run outside their input roots, or their exact active stdout/stderr and not-yet-created receipt must be excluded with an explicit reason. Add their closed receipts and verifier output as a separate final metadata supplement after they finish; never capture a currently running command's own output as terminal evidence.

Only the parent executes final collection, copies the validated output into the repository, adds binary `.gitattributes` rules, checks staged bytes, and commits/pushes. The scripts do not write repository evidence, mutate Git, dispatch CI, or contact production.
