import datetime, hashlib, json, os, stat, struct, time, zipfile, zlib
from pathlib import Path

SOURCE = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-ee122-native-tail-independent-peer-76364c609e694985bf7d74bf5b2c4ae9')
OUTPUT = Path(__file__).resolve().parent
ZIP = OUTPUT / 'ee122-frozen-root-lossless-opaque.zip'
PINS = [(526801, '1cb4680d0effb04b1784dd945738c5d3608c06c9c2423dd82784a9441aee2ebe'),
        (159232, 'cca4e7e35584c673444a27e4a619faf1589f57b9a13cbec9360287c940aa6d7c')]
REPARSE = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')

def safe_stat(path):
    value = os.lstat(path)
    assert not stat.S_ISLNK(value.st_mode) and not getattr(value, 'st_file_attributes', 0) & REPARSE, 'Reparse/symlink rejected: ' + str(path)
    return value

def identity(value):
    return {'device': value.st_dev, 'inode': value.st_ino, 'mode': value.st_mode,
            'bytes': value.st_size, 'mtimeNs': value.st_mtime_ns,
            'attributes': getattr(value, 'st_file_attributes', 0)}

def digest_file(path):
    h, size, crc = hashlib.sha256(), 0, 0
    with open(path, 'rb') as stream:
        while block := stream.read(1024 * 1024):
            h.update(block); size += len(block); crc = zlib.crc32(block, crc)
    return {'bytes': size, 'sha256': h.hexdigest(), 'crc32': f'{crc & 0xffffffff:08x}'}

def descriptor(path):
    value = digest_file(path)
    return {'path': path.as_posix(), **value}

def inventory():
    root = safe_stat(SOURCE)
    assert stat.S_ISDIR(root.st_mode)
    files, directories = {}, {}
    def visit(directory):
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda entry: entry.name)
        for child in children:
            path = Path(child.path); value = safe_stat(path)
            relative = path.relative_to(SOURCE).as_posix()
            assert relative and not relative.startswith('/') and '..' not in Path(relative).parts
            if stat.S_ISDIR(value.st_mode):
                directories[relative] = identity(value); visit(path)
            elif stat.S_ISREG(value.st_mode):
                observed = identity(value); digested = digest_file(path)
                assert identity(safe_stat(path)) == observed
                assert digested['bytes'] == observed['bytes']
                files[relative] = {'identity': observed, **digested}
            else:
                raise AssertionError('Non-ordinary source entry rejected: ' + str(path))
    visit(SOURCE)
    assert identity(safe_stat(SOURCE)) == identity(root)
    return {'sourceRoot': SOURCE.as_posix(), 'sourceRootIdentity': identity(root),
            'files': files, 'directories': directories}

def write_json(name, value):
    with open(OUTPUT / name, 'x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2); stream.write('\n')

def zip_info(relative, observed, directory=False):
    stamp = observed['mtimeNs'] // 1_000_000_000
    value = zipfile.ZipInfo(relative + ('/' if directory else ''), time.localtime(stamp)[:6])
    value.create_system = 3
    value.external_attr = observed['mode'] << 16 | (0x10 if directory else 0)
    value.extra = struct.pack('<HHBI', 0x5455, 5, 1, stamp & 0xffffffff)
    value.compress_type = zipfile.ZIP_DEFLATED
    value._compresslevel = 6
    return value

started = utc()
assert SOURCE.resolve() != OUTPUT.resolve() and SOURCE not in OUTPUT.parents and OUTPUT not in SOURCE.parents
assert not ZIP.exists()
before = inventory()
assert before['files']
pin_matches = []
for size, sha in PINS:
    matches = [name for name, item in before['files'].items() if item['bytes'] == size and item['sha256'] == sha]
    assert len(matches) == 1, 'Unique original FINAL/seal pin absent'
    pin_matches.append({'relative': matches[0], 'bytes': size, 'sha256': sha})
write_json('source-index.before.json', {'schema': 'cinatoken-ee122-source-index-v1', 'at': utc(), **before,
    'fileCount': len(before['files']), 'directoryCount': len(before['directories']),
    'totalBytes': sum(v['bytes'] for v in before['files'].values()), 'originalFinalAndSealPins': pin_matches,
    'exclusions': [], 'symlinkFollowing': False})
print(json.dumps({'phase': 'source-full-index', 'files': len(before['files']), 'directories': len(before['directories']), 'exclusions': 0}), flush=True)
with zipfile.ZipFile(ZIP, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
    for relative, observed in sorted(before['directories'].items()):
        archive.writestr(zip_info(relative, observed, True), b'')
    for relative, item in sorted(before['files'].items()):
        path = SOURCE / relative
        assert identity(safe_stat(path)) == item['identity']
        h, size, crc = hashlib.sha256(), 0, 0
        with open(path, 'rb') as original, archive.open(zip_info(relative, item['identity']), 'w', force_zip64=True) as member:
            while block := original.read(1024 * 1024):
                member.write(block); h.update(block); size += len(block); crc = zlib.crc32(block, crc)
        assert {'bytes': size, 'sha256': h.hexdigest(), 'crc32': f'{crc & 0xffffffff:08x}'} == {k:item[k] for k in ('bytes','sha256','crc32')}
        assert identity(safe_stat(path)) == item['identity']
print(json.dumps({'phase': 'complete-zip-written'}), flush=True)
member_proofs = []
with zipfile.ZipFile(ZIP, 'r') as archive:
    members = archive.infolist(); names = [m.filename for m in members]
    expected = set(before['files']) | {name + '/' for name in before['directories']}
    assert len(names) == len(set(names)) == len(expected) and set(names) == expected
    assert {m.filename[:-1] for m in members if m.is_dir()} == set(before['directories'])
    for member in members:
        if member.is_dir():
            assert member.file_size == 0 and member.CRC == 0 and archive.read(member) == b''
            member_proofs.append({'name': member.filename, 'kind': 'directory', 'bytes': 0,
                'sha256': hashlib.sha256(b'').hexdigest(), 'crc32': '00000000', 'exact': True})
            continue
        item = before['files'][member.filename]; path = SOURCE / member.filename
        assert identity(safe_stat(path)) == item['identity']
        h, size, crc = hashlib.sha256(), 0, 0
        with archive.open(member, 'r') as decoded, open(path, 'rb') as original:
            while True:
                block = decoded.read(1024 * 1024); source_block = original.read(1024 * 1024)
                assert block == source_block, 'Decoded bytes differ: ' + member.filename
                if not block: break
                h.update(block); size += len(block); crc = zlib.crc32(block, crc)
        assert size == item['bytes'] == member.file_size
        assert h.hexdigest() == item['sha256']
        assert f'{crc & 0xffffffff:08x}' == item['crc32'] == f'{member.CRC:08x}'
        assert identity(safe_stat(path)) == item['identity']
        member_proofs.append({'name': member.filename, 'kind': 'file', 'bytes': size,
            'sha256': h.hexdigest(), 'crc32': f'{member.CRC:08x}', 'compressedBytes': member.compress_size,
            'sourceMtimeNs': item['identity']['mtimeNs'], 'exact': True})
after = inventory()
assert after == before, 'Source full set/identity/mtime/bytes/SHA/CRC changed'
write_json('source-index.after.json', {'schema': 'cinatoken-ee122-source-index-v1', 'at': utc(), **after,
    'fileCount': len(after['files']), 'directoryCount': len(after['directories']),
    'totalBytes': sum(v['bytes'] for v in after['files'].values()), 'originalFinalAndSealPins': pin_matches,
    'exclusions': [], 'symlinkFollowing': False})
proof = {'schema': 'cinatoken-ee122-opaque-lossless-roundtrip-v1', 'startedAt': started, 'finishedAt': utc(),
    'sourceRoot': SOURCE.as_posix(), 'zip': descriptor(ZIP), 'originalFinalAndSealPins': pin_matches,
    'fileCount': len(before['files']), 'directoryCount': len(before['directories']), 'memberCount': len(member_proofs),
    'sourceTotalBytes': sum(v['bytes'] for v in before['files'].values()), 'sourceRootAndAllDirectoryIdentitiesAndMtimesUnchanged': True,
    'beforeAfterCompleteSetBytesShaCrcIdentityExact': True, 'zipCompleteMemberSetExact': True,
    'allDecodedFileBytesComparedWithLiveOriginal': True, 'allDecodedBytesShaAndCrcExact': True,
    'members': member_proofs, 'exclusions': [], 'symlinkFollowing': False, 'collectionOnly': True,
    'originalRawFailuresSlicesAndStdinPreservedOnlyInsideZip': True, 'internalReceiptsRewritten': False,
    'nativeExitZeroDerived': False, 'fullG7G8Derived': False, 'applicationRuns': 0, 'ciRuns': 0, 'dbRuns': 0,
    'archiveOutputIncludedAsNewSource': False}
write_json('zip-member-roundtrip-proof.json', proof)
print(json.dumps({'phase': 'roundtrip-complete', 'zip': proof['zip'], 'files': proof['fileCount'],
    'directories': proof['directoryCount'], 'members': proof['memberCount'], 'sourceTotalBytes': proof['sourceTotalBytes'],
    'collectionOnly': True, 'gatePassDerived': False}), flush=True)
