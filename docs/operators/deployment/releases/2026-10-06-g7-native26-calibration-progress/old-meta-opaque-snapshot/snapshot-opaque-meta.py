import datetime
import hashlib
import json
import os
import stat
import time
import zipfile
from pathlib import Path

SOURCE = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-native-g7-durable-meta-4d1a6190eb7e440fb1bce29961eaaea7')
OUTPUT = Path('C:/Users/cina/AppData/Local/Temp/cinatoken-old-meta-opaque-snapshot-eEXPR6')
ZIP = OUTPUT / 'frozen-old-metadata-lossless.zip'
INDEX = OUTPUT / 'frozen-old-metadata-index.json'
PROOF = OUTPUT / 'opaque-transport-verification.json'
REPARSE = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def safe_stat(path):
    observed = os.lstat(path)
    if stat.S_ISLNK(observed.st_mode) or getattr(observed, 'st_file_attributes', 0) & REPARSE:
        raise AssertionError('Symlink or reparse point rejected: ' + str(path))
    return observed


def identity(value):
    return [value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns,
            getattr(value, 'st_file_attributes', 0)]


def inventory():
    root_stat = safe_stat(SOURCE)
    assert stat.S_ISDIR(root_stat.st_mode)
    files, directories = {}, []

    def visit(directory):
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda entry: entry.name)
        for child in children:
            path = Path(child.path)
            value = safe_stat(path)
            relative = path.relative_to(SOURCE).as_posix()
            assert relative and not relative.startswith('/') and '..' not in Path(relative).parts
            if stat.S_ISDIR(value.st_mode):
                directories.append(relative)
                visit(path)
            elif stat.S_ISREG(value.st_mode):
                assert relative not in files
                files[relative] = {'path': path, 'identity': identity(value)}
            else:
                raise AssertionError('Non-regular source entry rejected: ' + str(path))
    visit(SOURCE)
    return files, sorted(directories)


def descriptor(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, 'rb') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
            size += len(block)
    return {'path': path.as_posix(), 'bytes': size, 'sha256': digest.hexdigest()}


def write_json(path, value):
    with open(path, 'x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


started = utc()
assert SOURCE.resolve() != OUTPUT.resolve()
assert SOURCE not in OUTPUT.parents and OUTPUT not in SOURCE.parents
for output in (ZIP, INDEX, PROOF):
    assert not output.exists(), 'Refusing overwrite: ' + str(output)
original_files, original_directories = inventory()
assert original_files
print(json.dumps({'phase': 'inventory', 'regularFiles': len(original_files), 'directories': len(original_directories), 'exclusions': 0}), flush=True)
entries = []
with zipfile.ZipFile(ZIP, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as archive:
    for relative in original_directories:
        archive.writestr(relative + '/', b'')
    for position, relative in enumerate(sorted(original_files), 1):
        source = original_files[relative]
        path = source['path']
        assert identity(safe_stat(path)) == source['identity']
        digest = hashlib.sha256()
        size = 0
        with open(path, 'rb') as stream, archive.open(relative, 'w', force_zip64=True) as member:
            while block := stream.read(1024 * 1024):
                member.write(block)
                digest.update(block)
                size += len(block)
        assert identity(safe_stat(path)) == source['identity']
        assert size == source['identity'][3]
        entries.append({'relative': relative, 'originalPath': path.as_posix(), 'zipEntry': relative,
                        'originalBytes': size, 'originalSha256': digest.hexdigest(),
                        'originalMtimeNs': source['identity'][4], 'encoding': 'zip-deflate-lossless'})
        if position % 250 == 0 or position == len(original_files):
            print(json.dumps({'phase': 'zip-written', 'files': position, 'total': len(original_files)}), flush=True)

by_relative = {entry['relative']: entry for entry in entries}
with zipfile.ZipFile(ZIP, 'r') as archive:
    members = archive.infolist()
    names = [member.filename for member in members]
    assert len(names) == len(set(names)) == len(original_files) + len(original_directories)
    assert set(names) == set(original_files) | {relative + '/' for relative in original_directories}
    assert {member.filename[:-1] for member in members if member.is_dir()} == set(original_directories)
    for member in members:
        if member.is_dir():
            assert member.file_size == 0 and archive.read(member) == b''
    file_members = [member for member in members if not member.is_dir()]
    for position, member in enumerate(file_members, 1):
        entry = by_relative[member.filename]
        source = original_files[member.filename]
        assert identity(safe_stat(source['path'])) == source['identity']
        digest = hashlib.sha256()
        size = 0
        with archive.open(member, 'r') as decoded, open(source['path'], 'rb') as original:
            while True:
                decoded_block = decoded.read(1024 * 1024)
                original_block = original.read(1024 * 1024)
                assert decoded_block == original_block, 'ZIP decode differs: ' + member.filename
                if not decoded_block:
                    break
                digest.update(decoded_block)
                size += len(decoded_block)
        assert size == entry['originalBytes'] == member.file_size
        assert digest.hexdigest() == entry['originalSha256']
        assert identity(safe_stat(source['path'])) == source['identity']
        entry.update({'decodedBytes': size, 'decodedSha256': digest.hexdigest(), 'roundtripBytesExact': True,
                      'zipCompressedBytes': member.compress_size, 'zipCRC32': f'{member.CRC:08x}'})
        if position % 250 == 0 or position == len(file_members):
            print(json.dumps({'phase': 'zip-decoded-exact', 'files': position, 'total': len(file_members)}), flush=True)

after_files, after_directories = inventory()
assert set(after_files) == set(original_files)
assert after_directories == original_directories
assert all(after_files[relative]['identity'] == original_files[relative]['identity'] for relative in original_files)
zip_descriptor = descriptor(ZIP)
write_json(INDEX, {'schema': 'cinatoken-frozen-old-metadata-opaque-lossless-index-v1',
                  'startedAt': started, 'endedAt': utc(), 'sourceRoot': SOURCE.as_posix(),
                  'regularFileCount': len(entries), 'originalTotalBytes': sum(entry['originalBytes'] for entry in entries),
                  'directoryCount': len(original_directories), 'directories': original_directories,
                  'exclusions': [], 'symlinkFollowing': False, 'allRegularFilesIncluded': True,
                  'zip': zip_descriptor, 'entries': entries,
                  'classification': 'opaque immutable historical evidence transport',
                  'collectionOnly': True, 'oldExecutionsRepeated': False, 'embeddedCopyIsNewExecution': False,
                  'gatePassDerived': False})
write_json(PROOF, {'schema': 'cinatoken-frozen-old-metadata-opaque-lossless-verification-v1',
                  'startedAt': started, 'endedAt': utc(), 'closed': True, 'actualCollectionExit': 0,
                  'sourceRoot': SOURCE.as_posix(), 'zip': zip_descriptor, 'index': descriptor(INDEX),
                  'regularFiles': len(entries), 'sourceSetExact': True, 'zipEntrySetExact': True,
                  'everyDecodedByteComparedWithOriginal': True, 'everyDecodedBytesAndSHA256Exact': True,
                  'sourceIdentityAndSetUnchanged': True, 'exclusions': [], 'symlinkFollowing': False,
                  'originalJSONRawNumericNullAndLiteralPathsPreservedAsBytes': True,
                  'nestedOutputAndOldFullReleaseCopiesIncluded': True,
                  'collectionOnly': True, 'oldExecutionsRepeated': False, 'applicationRuns': 0,
                  'ciRunsTriggered': 0, 'productionRequests': 0, 'gatePassDerived': False})
print(json.dumps({'closed': True, 'actualCollectionExit': 0, 'regularFiles': len(entries),
                  'originalTotalBytes': sum(entry['originalBytes'] for entry in entries),
                  'zip': zip_descriptor, 'collectionOnly': True, 'gatePassDerived': False}), flush=True)
