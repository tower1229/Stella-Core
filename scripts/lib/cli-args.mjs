export function parseRequiredArguments(values, required, usage) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(usage);
    result[key.slice(2)] = value;
  }
  for (const key of required) {
    if (!result[key]) throw new Error(`Missing --${key}`);
  }
  return result;
}
