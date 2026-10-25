// Node 22 and 24 print "ExperimentalWarning: SQLite is an experimental feature" whenever
// node:sqlite is loaded, that is on every run of warifuri. quietSqliteWarning drops that
// one warning and lets every other warning through as before. It has to run before
// node:sqlite is loaded.

// Is this the experimental warning of node:sqlite? (warning, type) as process.emitWarning takes them.
export function isSqliteWarning(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
  const name = typeof warning === 'string' ? (type ?? 'Warning') : warning?.name;
  const message = typeof warning === 'string' ? warning : warning?.message;
  return name === 'ExperimentalWarning' && typeof message === 'string' && /^SQLite\b/.test(message);
}

export function quietSqliteWarning(proc = process) {
  const emit = proc.emitWarning;
  proc.emitWarning = function emitWarning(warning, ...rest) {
    if (isSqliteWarning(warning, rest[0])) return undefined;
    return emit.call(this, warning, ...rest);
  };
}
