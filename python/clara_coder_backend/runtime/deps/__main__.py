"""CLI: ``python -m clara_coder_backend.runtime.deps <list|install|reinstall|delete> [id]``.

Used by Electron before the FastAPI sidecar is available (bootstrap).
Progress lines are printed as JSON to stdout prefixed with ``PROGRESS ``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _emit_progress(payload: dict) -> None:
    print('PROGRESS ' + json.dumps(payload), flush=True)


def main(argv: list[str] | None = None) -> int:
    from clara_coder_backend.logging.app_logging import configure_logging
    from clara_coder_backend.runtime.deps.progress import PROGRESS
    from clara_coder_backend.runtime.deps.registry import (
        DEPENDENCY_IDS,
        delete_dependency,
        install_dependency,
        list_dependencies,
        reinstall_dependency,
    )
    from clara_coder_backend.config import env_clara

    raw_log = env_clara('CLARA_LOG_DIR', '').strip()
    configure_logging(Path(raw_log) if raw_log else None)

    parser = argparse.ArgumentParser(prog='clara-deps')
    parser.add_argument('action', choices=('list', 'install', 'reinstall', 'delete', 'status'))
    parser.add_argument('dep_id', nargs='?', default=None)
    parser.add_argument(
        '--variant',
        default=None,
        help='llama-server build variant override (cpu|cuda-12|cuda-13|vulkan|cuda-compiled)',
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
        if args.action == 'install':
            dep = install_dependency(args.dep_id, force=False, variant=args.variant)
        elif args.action == 'reinstall':
            dep = reinstall_dependency(args.dep_id, variant=args.variant)
        else:
            dep = delete_dependency(args.dep_id)
        print(json.dumps({'ok': True, 'dependency': dep}))
        return 0
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
    finally:
        PROGRESS.unsubscribe(_emit_progress)


if __name__ == '__main__':
    raise SystemExit(main())
