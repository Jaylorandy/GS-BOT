# -*- coding: utf-8 -*-
"""dev-only: Extract business .pyc modules from PyInstaller PYZ archive.

Run with the VENDOR Python 3.11.9 (matches PYZ bytecode magic):
  E:/GS Bot-app/vendor/windows/python/python.exe tools/poe-reverse/pyz_extract.py

PYZ layout (PyInstaller >= 4):
  offset 0: magic 'PYZ\\0' (4 bytes)
  offset 4: pyc magic of target python (4 bytes)
  offset 8: TOC position, big-endian uint32
  at TOC pos: marshalled list of (name, (typ, pos, length))
  module data at `pos`: zlib-compressed marshalled code object
"""
import marshal
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
PYZ_PATH = os.path.join(os.environ.get('TEMP', '/tmp'), 'poe_extract', 'PYZ.pyz')
OUT_DIR = os.path.join(HERE, 'pyc')

# Business module prefixes to keep (everything else is bundled stdlib/deps)
KEEP_PREFIXES = ('core.', 'ui.')


def pyc_header(data_len):
    # Python 3.11 magic = A7 0D 0D 0A; flags=0 (timestamp-based); timestamp=0; size
    return b'\xa7\x0d\x0d\x0a' + struct.pack('<I', 0) + struct.pack('<I', 0) + struct.pack('<I', data_len)


def main():
    data = open(PYZ_PATH, 'rb').read()
    if data[:4] != b'PYZ\x00':
        print('ERROR: not a PYZ archive, magic=%r' % data[:4])
        return 1
    pyc_magic = data[4:8]
    (toc_pos,) = struct.unpack('>I', data[8:12])
    print('PYZ size=%d  pyc_magic=%s  toc_pos=%d' % (len(data), pyc_magic.hex(), toc_pos))

    toc = marshal.loads(data[toc_pos:])
    entries = toc.items() if isinstance(toc, dict) else toc
    total = 0
    kept = 0
    os.makedirs(OUT_DIR, exist_ok=True)

    for item in entries:
        total += 1
        if isinstance(item, tuple) and len(item) == 2:
            name, (typ, pos, length) = item
        else:
            continue
        if not isinstance(name, str):
            continue
        if not any(name == p.rstrip('.') or name.startswith(p) for p in KEEP_PREFIXES):
            continue
        raw = data[pos:pos + length]
        try:
            decompressed = zlib.decompress(raw)
            code = marshal.loads(decompressed)
        except Exception as e:
            print('  SKIP %s: %s' % (name, e))
            continue
        if not hasattr(code, 'co_code'):
            print('  SKIP %s: not a code object (%r)' % (name, type(code)))
            continue
        body = marshal.dumps(code)
        out_path = os.path.join(OUT_DIR, name.replace('.', os.sep) + '.pyc')
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, 'wb') as f:
            f.write(pyc_header(len(body)) + body)
        kept += 1

    print('TOC entries=%d  business modules extracted=%d -> %s' % (total, kept, OUT_DIR))
    return 0


if __name__ == '__main__':
    sys.exit(main())
