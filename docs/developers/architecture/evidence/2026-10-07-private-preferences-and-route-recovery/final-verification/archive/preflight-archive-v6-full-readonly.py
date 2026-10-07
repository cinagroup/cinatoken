import ast, hashlib, json, pathlib, sys
root = pathlib.Path(__file__).resolve().parent
source = (root / "archive-596-v6.py").read_bytes()
assert hashlib.sha256(source).hexdigest() == "ec441791152f95705e336739314e8d6077a8562b5bca9feb42a798b8d5d84391"
code = source.decode("utf-8")
assert code.count("output.mkdir()") == 1
code = code.replace("output.mkdir()", "missing_owner_dirs = []")
old = '    assert directory.get("completedOwnerReceiptRole") in roles, "Directory needs selected actual closed owner"'
assert code.count(old) == 1
code = code.replace(old, '    if directory.get("completedOwnerReceiptRole") not in roles:\n        missing_owner_dirs.append(directory)')
cut = '(output / "archive-input-plan.json").write_bytes(recipe_bytes)'
assert code.count(cut) == 1
code = code.split(cut)[0]
tree = ast.parse(code)
writes = []
for n in ast.walk(tree):
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("mkdir", "write_bytes", "write_text", "open", "unlink"):
        writes.append(n.func.attr)
assert writes == [], writes
sys.argv = [str(root / "archive-596-v6.py"), "--manifest", str(root / "archive-ready-596.json"), "--out", str(root / "preflight-never-created-596-v6")]
scope = {"__file__": str(root / "archive-596-v6.py"), "__name__": "__preflight__"}
exec(compile(code, str(root / "archive-596-v6.py") + ".PRE_ZIP_READONLY", "exec"), scope)
report = {"purpose": "Read-only exact archive-v6 PRE-ZIP assertions; missing original owner fields collected once, not waived for execution", "helperSha256": hashlib.sha256(source).hexdigest(), "readySha256": hashlib.sha256(scope["recipe_bytes"]).hexdigest(), "missingOwnerDirs": scope["missing_owner_dirs"], "evidenceDirs": len(scope["recipe"]["evidenceDirs"]), "actualReceipts": len(scope["receipt_rows"]), "receiptStreams": len(scope["receipt_stream_bindings"]), "legacyProofReceipts": len(scope["legacy_rows"]), "finalSources": len(scope["final_sources"]), "physicalFiles": len(scope["files"]), "uniquePayloads": len(scope["payloads"]), "rawBytes": sum(x["bytes"] for x in scope["files"]), "protectedInputs": len(scope["protected_before"]), "exactFrozenAliasAndPathSet": True, "allPhysicalBytesShaMtime": True, "noArchiveOrMkdirPerformed": True}
target = root / "archive-v6-full-prezip-readonly.json"
with target.open("x", encoding="utf-8", newline="\n") as handle:
    json.dump(report, handle, indent=2); handle.write("\n")
print(json.dumps({"report": str(target), "missingOwnerDirs": len(report["missingOwnerDirs"]), "otherPreZipAssertionsPassed": True, "physicalFiles": report["physicalFiles"]}))
