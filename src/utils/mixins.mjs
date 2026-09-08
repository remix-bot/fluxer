/**
 * @module src/utils/mixins
 * @description Minimal mixin helper used to split large classes across
 * multiple files while keeping a single runtime class and public API.
 */

/**
 * Copy the methods of each mixin onto the target class prototype.
 *
 * Use this when a class has grown across many concerns (playback, search,
 * display, …): define each concern as a plain object of methods in its own
 * module and apply them onto the class. All methods share the same `this`,
 * so behaviour is identical to a single-file class.
 *
 * Rules:
 * - Methods defined directly on the base class always win (never overridden).
 * - Later mixins override earlier mixins for the same method name.
 *
 * @param {Function} target - The base class to extend.
 * @param {...object} mixins - Objects of instance methods.
 * @returns {Function} The target class (for chaining).
 */
export function applyMixins(target, ...mixins) {
  const baseOwned = new Set(Object.getOwnPropertyNames(target.prototype));
  for (const mixin of mixins) {
    for (const [name, value] of Object.entries(mixin)) {
      if (typeof value !== "function") continue;
      if (baseOwned.has(name)) continue;
      target.prototype[name] = value;
    }
  }
  return target;
}
