/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Nur im Debug-Build gesetzt: enthält den automatischen Oberflächentest. */
  readonly VITE_SELFTEST?: string;
}
