"use client";

import type { DirectSpec, EnqueueSpec } from "@/components/layout/background-upload";
import { dossierDeDestination } from "@/lib/regulatory/ctd-initiale";
import type { LimitesEnvoi } from "@/components/layout/use-limites-envoi";
import type { PlanClient } from "@/lib/storage/envoi-direct-client";
import { refusTeleversement } from "@/lib/files/politique-televersement";
import { refusSansStockageObjet } from "@/lib/storage/phrases-stockage";
import { LIMITE_FICHIER_MO } from "@/lib/storage/limites-blob";
import { sansBloquer } from "@/lib/journal";

/** Où va le document : les mêmes champs que le chemin habituel. */
export interface CibleDocumentClient {
  entityType: string;
  entityId: string;
  category: string;
  confidentiality: string;
  stepKey?: string | null;
  /** Le dépôt vient du bloc « CTD initiale » d'un dossier Regulatory (§118.213) — le serveur le juge. */
  ctd?: boolean;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(sansBloquer("envoi-document.json.json", {}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Le serveur a répondu ${res.status}.`);
  return body;
}

const MO = 1024 * 1024;

/**
 * Ce que les documents ajoutent à un envoi : le REFUS dit avant d'envoyer, et l'envoi DIRECT au
 * bucket pour les gros fichiers. Avec le stockage objet branché, la limite d'un fichier est celle
 * d'une personne (10 Go) — plus la limite du chemin « en mémoire » (≈ 250 Mo), qui faisait échouer
 * les ZIP de CTD. Sans limites lues (serveur muet), on n'empêche rien : le serveur reste la garde.
 */
export function envoiDocument(
  cible: CibleDocumentClient,
  limites: LimitesEnvoi | null,
  dossierDe: (f: File) => string | null,
): { refus?: (f: File) => string | null; direct?: (f: File) => DirectSpec | null } {
  if (!limites) return {};
  // Le chemin ordinaire garde sa borne ; le direct n'en a qu'une, celle d'une personne.
  const seuil = Math.min(limites.seuilDirectOctets, limites.maxUploadMb * MO);
  return {
    refus: (f) => {
      if (limites.stockageObjet) return refusTeleversement(f.name, f.size, LIMITE_FICHIER_MO);
      return refusTeleversement(f.name, f.size, limites.maxUploadMb)
        ?? (f.size > limites.maxSansStockageObjetMo * MO ? refusSansStockageObjet(f.size, limites.maxSansStockageObjetMo) : null);
    },
    direct: (f) => {
      if (!limites.stockageObjet || f.size < seuil) return null;
      return {
        ouvrir: async () => {
          try {
            const r = await json<{ sessionId: string; plan: PlanClient }>(await fetch("/api/documents/upload/direct", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified, ...cible, folder: dossierDe(f) }),
            }));
            return { sessionId: r.sessionId, plan: r.plan };
          } catch (e) { return { error: e instanceof Error ? e.message : "Ouverture impossible." }; }
        },
        replanifier: async (id) => (await json<{ plan: PlanClient }>(await fetch(`/api/documents/upload/direct/${id}`, { cache: "no-store" }))).plan,
        finaliser: async (id, etags) => {
          // Les empreintes reçues par le navigateur : la finalisation s'en sert si le stockage ne liste pas ses parties.
          const res = await fetch(`/api/documents/upload/direct/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ etags: etags ?? {} }) });
          const b = (await res.json().catch(sansBloquer("envoi-document.finaliser.json", {}))) as { ok?: boolean; error?: string; reprendre?: boolean };
          return res.ok && b.ok ? { ok: true as const } : { ok: false as const, error: b.error ?? `Finalisation refusée (${res.status}).`, reprendre: b.reprendre };
        },
        abandonner: async (id) => { await fetch(`/api/documents/upload/direct/${id}`, { method: "DELETE" }).catch(sansBloquer("envoi-document.abandonner.fetch")); },
      };
    },
  };
}

/**
 * LE LOT À CONFIER AU GESTIONNAIRE D'ENVOIS — UNE construction, pour tous les téléverseurs.
 *
 * Le téléverseur des documents et le dépôt de la CTD à la création d'un dossier construisaient chacun
 * leur requête ; la seconde copie aurait fini par oublier un champ (le dossier d'origine, la marque
 * CTD). Chaque fichier part avec son dossier : le dossier de DESTINATION choisi (« Compléments »), puis le
 * dossier d'origine du fichier déposé (« CTD/Module 1 ») — l'arborescence se garde sur la fiche.
 */
export function construireEnvoi(args: {
  cible: CibleDocumentClient;
  entrees: EntreeDepot[];
  limites: LimitesEnvoi | null;
  /** Le dossier de la CTD où poser le lot (« Compléments ») ; absent = la racine. */
  dossierBase?: string | null;
  onFileDone?: (file: File, body: Record<string, unknown>) => void;
}): EnqueueSpec {
  const { cible, entrees, limites } = args;
  const files = entrees.map((e) => e.file);
  const dossiers = new Map<File, string | null>(entrees.map((e) => [e.file, dossierDeDestination(args.dossierBase, dossierDuChemin(e.path))]));
  const envoi = envoiDocument(cible, limites, (f) => dossiers.get(f) ?? null);
  return {
    label: cible.ctd ? `CTD initiale — ${files.length} document${files.length > 1 ? "s" : ""}` : `${files.length} document${files.length > 1 ? "s" : ""}`,
    files,
    concurrency: 6,
    makeRequest: (file) => {
      const fd = new FormData();
      fd.set("entityType", cible.entityType);
      fd.set("entityId", cible.entityId);
      fd.set("category", cible.category);
      fd.set("confidentiality", cible.confidentiality);
      if (cible.stepKey) fd.set("stepKey", cible.stepKey);
      if (cible.ctd) fd.set("ctd", "1");
      const dossier = dossiers.get(file);
      if (dossier) fd.set("folder", dossier);
      fd.append("files", file, file.name);
      return { url: "/api/documents/upload", formData: fd };
    },
    refus: envoi.refus,
    direct: envoi.direct,
    onFileDone: args.onFileDone,
  };
}

/** Fichiers parasites que les systèmes posent dans un dossier : on ne les envoie pas. */
export const FICHIER_PARASITE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*)$/i;

export interface EntreeDepot { file: File; path: string }

/** Lit TOUT ce qu'on a déposé par glisser-déposer, dossiers compris (parcours récursif). */
export async function lireDepot(dt: DataTransfer): Promise<EntreeDepot[]> {
  const items = Array.from(dt.items ?? []);
  const entrees = items
    .map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);
  // Navigateur sans parcours de dossiers : on garde le comportement d'avant (les fichiers).
  if (entrees.length === 0) return Array.from(dt.files).map((file) => ({ file, path: file.name }));

  const sortie: EntreeDepot[] = [];
  const fichierDe = (e: FileSystemFileEntry) => new Promise<File>((ok, ko) => e.file(ok, ko));
  async function parcourir(e: FileSystemEntry, prefixe: string): Promise<void> {
    if (e.isFile) {
      const file = await fichierDe(e as FileSystemFileEntry);
      sortie.push({ file, path: `${prefixe}${e.name}` });
      return;
    }
    const lecteur = (e as FileSystemDirectoryEntry).createReader();
    // `readEntries` rend les entrées PAR LOTS (≈ 100) : il faut le rappeler jusqu'à ce qu'il rende vide.
    for (;;) {
      const lot = await new Promise<FileSystemEntry[]>((ok, ko) => lecteur.readEntries(ok, ko));
      if (lot.length === 0) break;
      for (const enfant of lot) await parcourir(enfant, `${prefixe}${e.name}/`);
    }
  }
  for (const e of entrees) await parcourir(e, "");
  return sortie;
}

/** Le dossier d'un chemin relatif (« CTD/Module 1/a.pdf » → « CTD/Module 1 »), ou `null` pour un fichier seul. */
export function dossierDuChemin(chemin: string): string | null {
  const i = chemin.lastIndexOf("/");
  return i > 0 ? chemin.slice(0, i) : null;
}
