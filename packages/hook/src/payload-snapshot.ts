/**
 * 为单个 handler 创建隔离快照，既不冻结 Engine 原对象，也不让并行 handler 共享可变引用。
 * Hook payload 按契约应为结构化数据；structuredClone 失败时只递归复制普通对象、数组与常用容器。
 */
export function cloneHookPayload<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return cloneHookValueFallback(value, new WeakMap<object, unknown>());
  }
}

export function immutableHookPayload<T>(payload: T): T {
  return freezeHookValue(cloneHookPayload(payload));
}

function cloneHookValueFallback<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== 'object') return value;

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(source, clone);
    for (const item of value) clone.push(cloneHookValueFallback(item, seen));
    return clone as T;
  }

  if (value instanceof Date) return new Date(value.getTime()) as T;

  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(source, clone);
    for (const [key, item] of value) {
      clone.set(
        cloneHookValueFallback(key, seen),
        cloneHookValueFallback(item, seen),
      );
    }
    return clone as T;
  }

  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(source, clone);
    for (const item of value) clone.add(cloneHookValueFallback(item, seen));
    return clone as T;
  }

  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (ArrayBuffer.isView(value)) {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(source, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) {
      descriptor.value = cloneHookValueFallback(descriptor.value, seen);
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

function freezeHookValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;

  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);

  if (value instanceof Map) {
    for (const [key, item] of value) {
      freezeHookValue(key, seen);
      freezeHookValue(item, seen);
    }
  } else if (value instanceof Set) {
    for (const item of value) freezeHookValue(item, seen);
  } else if (!ArrayBuffer.isView(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freezeHookValue(Reflect.get(value, key), seen);
    }
  }

  // 带元素的 TypedArray 在 Node.js 中不能 Object.freeze；它仍是 handler 私有克隆，不会形成竞态。
  if (!ArrayBuffer.isView(value)) Object.freeze(value);
  return value;
}
