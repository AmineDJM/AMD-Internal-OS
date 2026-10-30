"use client";

import type { ElementFile, StockageFile } from "@/modules/assistant-ia/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE HORS LIGNE, DANS LE TÉLÉPHONE (lot J13, décision 0025) — IndexedDB, deux magasins :
 *
 *   • `file`     : l'état de chaque élément (la règle pure `file-hors-ligne.ts` le fait avancer) ;
 *   • `contenus` : l'audio ou l'image elle-même, et ce qu'il faut pour l'envoyer.
 *
 * Écrits ENSEMBLE à la capture (une transaction) : un élément sans contenu ne peut pas exister. Retirés ensemble, et
 * seulement sur l'accusé du serveur (`viderFile`). IndexedDB survit à la fermeture de l'onglet et au redémarrage du
 * téléphone ; sans IndexedDB (navigation privée ancienne), la file vit en mémoire et l'écran le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ContenuFile {
  id: string;
  fichier: Blob;
  nom: string;
  sorte: "vocal" | "photo";
  dureeS?: number | null;
  sortePhoto?: string | null;
}

const BASE = "amd-terrain";
const VERSION = 1;

function ouvrir(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(BASE, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("file")) db.createObjectStore("file", { keyPath: "id" });
      if (!db.objectStoreNames.contains("contenus")) db.createObjectStore("contenus", { keyPath: "id" });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

const fin = (t: IDBTransaction) => new Promise<void>((ok, ko) => { t.oncomplete = () => ok(); t.onerror = () => ko(t.error); t.onabort = () => ko(t.error); });
const requete = <T,>(r: IDBRequest<T>) => new Promise<T>((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });

export interface FileLocale extends StockageFile {
  persistante: boolean;
  ajouter(e: ElementFile, c: ContenuFile): Promise<void>;
  contenu(id: string): Promise<ContenuFile | null>;
}

export async function ouvrirFileLocale(): Promise<FileLocale> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("absente");
    const db = await ouvrir();
    return {
      persistante: true,
      async lister() { return requete(db.transaction("file").objectStore("file").getAll() as IDBRequest<ElementFile[]>); },
      async ecrire(e) { const t = db.transaction("file", "readwrite"); t.objectStore("file").put(e); await fin(t); },
      async retirer(id) { const t = db.transaction(["file", "contenus"], "readwrite"); t.objectStore("file").delete(id); t.objectStore("contenus").delete(id); await fin(t); },
      async ajouter(e, c) { const t = db.transaction(["file", "contenus"], "readwrite"); t.objectStore("file").put(e); t.objectStore("contenus").put(c); await fin(t); },
      async contenu(id) { return (await requete(db.transaction("contenus").objectStore("contenus").get(id) as IDBRequest<ContenuFile | undefined>)) ?? null; },
    };
  } catch {
    const file = new Map<string, ElementFile>();
    const contenus = new Map<string, ContenuFile>();
    return {
      persistante: false,
      lister: async () => [...file.values()],
      ecrire: async (e) => { file.set(e.id, e); },
      retirer: async (id) => { file.delete(id); contenus.delete(id); },
      ajouter: async (e, c) => { file.set(e.id, e); contenus.set(e.id, c); },
      contenu: async (id) => contenus.get(id) ?? null,
    };
  }
}

/** Une clé d'idempotence tirée à la capture (la même à chaque renvoi). */
export const nouvelleCle = (): string =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9_-]/g, "");
