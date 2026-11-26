'use strict';

const path = require('node:path');
const { spawnSync: spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

// Fail outside Exception handlers: a swallowed transport failure must not let a
// purported unit test silently query/restart the host PBX or write its database.
const prelude = `
import sys, os, socket, subprocess, builtins, fcntl
sys.path.insert(0, ${JSON.stringify(root)})
class OfflineViolation(BaseException): pass
def forbidden(*args, **kwargs):
    raise OfflineViolation('offline test reached an unmocked external boundary')
subprocess.Popen = forbidden
os.system = forbidden
socket.socket.connect = forbidden
socket.socket.connect_ex = forbidden
fcntl.ioctl = forbidden
_real_open, _real_os_open = builtins.open, os.open
def protected(p):
    return isinstance(p, (str, bytes)) and os.fsdecode(p).startswith(('/dev/', '/sys/', '/proc/'))
def safe_open(p, *a, **kw):
    if protected(p): forbidden()
    return _real_open(p, *a, **kw)
def safe_os_open(p, *a, **kw):
    if protected(p): forbidden()
    return _real_os_open(p, *a, **kw)
builtins.open, os.open = safe_open, safe_os_open
from laya.sensors import db as offline_db
offline_db.pymysql.connect = forbidden
class EmptyCursor:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def execute(self, query, *args):
        if not query.lstrip().upper().startswith('SELECT '): forbidden()
    def fetchall(self): return []
    def fetchone(self): return None
class EmptyConnection:
    def cursor(self): return EmptyCursor()
    def close(self): pass
offline_db.get_connection = lambda: EmptyConnection()
`;

function spawnSync(program, args, options = {}) {
    if (program !== 'python3') throw new Error('Laya offline runner only accepts Python');
    let code;
    if (args[0] === '-c') code = args[1];
    else {
        // Exercise the actual parser, but never its daemon IPC transport.
        code = `import laya.cli as cli\ncli.send_ipc_command = lambda *a, **k: (False, {})\nsys.argv = ${JSON.stringify(args)}\ncli.main()\n`;
    }
    return spawn(program, ['-c', prelude + '\n' + code], { ...options, timeout: 15000 });
}
module.exports = { spawnSync, prelude };
