"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CloudOff, Loader2, Mic, RefreshCw, Square, Wifi } from "lucide-react";
import {
  LIBELLE_LANGUE, LIBELLE_PHOTO, nouvelElement, phraseFile, relancer, reprendreApresRedemarrage, SORTES_PHOTO, viderFile,
  type ElementFile, type IssueEnvoi, type SortePhoto, type VueCaptation,
} from "@/modules/assistant-ia/partage";
import { confirmerCarteTerrain } from "@/modules/assistant-ia/actions";
import { ActionConfirmationCard } from "../action-confirmation-card";
import { nouvelleCle, ouvrirFileLocale, type FileLocale } from "./file-locale";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TERRAIN, AU TÉLÉPHONE (lot J13, décision 0025) — mobile d'abord (testé à 390 px).
 *
 * Un grand bouton « Dicter », un bouton « Photo ». Chaque capture entre d'abord dans la FILE LOCALE (IndexedDB) puis
 * part quand le réseau le permet — tout de suite en général, au retour du réseau sinon ; l'état est toujours dit en
 * haut de l'écran. Le serveur rend, pour un vocal, la transcription et le compte rendu structuré avec ses CARTES
 * (compte rendu pré-rempli, échantillons, tournée de demain), pour une photo, les faits lus et la carte « rattacher ».
 * Rien n'est écrit sans le bouton de la carte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ESSAI_MS = 15_000;

async function envoyerAuServeur(f: FileLocale, e: ElementFile): Promise<IssueEnvoi & { captation?: VueCaptation }> {
  const c = await f.contenu(e.id);
  if (!c) return { ok: false, erreur: "Le contenu local a disparu.", definitif: true };
  const form = new FormData();
  form.set("cle", e.id);
  form.set("sorte", c.sorte);
  form.set("fichier", c.fichier, c.nom);
  if (c.dureeS != null) form.set("dureeS", String(c.dureeS));
  if (c.sortePhoto) form.set("sortePhoto", c.sortePhoto);
  const r = await fetch("/api/assistant-ia/terrain", { method: "POST", body: form });
  const d = (await r.json().catch(() => ({}))) as { captation?: VueCaptation; error?: string };
  if (r.ok && d.captation) return { ok: true, accuse: d.captation.id, captation: d.captation };
  // 4xx (hors 401/408/429) : le serveur refuse CET élément — le renvoyer tel quel ne changera rien.
  const definitif = r.status >= 400 && r.status < 500 && ![401, 408, 429].includes(r.status);
  return { ok: false, erreur: d.error ?? `Envoi refusé (HTTP ${r.status}).`, definitif };
}

export function EcranTerrain({ initiales }: { initiales: VueCaptation[] }) {
  const [captations, setCaptations] = useState<VueCaptation[]>(initiales);
  const [file, setFile] = useState<ElementFile[]>([]);
  const [enLigne, setEnLigne] = useState(true);
  const [persistante, setPersistante] = useState(true);
  const [enregistre, setEnregistre] = useState(false);
  const [secondes, setSecondes] = useState(0);
  const [sortePhoto, setSortePhoto] = useState<SortePhoto>("PRESENTOIR");
  const [message, setMessage] = useState<string | null>(null);
  const stock = useRef<FileLocale | null>(null);
  const enCours = useRef(false);
  const rec = useRef<{ mr: MediaRecorder; morceaux: Blob[]; debut: number; minuterie: ReturnType<typeof setInterval> } | null>(null);
  const photo = useRef<HTMLInputElement>(null);

  const relire = useCallback(async () => { if (stock.current) setFile(await stock.current.lister()); }, []);

  const vider = useCallback(async () => {
    const f = stock.current;
    if (!f || enCours.current) return;
    enCours.current = true;
    try {
      await viderFile(f, async (e) => {
        const r = await envoyerAuServeur(f, e);
        if (r.ok && r.captation) setCaptations((cs) => [r.captation!, ...cs.filter((c) => c.id !== r.captation!.id)]);
        return r;
      }, () => Date.now(), () => navigator.onLine);
    } finally {
      enCours.current = false;
      await relire();
    }
  }, [relire]);

  useEffect(() => {
    let vivant = true;
    // Le service worker garde l'écran ouvrable hors ligne (public/sw.js) — enregistré ici aussi, sans attendre les notifications.
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    void (async () => {
      const f = await ouvrirFileLocale();
      if (!vivant) return;
      stock.current = f;
      setPersistante(f.persistante);
      // Un envoi coupé (onglet fermé pendant l'envoi) repart.
      for (const e of reprendreApresRedemarrage(await f.lister())) await f.ecrire(e);
      setEnLigne(navigator.onLine);
      await relire();
      void vider();
    })();
    const enLigneOk = () => { setEnLigne(true); void vider(); };
    const horsLigne = () => setEnLigne(false);
    window.addEventListener("online", enLigneOk);
    window.addEventListener("offline", horsLigne);
    const t = setInterval(() => void vider(), ESSAI_MS);
    return () => { vivant = false; window.removeEventListener("online", enLigneOk); window.removeEventListener("offline", horsLigne); clearInterval(t); };
  }, [relire, vider]);

  const mettreEnFile = useCallback(async (fichier: Blob, nom: string, sorte: "vocal" | "photo", libelle: string, extra: { dureeS?: number; sortePhoto?: string } = {}) => {
    const f = stock.current;
    if (!f) return;
    const id = nouvelleCle();
    await f.ajouter(nouvelElement(id, sorte, libelle, Date.now()), { id, fichier, nom, sorte, ...extra });
    await relire();
    void vider();
  }, [relire, vider]);

  const demarrer = async () => {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) { setMessage("Le micro demande une connexion sécurisée (HTTPS)."); return; }
    try {
      const flux = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(t));
      const mr = new MediaRecorder(flux, type ? { mimeType: type } : undefined);
      const morceaux: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) morceaux.push(e.data); };
      mr.onstop = () => {
        flux.getTracks().forEach((t) => t.stop());
        const r = rec.current;
        rec.current = null;
        if (!r) return;
        clearInterval(r.minuterie);
        const duree = Math.round((Date.now() - r.debut) / 1000);
        const mime = (mr.mimeType || "audio/webm").split(";")[0];
        const blob = new Blob(morceaux, { type: mime });
        void mettreEnFile(blob, `vocal-terrain.${mime.includes("mp4") ? "m4a" : "webm"}`, "vocal", `Vocal de ${Math.floor(duree / 60)}:${String(duree % 60).padStart(2, "0")}`, { dureeS: duree });
      };
      mr.start(1000);
      const debut = Date.now();
      rec.current = { mr, morceaux, debut, minuterie: setInterval(() => setSecondes(Math.round((Date.now() - debut) / 1000)), 500) };
      setSecondes(0);
      setEnregistre(true);
    } catch {
      setMessage("Micro inaccessible — autorisez-le dans le navigateur.");
    }
  };
  const arreter = () => { rec.current?.mr.stop(); setEnregistre(false); };

  const surPhoto = (f: File | undefined) => {
    if (!f) return;
    void mettreEnFile(f, f.name || "photo.jpg", "photo", `Photo — ${LIBELLE_PHOTO[sortePhoto]}`, { sortePhoto });
  };

  const relancerElement = async (e: ElementFile) => {
    await stock.current?.ecrire(relancer(e));
    await relire();
    void vider();
  };
  const jeter = async (e: ElementFile) => {
    if (!window.confirm(`Jeter « ${e.libelle} » ? Il n'a pas été envoyé : il sera perdu.`)) return;
    await stock.current?.retirer(e.id);
    await relire();
  };

  const attente = file.filter((e) => e.etat !== "ENVOYE");
  return (
    <div className="mx-auto max-w-xl space-y-4 pb-24">
      <div data-testid="etat-file" role="status" className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${enLigne ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"}`}>
        {enLigne ? <Wifi className="h-4 w-4 shrink-0" /> : <CloudOff className="h-4 w-4 shrink-0" />}
        <span>{phraseFile(file, enLigne)}{persistante ? "" : " (mémoire de l'onglet seulement : ne fermez pas la page)"}</span>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {enregistre ? (
          <button type="button" onClick={arreter} data-testid="arreter" className="flex h-20 items-center justify-center gap-3 rounded-2xl bg-red-600 text-lg font-semibold text-white">
            <Square className="h-6 w-6" /> Arrêter · {Math.floor(secondes / 60)}:{String(secondes % 60).padStart(2, "0")}
          </button>
        ) : (
          <button type="button" onClick={() => void demarrer()} data-testid="dicter" className="flex h-20 items-center justify-center gap-3 rounded-2xl bg-violet-600 text-lg font-semibold text-white">
            <Mic className="h-6 w-6" /> Dicter un compte rendu
          </button>
        )}
        <div className="flex gap-2">
          <select aria-label="Ce que montre la photo" value={sortePhoto} onChange={(e) => setSortePhoto(e.target.value as SortePhoto)}
            className="h-14 min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {SORTES_PHOTO.map((s) => <option key={s} value={s}>{LIBELLE_PHOTO[s]}</option>)}
          </select>
          <button type="button" onClick={() => photo.current?.click()} data-testid="photo" className="flex h-14 shrink-0 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium dark:border-zinc-700 dark:bg-zinc-900">
            <Camera className="h-5 w-5" /> Photo
          </button>
          <input ref={photo} type="file" accept="image/*" capture="environment" className="hidden" data-testid="photo-fichier"
            onChange={(e) => { surPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <p className="text-xs text-slate-500">Une ordonnance doit être anonymisée : les données du patient ne sont jamais recopiées.</p>
        {message && <p role="alert" className="text-sm text-red-600">{message}</p>}
      </div>

      {attente.length > 0 && (
        <ul className="space-y-2" aria-label="File d'envoi">
          {attente.map((e) => (
            <li key={e.id} data-testid="element-file" className="flex items-center gap-2 rounded-xl border border-slate-200 p-2.5 text-sm dark:border-zinc-800">
              {e.etat === "ENVOI" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudOff className="h-4 w-4 text-amber-600" />}
              <span className="min-w-0 flex-1 truncate">{e.libelle} — {e.etat === "REFUSE" ? `refusé : ${e.erreur}` : e.etat === "ENVOI" ? "envoi…" : e.erreur ? `en attente (${e.erreur})` : "en attente"}</span>
              <button type="button" onClick={() => void relancerElement(e)} aria-label={`Renvoyer ${e.libelle}`} className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-zinc-800"><RefreshCw className="h-4 w-4" /></button>
              {e.etat === "REFUSE" && <button type="button" onClick={() => void jeter(e)} className="rounded-lg px-2 py-1 text-xs text-red-600">Jeter</button>}
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-3" aria-label="Captations récentes">
        {captations.map((c) => <Captation key={c.id} c={c} />)}
        {!captations.length && <p className="text-sm text-slate-500">Dictez en sortant d&apos;une visite : le compte rendu se prépare seul, vous le confirmez.</p>}
      </section>
    </div>
  );
}

function Captation({ c }: { c: VueCaptation }) {
  const cr = c.compteRendu;
  return (
    <article data-testid="captation" className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        <span className="font-medium text-slate-800 dark:text-zinc-100">{c.sorte === "VOCAL" ? "Vocal" : "Photo"}</span>
        <span>{new Date(c.creeLe).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
        {c.langue && <span>· {LIBELLE_LANGUE[c.langue]}</span>}
        {c.msTotal != null && <span>· prêt en {(c.msTotal / 1000).toFixed(1)} s</span>}
      </header>
      {c.erreur && <p className="text-sm text-red-600">{c.erreur}</p>}
      {c.transcription && (
        <details className="text-sm"><summary className="cursor-pointer text-slate-600">Transcription</summary><p dir="auto" className="mt-1 whitespace-pre-wrap">{c.transcription}</p></details>
      )}
      {cr && <p className="text-sm">{cr.synthese}</p>}
      {c.photo && (
        <div className="text-sm">
          <p className="font-medium">{LIBELLE_PHOTO[c.photo.sorte]} — {c.photo.resume}</p>
          {c.photo.faits.length > 0 && (
            <dl className="mt-1 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
              {c.photo.faits.map((f, i) => <React.Fragment key={i}><dt className="text-slate-500">{f.cle}</dt><dd className="break-words">{f.valeur}</dd></React.Fragment>)}
            </dl>
          )}
          <p className="mt-1 text-[11px] text-slate-400">Faits proposés par la lecture de la photo — à vérifier.</p>
        </div>
      )}
      {c.notes.filter((n) => n !== c.erreur).map((n, i) => <p key={i} className="text-xs text-amber-700 dark:text-amber-300">{n}</p>)}
      {c.cartes.map((k) => (
        <ActionConfirmationCard key={k.intentId} intentId={k.intentId} kind={k.kind} title={k.title} fields={k.fields} warnings={k.warnings}
          confirmText={k.confirmText} libelleBouton={k.libelleBouton} onConfirm={(id) => confirmerCarteTerrain(id)}
          initialStatus={k.statut} resultMessage={k.resultat?.message ?? undefined} resultLink={k.resultat?.lien ?? undefined} />
      ))}
    </article>
  );
}
