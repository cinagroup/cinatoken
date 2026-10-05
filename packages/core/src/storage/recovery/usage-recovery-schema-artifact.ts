/** Reviewed disabled-prototype schema v1. Not a remote identity/IAM or full-database audit. */
export const RECOVERY_SCHEMA_ARTIFACT = Object.freeze({
	version: 1,
	baseMigrationCount: 77,
	baseMigrationSetSha256: '679f3a39b3c03fefadbbc33e95b33dbfb89454022dd200ff90626c9698d68560',
	proposals: Object.freeze([
  {
    "name": "request-dispatch-intents.sql",
    "sha256": "f3f9df3723fbccfd62a7f566804abcb591ee03f8d20bab47f60cb623ee082083"
  },
  {
    "name": "request-usage-settlements.sql",
    "sha256": "d25ffb168ec74112f602befec2057b96456e0f2291fd2179d6e131f16ffbcb04"
  },
  {
    "name": "request-usage-recovery-jobs.sql",
    "sha256": "4b1dfa909dc6c4abc4aaec929d12ac368adb1877ae975c7a00f35a6b9f01652d"
  }
].map(row => Object.freeze(row))),
	tables: Object.freeze(["request_dispatch_intents","request_usage_settlements","request_usage_commit_receipts","request_usage_recovery_jobs"]),
	objects: Object.freeze([
  {
    "type": "index",
    "name": "request_dispatch_intents_recovery",
    "table": "request_dispatch_intents",
    "bytes": 148,
    "sha256": "4d13b60367161009e5140a95248746ace32e84336d1fb35b98993a29d78ef1ea"
  },
  {
    "type": "index",
    "name": "request_usage_recovery_due",
    "table": "request_usage_recovery_jobs",
    "bytes": 131,
    "sha256": "06b42c9343502efb3ce3b627eb5ee469e425255010aef33d01a68cb6d255516b"
  },
  {
    "type": "index",
    "name": "request_usage_recovery_tenant_due",
    "table": "request_usage_recovery_jobs",
    "bytes": 159,
    "sha256": "0b705de1df50dfb443b59c06849ab2feb3a375dc35a3538d2489293cea693002"
  },
  {
    "type": "index",
    "name": "request_usage_settlements_scope",
    "table": "request_usage_settlements",
    "bytes": 106,
    "sha256": "3f8c1e06440e9b132cefebc1cbd2405928731aab68f123f63f6bf95d8640d0d0"
  },
  {
    "type": "index",
    "name": "sqlite_autoindex_request_dispatch_intents_1",
    "table": "request_dispatch_intents",
    "bytes": null,
    "sha256": null
  },
  {
    "type": "index",
    "name": "sqlite_autoindex_request_dispatch_intents_2",
    "table": "request_dispatch_intents",
    "bytes": null,
    "sha256": null
  },
  {
    "type": "index",
    "name": "sqlite_autoindex_request_usage_commit_receipts_1",
    "table": "request_usage_commit_receipts",
    "bytes": null,
    "sha256": null
  },
  {
    "type": "index",
    "name": "sqlite_autoindex_request_usage_recovery_jobs_1",
    "table": "request_usage_recovery_jobs",
    "bytes": null,
    "sha256": null
  },
  {
    "type": "index",
    "name": "sqlite_autoindex_request_usage_recovery_jobs_2",
    "table": "request_usage_recovery_jobs",
    "bytes": null,
    "sha256": null
  },
  {
    "type": "index",
    "name": "sqlite_autoindex_request_usage_settlements_1",
    "table": "request_usage_settlements",
    "bytes": null,
    "sha256": null
  },
  {
    "type": "index",
    "name": "sqlite_autoindex_request_usage_settlements_2",
    "table": "request_usage_settlements",
    "bytes": null,
    "sha256": null
  },
  {
    "type": "table",
    "name": "request_dispatch_intents",
    "table": "request_dispatch_intents",
    "bytes": 1845,
    "sha256": "805b0b01386d481014e3de805727d4fdedcadf2e737deb7c458ad8c09668d04c"
  },
  {
    "type": "table",
    "name": "request_usage_commit_receipts",
    "table": "request_usage_commit_receipts",
    "bytes": 322,
    "sha256": "f29a08f2f4264086066370496a05407bcc66d96430327f3bd9a643917bb47dc9"
  },
  {
    "type": "table",
    "name": "request_usage_recovery_jobs",
    "table": "request_usage_recovery_jobs",
    "bytes": 1509,
    "sha256": "bcfe76d3e530ddd47215f91aa4f829188f1f10d4ed3ff4ac0c253d1247fbef32"
  },
  {
    "type": "table",
    "name": "request_usage_settlements",
    "table": "request_usage_settlements",
    "bytes": 992,
    "sha256": "2e9ba87a1d2e88abe2b9b220efbfe20b9aa4952e84daabfdb3507a4a89e33cf8"
  },
  {
    "type": "trigger",
    "name": "request_dispatch_intents_forward_only",
    "table": "request_dispatch_intents",
    "bytes": 904,
    "sha256": "a1dcfb1a2bbd97a5fa40767f6d280840c45bd2152a7239af5aef10d098387fc6"
  },
  {
    "type": "trigger",
    "name": "request_usage_commit_receipts_immutable",
    "table": "request_usage_commit_receipts",
    "bytes": 166,
    "sha256": "37d528938af3b37b7e1dcc72da879cf5f7eb5a2a199d06125bbcb2d1260b51f9"
  },
  {
    "type": "trigger",
    "name": "request_usage_recovery_complete",
    "table": "request_usage_commit_receipts",
    "bytes": 320,
    "sha256": "fc5cda6a5ac4b814c429594ba25b19d80377b1d55906a548a37ac2db64f8769d"
  },
  {
    "type": "trigger",
    "name": "request_usage_recovery_enqueue",
    "table": "request_usage_settlements",
    "bytes": 411,
    "sha256": "fa8d7bb09f038a1310520d769a1a5ff92e268628de57a5b3471dcf4a2f431fab"
  },
  {
    "type": "trigger",
    "name": "request_usage_recovery_fence",
    "table": "request_usage_commit_receipts",
    "bytes": 425,
    "sha256": "d04541264cdf38d4116e688ce8a27aab8cba76e0b95bcb776ec14df3c7928510"
  },
  {
    "type": "trigger",
    "name": "request_usage_recovery_identity",
    "table": "request_usage_recovery_jobs",
    "bytes": 385,
    "sha256": "737dce56cd962a4bf495bca3ca3c4bf414a0182ec9d13e9142c1ad5bd18df420"
  },
  {
    "type": "trigger",
    "name": "request_usage_recovery_transition",
    "table": "request_usage_recovery_jobs",
    "bytes": 1517,
    "sha256": "3c71883d0d6d9a96ea156f3019c8bbb8fa870b77cc89e2fa98640a9f554efb5c"
  },
  {
    "type": "trigger",
    "name": "request_usage_settlements_claim",
    "table": "request_usage_settlements",
    "bytes": 573,
    "sha256": "c0f54c8f8f34d32c9c70c5fa4f4b38aeb1b6b0c04831023163125f1958b5f1d1"
  },
  {
    "type": "trigger",
    "name": "request_usage_settlements_immutable",
    "table": "request_usage_settlements",
    "bytes": 159,
    "sha256": "19492f5da36cb7fe85b44f019a40aa9cfd161723b04a073dd2cecb22e5f04e23"
  }
].map(row => Object.freeze(row))),
});

