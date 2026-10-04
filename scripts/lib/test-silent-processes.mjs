/** Test-only Windows console suppression, including command-line grandchildren.
 * This preload preserves explicit child data directories; callers isolate those before spawning.
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

if (process.platform === 'win32') {
  const directive = `--import=${import.meta.url}`;
  if (!(process.env.NODE_OPTIONS || '').includes(directive)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, directive].filter(Boolean).join(' ');
  }
  const hidden = options => ({ ...(options || {}), windowsHide: true });
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function (file, args, options, callback) {
      if (Array.isArray(args)) {
        if (typeof options === 'function') return original.call(this, file, args, hidden(), options);
        return original.call(this, file, args, hidden(options), callback);
      }
      if (typeof args === 'function') return original.call(this, file, hidden(), args);
      return original.call(this, file, hidden(args), options);
    };
  }
  for (const name of ['exec', 'execSync']) {
    const original = childProcess[name];
    childProcess[name] = function (command, options, callback) {
      if (typeof options === 'function') return original.call(this, command, hidden(), options);
      return original.call(this, command, hidden(options), callback);
    };
  }
  syncBuiltinESMExports();
}
