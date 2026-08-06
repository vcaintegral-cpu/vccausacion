import { useSyncExternalStore } from "react";

const KEY = "causacion.empresa";
const LOCK_KEY = "causacion.empresa.bloqueada";
const listeners = new Set<() => void>();
let value: string | null = null;
let hydrated = false;

function ensure() {
  if (!hydrated && typeof window !== "undefined") {
    value = window.localStorage.getItem(KEY);
    hydrated = true;
  }
}

export function setActiveCompany(id: string | null) {
  value = id;
  hydrated = true;
  if (typeof window !== "undefined") {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  }
  listeners.forEach((l) => l());
}

export function setCompanyLocked(locked: boolean) {
  if (typeof window === "undefined") return;
  if (locked) window.localStorage.setItem(LOCK_KEY, "1");
  else window.localStorage.removeItem(LOCK_KEY);
  listeners.forEach((l) => l());
}

export function useCompanyLocked(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (typeof window !== "undefined" ? window.localStorage.getItem(LOCK_KEY) === "1" : false),
    () => false,
  );
}

export function useActiveCompany(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => {
      ensure();
      return value;
    },
    () => null,
  );
}