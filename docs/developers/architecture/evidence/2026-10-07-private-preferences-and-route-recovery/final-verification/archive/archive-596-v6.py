import argparse, hashlib, json, os, pathlib, stat, zipfile
from datetime import datetime, timezone
OWN = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--manifest", required=True)
parser.add_argument("--out", required=True)
args = parser.parse_args()
manifest_path = pathlib.Path(args.manifest).resolve()
recipe_bytes = manifest_path.read_bytes()
recipe = json.loads(recipe_bytes)
assert recipe.get("status") == "READY_FOR_ARCHIVE" and recipe.get("pending") == [], "Do not execute a draft or incomplete input plan"
output = pathlib.Path(args.out).resolve()
assert output.is_relative_to(OWN) and output != OWN and not output.exists(), "Output must be NEW owned Temp child"
output.mkdir()
digest = lambda data: hashlib.sha256(data).hexdigest()
def physical(path):
    path = pathlib.Path(path).resolve()
    info = path.stat()
    assert stat.S_ISREG(info.st_mode), str(path)
    data = path.read_bytes()
    return {"path": str(path), "bytes": len(data), "sha256": digest(data), "mtimeNs": info.st_mtime_ns}, data
prepared = json.loads((OWN / "prepared-81-scope.json").read_bytes())
protected = [prepared["baseline"]] + prepared["protectedPriorEvidence"]
protected_before = []
for item in protected:
    actual, data = physical(item["path"])
    assert actual["bytes"] == item["bytes"] and actual["sha256"] == item["sha256"], "Old proof changed: " + item["path"]
    protected_before.append(actual)
input_manifest = recipe.get("physicalInputManifest")
assert input_manifest, "A frozen physical input manifest is required"
manifest_actual, physical_manifest_bytes = physical(input_manifest["path"])
assert manifest_actual["bytes"] == input_manifest["bytes"] and manifest_actual["sha256"] == input_manifest["sha256"], "Frozen manifest bytes changed"
physical_manifest = json.loads(physical_manifest_bytes)
frozen_inputs = physical_manifest["selectedFiles"]
frozen_protected = {pathlib.Path(x["path"]).resolve(): x for x in physical_manifest["protectedInputsBeforeAndAfter"]}
assert set(frozen_protected) == {pathlib.Path(x["path"]).resolve() for x in protected_before}, "Exact original protected evidence collection required"
for actual in protected_before:
    frozen = frozen_protected[pathlib.Path(actual["path"]).resolve()]
    assert actual["bytes"] == frozen["bytes"] and actual["sha256"] == frozen["sha256"] and str(actual["mtimeNs"]) == str(frozen["mtimeNs"]), "Protected old proof changed after physical freeze: " + actual["path"]
frozen_by_alias = {x["alias"]: x for x in frozen_inputs}
assert len(frozen_by_alias) == len(frozen_inputs), "Duplicate frozen alias"
legacy_rows = []
for item in recipe.get("legacyProofReceipts", []):
    actual, data = physical(item["path"])
    receipt = json.loads(data)
    assert item["originalExitField"] == "actualExit" and "actualExitCode" not in receipt
    assert receipt.get("actualExit") == item["actualExit"] and receipt.get("signal") is None
    assert receipt.get("finishedAt") == item["finishedAt"] and not receipt.get("spawnError") and not receipt.get("error")
    for stream in ("stdout", "stderr"):
        stream_actual, stream_bytes = physical(receipt[stream]["path"])
        assert stream_actual["bytes"] == receipt[stream]["bytes"] and stream_actual["sha256"] == receipt[stream]["sha256"]
    legacy_rows.append({"role": item["role"], **actual, "originalExitField": "actualExit", "actualExit": receipt["actualExit"], "finishedAt": receipt["finishedAt"]})
receipt_rows = []
receipt_stream_bindings = []
legacy_stream_names = {
    "private/preparation-v3/prepare": ("prepare-process-closed.json", "prepare", "prepare-closed.mjs"),
    "private/preparation-v3/prepare-v2": ("prepare-v2-process-closed.json", "prepare-v2", "prepare-v2-closed.mjs"),
    "private/preparation-v3/prepare-v3": ("prepare-v3-process-closed.json", "prepare-v3", "prepare-v3-closed.mjs"),
}
for item in recipe.get("actualReceipts", []):
    actual, data = physical(item["path"])
    receipt = json.loads(data)
    code = receipt.get("actualExitCode")
    assert type(code) is int, "Only actual closed child receipts may be classified as executed: " + item["path"]
    assert receipt.get("closedAt"), "Actual close time required"
    datetime.fromisoformat(receipt["closedAt"].replace("Z", "+00:00"))
    for stream in ("stdout", "stderr"):
        declared = receipt.get(stream) or receipt.get("streams", {}).get(stream)
        assert declared and "bytes" in declared and "sha256" in declared, "Closed receipt needs original stream size/SHA"
        original_path_declared = bool(declared.get("path"))
        frozen_stream = None
        if original_path_declared:
            stream_path = declared["path"]
            binding_source = "original-receipt-declared-path"
            producer_proof = None
        else:
            assert item["role"] in legacy_stream_names, "Only three known original bytes/SHA-only schemas may use frozen aliases"
            receipt_name, stream_stem, producer_name = legacy_stream_names[item["role"]]
            assert pathlib.Path(item["path"]).name == receipt_name
            stream_alias = "receipts/" + item["role"] + "/" + stream + ".log"
            frozen_stream = frozen_by_alias[stream_alias]
            expected_path = pathlib.Path(item["path"]).parent / (stream_stem + "." + stream)
            assert pathlib.Path(frozen_stream["path"]).resolve() == expected_path.resolve(), "Exact role/stream entity required; never hash-search empty files"
            producer_frozen = frozen_by_alias["private/preparation-v3/" + producer_name]
            assert pathlib.Path(producer_frozen["path"]).resolve() == (pathlib.Path(item["path"]).parent / producer_name).resolve()
            producer_actual, producer_bytes = physical(producer_frozen["path"])
            assert producer_actual["bytes"] == producer_frozen["bytes"] and producer_actual["sha256"] == producer_frozen["sha256"] and str(producer_actual["mtimeNs"]) == str(producer_frozen["mtimeNs"])
            producer_proof = producer_actual
            stream_path = frozen_stream["path"]
            binding_source = "frozen-selected-alias; original receipt has bytes/SHA only"
        stream_actual, stream_bytes = physical(stream_path)
        assert stream_actual["bytes"] == declared["bytes"] and stream_actual["sha256"] == declared["sha256"], "Actual closed log differs from receipt"
        if frozen_stream is not None:
            assert stream_actual["bytes"] == frozen_stream["bytes"] and stream_actual["sha256"] == frozen_stream["sha256"] and str(stream_actual["mtimeNs"]) == str(frozen_stream["mtimeNs"])
        receipt_stream_bindings.append({"role": item["role"], "stream": stream, "originalPathDeclared": original_path_declared, "bindingSource": binding_source, "physical": stream_actual, "producer": producer_proof})
    assert receipt.get("signal") is None and not receipt.get("spawnError") and not receipt.get("error")
    if "expectedActualExitCode" in item:
        assert code == item["expectedActualExitCode"], "Never relabel raw failure as pass"
    receipt_rows.append({"role": item["role"], **actual, "actualExitCode": code})
final_sources = recipe.get("finalSources", [])
if final_sources:
    assert sorted(x["relative"] for x in final_sources) == sorted(x["relative"] for x in prepared["preparationSourceSnapshots"]), "Exactly 11 known source paths"
    for item in final_sources:
        actual, data = physical(pathlib.Path("C:/cinagroup/cinatoken") / item["relative"])
        assert actual["bytes"] == item["bytes"] and actual["sha256"] == item["sha256"]
roles = {item["role"] for item in recipe.get("actualReceipts", [])}
for directory in recipe.get("evidenceDirs", []):
    assert directory.get("completedOwnerReceiptRole") in roles, "Directory needs selected actual closed owner"
selection = []
for item in recipe.get("evidenceFiles", []):
    source = pathlib.Path(item["path"]).resolve()
    selection.append((item["alias"], source))
for item in recipe.get("evidenceDirs", []):
    source = pathlib.Path(item["path"]).resolve()
    assert source.is_dir() and not output.is_relative_to(source), "Do not capture active output directory or ancestors"
    for path in sorted(source.rglob("*")):
        assert not path.is_symlink(), "No symlink archive input"
        if path.is_file():
            selection.append((item["alias"].rstrip("/") + "/" + path.relative_to(source).as_posix(), path.resolve()))
assert selection, "Explicit finished raw evidence inputs required"
selected_paths = {source.resolve() for alias, source in selection}
for source in final_sources:
    assert (pathlib.Path("C:/cinagroup/cinatoken") / source["relative"]).resolve() in selected_paths, "All 11 final source bytes must be explicitly archived"
for receipt in recipe.get("actualReceipts", []):
    assert pathlib.Path(receipt["path"]).resolve() in selected_paths, "Every classified actual receipt must be physically archived"
for receipt in recipe.get("legacyProofReceipts", []):
    assert pathlib.Path(receipt["path"]).resolve() in selected_paths, "Legacy original receipt must be physically archived"
assert {alias for alias, source in selection} == set(frozen_by_alias), "Exact frozen selection required; missing or additional evidence file"
aliases = set()
files, payloads = [], {}
for alias, source in selection:
    alias_path = pathlib.PurePosixPath(alias)
    assert not alias_path.is_absolute() and ".." not in alias_path.parts and "\\" not in alias and alias not in aliases
    aliases.add(alias)
    assert not source.is_relative_to(output)
    metadata, data = physical(source)
    frozen = frozen_by_alias[alias]
    assert pathlib.Path(frozen["path"]).resolve() == source.resolve()
    assert metadata["bytes"] == frozen["bytes"] and metadata["sha256"] == frozen["sha256"] and str(metadata["mtimeNs"]) == str(frozen["mtimeNs"]), "Archive input differs from frozen draft: " + alias
    member = "sha256/" + metadata["sha256"]
    if member in payloads:
        assert payloads[member] == data, "Same hash must have same physical bytes"
    else:
        payloads[member] = data
    files.append({"path": alias, "original": str(source), "bytes": len(data), "sha256": metadata["sha256"], "mtimeNs": metadata["mtimeNs"], "archive": "raw-evidence.zip", "member": member})
(output / "archive-input-plan.json").write_bytes(recipe_bytes)
(output / "selected-inputs-physical.json").write_bytes(physical_manifest_bytes)
assert (output / "archive-input-plan.json").read_bytes() == recipe_bytes
assert (output / "selected-inputs-physical.json").read_bytes() == physical_manifest_bytes
bundle = output / "raw-evidence.zip"
with zipfile.ZipFile(bundle, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as archive:
    for member, data in sorted(payloads.items()):
        info = zipfile.ZipInfo(member, date_time=(2026, 10, 7, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
with zipfile.ZipFile(bundle, "r") as archive:
    assert archive.testzip() is None, "ZIP CRC failed"
    assert set(archive.namelist()) == set(payloads), "Unexpected ZIP member"
    for item in files:
        decoded = archive.read(item["member"])
        assert len(decoded) == item["bytes"] and digest(decoded) == item["sha256"]
        current, original = physical(item["original"])
        assert original == decoded and current["mtimeNs"] == item["mtimeNs"], "Archive input changed while packaging"
protected_after = []
for old in protected_before:
    current, data = physical(old["path"])
    assert current == old, "Prior evidence or baseline changed while packaging"
    protected_after.append(current)
bundle_proof, data = physical(bundle)
index = {"schemaVersion": 1, "at": datetime.now(timezone.utc).isoformat(), "purpose": "Explicit selected 5.96 preference/route/source/CI/release proof bytes only, according to their actual individual scopes. Failed tests are preserved; archive success is not full application acceptance.",
         "baselineCommit": prepared["baselineCommit"], "recipe": {"path": str(manifest_path), "publishedFile": "archive-input-plan.json", "bytes": len(recipe_bytes), "sha256": digest(recipe_bytes)},
         "bundle": {"path": "raw-evidence.zip", "bytes": bundle_proof["bytes"], "sha256": bundle_proof["sha256"]},
         "receiptStreamBindings": receipt_stream_bindings, "files": files, "uniqueMembers": len(payloads), "physicalOriginals": len(files), "actualReceipts": receipt_rows, "legacyProofReceipts": legacy_rows, "physicalInputManifest": {**manifest_actual, "publishedFile": "selected-inputs-physical.json"}, "finalSources": final_sources,
         "priorProtectedInputs": protected_before, "verification": {"allOriginalBytesEqualDecodedZip": True, "allOriginalMtimeUnchanged": True, "allPriorProofBytesMtimeUnchanged": True, "crcErrors": 0},
         "limits": ["Only explicitly selected completed evidence files are classified", "Archiving selected production/SSR/Cloudflare proof does not expand its actual request or browser scope, or assert full Auth/workspace/key/BFCache/performance/full-gate completion", "intendedExitCode is not actual parent process closure", "No repository writes, Git mutation, browser, server or network performed"]}
index_path = output / "index.json"
with index_path.open("x", encoding="utf-8", newline="\n") as handle:
    json.dump(index, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
verification = {"output": str(output), "index": physical(index_path)[0], "recipe": physical(output / "archive-input-plan.json")[0], "physicalInputManifest": physical(output / "selected-inputs-physical.json")[0], "bundle": bundle_proof, "physicalFiles": len(files), "uniqueMembers": len(payloads), "priorProtectedFiles": len(protected_before), "actualReceipts": receipt_rows, "intendedExitCode": 0,
                "actualExitAuthority": "Parent child-close wrapper receipt after this script exits. Copy it separately after closure; never place active own logs inside selected evidence directories."}
with (output / "archive-verification.json").open("x", encoding="utf-8", newline="\n") as handle:
    json.dump(verification, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
print(json.dumps({"output": str(output), "physicalFiles": len(files), "uniqueMembers": len(payloads), "bundleBytes": bundle_proof["bytes"], "bundleSha256": bundle_proof["sha256"], "intendedExitCode": 0}))
