import {
  createRoot,
  createMemo as _createMemo,
  untrack,
  getOwner,
  runWithOwner,
  createSignal,
  $TRACK,
  $PROXY,
  onCleanup,
  getListener,
  Owner,
  Accessor,
} from "solid-js";
import { $RAW } from "solid-js/store";
import { trueFn } from "@solid-primitives/utils";

export const [nMemos, setNMemos] = createSignal(0);

const log = (label: string, ...a: any[]) =>
  console.log("\x1b[90m%s\x1b[0m", `${label.toUpperCase()}|`, ...a);

const createMemo: typeof _createMemo = ((a: any, b: any, c: any) => {
  setNMemos(n => n + 1);
  onCleanup(() => setNMemos(n => n - 1));
  return _createMemo(a, b, c);
}) as any;

export type ImmutablePrimitive = string | number | boolean | null | undefined;
export type ImmutableObject = { [key: string]: ImmutableValue; id?: ImmutablePrimitive };
export type ImmutableArray = ImmutableValue[];
export type ImmutableValue = ImmutablePrimitive | ImmutableObject | ImmutableArray;

/**
 * Compares two arrays for immutable changes
 */
function arrayEquals(a: any[], b: any[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const aVal = a[i],
      bVal = b[i];
    if (
      aVal !== bVal &&
      (!aVal ||
        !bVal ||
        typeof aVal !== "object" ||
        typeof bVal !== "object" ||
        aVal.id !== bVal.id)
    )
      return false;
  }
  return true;
}

class CommonTraps<T extends ImmutableObject | ImmutableArray> implements ProxyHandler<T> {
  trackKeys?: Accessor<Array<string | symbol>>;
  owner: Owner;

  constructor(public source: Accessor<T>) {
    this.owner = createRoot(getOwner)!;
  }

  getSourceValue(property: PropertyKey) {
    const s = this.source() as any;
    return s && typeof s === "object" ? s[property] : undefined;
  }

  has(target: T, property: PropertyKey) {
    if (property === $RAW || property === $PROXY || property === $TRACK || property === "__proto__")
      return true;
    return property in this.source();
  }
  ownKeys(): Array<string | symbol> {
    if (getListener() && !this.trackKeys)
      runWithOwner(this.owner, () => {
        this.trackKeys = createMemo<Array<string | symbol>>(prev => {
          const keys = Reflect.ownKeys(this.source());
          return arrayEquals(keys, prev) ? prev : keys;
        }, []);
      });
    return this.trackKeys ? this.trackKeys() : Reflect.ownKeys(this.source());
  }
  set = trueFn;
  deleteProperty = trueFn;
}

type ObjectTrapsCached = { get: () => ImmutableValue; memo: boolean };
class ObjectTraps extends CommonTraps<ImmutableObject> implements ProxyHandler<ImmutableObject> {
  cache = new Map<PropertyKey, ObjectTrapsCached>();

  constructor(source: Accessor<ImmutableObject>) {
    super(source);
  }

  getCachedValue(cached: ObjectTrapsCached) {
    if (!cached.memo && getListener()) {
      cached.memo = true;
      cached.get = runWithOwner(this.owner, () => createMemo(cached.get))!;
    }
    return cached.get();
  }

  get(target: ImmutableObject, property: PropertyKey, receiver: unknown) {
    if (property === $RAW) return untrack(this.source);
    if (property === $PROXY || property === $TRACK) return receiver;
    if (property === Symbol.iterator) return undefined;
    if (property === "id") return untrack(this.source).id;

    let cached = this.cache.get(property);
    if (cached) return this.getCachedValue(cached);

    let id: ImmutableValue;
    let prevValue: ImmutableValue;
    let prevResult: ImmutableValue;

    cached = {
      get: () => {
        const v = this.getSourceValue(property);

        if (v === prevValue) return prevResult;
        prevValue = v;

        return untrack(() => {
          if (v && typeof v === "object") {
            if (v.id === id && prevResult) return prevResult;
            id = v.id;
            return (prevResult = wrap(v, () => this.getSourceValue(property)));
          }

          id = undefined;
          return (prevResult = v);
        });
      },
      memo: false,
    };
    this.cache.set(property, cached);
    return this.getCachedValue(cached);
  }
}

type ArrayTrapsCached = { get: () => ImmutableValue; dispose: VoidFunction | undefined };
class ArrayTraps extends CommonTraps<ImmutableArray> implements ProxyHandler<ImmutableArray> {
  #cache: ArrayTrapsCached[] = [];

  #trackLength: Accessor<number>;

  constructor(source: Accessor<ImmutableArray>) {
    super(source);

    this.#trackLength = runWithOwner(this.owner, () =>
      createMemo(p => {
        const { length } = this.source();

        if (length !== p) {
          for (let i = length; i < p; i++) this.#cache[i]!.dispose?.();
          this.#cache.length = length;
        }

        return length;
      }, 0),
    )!;
  }

  #trackItemsMemo?: Accessor<boolean>;
  #trackItems() {
    if (getListener()) {
      if (!this.#trackItemsMemo)
        runWithOwner(this.owner, () => {
          let prev: unknown[] = [];
          this.#trackItemsMemo = createMemo(
            () => {
              const arr = this.source();
              const prevArr = prev;
              prev = arr;
              return Array.isArray(arr) && arrayEquals(arr, prevArr);
            },
            true,
            { equals: (_, b) => b },
          );
        });
      this.#trackItemsMemo!();
    }
  }

  #getCachedValue(cached: ArrayTrapsCached) {
    if (!cached.dispose && getListener())
      createRoot(dispose => {
        cached.dispose = dispose;
        cached.get = createMemo(cached.get);
      }, this.owner);
    return cached.get();
  }

  get(target: ImmutableArray, property: PropertyKey, receiver: unknown) {
    log("GET", property);

    if (property === $RAW) return untrack(this.source);
    if (property === $PROXY) return receiver;
    if (property === $TRACK) {
      this.#trackItems();
      return receiver;
    }

    if (property === Symbol.iterator) {
      this.#trackItems();
      return untrack(this.source)[Symbol.iterator];
    }

    if (property === "length") return this.#trackLength();

    if (typeof property === "symbol") return this.getSourceValue(property);

    if (typeof property === "string") {
      const num = Number(property);
      if (num === num) property = num;
      else return this.getSourceValue(property);
    }

    if (property >= this.#trackLength()) return this.getSourceValue(property);

    const cached = this.#cache[property];
    if (cached) return this.#getCachedValue(cached);

    let id: ImmutableValue;
    let prevValue: ImmutableValue;
    let prevResult: ImmutableValue;

    return this.#getCachedValue(
      (this.#cache[property] = {
        get: () => {
          const v = this.getSourceValue(property);

          if (v === prevValue) return prevResult;
          prevValue = v;

          return untrack(() => {
            if (v && typeof v === "object") {
              if (v.id === id && prevResult) return prevResult;
              id = v.id;
              return (prevResult = wrap(v, () => this.getSourceValue(property)));
            }

            id = undefined;
            return (prevResult = v);
          });
        },
        dispose: undefined,
      }),
    );
  }
}

function wrap<T extends ImmutableObject | ImmutableArray>(source: T, sourceMemo: () => T): T {
  return new Proxy(
    source.constructor(),
    new (Array.isArray(source) ? ArrayTraps : ObjectTraps)(sourceMemo as any),
  );
}

export function createImmutable<T extends ImmutableObject | ImmutableArray>(source: () => T): T {
  return wrap(source(), createMemo(source));
}
