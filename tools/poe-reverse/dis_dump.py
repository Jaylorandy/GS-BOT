# -*- coding: utf-8 -*-
"""dev-only: Disassemble extracted .pyc modules + dump constants.

Run with VENDOR Python 3.11.9:
  E:/GS Bot-app/vendor/windows/python/python.exe tools/poe-reverse/dis_dump.py [module_filter]

Outputs:
  tools/poe-reverse/dis/<module>.txt   - recursive disassembly
  tools/poe-reverse/consts/<module>.json - per-code-object constants (strings/numbers/tuples)
"""
import dis
import io
import json
import marshal
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PYC_DIR = os.path.join(HERE, 'pyc')
DIS_DIR = os.path.join(HERE, 'dis')
CONSTS_DIR = os.path.join(HERE, 'consts')


def jsonable(v, depth=0):
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    if isinstance(v, tuple):
        return [jsonable(x, depth + 1) for x in v] if depth < 6 else '<tuple:%d>' % len(v)
    if isinstance(v, frozenset):
        return ['<frozenset>'] + [jsonable(x, depth + 1) for x in sorted(v, key=str)][:200]
    if isinstance(v, bytes):
        return repr(v)
    if isinstance(v, type(re.compile(''))):
        return '<regex:%s>' % v.pattern
    return '<%s>' % type(v).__name__


def walk(code, prefix=''):
    """Yield (qualified_name, code_object) for code and all nested."""
    name = prefix + code.co_name if not prefix else '%s.%s' % (prefix, code.co_name)
    yield name, code
    for const in code.co_consts:
        if hasattr(const, 'co_code'):
            for item in walk(const, name):
                yield item


def dump_module(pyc_path, rel_name):
    with open(pyc_path, 'rb') as f:
        f.read(16)  # skip header
        code = marshal.loads(f.read())

    # --- disassembly ---
    buf = io.StringIO()
    buf.write('# module: %s\n# pyc: %s\n\n' % (rel_name, pyc_path))
    for qname, co in walk(code):
        buf.write('\n' + '=' * 78 + '\n')
        buf.write('## %s  (args=%d, locals=%d)\n' % (qname, co.co_argcount, len(co.co_varnames)))
        if co.co_varnames:
            buf.write('# varnames: %s\n' % ', '.join(co.co_varnames))
        try:
            dis.dis(co, file=buf, depth=0)
        except Exception as e:
            buf.write('# dis failed: %s\n' % e)
    dis_path = os.path.join(DIS_DIR, rel_name.replace('.', os.sep) + '.txt')
    os.makedirs(os.path.dirname(dis_path), exist_ok=True)
    with open(dis_path, 'w', encoding='utf-8') as f:
        f.write(buf.getvalue())

    # --- constants ---
    consts = {}
    for qname, co in walk(code):
        entry = {
            'names': list(co.co_names),
            'varnames': list(co.co_varnames),
            'consts': [jsonable(c) for c in co.co_consts if not hasattr(c, 'co_code')],
            'n_instructions': sum(1 for _ in dis.get_instructions(co)),
        }
        consts[qname] = entry
    const_path = os.path.join(CONSTS_DIR, rel_name.replace('.', os.sep) + '.json')
    os.makedirs(os.path.dirname(const_path), exist_ok=True)
    with open(const_path, 'w', encoding='utf-8') as f:
        json.dump(consts, f, ensure_ascii=False, indent=1)

    total_instr = sum(v['n_instructions'] for v in consts.values())
    return len(consts), total_instr, dis_path


def main():
    filt = sys.argv[1] if len(sys.argv) > 1 else ''
    results = []
    for root, _dirs, files in os.walk(PYC_DIR):
        for fn in files:
            if not fn.endswith('.pyc'):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, PYC_DIR)[:-4].replace(os.sep, '.')
            if filt and filt not in rel:
                continue
            try:
                n_funcs, n_instr, _ = dump_module(full, rel)
                results.append((rel, n_funcs, n_instr))
            except Exception as e:
                print('FAIL %s: %s' % (rel, e))
    results.sort(key=lambda r: -r[2])
    print('%-45s %8s %10s' % ('module', 'funcs', 'instructions'))
    for rel, n_funcs, n_instr in results:
        print('%-45s %8d %10d' % (rel, n_funcs, n_instr))
    print('--- %d modules dumped to %s and %s' % (len(results), DIS_DIR, CONSTS_DIR))


if __name__ == '__main__':
    main()
