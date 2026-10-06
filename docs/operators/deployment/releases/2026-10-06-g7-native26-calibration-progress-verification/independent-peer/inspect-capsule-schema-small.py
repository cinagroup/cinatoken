import json,pathlib
root=pathlib.Path(r'C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-opaque-capsule-89cf1ba373634086a3926a636a292ec7')
def short(v):
 if isinstance(v,list):return {'type':'list','count':len(v),'first':v[0] if v else None}
 if isinstance(v,dict):return {'type':'dict','keys':list(v)[:20],'first':next(iter(v.items()),None)}
 return v
for name in ['source-index.before.json','source-index.after.json','zip-member-roundtrip-proof.json','CAPSULE-SEAL.json']:
 r=json.loads((root/name).read_text(encoding='utf-8'))
 print(name,json.dumps({k:short(v) for k,v in r.items()},indent=2))