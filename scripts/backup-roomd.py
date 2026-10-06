#!/usr/bin/env python3
"""Create a private, atomic roomd identity/config/SQLite backup without stopping it."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile


def backup(source, destination, keep=14):
    if keep < 1:
        raise ValueError('keep must be at least 1')
    source = Path(source).resolve()
    destination = Path(destination).resolve()
    database = source / 'data/history/history.db'
    identity = source / 'data/identity.key'
    for required in (database, identity):
        if not required.is_file():
            raise FileNotFoundError(required)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    with (destination / '.backup.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(dir=destination) as staging:
            snapshot = Path(staging) / 'history.db'
            with closing(sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True, timeout=30)) as live:
                with closing(sqlite3.connect(snapshot)) as copy:
                    live.backup(copy)
                    if copy.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                        raise RuntimeError('SQLite backup integrity check failed')
            timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            archive_path = destination / f'roomd-{timestamp}.tar.gz'
            temporary_archive = Path(staging) / 'backup.tar.gz'
            with tarfile.open(temporary_archive, 'w:gz') as archive:
                archive.add(snapshot, arcname='data/history/history.db')
                archive.add(identity, arcname='data/identity.key')
                for name in ('.env', 'docker-compose.yml', 'Dockerfile'):
                    config = source / name
                    if config.is_file():
                        archive.add(config, arcname=name)
            os.chmod(temporary_archive, 0o600)
            with temporary_archive.open('rb') as archive:
                os.fsync(archive.fileno())
            os.replace(temporary_archive, archive_path)
            directory_fd = os.open(destination, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        for expired in sorted(destination.glob('roomd-*.tar.gz'), reverse=True)[keep:]:
            expired.unlink()
        return archive_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/opt/iroh/roomd'))
    parser.add_argument('--destination', type=Path, default=Path('/opt/iroh/backups/roomd'))
    parser.add_argument('--keep', type=int, default=14)
    options = parser.parse_args()
    os.umask(0o077)
    try:
        archive = backup(options.source, options.destination, options.keep)
    except (OSError, ValueError, sqlite3.Error, RuntimeError) as error:
        parser.exit(1, f'roomd backup failed: {error}\n')
    print(f'roomd backup ready: {archive}')


if __name__ == '__main__':
    main()
