import importlib.util
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backup_roomd', Path(__file__).with_name('backup-roomd.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def test_live_wal_backup_and_retention(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / 'roomd'
            history = source / 'data/history'
            history.mkdir(parents=True)
            (source / 'data/identity.key').write_bytes(b'identity-fixture')
            (source / '.env').write_text('ROOMD_NICKNAME=test\n')
            with sqlite3.connect(history / 'history.db') as live:
                live.execute('PRAGMA journal_mode=WAL')
                live.execute('CREATE TABLE messages (body TEXT)')
                live.execute('INSERT INTO messages VALUES (?)', ('persisted in WAL',))
                live.commit()
                archive = module.backup(source, root / 'backups', keep=1)
                self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
                self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)
                with tarfile.open(archive) as package:
                    self.assertEqual(package.extractfile('data/identity.key').read(), b'identity-fixture')
                    self.assertEqual(package.extractfile('.env').read(), b'ROOMD_NICKNAME=test\n')
                    restored = root / 'restored.db'
                    restored.write_bytes(package.extractfile('data/history/history.db').read())
                with sqlite3.connect(restored) as restored_db:
                    self.assertEqual(restored_db.execute('PRAGMA quick_check').fetchone(), ('ok',))
                    self.assertEqual(restored_db.execute('SELECT body FROM messages').fetchone(), ('persisted in WAL',))
                replacement = module.backup(source, root / 'backups', keep=1)
                self.assertNotEqual(replacement, archive)
                self.assertEqual(list((root / 'backups').glob('roomd-*.tar.gz')), [replacement])

    def test_missing_database_does_not_create_empty_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                module.backup(root, root / 'backups')
            self.assertFalse((root / 'data/history/history.db').exists())

    def test_invalid_retention_is_rejected(self):
        with self.assertRaises(ValueError):
            module.backup('/missing', '/unused', keep=0)


if __name__ == '__main__':
    unittest.main()
