function hasUsableLocalStorage(value: unknown): value is Storage {
  const maybeStorage = value as Partial<Storage> | undefined;
  return Boolean(
    maybeStorage &&
      typeof maybeStorage.getItem === 'function' &&
      typeof maybeStorage.setItem === 'function' &&
      typeof maybeStorage.removeItem === 'function' &&
      typeof maybeStorage.clear === 'function',
  );
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function readLocalStorage(target: { localStorage?: Storage }): Storage | undefined {
  try {
    return target.localStorage;
  } catch {
    return undefined;
  }
}

function installLocalStorage(target: { localStorage?: Storage }, storage: Storage) {
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
}

const globalStorage = readLocalStorage(globalThis);
const storage = hasUsableLocalStorage(globalStorage) ? globalStorage : createMemoryStorage();

if (!hasUsableLocalStorage(globalStorage)) {
  installLocalStorage(globalThis, storage);
}

if (typeof window !== 'undefined') {
  const windowStorage = readLocalStorage(window);
  if (!hasUsableLocalStorage(windowStorage)) {
    installLocalStorage(window, storage);
  }
}
