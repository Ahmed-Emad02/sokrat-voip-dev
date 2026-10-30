#!/usr/bin/env python3
"""Install the additive Sokrat tenant push hook into an existing PBX dialplan.

Scope: exactly one additive System() action inside the existing
[sub-sokrat-push-send] context, inserted immediately before the single
same=>n(done),Return() line of that context. Nothing else is touched:

  * no new contexts, macros or global/wildcard patterns;
  * no changes to any other context;
  * the legacy dispatcher line is preserved untouched;
  * Asterisk is never reloaded by this tool.

Dry-run is the default. Pass --apply to write, which requires root (override
only for staging fixtures/tests with --allow-unprivileged).

The rendered action passes URIENCODE()d callee/caller/caller-name values and the
dialplan-filtered call id as double-quoted argv to the tenant hook runner, which
decodes them (scripts/pbx-tenant-push-hook.py).
"""
import argparse
import datetime
import difflib
import os
from pathlib import Path
import re
import secrets
import shutil
import sys

CONTEXT = 'sub-sokrat-push-send'
MARKER = '; sokrat-tenant-push-hook v1'
HOOK_NAME = 'pbx-tenant-push-hook.py'
LEGACY_ENDPOINT = '/api/push/incoming-call'
TENANT_ENDPOINT = '/api/gateway/incoming-call'
LEGACY_DISPATCHER = 'System('
MAX_DIALPLAN_BYTES = 2 * 1024 * 1024
MAX_HOOK_BYTES = 256 * 1024
PATH_RE = re.compile(r'^/[A-Za-z0-9._+/-]+$')
VAR_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
HEADER_RE = re.compile(r'^\s*\[([^\]\s]+)\]\s*$')
DONE_RE = re.compile(r'^\s*same\s*=>\s*n\(done\)\s*,\s*Return\(\)\s*$')

SYSTEM_TEMPLATE = (
    'same=>n,System(nohup env SOKRAT_HOOK_CONFIG="%(config)s" '
    '/usr/bin/python3 "%(hook)s" '
    '"${URIENCODE(${%(callee)s})}" '
    '"${URIENCODE(${%(caller)s})}" '
    '"${URIENCODE(${%(name)s})}" '
    '"${%(call_id)s}" >/dev/null 2>&1 &)'
)


class Refusal(Exception):
    """A safe, user-facing refusal: nothing was written."""


def refuse(message):
    raise Refusal(message)


def validate_path(label, raw):
    """Reject relative, whitespace-bearing or shell-active paths."""
    if not raw or not raw.startswith('/'):
        refuse('%s must be an absolute path' % label)
    if len(raw) > 4096:
        refuse('%s is too long' % label)
    if not PATH_RE.match(raw):
        refuse('%s contains whitespace or shell-active characters' % label)
    if raw.endswith('/'):
        refuse('%s must name a file, not a directory' % label)
    if '//' in raw or '/./' in raw or '/../' in raw:
        refuse('%s must not contain empty, "." or ".." segments' % label)
    return Path(raw)


def read_dialplan(path):
    if path.is_symlink():
        refuse('dialplan file must not be a symlink: %s' % path)
    if not path.exists():
        refuse('dialplan file not found: %s' % path)
    if not path.is_file():
        refuse('dialplan path is not a regular file: %s' % path)
    if path.stat().st_size > MAX_DIALPLAN_BYTES:
        refuse('dialplan file is unexpectedly large: %s' % path)
    try:
        text = path.read_bytes().decode('utf-8')
    except UnicodeDecodeError:
        refuse('dialplan file is not valid UTF-8: %s' % path)
    if '\x00' in text:
        refuse('dialplan file contains NUL bytes: %s' % path)
    return text


def check_hook_script(path):
    if path.is_symlink():
        refuse('hook script must not be a symlink: %s' % path)
    if not path.exists():
        refuse('hook script not found: %s' % path)
    if not path.is_file():
        refuse('hook script is not a regular file: %s' % path)
    if path.stat().st_size > MAX_HOOK_BYTES:
        refuse('hook script is unexpectedly large: %s' % path)
    try:
        text = path.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError):
        refuse('hook script is not readable UTF-8 Python: %s' % path)
    if not text.startswith('#!') or 'python' not in text.splitlines()[0]:
        refuse('hook script does not look like a Python entry point: %s' % path)
    if 'unquote(' not in text:
        refuse('hook script does not decode URIENCODE()d argv (%s); pass %s'
               % ('unquote(', HOOK_NAME))


def check_config(path):
    """Warn when absent; refuse public/ambiguous files when present."""
    if not path.exists():
        return 'warning: hook config does not exist yet: %s (the hook fails closed)' % path
    if path.is_symlink():
        refuse('hook config must not be a symlink: %s' % path)
    if not path.is_file():
        refuse('hook config is not a regular file: %s' % path)
    if path.stat().st_mode & 0o007:
        refuse('hook config must not be world-readable/executable: %s' % path)
    return None


def context_bounds(lines):
    headers = [index for index, line in enumerate(lines)
               if HEADER_RE.match(line.rstrip('\r\n'))]
    matches = [index for index in headers
               if HEADER_RE.match(lines[index].rstrip('\r\n')).group(1) == CONTEXT]
    if not matches:
        refuse('dialplan has no [%s] context' % CONTEXT)
    if len(matches) > 1:
        refuse('dialplan has %d [%s] contexts; exactly one is required'
               % (len(matches), CONTEXT))
    start = matches[0] + 1
    end = next((index for index in headers if index > matches[0]), len(lines))
    return start, end


def newline_of(lines):
    for line in lines:
        if line.endswith('\r\n'):
            return '\r\n'
        if line.endswith('\n'):
            return '\n'
    return '\n'


def render(args, ending):
    return SYSTEM_TEMPLATE % {
        'config': str(args.config),
        'hook': str(args.hook_script),
        'callee': args.callee_var,
        'caller': args.caller_var,
        'name': args.name_var,
        'call_id': args.call_id_var,
    } + ending


def plan(text, args):
    lines = text.splitlines(keepends=True)
    start, end = context_bounds(lines)
    body = [line.rstrip('\r\n') for line in lines[start:end]]

    done = [index for index, line in enumerate(body) if DONE_RE.match(line)]
    if len(done) != 1:
        refuse('context [%s] must contain exactly one same=>n(done),Return() (found %d)'
               % (CONTEXT, len(done)))
    done_index = start + done[0]

    legacy = [index for index, line in enumerate(body)
              if LEGACY_DISPATCHER in line and LEGACY_ENDPOINT in line]
    if len(legacy) != 1:
        refuse('context [%s] must contain exactly one legacy dispatcher line (%s ... %s); found %d'
               % (CONTEXT, LEGACY_DISPATCHER, LEGACY_ENDPOINT, len(legacy)))

    if any(TENANT_ENDPOINT in line for line in body):
        refuse('context [%s] already references %s without the installer marker'
               % (CONTEXT, TENANT_ENDPOINT))

    ending = newline_of(lines[done_index:]) or newline_of(lines)
    system_line = render(args, ending)

    warnings = []
    marker_line = MARKER + ending
    markers = [index for index, line in enumerate(lines) if line.strip() == MARKER]
    if markers:
        if len(markers) != 1 or not start <= markers[0] < done_index:
            refuse('managed marker must occur once inside [%s] before Return()' % CONTEXT)
        # The marker identifies our own managed line. If it differs from the
        # canonical rendering (an older path, a renamed variable), it is
        # replaced instead of blocking the setup.
        marker_index = markers[0]
        action_index = None
        for index in range(marker_index + 1, done_index):
            stripped = lines[index].strip()
            if not stripped:
                continue
            if (re.match(r'^same\s*=>\s*n\s*,\s*System\(', stripped)
                    and 'SOKRAT_HOOK_CONFIG=' in stripped and '/usr/bin/python3' in stripped):
                action_index = index
            break
        if action_index is None:
            refuse('marker %r is present but no managed action follows it; refusing to guess'
                   % MARKER)
        if lines[action_index].rstrip('\r\n') == system_line.rstrip('\r\n'):
            return None, None, 'already installed (marker %r present)' % MARKER, []
        updated = list(lines)
        updated[action_index] = system_line
        return updated, action_index, 'replaced the managed action after marker %r' % MARKER, warnings
    if any(HOOK_NAME in line for line in body):
        refuse('context [%s] already references %s without the installer marker'
               % (CONTEXT, HOOK_NAME))

    context_text = '\n'.join(body)
    for label, value in (('callee', args.callee_var), ('caller', args.caller_var),
                         ('name', args.name_var), ('call id', args.call_id_var)):
        assigned = re.search(r'(?<![A-Za-z0-9_])' + re.escape(value) + r'\s*=', context_text)
        if '${%s}' % value not in context_text and not assigned:
            warnings.append('warning: %s variable ${%s} is not referenced inside [%s]; '
                            'confirm the mapping before applying'
                            % (label, value, CONTEXT))

    updated = (lines[:done_index] + [marker_line, system_line] + lines[done_index:])
    return updated, done_index, 'inserted one System() action before line %d' % (done_index + 1), warnings


def diff_text(path, before, after):
    return ''.join(difflib.unified_diff(before.splitlines(keepends=True),
                                        after.splitlines(keepends=True),
                                        fromfile=str(path), tofile=str(path), n=2))


def atomic_write(path, text, mode):
    original = path.stat()
    directory = path.parent
    tmp = directory / ('.%s.tmp-%d-%s' % (path.name, os.getpid(), secrets.token_hex(4)))
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            if os.geteuid() == 0:
                os.fchown(handle.fileno(), original.st_uid, original.st_gid)
            handle.write(text.encode('utf-8'))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description='Insert one additive tenant push hook into [%s].' % CONTEXT,
        epilog='Dry-run is the default; --apply writes a timestamped backup and never reloads Asterisk.')
    parser.add_argument('--dialplan-file', required=True,
                        help='existing Asterisk dialplan file containing [%s]' % CONTEXT)
    parser.add_argument('--hook-script', required=True,
                        help='absolute path to the installed %s runner' % HOOK_NAME)
    parser.add_argument('--config', required=True,
                        help='absolute path to the root-private hook config (SOKRAT_HOOK_CONFIG)')
    parser.add_argument('--apply', action='store_true',
                        help='write the change (requires root); default is dry-run')
    parser.add_argument('--dry-run', action='store_true',
                        help='render the change only (default)')
    parser.add_argument('--allow-unprivileged', action='store_true',
                        help='permit --apply without root for staging fixtures/tests only')
    parser.add_argument('--callee-var', default='CALLEE',
                        help='dialplan variable holding the callee extension (default CALLEE)')
    parser.add_argument('--caller-var', default='CALLER',
                        help='dialplan variable holding the caller number (default CALLER)')
    parser.add_argument('--name-var', default='CALLER_NAME',
                        help='dialplan variable holding the caller name (default CALLER_NAME)')
    parser.add_argument('--call-id-var', default='SOKRAT_CALL_ID',
                        help='dialplan variable holding the already-filtered call id (default SOKRAT_CALL_ID)')
    args = parser.parse_args(argv)
    if args.apply and args.dry_run:
        refuse('choose either --apply or --dry-run, not both')
    for label, value in (('--callee-var', args.callee_var), ('--caller-var', args.caller_var),
                         ('--name-var', args.name_var), ('--call-id-var', args.call_id_var)):
        if not VAR_RE.match(value):
            refuse('%s must be a plain dialplan variable name' % label)
    args.dialplan_file = validate_path('--dialplan-file', args.dialplan_file)
    args.hook_script = validate_path('--hook-script', args.hook_script)
    args.config = validate_path('--config', args.config)
    return args


def main(argv=None):
    args = parse_args(argv)
    apply = bool(args.apply)
    if apply and os.geteuid() != 0 and not args.allow_unprivileged:
        refuse('--apply requires root (use --allow-unprivileged only for staging fixtures)')

    text = read_dialplan(args.dialplan_file)
    check_hook_script(args.hook_script)
    warning = check_config(args.config)

    updated, done_index, summary, warnings = plan(text, args)
    warnings = ([warning] if warning else []) + warnings

    if updated is None:
        print('Tenant push hook: %s' % summary)
        print('Target: %s' % args.dialplan_file)
        print('No files were written. No Asterisk reload was performed.')
        return 0

    rendered = ''.join(updated)
    start, end = context_bounds(rendered.splitlines(keepends=True))
    context_lines = ''.join(rendered.splitlines(keepends=True)[start:end]).rstrip('\r\n')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = args.dialplan_file.with_name(args.dialplan_file.name + '.bak-tenant-push-' + stamp)

    for message in warnings:
        print(message, file=sys.stderr)

    print('Tenant push hook: %s' % summary)
    print('Target: %s' % args.dialplan_file)
    print('Backup: %s' % backup)
    print('Rendered [%s]:' % CONTEXT)
    print(context_lines)
    print('Diff:')
    print(diff_text(args.dialplan_file, text, rendered).rstrip('\n'))

    if not apply:
        print('Dry run: no files were written. No Asterisk reload was performed.')
        return 0

    if backup.exists():
        refuse('backup already exists: %s' % backup)
    mode = args.dialplan_file.stat().st_mode & 0o7777
    shutil.copy2(args.dialplan_file, backup)
    os.chmod(backup, mode)
    try:
        atomic_write(args.dialplan_file, rendered, mode)
    except BaseException:
        shutil.copy2(backup, args.dialplan_file)
        os.chmod(args.dialplan_file, mode)
        raise
    print('Applied. Backup written to %s' % backup)
    print('No Asterisk reload was performed; reload the dialplan manually after review.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Refusal as error:
        print('refused: %s' % error, file=sys.stderr)
        raise SystemExit(2)
    except OSError as error:
        print('error: %s' % error, file=sys.stderr)
        raise SystemExit(1)
