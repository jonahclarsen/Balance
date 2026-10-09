"""CI-only, synthetic SQLCipher storage prototypes; never opens an existing DB.

No app persistence/wire-format changes. See README.md for scope and limitations.
"""
import argparse
import copy
import hashlib
import html
import json
import os
from pathlib import Path
import platform
import random
import statistics
import tempfile
import time
import uuid
import zlib

import sqlcipher3 as sqlite
import zstandard as zstd


METHODS = ['raw', 'zlib-1', 'zlib-6', 'zstd-1', 'zstd-3',
           'dictionary-3', 'dedup-3', 'block30-3']
SCENARIOS = {
    'typical-year': (365, 1 / 3, 7, False),
    'typical-decade': (3650, 1 / 3, 7, False),
    'full-decade': (3650, 1, 7, False),
    'churn-decade': (3650, 1 / 3, 1, False),
    'plans-decade': (3650, 1, 7, True),
}
# Entirely authored synthetic vocabulary; no downloaded/user corpus.
WORDS = ("review plan walk garden listen focus prepare reflect learn practice finish "
         "morning evening weekly patient steady thoughtful clear simple careful kind "
         "journal reading exercise project kitchen window river forest music notebook "
         "chapter meeting question answer habit progress energy attention family friend "
         "before after while today tomorrow toward through beside within without "
         "a the and with for from to in of my our this that each some another "
         "minutes hours ideas details purpose choice effort rest breathe water stretch "
         "remember consider notice record organize explore understand improve repeat "
         "café naïve 東京 🌱 résumé").split()


def pack(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode()


def walk(items):
    for item in items:
        yield item
        yield from walk(item.get('children', []))


def fixture(days, probability, edit_every, plans, seed):
    """Different daily IDs, selections, nested rows, checkoffs and durable edits."""
    rng = random.Random(seed)

    def identifier():
        return str(uuid.UUID(int=rng.getrandbits(128)))

    sizes = [300] if plans else [2700, 1350, 540]
    sources = []
    for size in sizes:
        rows = []
        remaining = size
        while remaining:
            count = min(remaining, rng.randint(8, 32))
            words = rng.choices(WORDS, k=count)
            text = ' '.join(words)
            markup = '<p>' + html.escape(text) + '</p>'
            if len(rows) % 4 == 0:
                markup = '<p><strong>' + html.escape(text) + '</strong></p>'
            rows.append(dict(id=identifier(), text=text, html=markup))
            remaining -= count
        sources.append(rows)
    dictionaries = [pack(rows) for rows in sources]
    records = []
    import datetime
    for day in range(days):
        date = str(datetime.date(2020, 1, 1) + datetime.timedelta(days=day))
        for group, source in enumerate(sources):
            if day and day % edit_every == 0:
                row = rng.choice(source)
                words = row['text'].split()
                words[rng.randrange(len(words))] = rng.choice(WORDS)
                row['text'] = ' '.join(words)
                row['html'] = '<p>' + html.escape(row['text']) + '</p>'
            # Sensitivity case includes deletion/replacement, reorders, new prose.
            if edit_every == 1 and day % 30 == 0:
                rng.shuffle(source)
                row = rng.choice(source)
                row.update(id=identifier(), text=' '.join(rng.choices(WORDS, k=22)))
                row['html'] = '<p>' + row['text'] + '</p>'
            suffix = identifier()[:8]
            items = []
            for index, original in enumerate(source):
                if rng.random() > probability:
                    continue
                row = dict(original, id=original['id'] + '.' + suffix,
                           done=rng.random() < .9, startMinutes=None,
                           endMinutes=None, children=[])
                if row['done'] and not plans:
                    row['doneAt'] = index * 25 + rng.randrange(25)
                # Some day-specific edits must not affect the source or other days.
                if rng.random() < .01:
                    row['text'] += ' ' + rng.choice(WORDS)
                    row['html'] = '<p>' + html.escape(row['text']) + '</p>'
                if items and index % 7 == 0:
                    items[-1]['children'].append(row)
                else:
                    items.append(row)
            records.append(dict(id=identifier(), date=date,
                                listTemplateId=f'template-{group}',
                                createdAt=date + 'T12:00:00Z', items=items))
    return records, dictionaries


class Store:
    def __init__(self, path, method, dictionaries=None, reopen=False):
        if not reopen and path.exists():
            raise ValueError('Refusing to open an existing database')
        self.path, self.method = path, method
        self.db = sqlite.connect(str(path))
        # Raw, explicitly test-only key; no keychain or app directories involved.
        self.db.execute('PRAGMA key = "x\'' + '42' * 32 + '\'"')
        assert self.db.execute('PRAGMA cipher_version').fetchone()[0]
        self.db.execute('PRAGMA foreign_keys=ON')
        if not reopen:
            self.db.executescript('''
                CREATE TABLE state_entities (
                  collection TEXT NOT NULL, entity_key TEXT NOT NULL,
                  position INTEGER NOT NULL, value_json BLOB NOT NULL,
                  PRIMARY KEY(collection, entity_key));
                CREATE INDEX idx_state_entities_order
                  ON state_entities(collection, position, entity_key);
                CREATE TABLE dictionaries (id INTEGER PRIMARY KEY, data BLOB NOT NULL);
                CREATE TABLE content (id TEXT PRIMARY KEY, data BLOB NOT NULL);
            ''')
            if method == 'dictionary-3':
                self.db.executemany('INSERT INTO dictionaries VALUES (?, ?)', enumerate(dictionaries))
            self.db.commit()
        ds = self.db.execute('SELECT data FROM dictionaries ORDER BY id').fetchall()
        self.encoders, self.decoders = [], []
        for (data,) in ds:
            dictionary = zstd.ZstdCompressionDict(data, dict_type=zstd.DICT_TYPE_RAWCONTENT)
            self.encoders.append(zstd.ZstdCompressor(level=3, dict_data=dictionary, write_checksum=True))
            self.decoders.append(zstd.ZstdDecompressor(dict_data=dictionary))
        self.zencoder = zstd.ZstdCompressor(level=1 if method == 'zstd-1' else 3,
                                           write_checksum=True)
        self.zdecoder = zstd.ZstdDecompressor()

    def group(self, record):
        return int(record['listTemplateId'].split('-')[-1])

    def encode(self, record):
        group = self.group(record) if isinstance(record, dict) else 0
        if self.method == 'dedup-3':
            record = copy.deepcopy(record)
            for row in walk(record['items']):
                payload = pack([row.pop('text'), row.pop('html')])
                key = hashlib.sha256(payload).hexdigest()
                self.db.execute('INSERT OR IGNORE INTO content VALUES (?, ?)',
                                (key, self.zencoder.compress(payload)))
                row['_content'] = key
        raw = pack(record)
        if self.method == 'raw':
            return raw
        if self.method.startswith('zlib'):
            return zlib.compress(raw, int(self.method[-1]))
        if self.method == 'dictionary-3':
            return bytes([group]) + self.encoders[group].compress(raw)
        return self.zencoder.compress(raw)

    def decode(self, payload):
        if self.method == 'raw':
            raw = payload
        elif self.method.startswith('zlib'):
            raw = zlib.decompress(payload)
        elif self.method == 'dictionary-3':
            raw = self.decoders[payload[0]].decompress(payload[1:])
        else:
            raw = self.zdecoder.decompress(payload)
        record = json.loads(raw)
        if self.method == 'dedup-3':
            for row in walk(record['items']):
                key = row.pop('_content')
                result = self.db.execute('SELECT data FROM content WHERE id=?', (key,)).fetchone()
                if result is None:
                    raise ValueError('Missing immutable text content')
                data = self.zdecoder.decompress(result[0])
                if hashlib.sha256(data).hexdigest() != key:
                    raise ValueError('Content hash mismatch')
                row['text'], row['html'] = json.loads(data)
        return record

    def populate(self, records, groups):
        self.block_size = 30 * groups
        step = self.block_size if self.method == 'block30-3' else 1
        for offset in range(0, len(records), step):
            value = records[offset:offset + step] if step > 1 else records[offset]
            self.db.execute('INSERT INTO state_entities VALUES (?, ?, ?, ?)',
                            ('lists', records[offset]['id'], offset, self.encode(value)))
            # Approximate daily transactions; synchronous defaults are retained.
            if step > 1 or (offset + 1) % groups == 0:
                self.db.commit()
        self.db.commit()

    def read(self, index):
        key = index // self.block_size * self.block_size if self.method == 'block30-3' else index
        row = self.db.execute('SELECT value_json FROM state_entities WHERE collection=? AND position=?',
                              ('lists', key)).fetchone()
        if row is None:
            raise ValueError('Missing record')
        value = self.decode(row[0])
        return value[index % self.block_size] if self.method == 'block30-3' else value

    def update(self, index, record):
        key = index // self.block_size * self.block_size if self.method == 'block30-3' else index
        value = record
        if self.method == 'block30-3':
            value = self.decode(self.db.execute('SELECT value_json FROM state_entities WHERE collection=? AND position=?',
                                               ('lists', key)).fetchone()[0])
            value[index % self.block_size] = record
        self.db.execute('UPDATE state_entities SET value_json=? WHERE collection=? AND position=?',
                        (self.encode(value), 'lists', key))

    def verify_all(self, records):
        # Linear scan verifies every record without decompressing a block 90 times.
        count = 0
        for offset, payload in self.db.execute('SELECT position, value_json FROM state_entities ORDER BY position'):
            values = self.decode(payload)
            if self.method != 'block30-3':
                values = [values]
            for index, value in enumerate(values, offset):
                assert value == records[index], (self.method, index)
                count += 1
        assert count == len(records)
        assert self.db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert self.db.execute('PRAGMA cipher_integrity_check').fetchall() == []


def percentile(values, fraction):
    return sorted(values)[min(len(values) - 1, int(len(values) * fraction))]


def verify():
    records, dictionaries = fixture(65, 1 / 3, 1, False, 123)
    records[0]['futureUnknown'] = {'unicode': '🌱 café 東京', 'nested': [None, 1, True]}
    records[1]['items'] = []
    records[2]['items'][0]['text'] = ''
    records[2]['items'][0]['html'] = '<p><a href="https://example.invalid/">link</a></p>'
    with tempfile.TemporaryDirectory(prefix='balance-synthetic-verify-') as directory:
        for method in METHODS:
            path = Path(directory) / (method + '.db')
            store = Store(path, method, dictionaries)
            store.populate(records, 3)
            store.verify_all(records)
            original = store.read(0)
            changed = copy.deepcopy(original)
            changed['items'][0]['text'] += ' changed'
            # Undo/redo here tests prototype replacements, not Balance's op engine.
            for value in [changed, original, changed, original]:
                store.update(0, value)
                store.db.commit()
                assert store.read(0) == value
                assert store.read(3) == records[3]
            store.update(0, changed)
            store.db.rollback()
            assert store.read(0) == original
            store.db.execute('VACUUM')
            store.db.close()
            assert path.read_bytes()[:16] != b'SQLite format 3\x00'
            store = Store(path, method, reopen=True)
            store.block_size = 90
            store.verify_all(records)
            if method == 'dedup-3':
                key = store.db.execute('SELECT id FROM content LIMIT 1').fetchone()[0]
                store.db.execute('DELETE FROM content WHERE id=?', (key,))
                try:
                    store.verify_all(records)
                except ValueError:
                    pass
                else:
                    raise AssertionError('Missing dependency was silently accepted')
                store.db.rollback()
            if method not in ('raw', 'dedup-3'):
                data = store.db.execute('SELECT value_json FROM state_entities LIMIT 1').fetchone()[0]
                try:
                    store.decode(data[:-8])
                except (ValueError, zlib.error, zstd.ZstdError):
                    pass
                else:
                    raise AssertionError('Truncated compressed data was accepted')
            store.db.close()
    print('Verified all codecs, all records, Unicode/HTML/unknown fields, replacement undo/redo, rollback, vacuum, reopen and dependency/truncation errors.', flush=True)


def benchmark(scenario, output):
    days, probability, edit_every, plans = SCENARIOS[scenario]
    results = []
    output.mkdir(parents=True, exist_ok=True)
    for seed in [17, 29, 43]:
        records, dictionaries = fixture(days, probability, edit_every, plans, seed)
        logical_bytes = sum(len(pack(row)) for row in records)
        groups = len(dictionaries)
        order = METHODS[:]
        random.Random(seed).shuffle(order)
        for method in order:
            with tempfile.TemporaryDirectory(prefix='balance-synthetic-study-') as directory:
                path = Path(directory) / 'synthetic.db'
                store = Store(path, method, dictionaries)
                start, cpu_start = time.perf_counter(), time.process_time()
                store.populate(records, groups)
                build_s, build_cpu_s = time.perf_counter() - start, time.process_time() - cpu_start
                store.db.close()
                size = path.stat().st_size
                # Encryption should defeat attempts to zip the final file.
                encrypted_zip_bytes = 0
                if method == 'raw':
                    compressor = zlib.compressobj(6)
                    with path.open('rb') as handle:
                        while chunk := handle.read(1024 * 1024):
                            encrypted_zip_bytes += len(compressor.compress(chunk))
                    encrypted_zip_bytes += len(compressor.flush())
                store = Store(path, method, reopen=True)
                store.block_size = 30 * groups
                rng = random.Random(seed + 100)
                samples = [rng.randrange(len(records)) for _ in range(150)]
                read_ms = []
                for index in samples:
                    start = time.perf_counter()
                    value = store.read(index)
                    read_ms.append((time.perf_counter() - start) * 1000)
                    assert value == records[index]
                start = time.perf_counter()
                store.verify_all(records)
                scan_verify_s = time.perf_counter() - start
                edit_ms, edit_cpu_ms = [], []
                for index in samples[:50]:
                    start, cpu_start = time.perf_counter(), time.process_time()
                    value = store.read(index)
                    if value['items']:
                        value['items'][0]['text'] += ' revised'
                        value['items'][0]['html'] += '<em> revised</em>'
                    store.update(index, value)
                    store.db.commit()
                    edit_ms.append((time.perf_counter() - start) * 1000)
                    edit_cpu_ms.append((time.process_time() - cpu_start) * 1000)
                    assert store.read(index) == value
                    store.update(index, records[index])
                    store.db.commit()
                after_edit_bytes = path.stat().st_size
                store.db.execute('VACUUM')
                vacuum_bytes = path.stat().st_size
                store.verify_all(records)
                result = dict(scenario=scenario, seed=seed, method=method, days=days,
                              records=len(records), logical_bytes=logical_bytes, database_bytes=size,
                              encrypted_zip_bytes=encrypted_zip_bytes, after_edit_bytes=after_edit_bytes,
                              vacuum_bytes=vacuum_bytes, build_s=build_s, build_cpu_s=build_cpu_s,
                              read_median_ms=statistics.median(read_ms), read_p95_ms=percentile(read_ms, .95),
                              edit_median_ms=statistics.median(edit_ms), edit_p95_ms=percentile(edit_ms, .95),
                              edit_cpu_median_ms=statistics.median(edit_cpu_ms), scan_verify_s=scan_verify_s,
                              sqlcipher=store.db.execute('PRAGMA cipher_version').fetchone()[0])
                results.append(result)
                store.db.close()
                print(json.dumps(result), flush=True)
                (output / 'results.json').write_text(json.dumps(dict(
                    scenario=scenario, python=platform.python_version(), platform=platform.platform(),
                    zstandard=zstd.__version__, results=results), indent=2) + '\n')
    rows = ['# Synthetic storage study: ' + scenario, '',
            'Medians across three independent seeded histories. MiB = 1,048,576 bytes.', '',
            '| Method | Database MiB | Saved | Build CPU s | Read p95 ms | Edit p95 ms | Edit CPU median ms |',
            '|---|---:|---:|---:|---:|---:|---:|']
    baseline = statistics.median(r['database_bytes'] for r in results if r['method'] == 'raw')
    for method in METHODS:
        selected = [r for r in results if r['method'] == method]
        med = lambda key: statistics.median(r[key] for r in selected)
        rows.append(f"| {method} | {med('database_bytes') / 1048576:.2f} | "
                    f"{(1 - med('database_bytes') / baseline) * 100:.1f}% | {med('build_cpu_s'):.2f} | "
                    f"{med('read_p95_ms'):.3f} | {med('edit_p95_ms'):.3f} | {med('edit_cpu_median_ms'):.3f} |")
    rows += ['', 'Payload-storage prototypes only: excludes operation log, undo history, checkpoints, images and other collections.',
             'Plans scenario uses a JSON proxy; current day plans actually use relational tables.',
             'Reads have no decoded-object cache; OS caches are not flushed. Timings are Linux CI Python/SQLCipher, not native app/device latency.',
             'Every record was compared exactly after reopen and after edits/vacuum. See scripts/storage-study/README.md.']
    (output / 'summary.md').write_text('\n'.join(rows) + '\n')


if __name__ == '__main__':
    if os.environ.get('CI') != 'true' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise SystemExit('This study is restricted to GitHub Actions; do not run on the user’s machine.')
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--scenario', choices=SCENARIOS)
    parser.add_argument('--output', type=Path, default=Path('results'))
    args = parser.parse_args()
    if args.verify:
        verify()
    elif args.scenario:
        benchmark(args.scenario, args.output)
    else:
        parser.error('Choose --verify or --scenario')
