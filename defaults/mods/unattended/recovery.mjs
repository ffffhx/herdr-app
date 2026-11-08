// Follow only an exact local terminal identity. Keep earlier journals reachable.
export function recoveredEntry(entry, state, records) {
  if (entry.on || !state?.native || !state.terminal || !state.sourceCreated) return entry;
  const record = records.find(r => r.terminal === state.terminal && r.created === state.sourceCreated && r.agent === entry.agent && r.state === "ready");
  if (!record?.unattendedControl?.match(/[\\/]control\.json$/)) return entry;
  const directory = record.unattendedControl.replace(/[\\/]control\.json$/, "");
  if (directory.replaceAll("\\", "/") === entry.directory.replaceAll("\\", "/")) return entry;
  return { ...entry, directory, previousDirectories: [...(entry.previousDirectories || []), entry.directory] };
}
