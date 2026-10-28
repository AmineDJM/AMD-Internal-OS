"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Loader2, CheckCircle2, AlertCircle, X, UploadCloud, ChevronDown, ChevronUp, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { isRetryableHttpStatus, backoffMs } from "@/lib/regulatory/intelligence/upload/retry";
import { rememberUpload, forgetUpload, listPendingUploads } from "@/lib/regulatory/intelligence/upload/pending-store";
import { envoyerParties, EnvoiAnnule, debitLisible, resteLisible, type PlanClient } from "@/lib/storage/envoi-direct-client";
import { sansBloquer } from "@/lib/journal";

/**
 * GESTIONNAIRE D'ENVOIS GLOBAL — l'upload d'un dossier CTD tourne EN ARRIÈRE-PLAN : monté dans la
 * mise en page de l'app (persiste à travers la navigation), il continue pendant que l'utilisateur
 * travaille ailleurs. Une pastille flottante montre la progression partout. Moteur robuste :
 * envoi par parties EN PARALLÈLE, reprise, finalisation avec RETENTE (idempotente côté serveur).
 */

export interface UploadSummary { total: number; stored: number; blocked: number; suspicious: number; totalBytes: number }
export type UploadPhase = "uploading" | "processing" | "done" | "error" | "cancelled";
export interface UploadJob {
  dossierId: string; fileName: string; phase: UploadPhase; progress: number; error: string | null; summary: UploadSummary | null;
  /** Débit réel (octets/s) et temps restant — mesurés sur l'envoi direct au bucket. */
  debit?: number; resteS?: number | null;
  /** Envoi REPRIS après coupure : combien de parties étaient déjà dans le bucket. */
  reprise?: { recues: number; total: number } | null;
}

interface UploadContextValue {
  jobs: Record<string, UploadJob>;
  start: (dossierId: string, file: File) => void;
  dismiss: (dossierId: string) => void;
  /** Interrompt un envoi EN COURS et efface ce qui en est déjà arrivé côté serveur. */
  cancel: (dossierId: string) => void;
}

/** Sortie de boucle par annulation — ce n'est pas une erreur, on ne l'affiche pas comme telle. */
class UploadCancelled extends Error {
  constructor() { super("Envoi annulé."); }
}
const UploadContext = React.createContext<UploadContextValue | null>(null);

/** Accès au gestionnaire d'envois (démarrer un envoi, lire l'état de CE dossier). */
export function useCtdUpload(): UploadContextValue {
  const ctx = React.useContext(UploadContext);
  if (!ctx) throw new Error("useCtdUpload doit être utilisé dans <UploadProvider>.");
  return ctx;
}

const humanSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.ceil(n / 1024))} Ko`);

// ── Primitives réseau (identiques au moteur d'upload : progression réelle + retente) ────────────

function putPartXhr(
  url: string, body: ArrayBuffer | Blob, onLoaded: (loaded: number) => void, timeoutMs: number,
  contentType = "application/octet-stream",
  // Rend la requête INTERROMPABLE : sans cette prise, annuler n'arrêterait rien tant que la
  // tranche en vol (jusqu'à plusieurs Mo) n'aurait pas fini de monter.
  onOpen?: (xhr: XMLHttpRequest) => void,
  // Reçoit l'ETag renvoyé par le bucket — indispensable pour recoller un envoi multipart.
  onEtag?: (etag: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (contentType) xhr.setRequestHeader("content-type", contentType);
    xhr.timeout = timeoutMs;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onEtag) {
          // ⚠️ Lisible seulement si le bucket expose `ETag` en CORS (`ExposeHeaders: ETag`).
          // Sans lui, on ne peut pas recoller les parties — le message doit le dire, sinon on
          // cherche l'erreur du côté du réseau pendant des heures.
          const etag = xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag") ?? "";
          if (!etag) return reject(new Error("le stockage n'expose pas l'en-tête ETag (règle CORS « ExposeHeaders: ETag » manquante)"));
          onEtag(etag);
        }
        return resolve();
      }
      let msg = `code ${xhr.status}`;
      try { msg = JSON.parse(xhr.responseText)?.error ?? msg; } catch { /* corps non-JSON */ }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("réseau"));
    xhr.ontimeout = () => reject(new Error("délai dépassé"));
    xhr.onabort = () => reject(new UploadCancelled());
    onOpen?.(xhr);
    xhr.send(body);
  });
}

async function readJsonSafe<T extends { ok?: boolean; error?: string; retryable?: boolean }>(res: Response): Promise<T> {
  const text = await res.text().catch(sansBloquer("upload-manager.readJsonSafe.text", ""));
  if (!text) {
    return { ok: false, error: res.ok ? "Réponse vide du serveur — nouvelle tentative…" : `Serveur momentanément indisponible (code ${res.status}) — nouvelle tentative…`, retryable: true } as T;
  }
  try { return JSON.parse(text) as T; }
  catch { return { ok: false, error: `Réponse serveur illisible (code ${res.status}).`, retryable: true } as T; }
}

async function postJsonWithRetry<T extends { ok?: boolean; error?: string; retryable?: boolean }>(
  url: string, attempts = 6, body?: unknown,
): Promise<T> {
  let lastErr = "Échec réseau";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300_000);
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        method: "POST", signal: ctrl.signal,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    }
    catch { lastErr = "réseau"; }
    finally { clearTimeout(timer); }
    if (res) {
      const data = await readJsonSafe<T>(res);
      if (res.ok && (data.ok ?? true)) return data;
      const retryable = isRetryableHttpStatus(res.status) || data.retryable === true;
      if (!retryable) return data;
      lastErr = data.error ?? `code ${res.status}`;
    }
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }
  return { ok: false, error: `${lastErr} (après ${attempts} tentatives)` } as T;
}

// ────────────────────────────────────────────────────────────────────────────────────────────

export function UploadProvider({ children }: { children: React.ReactNode }) {
  // Rafraîchissements de fin d'envoi, en tâche de fond : `enCours` n'est lu nulle part — aucun geste n'est bloqué.
  const { rafraichir } = useRafraichir();
  const [jobs, setJobs] = React.useState<Record<string, UploadJob>>({});
  const jobsRef = React.useRef(jobs);
  jobsRef.current = jobs;
  const patch = React.useCallback((dossierId: string, p: Partial<UploadJob>) => {
    setJobs((j) => (j[dossierId] ? { ...j, [dossierId]: { ...j[dossierId], ...p } } : j));
  }, []);

  // ANNULATION — trois choses doivent arriver ensemble, sinon « annuler » ne fait qu'y ressembler :
  //  1. le DRAPEAU arrête les boucles (aucune nouvelle tranche ne part) ;
  //  2. les requêtes EN VOL sont avortées (sans quoi on attendrait la fin de la tranche courante,
  //     plusieurs Mo, voire du fichier entier en envoi direct au bucket) ;
  //  3. le SERVEUR oublie la session et SUPPRIME les tranches déjà reçues — c'est le « supprimer »
  //     de la demande, et c'est aussi ce qui évite de laisser des centaines de Mo en base.
  const cancelled = React.useRef(new Set<string>());
  const inflight = React.useRef(new Map<string, Set<XMLHttpRequest>>());
  const sessionOf = React.useRef(new Map<string, string>());
  /** Coupe-circuit des envois DIRECTS au bucket : avorte toutes les parties en vol d'un coup. */
  const aborts = React.useRef(new Map<string, AbortController>());

  /** Suit une requête le temps de son vol, pour pouvoir l'avorter. */
  const track = React.useCallback((dossierId: string, xhr: XMLHttpRequest) => {
    const set = inflight.current.get(dossierId) ?? new Set();
    set.add(xhr);
    inflight.current.set(dossierId, set);
    const forget = () => set.delete(xhr);
    xhr.addEventListener("loadend", forget);
  }, []);

  const runUpload = React.useCallback(async (dossierId: string, file: File) => {
    setJobs((j) => ({ ...j, [dossierId]: { dossierId, fileName: file.name, phase: "uploading", progress: 0, error: null, summary: null } }));
    const setProgress = (p: number) => patch(dossierId, { progress: p });
    // Un nouvel envoi repart d'une ardoise propre : une annulation précédente ne doit pas
    // interrompre celui-ci au premier tour de boucle.
    cancelled.current.delete(dossierId);
    inflight.current.set(dossierId, new Set());
    sessionOf.current.delete(dossierId);
    const stopped = () => cancelled.current.has(dossierId);
    const bailIfCancelled = () => { if (stopped()) throw new UploadCancelled(); };
    // Le fichier est mis en mémoire AVANT le premier octet envoyé : à partir d'ici, quitter
    // l'application ne coûte plus rien — l'envoi reprendra tout seul à la réouverture.
    void rememberUpload(dossierId, file);
    try {
      // OUVERTURE DE SESSION — la seule étape de l'envoi qui n'avait AUCUNE reprise.
      //
      // Une seule tentative, 30 s, et le moindre à-coup du serveur (une analyse qui monopolise la
      // base, un redéploiement, un réseau qui hoquette) devenait un échec sec : « serveur
      // injoignable ou trop lent ». Toutes les autres étapes réessaient depuis toujours ; celle-ci
      // le fait maintenant aussi, avec une attente croissante entre les tentatives. Le fichier
      // n'est pas encore parti : rejouer l'ouverture ne coûte rien et ne perd rien.
      const OPEN_ATTEMPTS = 4;
      let open: Response | null = null;
      let openErr = "";
      for (let attempt = 0; attempt < OPEN_ATTEMPTS && !open; attempt++) {
        const ctrl = new AbortController();
        const openTimer = setTimeout(() => ctrl.abort(), 45_000);
        try {
          const res = await fetch("/api/regulatory/intelligence/upload/session", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ dossierId, filename: file.name, totalBytes: file.size, contentType: file.type }),
            signal: ctrl.signal,
          });
          // 5xx = serveur occupé/redémarré → on retente. 4xx = refus motivé → on s'arrête pour
          // afficher la vraie raison (quota, droits, fichier non-ZIP) plutôt que « trop lent ».
          if (res.ok || !isRetryableHttpStatus(res.status)) open = res;
          else openErr = `serveur occupé (code ${res.status})`;
        } catch {
          openErr = "serveur injoignable ou trop lent";
        } finally { clearTimeout(openTimer); }
        if (!open && attempt < OPEN_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
      bailIfCancelled();
      if (!open) throw new Error(`Ouverture de session impossible : ${openErr} (${OPEN_ATTEMPTS} tentatives). Relancez le même fichier pour reprendre.`);
      const meta = await readJsonSafe<{ ok?: boolean; error?: string; mode?: string; uploadUrl?: string; sessionId?: string; partSize?: number; expectedParts?: number; receivedIndices?: number[]; concurrency?: number; plan?: PlanClient; resumed?: boolean }>(open);
      if (!open.ok || meta.error) throw new Error(meta.error ?? "Ouverture de session refusée.");
      // Dès qu'on la connaît : c'est elle que l'annulation ira faire effacer côté serveur.
      if (meta.sessionId) sessionOf.current.set(dossierId, meta.sessionId);

      // ── ENVOI DIRECT EN PLUSIEURS PARTIES, EN PARALLÈLE ──
      //
      // C'est le chemin le plus rapide qui existe pour ce fichier : les octets vont du navigateur
      // AU BUCKET, sans passer par l'application ni par Postgres, et plusieurs parties montent de
      // front. Un flux unique n'utilise qu'une fraction du débit disponible — sa fenêtre de
      // congestion met des dizaines de secondes à s'ouvrir et le moindre paquet perdu la divise.
      // Corollaire honnête : au-delà, c'est la bande passante MONTANTE du poste qui décide, et
      // aucune technologie ne la dépasse.
      if (meta.mode === "direct-multipart" && meta.plan && meta.sessionId) {
        const sessionId = meta.sessionId;
        const ctrl = new AbortController();
        aborts.current.set(dossierId, ctrl);
        // REPRISE : le serveur a reconnu le même fichier, et le bucket a déjà une partie des
        // octets. On le DIT — sinon une barre qui démarre à 60 % ressemble à un défaut.
        if (meta.resumed && meta.plan.recues.length > 0) patch(dossierId, { reprise: { recues: meta.plan.recues.length, total: meta.plan.nbParties } });

        /** Rouvrir la session = la REPRENDRE : le plan rendu ne porte que les parties manquantes. */
        const rouvrir = async (): Promise<PlanClient> => {
          const res = await fetch("/api/regulatory/intelligence/upload/session", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ dossierId, filename: file.name, totalBytes: file.size, contentType: file.type }),
          });
          const m = await readJsonSafe<{ ok?: boolean; error?: string; sessionId?: string; plan?: PlanClient }>(res);
          if (!res.ok || !m.plan || m.sessionId !== sessionId) throw new Error(m.error ?? "Reprise de l'envoi impossible.");
          return m.plan;
        };
        let dernier = 0;
        // Les empreintes des parties reçues par le navigateur — remises à la finalisation (secours d'un stockage
        // qui ne liste pas ses parties) et cumulées d'un envoi à la reprise.
        let etags: Record<number, string> = {};
        const envoyer = async (plan: PlanClient) => { etags = await envoyerParties({
          fichier: file, plan, signal: ctrl.signal, renouveler: rouvrir, etags,
          onProgres: (p) => {
            const t = Date.now();
            if (t - dernier < 250 && p.envoyes < p.total) return; // quatre rafraîchissements par seconde suffisent
            dernier = t;
            patch(dossierId, { progress: Math.min(99, Math.floor((p.envoyes / Math.max(1, p.total)) * 100)), debit: p.debit, resteS: p.resteS });
          },
        }); };

        const startedAt = Date.now();
        try {
          await envoyer(meta.plan);
          // FINALISATION. Si le bucket signale une partie manquante, on rouvre (reprise) et l'on
          // ne renvoie QU'ELLE — jamais le dossier entier.
          for (let essai = 0; ; essai++) {
            bailIfCancelled();
            patch(dossierId, { phase: "processing", progress: 100, debit: undefined, resteS: undefined });
            const data = await postJsonWithRetry<{ ok?: boolean; error?: string; summary?: UploadSummary; manquantes?: number[] }>(
              `/api/regulatory/intelligence/upload/direct/${sessionId}/finalize`, 45, { etags },
            );
            if (data.ok) {
              const seconds = (Date.now() - startedAt) / 1000;
              console.info(`[upload] ${(file.size / 1048576).toFixed(0)} Mo en ${seconds.toFixed(1)} s — ${(file.size / 1048576 / Math.max(seconds, 0.001)).toFixed(1)} Mo/s`);
              patch(dossierId, { phase: "done", summary: data.summary ?? null });
              void forgetUpload(dossierId);
              fetch("/api/regulatory/intelligence/process", { method: "POST" }).catch(sansBloquer("upload-manager.UploadProvider.fetch")).finally(() => rafraichir());
              rafraichir();
              return;
            }
            if (!data.manquantes?.length || essai >= 2) throw new Error(data.error ?? "Finalisation refusée.");
            patch(dossierId, { phase: "uploading" });
            await envoyer(await rouvrir());
          }
        } catch (e) {
          if (e instanceof EnvoiAnnule) throw new UploadCancelled();
          throw e;
        } finally {
          aborts.current.delete(dossierId);
        }
      }

      // Envoi DIRECT vers le bucket (si configuré).
      if (meta.mode === "direct" && meta.uploadUrl && meta.sessionId) {
        let ok = false, lastErr = "";
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          bailIfCancelled();
          try { await putPartXhr(meta.uploadUrl, file, (l) => setProgress(Math.min(99, Math.round((l / file.size) * 100))), 20 * 60_000, file.type || "application/zip", (x) => track(dossierId, x)); ok = true; }
          catch (e) {
            if (e instanceof UploadCancelled) throw e;
            lastErr = e instanceof Error ? e.message : "réseau"; setProgress(0); if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        if (!ok) throw new Error(`Envoi direct au bucket échoué (${lastErr}) — vérifiez la règle CORS et l'endpoint R2.`);
        setProgress(100);
        patch(dossierId, { phase: "processing" });
        const data = await postJsonWithRetry<{ ok?: boolean; error?: string; summary?: UploadSummary }>(`/api/regulatory/intelligence/upload/direct/${meta.sessionId}/finalize`, 45);
        if (!data.ok) throw new Error(data.error ?? "Finalisation refusée.");
        patch(dossierId, { phase: "done", summary: data.summary ?? null });
        void forgetUpload(dossierId); // terminé : plus rien à reprendre
        fetch("/api/regulatory/intelligence/process", { method: "POST" }).catch(sansBloquer("upload-manager.UploadProvider.fetch")).finally(() => rafraichir());
        rafraichir();
        return;
      }

      const { sessionId, partSize, expectedParts, receivedIndices, concurrency } = meta as { sessionId: string; partSize: number; expectedParts: number; receivedIndices?: number[]; concurrency?: number };
      const poolSize = Math.max(1, Math.min(concurrency ?? 3, expectedParts));
      const partBytes = (i: number) => (i < expectedParts - 1 ? partSize : file.size - partSize * (expectedParts - 1));
      const received = new Set<number>((receivedIndices ?? []).filter((i) => i >= 0 && i < expectedParts));
      const loaded = new Array<number>(expectedParts).fill(0);
      for (const i of received) loaded[i] = partBytes(i);
      // BARRE MONOTONE — elle ne recule JAMAIS.
      //
      // Une tranche qui échoue (onglet mis en arrière-plan, réseau qui hoquette) voit son compteur
      // remis à zéro puis renvoyée : la somme brute redescend, et l'utilisateur voit la barre
      // reculer de plusieurs pour cent — d'autant plus visible que les tranches sont grosses.
      // Reculer donne l'impression que le travail est perdu, alors qu'il est simplement rejoué.
      // On affiche donc le POINT LE PLUS AVANCÉ atteint : la barre marque une pause pendant la
      // reprise, puis repart — jamais en arrière.
      let shown = 0;
      const refresh = () => {
        const pct = Math.min(99, Math.round((loaded.reduce((a, b) => a + b, 0) / file.size) * 100));
        if (pct > shown) shown = pct;
        setProgress(shown);
      };
      refresh();

      let cursor = 0;
      let aborted = false;
      const MAX_ATTEMPTS = 6;
      const putPart = async (i: number): Promise<void> => {
        if (received.has(i)) { loaded[i] = partBytes(i); refresh(); return; }
        bailIfCancelled();
        const buf = await file.slice(i * partSize, Math.min((i + 1) * partSize, file.size)).arrayBuffer();
        let lastErr = "";
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          if (aborted) return;
          bailIfCancelled();
          try {
            await putPartXhr(`/api/regulatory/intelligence/upload/session/${sessionId}/part?index=${i}`, buf, (l) => { loaded[i] = l; refresh(); }, 90_000, "application/octet-stream", (x) => track(dossierId, x));
            loaded[i] = buf.byteLength; refresh(); return;
          } catch (e) {
            // Une annulation n'est pas un échec réseau : elle ne se retente pas.
            if (e instanceof UploadCancelled) throw e;
            loaded[i] = 0; refresh();
            lastErr = e instanceof Error ? e.message : "échec";
            if (!aborted && attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 16_000)));
          }
        }
        throw new Error(`Échec de la partie ${i + 1}/${expectedParts} (${lastErr}).`);
      };
      const worker = async (): Promise<void> => { while (!aborted && !stopped()) { const i = cursor++; if (i >= expectedParts) return; await putPart(i); } };
      try { await Promise.all(Array.from({ length: poolSize }, () => worker())); }
      catch (e) { aborted = true; throw e; }
      bailIfCancelled();
      setProgress(100);

      patch(dossierId, { phase: "processing" });
      // PATIENCE LONGUE : la finalisation d'un dossier de plusieurs centaines de Mo dure plusieurs
      // minutes côté serveur. Même si le proxy coupe la réponse (~100 s), le serveur CONTINUE le
      // travail (bail + battement de cœur) ; le client re-sonde (503 « en cours » → retente) jusqu'à
      // ~11 min et récupère le SUCCÈS idempotent (session COMPLETED → version + manifeste).
      const data = await postJsonWithRetry<{ ok?: boolean; error?: string; summary?: UploadSummary }>(`/api/regulatory/intelligence/upload/session/${sessionId}/finalize`, 45);
      if (!data.ok) throw new Error(data.error ?? "Finalisation refusée.");
      patch(dossierId, { phase: "done", summary: data.summary ?? null });
      void forgetUpload(dossierId); // terminé : plus rien à reprendre
      fetch("/api/regulatory/intelligence/process", { method: "POST" }).catch(sansBloquer("upload-manager.UploadProvider.fetch")).finally(() => rafraichir());
      rafraichir();
    } catch (e) {
      // Annulé À LA DEMANDE : ce n'est pas une panne, et surtout ce n'est pas « relancez pour
      // reprendre » — l'utilisateur vient précisément de dire qu'il ne voulait plus de cet envoi.
      if (e instanceof UploadCancelled) { patch(dossierId, { phase: "cancelled", progress: 0, error: null }); return; }
      patch(dossierId, { phase: "error", error: e instanceof Error ? `${e.message} Relancez le même fichier pour reprendre.` : "Échec du téléversement — relancez pour reprendre." });
    } finally {
      inflight.current.delete(dossierId);
    }
  }, [patch, rafraichir, track]);

  /**
   * ANNULER — arrêter POUR DE BON, pas seulement à l'écran.
   *
   * On coupe les requêtes en vol, on oublie le fichier mémorisé (sans quoi il repartirait tout
   * seul à la prochaine ouverture, ce qui est exactement le contraire de ce qui est demandé), et
   * on demande au serveur d'abandonner la session : ses tranches déjà reçues sont supprimées.
   */
  const cancel = React.useCallback((dossierId: string) => {
    cancelled.current.add(dossierId);
    for (const xhr of inflight.current.get(dossierId) ?? []) { try { xhr.abort(); } catch { /* déjà terminée */ } }
    inflight.current.delete(dossierId);
    aborts.current.get(dossierId)?.abort();
    aborts.current.delete(dossierId);
    void forgetUpload(dossierId);
    patch(dossierId, { phase: "cancelled", progress: 0, error: null });

    const sessionId = sessionOf.current.get(dossierId);
    sessionOf.current.delete(dossierId);
    // Rien à effacer si la session n'a jamais été ouverte ; sinon le ménage est le fait du
    // serveur, et son échec ne doit pas ré-afficher l'envoi comme s'il continuait (le ménage de
    // fond ramassera la session restée incomplète).
    if (sessionId) {
      void fetch(`/api/regulatory/intelligence/upload/session/${sessionId}`, { method: "DELETE" }).catch(sansBloquer("upload-manager.UploadProvider.fetch"));
    }
  }, [patch]);

  const start = React.useCallback((dossierId: string, file: File) => {
    if (!/\.zip$/i.test(file.name)) { setJobs((j) => ({ ...j, [dossierId]: { dossierId, fileName: file.name, phase: "error", progress: 0, error: "Le dossier CTD doit être un fichier ZIP (.zip).", summary: null } })); return; }
    const existing = jobsRef.current[dossierId];
    if (existing && (existing.phase === "uploading" || existing.phase === "processing")) return; // déjà en cours pour ce dossier
    void runUpload(dossierId, file);
  }, [runUpload]);

  const dismiss = React.useCallback((dossierId: string) => {
    void forgetUpload(dossierId); // écarté à la main : ne pas le reprendre au prochain démarrage
    setJobs((j) => { const n = { ...j }; delete n[dossierId]; return n; });
  }, []);

  /**
   * REPRISE AUTOMATIQUE AU DÉMARRAGE — « dès le premier %, je peux sortir jusqu'à la fin ».
   *
   * Un onglet fermé n'envoie plus d'octets : c'est une limite du navigateur, pas un réglage. Ce
   * qu'on garantit, c'est que RIEN N'EST PERDU et que personne ne recommence. Les parties déjà
   * reçues vivent côté serveur, le fichier vit dans IndexedDB : à la réouverture, l'envoi repart
   * seul là où il s'était arrêté, sans ressélectionner quoi que ce soit, et seules les parties
   * manquantes repassent sur le réseau.
   *
   * L'analyse, elle, ne dépend plus de rien : une fois les octets reçus, elle se poursuit côté
   * serveur même application fermée (battement autonome du planificateur).
   */
  const resumed = React.useRef(false);
  React.useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void (async () => {
      for (const p of await listPendingUploads()) {
        if (jobsRef.current[p.dossierId]) continue; // déjà en cours dans cet onglet
        void runUpload(p.dossierId, p.file);
      }
    })();
  }, [runUpload]);

  // Avertit avant de fermer/recharger l'onglet tant qu'un envoi est réellement en cours.
  React.useEffect(() => {
    const active: boolean = Object.values(jobs).some((j) => j.phase === "uploading" || j.phase === "processing");
    if (!active) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [jobs]);

  const value = React.useMemo(() => ({ jobs, start, dismiss, cancel }), [jobs, start, dismiss, cancel]);
  return (
    <UploadContext.Provider value={value}>
      {children}
      <UploadWidget />
    </UploadContext.Provider>
  );
}

// ── Pastille flottante globale (visible partout tant qu'un envoi n'est pas rejeté) ──────────────

function UploadWidget() {
  const { jobs, dismiss, cancel } = useCtdUpload();
  const [collapsed, setCollapsed] = React.useState(false);
  const list = Object.values(jobs);
  if (list.length === 0) return null;
  const active = list.filter((j) => j.phase === "uploading" || j.phase === "processing").length;

  // Au téléphone, EN HAUT : en bas, il recouvrait exactement la pastille des envois en arrière-plan (`background-upload`).
  return (
    <div className="fixed right-4 top-[calc(4.5rem+env(safe-area-inset-top))] z-40 w-[min(92vw,22rem)] sm:bottom-24 sm:top-auto">
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-left text-sm font-medium text-foreground"
        >
          <span className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-primary" />
            {active > 0 ? `Envoi en cours (${active})` : "Envois"}
          </span>
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {!collapsed && (
          <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto">
            {list.map((j) => (
              <li key={j.dossierId} className="px-3 py-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {j.phase === "uploading" || j.phase === "processing" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      : j.phase === "done" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                      : j.phase === "cancelled" ? <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                    <span className="truncate text-foreground" title={j.fileName}>{j.fileName}</span>
                  </span>
                  {/* ANNULER n'est proposé que TANT QUE LES OCTETS MONTENT. Passé en « inspection »,
                      l'archive est entièrement reçue et le serveur la dépouille : interrompre là
                      laisserait une version à moitié constituée — on ne le propose donc pas. */}
                  {j.phase === "uploading" && (
                    <button type="button" onClick={() => cancel(j.dossierId)}
                      className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-destructive sm:px-2 sm:py-0.5">
                      Annuler
                    </button>
                  )}
                  {(j.phase === "done" || j.phase === "error" || j.phase === "cancelled") && (
                    <button type="button" onClick={() => dismiss(j.dossierId)} className="shrink-0 rounded p-2 text-muted-foreground hover:bg-muted sm:p-0.5" aria-label="Masquer">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {(j.phase === "uploading" || j.phase === "processing") && (
                  <div className="mt-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{j.phase === "uploading" ? "Téléversement…" : "Inspection & extraction…"}</span>
                      {j.phase === "uploading" && <span>{j.progress}%</span>}
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: j.phase === "processing" ? "100%" : `${j.progress}%` }} />
                    </div>
                    {/* Le débit réel et le temps restant : sur un dossier de plusieurs Go, c'est ce
                        qui permet de décider d'attendre ou de fermer l'ordinateur (l'envoi reprendra). */}
                    {j.phase === "uploading" && j.debit !== undefined && (
                      <p className="mt-1 flex justify-between text-[0.6875rem] text-muted-foreground" aria-live="polite">
                        <span>{debitLisible(j.debit ?? 0)}</span>
                        <span>{resteLisible(j.resteS ?? null)}</span>
                      </p>
                    )}
                    {j.reprise && (
                      <p className="mt-1 text-[0.6875rem] text-muted-foreground">Envoi repris : {j.reprise.recues} partie·s sur {j.reprise.total} étaient déjà arrivées — elles ne repartent pas.</p>
                    )}
                  </div>
                )}
                {j.phase === "done" && j.summary && (
                  <p className="mt-1 text-xs text-success">Ingéré — {j.summary.stored} fichier·s conservé·s ({humanSize(j.summary.totalBytes)}){j.summary.blocked > 0 ? `, ${j.summary.blocked} non lu·s` : ""}.</p>
                )}
                {j.phase === "cancelled" && (
                  <p className="mt-1 text-xs text-muted-foreground">Envoi annulé — les tranches déjà reçues ont été supprimées. Relancez le fichier pour repartir de zéro.</p>
                )}
                {j.phase === "error" && j.error && <p className="mt-1 text-xs text-destructive">{j.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
