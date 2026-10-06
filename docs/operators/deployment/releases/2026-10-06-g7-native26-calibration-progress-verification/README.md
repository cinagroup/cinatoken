# Frozen evidence verification

This archive preserves historical source cohorts and failed gates. Its collection success does not prove business acceptance.

Portable bytes and decoded contents verification (write a new receipt under the system temporary directory):

    node tools/verify-evidence.mjs ../2026-10-06-g7-native26-calibration-progress.json <new-temp-receipt.json> stored-only

collection-config.json records the original frozen temporary source roots. with-source additionally requires those original roots.
Verification copies retain their original descriptors and are listed in copy-manifest.json; copying them creates no new business process exit.
