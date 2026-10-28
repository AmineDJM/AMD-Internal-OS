"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, Loader2, CheckCircle2, AlertCircle, X, ChevronDown, Ban } from "lucide-react";
import {
  envoyerParties, EnvoiAnnule, Debitmetre, debitLisible, resteLisible, type PlanClient,
} from "@/lib/storage/envoi-direct-client";
import { sansBloquer } from "@/lib/journal";

/**
 * GESTIONNAIRE D'ENVOIS GÉNÉRIQUE, GLOBAL — n'importe quel téléversement de la plateforme
 * (Documents, Drive, …) est confié à ce provider, monté dans la mise en page de l'app. L'envoi
 * continue EN ARRIÈRE-PLAN : l'utilisateur peut changer de module, naviguer, travailler ailleurs
 * — les fichiers montent en parallèle et une pastille flottante montre la progression partout.
 * Chaque fichier est un POST indépendant avec progression réelle (XHR) et RETENTE (réseau / 5xx /
 * 429 avec backoff). À la fin d'un lot, la vue courante est rafraîchie.
 *
 * (Le dossier CTD garde son propre moteur résumable par parties — voir upload-manager.tsx.)
 */

type FileStatus = "pending" | "checking" | "uploading" | "done" | "error" | "cancelled";
/** Un message de REFUS (droit, type, catégorie, taille) — par opposition à une coupure réseau qu'une relance répare. */
function estUnRefus(message: string): boolean {
  return /autoris|catégorie|type de fichier|trop volumineux|choisissez|mot de passe|interdit|refus/i.test(message);
}

interface BgFile {
  name: string; size: number; status: FileStatus; progress: number; error?: string; direct?: boolean;
  /** Un REFUS (droit, type de fichier, catégorie) : le renvoyer tel quel donnerait le même refus — « Réessayer » ne sert à rien. */
  definitif?: boolean;
}
interface BgJob {
  id: string; label: string; files: BgFile[]; phase: "uploading" | "done" | "error" | "cancelled"; spec: EnqueueSpec;
  /** Diagnostic du serveur sur l'envoi le plus lent du lot — affiché quand ça traîne. */
  slowest?: { name: string; line: string };
  /** Débit mesuré (octets/s) et temps restant estimé — ce que la personne attend de savoir. */
  debit?: number;
  resteS?: number | null;
}

/**
 * ENVOI DIRECT AU BUCKET d'un gros fichier : le serveur ouvre, signe, finalise ; les octets vont
 * du navigateur au stockage, en parties parallèles, et une coupure ne coûte que les parties
 * manquantes (le serveur reconnaît le même fichier et rend ce que le bucket a déjà).
 */
export interface DirectSpec {
  ouvrir: () => Promise<{ sessionId: string; plan: PlanClient } | { error: string }>;
  replanifier: (sessionId: string) => Promise<PlanClient>;
  /** `body` : ce que le serveur a créé (l'id du nœud…), remis à `onFileDone` comme sur le chemin habituel. */
  finaliser: (sessionId: string, etags?: Record<number, string>) => Promise<{ ok: true; body?: Record<string, unknown> } | { ok: false; error: string; reprendre?: boolean }>;
  abandonner: (sessionId: string) => Promise<void>;
}

/** Spécification d'un envoi : un libellé, des fichiers, et comment poster CHAQUE fichier. */
export interface EnqueueSpec {
  label: string;
  files: File[];
  /** Construit la requête (URL + FormData) pour un fichier donné. */
  makeRequest: (file: File) => { url: string; formData: FormData };
  concurrency?: number;
  /**
   * ESSAI SANS TRANSFERT, avant d'envoyer les octets.
   *
   * Rend `true` quand le fichier est déjà en place côté serveur — le POST est alors purement et
   * simplement sauté. C'est ce qui rend instantané le redépôt d'une arborescence dont l'essentiel
   * existe déjà. Toute erreur ici est ignorée : c'est une optimisation, elle ne doit jamais faire
   * échouer un envoi.
   */
  preflight?: (file: File) => Promise<boolean | Record<string, unknown>>;
  /**
   * Après le dépôt RÉUSSI d'un fichier, avec le corps de la réponse du serveur — ce qu'il a créé.
   * Une erreur ici est avalée : l'envoi a eu lieu, un écran qui n'écoute plus ne le défait pas.
   * Appelé sur LES TROIS chemins : envoi habituel, envoi direct au bucket (corps de la finalisation),
   * contenu déjà connu (corps de l'essai, `{}` s'il n'a rendu que `true`).
   */
  onFileDone?: (file: File, body: Record<string, unknown>) => void;
  /** Le lot (re)démarre — à l'envoi, puis à chaque « Réessayer ». */
  onJobStart?: () => void;
  /** Le lot est terminé (ou annulé) : le compte de TOUS ses fichiers, pour l'écran qui attend la fin. */
  onJobDone?: (bilan: BilanEnvoi) => void;
  /**
   * REFUS AVANT L'ENVOI (audit du 04/10, constat 11) : type interdit ou taille au-delà de la
   * limite se disent tout de suite, avec la phrase du serveur — pas après avoir envoyé 300 Mo
   * pour recevoir « Body exceeded ».
   */
  refus?: (file: File) => string | null;
  /** Envoi DIRECT au bucket pour ce fichier (gros fichier, stockage objet branché), ou `null`. */
  direct?: (file: File) => DirectSpec | null;
}

/** Le compte d'un lot à sa fin. */
export interface BilanEnvoi { total: number; recus: number; echecs: number; annules: number; annule: boolean }

interface Ctx { enqueue: (spec: EnqueueSpec) => void }

/** Sortie de boucle par annulation — ce n'est pas une erreur, on ne l'affiche pas comme telle. */
class BgCancelled extends Error {
  constructor() { super("Envoi annulé."); }
}
const BgUploadContext = React.createContext<Ctx | null>(null);

/** Accès au gestionnaire d'envois générique (démarrer un envoi en arrière-plan). */
export function useBackgroundUpload(): Ctx {
  const ctx = React.useContext(BgUploadContext);
  if (!ctx) throw new Error("useBackgroundUpload doit être utilisé dans <BackgroundUploadProvider>.");
  return ctx;
}

const humanSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.ceil(n / 1024))} Ko`);

/** Au-delà, un envoi mérite une explication plutôt qu'une barre qui avance en silence. */
const SLOW_MS = 3000;

/**
 * POST d'un FormData avec progression d'upload réelle ; ne rejette jamais — SAUF sur annulation,
 * qui doit se distinguer d'un échec réseau (un échec se retente, une annulation non).
 *
 * `onOpen` rend la requête interruptible : sans cette prise, annuler n'arrêterait rien tant que le
 * fichier en vol n'aurait pas fini de monter.
 */
function postFormXhr(
  url: string, formData: FormData, onProgress: (frac: number) => void, timeoutMs: number,
  onOpen?: (xhr: XMLHttpRequest) => void,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* corps non-JSON */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, body: {} });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, body: {} });
    xhr.onabort = () => reject(new BgCancelled());
    onOpen?.(xhr);
    xhr.send(formData);
  });
}

export function BackgroundUploadProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [jobs, setJobs] = React.useState<BgJob[]>([]);
  // L'état de chaque fichier, tenu AUSSI hors de React : le bilan de fin de lot (`onJobDone`) se lit
  // ici, de façon synchrone — l'état React n'est pas lisible depuis la boucle d'envoi.
  const statuts = React.useRef(new Map<string, FileStatus[]>());

  const patchFile = React.useCallback((jobId: string, idx: number, p: Partial<BgFile>) => {
    if (p.status) { const s = statuts.current.get(jobId); if (s) s[idx] = p.status; }
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, files: j.files.map((f, i) => (i === idx ? { ...f, ...p } : f)) } : j)));
  }, []);
  const patchJob = React.useCallback((jobId: string, p: Partial<BgJob>) => {
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, ...p } : j)));
  }, []);
  const dismiss = React.useCallback((jobId: string) => { statuts.current.delete(jobId); setJobs((js) => js.filter((j) => j.id !== jobId)); }, []);

  // ANNULATION — le drapeau arrête la file, l'avortement coupe ce qui est déjà en vol. Les deux
  // sont nécessaires : sans le second, annuler un envoi de 200 Mo attendrait la fin du fichier
  // courant, ce qui n'a rien d'une annulation.
  const cancelled = React.useRef(new Set<string>());
  const inflight = React.useRef(new Map<string, Set<XMLHttpRequest>>());
  const track = React.useCallback((jobId: string, xhr: XMLHttpRequest) => {
    const set = inflight.current.get(jobId) ?? new Set();
    set.add(xhr);
    inflight.current.set(jobId, set);
    xhr.addEventListener("loadend", () => set.delete(xhr));
  }, []);

  // Envois DIRECTS en cours (pour les abandonner côté bucket sur « Annuler ») et coupe-circuit.
  const controllers = React.useRef(new Map<string, AbortController>());
  const directSessions = React.useRef(new Map<string, Map<string, DirectSpec>>());

  // DÉBIT ET TEMPS RESTANT, par lot, sur une fenêtre glissante (voir `Debitmetre`).
  const meters = React.useRef(new Map<string, { metre: Debitmetre; octets: Map<number, number>; total: number; dernier: number }>());
  const noterOctets = React.useCallback((jobId: string, idx: number, octets: number) => {
    const m = meters.current.get(jobId);
    if (!m) return;
    m.octets.set(idx, octets);
    let somme = 0;
    for (const v of m.octets.values()) somme += v;
    const t = Date.now();
    m.metre.noter(t, somme);
    if (t - m.dernier < 400) return; // l'écran n'a pas besoin de plus de deux rafraîchissements par seconde
    m.dernier = t;
    const debit = m.metre.debit();
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, debit, resteS: debit > 0 ? Math.max(0, m.total - somme) / debit : null } : j)));
  }, []);

  // Lance (ou relance) l'envoi des fichiers du lot dont l'index est dans `indices`.
  const runJob = React.useCallback(async (jobId: string, spec: EnqueueSpec, indices: number[]) => {
    cancelled.current.delete(jobId);
    inflight.current.set(jobId, new Set());
    const ctrl = new AbortController();
    controllers.current.set(jobId, ctrl);
    directSessions.current.set(jobId, new Map());
    meters.current.set(jobId, {
      metre: new Debitmetre(), octets: new Map(), dernier: 0,
      total: indices.reduce((a, i) => a + (spec.files[i]?.size ?? 0), 0),
    });
    const stopped = () => cancelled.current.has(jobId);
    try { spec.onJobStart?.(); } catch { /* l'écran qui écoutait a pu disparaître */ }

    /** Envoi DIRECT au bucket : ouverture (ou reprise), parties parallèles, finalisation. */
    const uploadDirect = async (idx: number, file: File, direct: DirectSpec): Promise<void> => {
      patchFile(jobId, idx, { status: "uploading", progress: 0, error: undefined, direct: true });
      const ouv = await direct.ouvrir().catch((e: unknown) => ({ error: e instanceof Error ? e.message : "Ouverture impossible." }));
      if ("error" in ouv) { patchFile(jobId, idx, { status: "error", progress: 0, error: ouv.error }); return; }
      directSessions.current.get(jobId)?.set(ouv.sessionId, direct);
      // Les empreintes des parties reçues par le navigateur — remises à la finalisation (secours d'un stockage qui ne
      // liste pas ses parties), cumulées d'un envoi à la reprise.
      let etags: Record<number, string> = {};
      const envoyer = async (plan: PlanClient) => { etags = await envoyerParties({
        fichier: file, plan, signal: ctrl.signal, etags,
        onProgres: (p) => {
          patchFile(jobId, idx, { progress: Math.min(99, Math.floor((p.envoyes / Math.max(1, p.total)) * 100)) });
          noterOctets(jobId, idx, p.envoyes);
        },
        renouveler: () => direct.replanifier(ouv.sessionId),
      }); };
      try {
        await envoyer(ouv.plan);
        // La finalisation dit si une partie manque encore : on renvoie CELLES-LÀ, puis on refinalise.
        for (let essai = 0; essai < 3; essai++) {
          const f = await direct.finaliser(ouv.sessionId, etags);
          if (f.ok) {
            directSessions.current.get(jobId)?.delete(ouv.sessionId);
            patchFile(jobId, idx, { status: "done", progress: 100 });
            // Le gros fichier passé par le bucket se signale comme les autres (il ne le faisait pas).
            try { spec.onFileDone?.(file, f.body ?? {}); } catch { /* l'écran qui écoutait a pu disparaître */ }
            return;
          }
          if (!f.reprendre || essai === 2) throw new Error(f.error);
          await envoyer(await direct.replanifier(ouv.sessionId));
        }
      } catch (e) {
        if (e instanceof EnvoiAnnule || stopped()) { patchFile(jobId, idx, { status: "cancelled", progress: 0 }); return; }
        directSessions.current.get(jobId)?.delete(ouv.sessionId); // gardée côté serveur : la reprise la retrouvera
        const msg = e instanceof Error ? e.message : "Échec de l'envoi.";
        // UN REFUS N'EST PAS UNE COUPURE (Direction, 06/10) : « relancez » n'a de sens que pour un envoi interrompu.
        const refus = estUnRefus(msg);
        patchFile(jobId, idx, { status: "error", progress: 0, definitif: refus, error: refus ? msg : `${msg} Relancez le même fichier : les parties déjà envoyées ne repartiront pas.` });
      }
    };

    const uploadOne = async (idx: number): Promise<void> => {
      const file = spec.files[idx];
      if (stopped()) { patchFile(jobId, idx, { status: "cancelled", progress: 0 }); return; }
      // Refusé AVANT d'envoyer : la phrase du serveur, sans attendre l'aller-retour (constat 11).
      const refus = file.size === 0 ? "Fichier vide (0 octet) — rien à envoyer." : spec.refus?.(file) ?? null;
      if (refus) { patchFile(jobId, idx, { status: "error", progress: 0, error: refus }); return; }
      const direct = spec.direct?.(file) ?? null;
      if (direct) { await uploadDirect(idx, file, direct); return; }
      patchFile(jobId, idx, { status: "uploading", progress: 0, error: undefined });

      // Le contenu est-il déjà là ? Si oui, aucun octet ne part sur le réseau. L'état
      // « checking » est visible : lire un gros fichier pour l'empreinte prend une seconde ou
      // deux, et une barre figée sans explication fait croire à une panne.
      if (spec.preflight) {
        patchFile(jobId, idx, { status: "checking" });
        try {
          const connu = await spec.preflight(file);
          if (connu) {
            patchFile(jobId, idx, { status: "done", progress: 100 });
            try { spec.onFileDone?.(file, typeof connu === "object" ? connu : {}); } catch { /* écran disparu */ }
            return;
          }
        } catch { /* une optimisation ratée n'est pas un envoi raté */ }
        patchFile(jobId, idx, { status: "uploading" });
      }

      const { url, formData } = spec.makeRequest(file);
      const attempts = 5;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (stopped()) { patchFile(jobId, idx, { status: "cancelled", progress: 0 }); return; }
        let r: { ok: boolean; status: number; body: Record<string, unknown> };
        try {
          r = await postFormXhr(url, formData, (frac) => { patchFile(jobId, idx, { progress: Math.round(frac * 100) }); noterOctets(jobId, idx, frac * file.size); }, 20 * 60_000, (x) => track(jobId, x));
        } catch (e) {
          // Annulation : on ne retente pas ce que l'utilisateur vient d'arrêter.
          if (e instanceof BgCancelled) { patchFile(jobId, idx, { status: "cancelled", progress: 0 }); return; }
          throw e;
        }
        if (r.ok && (r.body.ok ?? true)) {
          patchFile(jobId, idx, { status: "done", progress: 100 });
          try { spec.onFileDone?.(file, r.body); } catch { /* l'écran qui écoutait a pu disparaître */ }
          // Le serveur dit où est passé le temps. On garde le pire du lot : quand quelqu'un
          // signale « c'est lent », la réponse est déjà à l'écran.
          const t = r.body.timing as { totalMs?: number; phases?: { name: string; ms: number }[]; backend?: string; throughputMbs?: number } | undefined;
          if (t?.totalMs && t.totalMs > SLOW_MS) {
            const worst = (t.phases ?? []).reduce<{ name: string; ms: number } | null>((w, p) => (!w || p.ms > w.ms ? p : w), null);
            const line = `${(t.totalMs / 1000).toFixed(1)} s · ${t.throughputMbs ?? 0} Mo/s · stockage ${t.backend ?? "?"}${worst ? ` · surtout « ${worst.name} » (${(worst.ms / 1000).toFixed(1)} s)` : ""}`;
            setJobs((js) => js.map((j) => (j.id === jobId && (!j.slowest || t.totalMs! > 0) ? { ...j, slowest: { name: file.name, line } } : j)));
          }
          return;
        }
        const retryable = r.status === 0 || r.status >= 500 || r.status === 429;
        // TOUTES les raisons du serveur, pas la première seulement (constat 13).
        const errs = (r.body.errors as { name?: string; error?: string }[] | undefined)?.filter((e) => e.error);
        const msg = (errs && errs.length > 0 ? errs.map((e) => (e.name ? `« ${e.name} » : ${e.error}` : e.error)).join(" · ") : undefined)
          ?? (r.body.error as string | undefined)
          ?? (r.status === 413 ? `Fichier trop volumineux pour cet envoi (${humanSize(file.size)}).`
            : r.status === 0 ? "Réseau indisponible."
            // UN REFUS SANS PHRASE DU SERVEUR se dit quand même en clair (Direction, 06/10) — jamais « Échec (code 403) ».
            : r.status === 401 ? "Session expirée : reconnectez-vous, puis relancez l'envoi."
            : r.status === 403 ? "Vous n'êtes pas autorisé à déposer un document ici : demandez l'accès au responsable de cet espace."
            : `Échec (code ${r.status}).`);
        if (!retryable || attempt === attempts - 1) { patchFile(jobId, idx, { status: "error", progress: 0, error: msg, definitif: !retryable }); return; }
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt)); // backoff : 0,5 → 1 → 2 → 4 s
      }
    };

    // Concurrence bornée : plusieurs fichiers montent en parallèle.
    const pool = Math.max(1, Math.min(spec.concurrency ?? 4, indices.length));
    let cursor = 0;
    const worker = async () => { while (cursor < indices.length && !stopped()) { const i = cursor++; await uploadOne(indices[i]); } };
    await Promise.all(Array.from({ length: pool }, () => worker()));
    inflight.current.delete(jobId);
    controllers.current.delete(jobId);
    directSessions.current.delete(jobId);
    meters.current.delete(jobId);

    // État final du lot + rafraîchissement de la vue courante. Les fichiers restés en attente au
    // moment de l'annulation le disent, plutôt que de figer une barre à mi-course.
    setJobs((js) => js.map((j) => {
      if (j.id !== jobId) return j;
      if (cancelled.current.has(jobId)) {
        return {
          ...j, phase: "cancelled",
          files: j.files.map((f) => (f.status === "done" || f.status === "error" ? f : { ...f, status: "cancelled" as FileStatus, progress: 0 })),
        };
      }
      return { ...j, phase: j.files.some((f) => f.status === "error") ? "error" : "done" };
    }));

    // LE BILAN, pour l'écran qui attend la fin du lot (la messagerie n'envoie qu'un lot complet).
    const annule = cancelled.current.has(jobId);
    const s = statuts.current.get(jobId) ?? [];
    if (annule) s.forEach((st, i) => { if (st !== "done" && st !== "error") s[i] = "cancelled"; });
    try {
      spec.onJobDone?.({
        total: spec.files.length, annule,
        recus: s.filter((st) => st === "done").length,
        echecs: s.filter((st) => st === "error").length,
        annules: s.filter((st) => st === "cancelled").length,
      });
    } catch { /* l'écran qui écoutait a pu disparaître */ }
    router.refresh();
  }, [patchFile, router, track, noterOctets]);

  /**
   * ANNULER UN LOT EN COURS.
   *
   * Ce qui n'est pas encore parti ne partira pas ; ce qui est en vol est coupé. Ce qui est DÉJÀ
   * arrivé reste : le serveur l'a enregistré, et le prétendre annulé serait mentir. Le compte est
   * affiché pour qu'on sache exactement quoi supprimer si on le veut.
   */
  const cancelJob = React.useCallback((jobId: string) => {
    cancelled.current.add(jobId);
    for (const xhr of inflight.current.get(jobId) ?? []) { try { xhr.abort(); } catch { /* déjà terminée */ } }
    inflight.current.delete(jobId);
    // Les envois directs : les parties en vol sont coupées, et celles déjà reçues par le bucket
    // sont LIBÉRÉES — un envoi annulé à 80 % ne doit pas rester payé et invisible.
    controllers.current.get(jobId)?.abort();
    for (const [sessionId, d] of directSessions.current.get(jobId) ?? []) void d.abandonner(sessionId).catch(sansBloquer("background-upload.BackgroundUploadProvider.abandonner"));
    directSessions.current.delete(jobId);
    setJobs((js) => js.map((j) => (j.id === jobId
      ? { ...j, phase: "cancelled", files: j.files.map((f) => (f.status === "done" || f.status === "error" ? f : { ...f, status: "cancelled" as FileStatus, progress: 0 })) }
      : j)));
  }, []);

  const enqueue = React.useCallback((spec: EnqueueSpec) => {
    // Un fichier VIDE reste dans le lot, et le dit — l'écarter en silence le faisait disparaître
    // sans que personne sache pourquoi (constat 13).
    const files = spec.files;
    if (files.length === 0) return;
    const id = `bg${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fullSpec = { ...spec, files };
    statuts.current.set(id, files.map(() => "pending"));
    setJobs((js) => [...js, { id, label: spec.label, phase: "uploading", spec: fullSpec, files: files.map((f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, size: f.size, status: "pending", progress: 0 })) }]);
    void runJob(id, fullSpec, files.map((_, i) => i));
  }, [runJob]);

  // RÉESSAYER les fichiers en échec d'un lot, sans perdre la file (bouton du widget).
  const retryFailed = React.useCallback((jobId: string) => {
    setJobs((js) => js.map((j) => {
      if (j.id !== jobId) return j;
      const failed = j.files.map((f, i) => (f.status === "error" ? i : -1)).filter((i) => i >= 0);
      if (failed.length === 0) return j;
      const s = statuts.current.get(jobId);
      if (s) failed.forEach((i) => { s[i] = "pending"; });
      void runJob(jobId, j.spec, failed);
      return { ...j, phase: "uploading", files: j.files.map((f) => (f.status === "error" ? { ...f, status: "pending" as FileStatus, error: undefined } : f)) };
    }));
  }, [runJob]);

  // Avertit avant de fermer l'onglet tant qu'un envoi est en cours.
  React.useEffect(() => {
    const active = jobs.some((j) => j.phase === "uploading");
    if (!active) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [jobs]);

  const value = React.useMemo(() => ({ enqueue }), [enqueue]);
  return (
    <BgUploadContext.Provider value={value}>
      {children}
      <BgUploadWidget jobs={jobs} onDismiss={dismiss} onRetry={retryFailed} onCancel={cancelJob} />
    </BgUploadContext.Provider>
  );
}

/**
 * Pastille flottante des téléversements — **déplaçable** (glisser l'en-tête) partout à l'écran et
 * **réductible** en une petite bulle (bouton −). Un bouton **Réessayer** relance les fichiers en
 * échec sans perdre la file. Position par défaut : bas-gauche (n'écrase ni l'assistant ni le CTD).
 */
function BgUploadWidget({ jobs, onDismiss, onRetry, onCancel }: { jobs: BgJob[]; onDismiss: (id: string) => void; onRetry: (id: string) => void; onCancel: (id: string) => void }) {
  const [minimized, setMinimized] = React.useState(false);
  // UN ÉCHEC S'AFFICHE (Direction, 06/10) : réduit, le widget ne disait que « Échecs » — la raison restait cachée.
  const nbEchecs = jobs.filter((j) => j.phase === "error").length;
  React.useEffect(() => { if (nbEchecs > 0) setMinimized(false); }, [nbEchecs]);
  // Position libre (coin haut-gauche du widget). `null` = ancrage par défaut en bas-gauche.
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const drag = React.useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    // On ne démarre pas le glissement depuis un bouton (réduire, masquer…).
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const w = 320, margin = 8;
    const x = Math.min(Math.max(margin, e.clientX - drag.current.dx), window.innerWidth - w - margin);
    const y = Math.min(Math.max(margin, e.clientY - drag.current.dy), window.innerHeight - 56 - margin);
    setPos({ x, y });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  if (jobs.length === 0) return null;
  const active = jobs.filter((j) => j.phase === "uploading").length;
  const anyFailed = jobs.some((j) => j.phase === "error");
  // « Terminé » sur un lot qu'on vient d'annuler serait un mensonge à l'écran.
  const allCancelled = jobs.length > 0 && jobs.every((j) => j.phase === "cancelled");
  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y } : { left: 16, bottom: 96 };

  // ── Réduit : petite bulle déplaçable (clic pour rouvrir) ──
  if (minimized) {
    return (
      <div className="fixed z-40" style={style}>
        <button type="button" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onClick={() => { if (!drag.current) setMinimized(false); }}
          className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-sm font-medium shadow-lg hover:bg-muted/60"
          title="Ouvrir les téléversements">
          {active > 0 ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
            : anyFailed ? <AlertCircle className="h-4 w-4 text-destructive" />
            : allCancelled ? <Ban className="h-4 w-4 text-muted-foreground" />
            : <CheckCircle2 className="h-4 w-4 text-success" />}
          <span>{active > 0 ? `Envoi (${active})` : anyFailed ? "Échecs" : allCancelled ? "Annulé" : "Terminé"}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="fixed z-40 w-[min(92vw,20rem)]" style={style}>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          className="flex cursor-grab touch-none select-none items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground active:cursor-grabbing">
          <span className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-primary" />
            {active > 0 ? `Téléversement en cours (${active})` : "Téléversements"}
          </span>
          <span className="flex items-center gap-0.5">
            <button type="button" onClick={() => setMinimized(true)} className="rounded p-2 text-muted-foreground hover:bg-muted sm:p-0.5" aria-label="Réduire"><ChevronDown className="h-4 w-4" /></button>
          </span>
        </div>
        <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto">
          {jobs.map((j) => {
            const done = j.files.filter((f) => f.status === "done").length;
            // « Vérification » = on calcule l'empreinte pour éviter de renvoyer un contenu déjà
            // présent. Sans ce mot, la barre paraît figée et l'on croit à une panne.
            const checking = j.files.filter((f) => f.status === "checking").length;
            const failed = j.files.filter((f) => f.status === "error").length;
            // TOUTES les erreurs du lot, fichier par fichier (constat 13) — cinq au plus à l'écran,
            // le reste COMPTÉ : une liste coupée en silence se lirait comme complète.
            const erreurs = j.files.filter((f) => f.status === "error" && f.error);
            const pct = Math.round((j.files.reduce((a, f) => a + (f.status === "done" ? 100 : f.progress), 0) / (j.files.length * 100)) * 100);
            return (
              <li key={j.id} className="px-3 py-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {j.phase === "uploading" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      : j.phase === "done" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                      : j.phase === "cancelled" ? <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                    <span className="truncate text-foreground" title={j.label}>{j.label}</span>
                  </span>
                  {j.phase === "uploading" ? (
                    <button type="button" onClick={() => onCancel(j.id)}
                      className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-destructive sm:px-2 sm:py-0.5">
                      Annuler
                    </button>
                  ) : (
                    <button type="button" onClick={() => onDismiss(j.id)} className="shrink-0 rounded p-2 text-muted-foreground hover:bg-muted sm:p-0.5" aria-label="Masquer"><X className="h-3.5 w-3.5" /></button>
                  )}
                </div>
                {j.phase === "uploading" && (
                  <div className="mt-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{done}/{j.files.length} fichier·s{checking > 0 ? ` · ${checking} en vérification` : ""}</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
                    {/* Le débit RÉEL et le temps restant : sur un fichier de plusieurs Go, c'est la
                        seule chose qui permet de décider d'attendre ou d'aller faire autre chose. */}
                    <p className="mt-1 flex justify-between text-[0.6875rem] text-muted-foreground" aria-live="polite">
                      <span>{debitLisible(j.debit ?? 0)}</span>
                      <span>{resteLisible(j.resteS ?? null)}</span>
                    </p>
                  </div>
                )}
                {failed > 0 && j.phase !== "error" && erreurs.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {erreurs.slice(0, 5).map((f, i) => (
                      <li key={`${i}-${f.name}`} className="rounded bg-destructive/10 px-2 py-1 text-[0.6875rem] leading-snug text-destructive"><strong>{f.name}</strong> — {f.error}</li>
                    ))}
                    {erreurs.length > 5 && <li className="text-[0.6875rem] text-destructive">… et {erreurs.length - 5} autre·s fichier·s en échec.</li>}
                  </ul>
                )}
                {j.phase === "done" && <p className="mt-1 text-xs text-success">{done} fichier·s téléversé·s{failed > 0 ? `, ${failed} en échec` : ""}.</p>}
                {/* On ne prétend PAS avoir annulé ce qui est déjà arrivé : le serveur l'a
                    enregistré. On dit combien, pour qu'on sache quoi supprimer si on le veut. */}
                {j.phase === "cancelled" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Envoi annulé — {j.files.filter((f) => f.status === "cancelled").length} fichier·s non envoyé·s
                    {done > 0 ? `, ${done} déjà enregistré·s (à supprimer depuis la liste si besoin)` : ""}.
                  </p>
                )}
                {j.slowest && (
                  <p className="mt-1 rounded bg-secondary/60 px-2 py-1 text-[0.6875rem] leading-snug text-muted-foreground" title={j.slowest.name}>
                    Le plus lent : {j.slowest.line}
                  </p>
                )}
                {j.phase === "error" && (
                  <div className="mt-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-destructive">{done} réussi·s, {failed} en échec.</p>
                      {erreurs.some((f) => !f.definitif) && (
                        <button type="button" onClick={() => onRetry(j.id)} className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted sm:px-2 sm:py-0.5">Réessayer</button>
                      )}
                    </div>
                    <ul className="space-y-0.5">
                      {erreurs.slice(0, 5).map((f, i) => (
                        <li key={`${i}-${f.name}`} className="rounded bg-destructive/10 px-2 py-1 text-[0.6875rem] leading-snug text-destructive"><strong>{f.name}</strong> — {f.error}</li>
                      ))}
                      {erreurs.length > 5 && <li className="text-[0.6875rem] text-destructive">… et {erreurs.length - 5} autre·s fichier·s en échec.</li>}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
