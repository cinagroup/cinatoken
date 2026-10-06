"""Extract exactly one closed ZIP into a fresh owned folder; decode/hash all members."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

binding_path = Path(sys.argv[1]).resolve()
binding = json.loads(binding_path.read_text(encoding='utf-8'))
assert binding['schema'] == 'cinatoken-v364-queued-linux-observation-binding-v1'
assert binding['rootAuthorisedObservation'] is True
root = Path(binding['observationRoot']).resolve()
assert binding_path.parent == root
assert root.name.startswith('cinatoken-v364-queued-linux-run-')
receipt = json.loads((root / 'download-artifact-once.result.json').read_text(encoding='utf-8'))
assert receipt['closed'] is True and receipt['actualExit'] == 0
assert receipt['signal'] is None and receipt['spawnError'] is None and receipt['timedOut'] is False
archive = Path(receipt['stdout']['path']).resolve()
assert archive.parent == root
encoded = archive.read_bytes()
assert len(encoded) == receipt['stdout']['bytes']
assert hashlib.sha256(encoded).hexdigest() == receipt['stdout']['sha256']
target = root / 'full-artifact'
assert not target.exists()
target.mkdir()
files = []
directories = []
seen = set()
seen_folded = set()
decoded_total = 0
with zipfile.ZipFile(archive) as source:
    for info in source.infolist():
        name = info.filename
        assert '\\' not in name and ':' not in name and '\x00' not in name
        relative = PurePosixPath(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        assert relative.parts and all(p not in ('', '.') for p in relative.parts)
        assert name.rstrip('/') == relative.as_posix()
        assert name not in seen
        assert name.rstrip('/').casefold() not in seen_folded
        seen.add(name)
        seen_folded.add(name.rstrip('/').casefold())
        unix_mode = info.external_attr >> 16
        assert not stat.S_ISLNK(unix_mode)
        destination = target.joinpath(*relative.parts)
        assert destination.resolve().is_relative_to(target.resolve())
        if info.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            directories.append(name)
            continue
        assert info.file_size <= 128 * 1024 * 1024
        decoded_total += info.file_size
        assert decoded_total <= 256 * 1024 * 1024
        destination.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        length = 0
        with source.open(info) as incoming, destination.open('xb') as outgoing:
            while True:
                chunk = incoming.read(1024 * 1024)
                if not chunk:
                    break
                length += len(chunk)
                assert length <= info.file_size
                digest.update(chunk)
                outgoing.write(chunk)
        assert length == info.file_size
        reloaded = destination.read_bytes()
        assert hashlib.sha256(reloaded).hexdigest() == digest.hexdigest()
        files.append({'relative': name, 'path': str(destination).replace('\\', '/'), 'bytes': length, 'sha256': digest.hexdigest(), 'zipCRC32': f'{info.CRC:08x}', 'compressedBytes': info.compress_size, 'decodedExact': True})
report = {'schema': 'cinatoken-v364-full-artifact-zip-decode-index-v1', 'actualDecodeVerification': 0, 'archive': {'path': str(archive).replace('\\', '/'), 'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()}, 'fileCount': len(files), 'directoryCount': len(directories), 'decodedBytes': decoded_total, 'files': files, 'directories': directories, 'completeZipMemberSetRetained': True, 'sourceSHA': binding['sourceSHA'], 'runId': str(binding['runId']), 'ciOrProductPassDerived': False, 'runtimeExecuted': False}
with (root / 'full-artifact-index.json').open('x', encoding='utf-8', newline='\n') as output:
    json.dump(report, output, ensure_ascii=False, indent=2)
    output.write('\n')
print(json.dumps({'actualDecodeVerification': 0, 'fileCount': len(files), 'decodedBytes': decoded_total, 'ciOrProductPassDerived': False}))
