declare const BRAND: unique symbol;

/**
 * Nominal typing helper. `Brand<string, 'DomPath'>` is not assignable from a
 * plain string, so an id can never be confused with arbitrary text.
 */
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** Widen a branded value back to its base type. Deliberately explicit. */
export function unbrand<T, B extends string>(value: Brand<T, B>): T {
  return value as T;
}
