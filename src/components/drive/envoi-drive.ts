"use client";

import type { BilanEnvoi, DirectSpec, EnqueueSpec } from "@/components/layout/background-upload";
import type { LimitesEnvoi } from "@/components/layout/use-limites-envoi";
import type { PlanClient } from "@/lib/storage/envoi-direct-client";
import { refusTeleversement } from "@/lib/files/politique-televersement";
import { refusSansStockageObjet } from "@/lib/storage/phrases-stockage";
import { fingerprintFile } from "@/lib/drive/fingerprint";
import { sansBloquer } from "@/lib/journal";

/** Où va le fichier dans le Drive — les mêmes champs que le chemin habituel. */
export interface CibleDrive {
  nodeId?: string | null;
  parentId?: string | null;
  spaceId?: string | null;
  category?: string | null;
  viewers?: string[];
  editors?: string[];
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(sansBloquer("envoi-drive.json.json", {}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Le serveur a répondu ${res.status}.`);
  return body;
}

/**
 * Ce que le Drive ajoute à un envoi : le REFUS dit avant d'envoyer (type, taille, et la phrase
 * qui nomme les variables à poser quand un très gros fichier n'a nulle part où aller), et l'envoi
 * DIRECT au bucket au-delà du seuil. Sans limites (serveur muet), on n'empêche rien : le serveur
 * reste la garde.
 */
export function envoiDrive(cible: CibleDrive, limites: LimitesEnvoi | null): { refus?: (f: File) => string | null; direct?: (f: File) => DirectSpec | null } {
  if (!limites) return {};
  return {
    refus: (f) => refusTeleversement(f.name, f.size, limites.maxDriveUploadMb)
      ?? (!limites.stockageObjet && f.size > limites.maxSansStockageObjetMo * 1024 * 1024
        ? refusSansStockageObjet(f.size, limites.maxSansStockageObjetMo) : null),
    direct: (f) => {
      if (!limites.stockageObjet || f.size < limites.seuilDirectOctets) return null;
      return {
        ouvrir: async () => {
          try {
            const r = await json<{ sessionId: string; plan: PlanClient }>(await fetch("/api/drive/upload/direct", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified, ...cible }),
            }));
            return { sessionId: r.sessionId, plan: r.plan };
          } catch (e) { return { error: e instanceof Error ? e.message : "Ouverture impossible." }; }
        },
        replanifier: async (id) => (await json<{ plan: PlanClient }>(await fetch(`/api/drive/upload/direct/${id}`, { cache: "no-store" }))).plan,
        finaliser: async (id, etags) => {
          // Les empreintes reçues par le navigateur : la finalisation s'en sert si le stockage ne liste pas ses parties.
          const res = await fetch(`/api/drive/upload/direct/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ etags: etags ?? {} }) });
          const b = (await res.json().catch(sansBloquer("envoi-drive.finaliser.json", {}))) as { ok?: boolean; error?: string; reprendre?: boolean; id?: string };
          // Le corps (avec l'id du nœud créé) remonte à `onFileDone`, comme sur le chemin habituel.
          return res.ok && b.ok ? { ok: true as const, body: b as Record<string, unknown> } : { ok: false as const, error: b.error ?? `Finalisation refusée (${res.status}).`, reprendre: b.reprendre };
        },
        abandonner: async (id) => { await fetch(`/api/drive/upload/direct/${id}`, { method: "DELETE" }).catch(sansBloquer("envoi-drive.abandonner.fetch")); },
      };
    },
  };
}

/**
 * ENVOI INSTANTANÉ QUAND LE CONTENU EST DÉJÀ LÀ.
 *
 * On calcule l'empreinte du fichier dans le navigateur et on la présente au serveur : s'il connaît
 * déjà ce contenu (et que la personne peut déjà le voir), le fichier est créé sans qu'un seul octet
 * ne parte. Redéposer un dossier dont 90 % existe déjà devient immédiat au lieu de retransférer.
 *
 * Rend `false` au moindre doute — un fichier trop petit ou trop gros pour être empreint, un serveur
 * qui ne répond pas : on retombe simplement sur l'envoi normal. Connu, rend le corps du serveur
 * (`{ known, id }`), que le gestionnaire d'envois remet à `onFileDone`.
 */
export function preflightDrive(target: { parentId?: string | null; spaceId?: string | null; category?: string; viewers?: string[]; editors?: string[] }) {
  return async (file: File): Promise<false | Record<string, unknown>> => {
    const sha256 = await fingerprintFile(file);
    if (!sha256) return false;
    const res = await fetch("/api/drive/upload/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256, name: file.name, size: file.size, ...target }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { known?: boolean } & Record<string, unknown>;
    return body.known ? body : false;
  };
}

/** Le dossier d'un chemin relatif (« A/B/c.pdf » → « A/B »), ou « » pour un fichier seul. */
export const dossierDuCheminDrive = (p: string) => { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(0, i) : ""; };

/**
 * IMPORT D'UNE ARBORESCENCE DANS LE DRIVE — le lot confié au gestionnaire d'envois.
 *
 * Une seule construction pour l'import de dossier du Drive ET le dépôt de la messagerie (Direction,
 * 06/10 : « avec les exactes et mêmes performances ») : six fichiers en parallèle, refus dit avant
 * d'envoyer, envoi direct au bucket au-delà du seuil, contenu déjà connu non retransféré — et chaque
 * fichier dans SON dossier (`map`, rendu par la création de l'arborescence côté serveur).
 */
export function envoiArborescenceDrive(args: {
  label: string;
  entrees: { file: File; path: string }[];
  /** Chemin relatif d'un dossier → id du dossier créé. */
  map: Record<string, string>;
  /** Où vont les fichiers posés à la racine de la sélection. */
  parentId: string | null;
  spaceId?: string | null;
  limites: LimitesEnvoi | null;
  onFileDone?: (file: File, body: Record<string, unknown>) => void;
  onJobStart?: () => void;
  onJobDone?: (bilan: BilanEnvoi) => void;
}): EnqueueSpec {
  const { map, parentId, limites } = args;
  const spaceId = args.spaceId ?? null;
  const chemins = new Map<File, string>(args.entrees.map((e) => [e.file, e.path]));
  // Le dossier de destination dépend du fichier.
  const pidDe = (file: File): string | null => {
    const dir = dossierDuCheminDrive(chemins.get(file) ?? file.name);
    return dir ? (map[dir] ?? parentId) : parentId;
  };
  return {
    label: args.label,
    files: args.entrees.map((e) => e.file),
    concurrency: 6,
    refus: envoiDrive({}, limites).refus,
    // L'envoi direct reçoit sa destination fichier par fichier.
    direct: (file) => {
      const pid = pidDe(file);
      return envoiDrive({ parentId: pid, spaceId: pid ? null : spaceId }, limites).direct?.(file) ?? null;
    },
    // Réimporter un dossier déjà déposé : la quasi-totalité des fichiers est reconnue et n'est pas
    // retransférée. C'est le cas où le gain se compte en minutes.
    preflight: async (file) => {
      const pid = pidDe(file);
      return preflightDrive({ parentId: pid, spaceId: pid ? null : spaceId })(file);
    },
    makeRequest: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      const pid = pidDe(file);
      if (pid) fd.append("parentId", pid);
      else if (spaceId) fd.append("spaceId", spaceId);
      return { url: "/api/drive/upload", formData: fd };
    },
    onFileDone: args.onFileDone,
    onJobStart: args.onJobStart,
    onJobDone: args.onJobDone,
  };
}
