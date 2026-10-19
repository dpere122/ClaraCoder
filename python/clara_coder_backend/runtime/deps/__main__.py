"""CLI: ``python -m clara_coder_backend.runtime.deps <list|install|reinstall|delete|cleanup> [id]``.

Used by Electron before the FastAPI sidecar is available (bootstrap).
Progress lines are printed as JSON to stdout prefixed with ``PROGRESS ``.
During install/reinstall a ``cancel`` line on stdin stops the install and cleans up;
``cleanup`` removes what a forcibly killed install left behind.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from pathlib import Path


def _emit_progress(payload: dict) -> None:
    print('PROGRESS ' + json.dumps(payload), flush=True)


def _listen_for_cancel(dep_id: str) -> None:
    """Electron writes ``cancel`` to stdin; forward it to the running install."""

    from clara_coder_backend.runtime.deps.cancel import request_cancel

    def _read() -> None:
        try:
            for line in sys.stdin:
                if line.strip().lower() == 'cancel':
                    request_cancel(dep_id)
                    return
        except (OSError, ValueError):
            return

    threading.Thread(target=_read, name='deps-cli-cancel', daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    from clara_coder_backend.logging.app_logging import configure_logging
    from clara_coder_backend.runtime.deps.cancel import InstallCancelled
    from clara_coder_backend.runtime.deps.progress import PROGRESS
    from clara_coder_backend.runtime.deps.registry import (
        DEPENDENCY_IDS,
        cleanup_after_cancel,
        delete_dependency,
        install_dependency,
        list_dependencies,
        reinstall_dependency,
    )
    from clara_coder_backend.config import env_clara

    raw_log = env_clara('CLARA_LOG_DIR', '').strip()
    configure_logging(Path(raw_log) if raw_log else None)

    parser = argparse.ArgumentParser(prog='clara-deps')
    parser.add_argument('action', choices=('list', 'install', 'reinstall', 'delete', 'status', 'cleanup'))
    parser.add_argument('dep_id', nargs='?', default=None)
    parser.add_argument(
        '--variant',
        default=None,
        help='llama-server build variant, or Whisper size (tiny|base|small|medium|distil-large-v3|large-v3-turbo)',
    )
    args = parser.parse_args(argv)

    PROGRESS.subscribe(_emit_progress)
    try:
        if args.action == 'list':
            print(json.dumps({'ok': True, 'dependencies': list_dependencies()}))
            return 0
        if args.action == 'status':
            if not args.dep_id:
                print(json.dumps({'ok': False, 'error': 'dep_id required'}), file=sys.stderr)
                return 2
            from clara_coder_backend.runtime.deps.registry import get_dependency

            print(json.dumps({'ok': True, 'dependency': get_dependency(args.dep_id)}))
            return 0
        if not args.dep_id or args.dep_id not in DEPENDENCY_IDS:
            print(
                json.dumps({'ok': False, 'error': f'dep_id must be one of {list(DEPENDENCY_IDS)}'}),
                file=sys.stderr,
            )
            return 2
        if args.action in ('install', 'reinstall'):
            _listen_for_cancel(args.dep_id)
        if args.action == 'install':
            dep = install_dependency(args.dep_id, force=False, variant=args.variant)
        elif args.action == 'reinstall':
            dep = reinstall_dependency(args.dep_id, variant=args.variant)
        elif args.action == 'cleanup':
            dep = cleanup_after_cancel(args.dep_id)
        else:
            dep = delete_dependency(args.dep_id)
        print(json.dumps({'ok': True, 'dependency': dep}))
        return 0
    except InstallCancelled:
        print(json.dumps({'ok': False, 'cancelled': True, 'error': 'Install cancelled'}))
        return 1
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
    finally:
        PROGRESS.unsubscribe(_emit_progress)


if __name__ == '__main__':
    raise SystemExit(main())
