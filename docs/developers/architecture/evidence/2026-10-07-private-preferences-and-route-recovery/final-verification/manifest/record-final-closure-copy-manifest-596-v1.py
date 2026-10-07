import hashlib, json, pathlib, stat
from datetime import datetime, timezone
ROOT = pathlib.Path(__file__).resolve().parent
CONFIG = json.loads("{\"roots\":{\"S\":\"C:/Users/cina/AppData/Local/Temp/cinatoken-private-preferences-md-596-scope-205e5c1e2d444a7c8a8fa1de33de32bd\",\"R\":\"C:/Users/cina/AppData/Local/Temp/cinatoken-private-preferences-38ed4ea0f0a742aca3705cba2813a099\",\"D\":\"C:/Users/cina/AppData/Local/Temp/cinatoken-route-state-browser-a2a330f399d44a19b86afb6934937dc9/real-dist-chunk-v1\"},\"groups\":[{\"root\":\"S\",\"stem\":\"archive-final-596-v5\",\"suffix\":\".process-closed.json\",\"code\":1,\"prefix\":\"archive\"},{\"root\":\"S\",\"stem\":\"archive-final-596-schema-v6\",\"suffix\":\".process-closed.json\",\"code\":1,\"prefix\":\"archive\"},{\"root\":\"S\",\"stem\":\"archive-final-596-schema-v7\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"archive\"},{\"root\":\"S\",\"stem\":\"prepare-archive-596-v6\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"archive\"},{\"root\":\"S\",\"stem\":\"syntax-archive-596-v6\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"archive\"},{\"root\":\"S\",\"stem\":\"prepare-archive-596-v7\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"archive\"},{\"root\":\"S\",\"stem\":\"archive-v6-full-prezip-readonly\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"archive\"},{\"root\":\"S\",\"stem\":\"root-final-scope-596.f9.git-show\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"stem\":\"root-final-scope-596.f77.git-show\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"stem\":\"root-final-scope-596.audit\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"installed-scope\"},{\"root\":\"R\",\"stem\":\"install-final-evidence-596\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"root\"},{\"root\":\"R\",\"stem\":\"final-main-scope-596\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"root\"},{\"root\":\"R\",\"stem\":\"final-main-publication-596\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"root\"},{\"root\":\"R\",\"stem\":\"final-md-diff-check-596\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"root\"},{\"root\":\"R\",\"stem\":\"syntax-final-install-596\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"root\"},{\"root\":\"R\",\"stem\":\"syntax-doc-git-596\",\"suffix\":\".result.json\",\"code\":0,\"prefix\":\"root\"},{\"root\":\"D\",\"stem\":\"archive-original-stream-bindings-review-v1\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"independent-review\"},{\"root\":\"D\",\"stem\":\"archive-all22-dir-owner-bindings-v1\",\"suffix\":\".process-closed.json\",\"code\":1,\"prefix\":\"independent-review\"},{\"root\":\"D\",\"stem\":\"archive-all22-dir-owner-bindings-v2\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"independent-review\"},{\"root\":\"D\",\"stem\":\"archive-schema-v6-readonly-review\",\"suffix\":\".process-closed.json\",\"code\":1,\"prefix\":\"independent-review\"},{\"root\":\"D\",\"stem\":\"archive-schema-v6-readonly-review-v2\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"independent-review\"},{\"root\":\"D\",\"stem\":\"archive-v7-complete-prezip-readonly-review\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"independent-review\"},{\"root\":\"D\",\"stem\":\"prepare-archive-schema-v6-review-v2\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"independent-review\"},{\"root\":\"D\",\"stem\":\"prepare-dir-owner-audit-v2\",\"suffix\":\".process-closed.json\",\"code\":0,\"prefix\":\"independent-review\"}],\"aux\":[{\"root\":\"S\",\"name\":\"archive-596-v5.py\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"archive-596-v6.py\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"archive-596-v7.py\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"prepare-archive-596-v6.mjs\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"prepare-archive-596-v7.py\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"preflight-archive-v6-full-readonly.py\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"run-helper-closed.mjs\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"archive-v6-full-prezip-readonly.json\",\"prefix\":\"archive\"},{\"root\":\"S\",\"name\":\"root-final-scope-596.working.md\",\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"name\":\"root-final-scope-596.report.json\",\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"name\":\"root-final-publication-596.working.md\",\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"name\":\"root-final-publication-596.81-scope.report.json\",\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"name\":\"audit-migration-scope.mjs\",\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"name\":\"run-owned-audit.mjs\",\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"name\":\"compare-81-publication-v1.mjs\",\"prefix\":\"installed-scope\"},{\"root\":\"S\",\"name\":\"publication-metadata-contract-v1.mjs\",\"prefix\":\"installed-scope\"},{\"root\":\"R\",\"name\":\"installed-final-evidence-596.json\",\"prefix\":\"root\"},{\"root\":\"R\",\"name\":\"install-final-evidence-596.mjs\",\"prefix\":\"root\"},{\"root\":\"R\",\"name\":\"verify-doc-publication-git-596.mjs\",\"prefix\":\"root\"},{\"root\":\"R\",\"name\":\"run-all-closed.mjs\",\"prefix\":\"root\"},{\"root\":\"D\",\"name\":\"archive-secret-review-596-v1/original-stream-bindings-review-v1.json\",\"prefix\":\"independent-review\"},{\"root\":\"D\",\"name\":\"archive-secret-review-596-v1/all22-dir-owner-output-bindings-v2.json\",\"prefix\":\"independent-review\"},{\"root\":\"D\",\"name\":\"archive-secret-review-596-v1/archive-schema-v6-readonly-review-v2.json\",\"prefix\":\"independent-review\"},{\"root\":\"D\",\"name\":\"archive-secret-review-596-v1/archive-v7-complete-prezip-readonly-review.json\",\"prefix\":\"independent-review\"}]}")
roots = {key:pathlib.Path(value).resolve() for key,value in CONFIG["roots"].items()}
selected = {}
def proof(path):
    path=pathlib.Path(path).resolve()
    info=path.stat()
    assert stat.S_ISREG(info.st_mode) and not path.is_symlink(), str(path)
    data=path.read_bytes()
    return {"file":str(path),"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),"mtimeNs":str(info.st_mtime_ns)},data
def add(key,name,prefix):
    path=roots[key]/name
    assert path.resolve().is_relative_to(roots[key]) and not path.is_symlink()
    meta,data=proof(path)
    destination=pathlib.PurePosixPath("final-verification",prefix,name.replace("\\","/"))
    assert not destination.is_absolute() and ".." not in destination.parts
    row={**meta,"destination":str(destination)}
    previous=selected.get(str(destination))
    assert previous is None or previous==row, "Conflicting destination"
    selected[str(destination)]=row
    return row,data
for aux in CONFIG["aux"]:
    add(aux["root"],aux["name"],aux["prefix"])
closed=[]
for family in CONFIG["groups"]:
    key,stem,prefix=family["root"],family["stem"],family["prefix"]
    receipt_row,receipt_bytes=add(key,stem+family["suffix"],prefix)
    receipt=json.loads(receipt_bytes)
    assert type(receipt.get("actualExitCode")) is int and receipt["actualExitCode"]==family["code"]
    assert receipt.get("signal") is None and not receipt.get("spawnError") and not receipt.get("error")
    close_fields=[field for field in ("closedAt","endedAt") if receipt.get(field)]
    assert len(close_fields)==1
    close_field=close_fields[0]
    datetime.fromisoformat(receipt[close_field].replace("Z","+00:00"))
    script=receipt.get("script")
    if script:
        script_path=pathlib.Path(script).resolve()
        assert script_path.is_relative_to(roots[key])
        add(key,str(script_path.relative_to(roots[key])),prefix)
    streams=[]
    for stream in ("stdout","stderr"):
        stream_row,stream_bytes=add(key,stem+"."+stream+".log",prefix)
        declared=receipt.get(stream) or receipt.get("streams",{}).get(stream)
        assert isinstance(declared,dict) and declared.get("bytes")==stream_row["bytes"] and declared.get("sha256")==stream_row["sha256"]
        original_path=declared.get("path")
        if original_path:
            assert pathlib.Path(original_path).resolve()==pathlib.Path(stream_row["file"]).resolve()
            binding="original-receipt-declared-path"
        else:
            assert key=="S" and stem in ("root-final-scope-596.f9.git-show","root-final-scope-596.f77.git-show")
            producer=(roots["S"]/"audit-migration-scope.mjs").read_text(encoding="utf-8")
            assert "label + '.' + short + '.git-show."+stream+".log'" in producer
            binding="explicit selected closed family filename; original receipt declares bytes/SHA only; original producer pattern checked"
        streams.append({"stream":stream,"originalPathDeclared":bool(original_path),"bindingSource":binding,"selected":stream_row})
    closed.append({"family":stem,"receipt":receipt_row,"originalExitField":"actualExitCode","actualExitCode":receipt["actualExitCode"],"originalCloseField":close_field,"actualCloseTime":receipt[close_field],"streams":streams})
rows=sorted(selected.values(),key=lambda row:row["destination"])
for row in rows:
    after,data=proof(row["file"])
    assert all(after[field]==row[field] for field in ("file","bytes","sha256","mtimeNs")), "Input changed while recording"
target=ROOT/"final-closure-copy-manifest-596-v1.json"
manifest={"schemaVersion":1,"status":"READY_FOR_COPY_OF_EXPLICIT_CLOSED_INPUTS","at":datetime.now(timezone.utc).isoformat(),"purpose":"Standalone original-byte closure proof copy after immutable archive; no active directories, no rearchive, no new product/browser/network/Git operations","targetEvidenceRoot":"docs/developers/architecture/evidence/2026-10-07-private-preferences-and-route-recovery","files":rows,"closedProcesses":closed,"physicalFiles":len(rows),"physicalBytes":sum(row["bytes"] for row in rows),"failedOriginalProcessesPreserved":sum(row["actualExitCode"]!=0 for row in closed),"limits":["Installation and scope/publication records bind the original installed v6 snapshot SHA063f2c...; later two-current-pointer correction and new checks are separate Root proofs","Historical failures remain actual1; copy readiness does not relabel them","Future commit/stage/push proofs are excluded and remain separate","This manifest recorder's actual parent-close receipt is separate after closure; no self-referential collection"]}
with target.open("x",encoding="utf-8",newline="\n") as handle:
    json.dump(manifest,handle,ensure_ascii=False,indent=2);handle.write("\n")
target_proof,data=proof(target)
print(json.dumps({"manifest":target_proof,"files":len(rows),"closedProcesses":len(closed),"preservedActualFailures":manifest["failedOriginalProcessesPreserved"]}))
