import json, pathlib
root=pathlib.Path(r'C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-opaque-capsule-89cf1ba373634086a3926a636a292ec7')
for name in ['source-index.before.json','source-index.after.json','zip-member-roundtrip-proof.json','CAPSULE-SEAL.json']:
 r=json.loads((root/name).read_text(encoding='utf-8'))
 print(name, json.dumps({'type':type(r).__name__,'keys':list(r) if isinstance(r,dict) else None,'sample':r[0] if isinstance(r,list) else {k:(v[:1] if isinstance(v,list) else v) for k,v in r.items()}},indent=2))