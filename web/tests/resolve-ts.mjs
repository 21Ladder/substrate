// Node-Loader-Hook: erlaubt Imports ohne Dateiendung (wie im Vite-Projekt).
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return await next(specifier + ".ts", context);
    } catch {
      /* weiter mit dem Original */
    }
  }
  return next(specifier, context);
}
