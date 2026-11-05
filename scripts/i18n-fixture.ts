export function english(message: string, values: (string | number)[] = []): string {
  return message.replace(/\{(\d+)\}/g, (match, i) => values[Number(i)] === undefined ? match : String(values[Number(i)]));
}
