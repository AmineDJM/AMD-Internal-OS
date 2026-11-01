"use client";

import { useCallback, useEffect, useState } from "react";
import { Undo2, Redo2, Send, X } from "lucide-react";
import { sansBloquer } from "@/lib/journal";
import { agirSurMonEnvoi, annulerMonGeste, historiqueDeLaFiche, mesGestesEtEnvoisRecents, retablirMonGeste } from "@/modules/assistant-ia/actions-gestes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BARRE « ANNULER » DE L'ERP (K10b, décision 0040) — montée par la coque, pour tout le monde.
 *
 *   • « Fait : <geste> — Annuler » : le geste réversible qu'on vient de faire (bouton de l'ERP ou carte de l'assistant),
 *     pendant une minute. Annulé : le compte rendu honnête (annulé / compensé / impossible) et « Rétablir ».
 *   • « Courriel à … part dans 1:42 — Annuler l'envoi » : l'envoi qui attend sa fenêtre d'annulation, façon messagerie.
 *     Annulé : « rien n'est parti » et « Rétablir l'envoi ». Parti : la barre se tait — l'historique de la fiche le garde.
 *
 * `HistoriqueAnnulable` est la même chose sur la fiche d'un objet : ses gestes et ses envois, chacun annulable.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Donnees = Extract<Awaited<ReturnType<typeof mesGestesEtEnvoisRecents>>, { ok: true }>;
type Geste = Donnees["gestes"][number];
type Envoi = Donnees["envois"][number];

const MONTRER_GESTE_MS = 60_000;
const MONTRER_ENVOI_ANNULE_MS = 120_000;

const reste = (iso: string, decalage: number) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now() - decalage) / 1000));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const majuscule = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Les gestes sur un geste ou un envoi — partagés par la barre et l'historique de la fiche. */
function useGestesAnnulables(charger: () => Promise<void>) {
  const [occupe, setOccupe] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const agir = useCallback(async (cle: string, fn: () => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>, lire: (r: Record<string, unknown>) => string) => {
    setOccupe(cle);
    try {
      const r = await fn();
      setMessages((m) => ({ ...m, [cle]: r.ok ? lire(r) : (r.error ?? "Refusé.") }));
      await charger();
    } finally {
      setOccupe(null);
    }
  }, [charger]);
  const annuler = (g: Geste) => agir(g.id, () => annulerMonGeste(g.id) as never, (r) => (r.compte as { resume: string }).resume);
  const retablir = (g: Geste) => agir(g.id, () => retablirMonGeste(g.id) as never, (r) => (r.compte as { resume: string }).resume);
  const envoi = (e: Envoi, geste: "annuler" | "retablir") => agir(e.id, () => agirSurMonEnvoi(e.id, geste) as never, (r) => (r.issue as { message: string }).message);
  return { occupe, messages, annuler, retablir, envoi };
}

function LigneEnvoi({ e, decalage, occupe, message, agir }: { e: Envoi; decalage: number; occupe: boolean; message?: string; agir: (g: "annuler" | "retablir") => void }) {
  const secondes = reste(e.executeLe, decalage);
  const quoi = `${majuscule(e.quoi)} à ${e.cible}${e.apercu ? ` ${e.apercu}` : ""}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Send className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        {e.statut === "EN_ATTENTE" && <>{quoi} — part dans <strong className="tabular-nums">{mmss(secondes)}</strong></>}
        {e.statut === "EN_COURS" && <>{quoi} — en train de partir</>}
        {e.statut === "ANNULE" && <>{quoi} — <strong>envoi annulé : rien n&apos;est parti</strong></>}
        {e.statut === "PARTI" && <>{quoi} — {e.type.startsWith("inverse.") ? "fait" : "parti"}{e.parti ? ` le ${new Date(e.parti).toLocaleString("fr-FR")}` : ""}</>}
        {e.statut === "COMPENSE" && <>{quoi} — parti, compensé : {e.compensation}</>}
        {e.statut === "ECHEC" && <>{quoi} — non parti ({e.erreur})</>}
        {message && <span className="block text-xs text-muted-foreground">{message}</span>}
      </span>
      {e.statut === "EN_ATTENTE" && <button type="button" disabled={occupe} onClick={() => agir("annuler")} className="h-9 rounded-md border px-3 font-medium focus-ring">Annuler l&apos;envoi</button>}
      {e.statut === "ANNULE" && <button type="button" disabled={occupe} onClick={() => agir("retablir")} className="h-9 rounded-md border px-3 focus-ring">Rétablir l&apos;envoi</button>}
      {e.statut === "PARTI" && <button type="button" disabled={occupe} onClick={() => agir("annuler")} className="h-9 rounded-md border px-3 focus-ring" title={e.type.startsWith("inverse.") ? "Le geste inverse est fait (le message retrouve son état d'avant)." : "Le message est parti : il n'est pas effacé chez son destinataire. Un rectificatif lui est envoyé."}>{e.type.startsWith("inverse.") ? "Défaire" : "Compenser"}</button>}
    </div>
  );
}

function LigneGeste({ g, occupe, message, annuler, retablir }: { g: Geste; occupe: boolean; message?: string; annuler: () => void; retablir: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Undo2 className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        {g.annuleLe ? <>Annulé : {g.libelle}</> : <>Fait : {g.libelle}</>}
        {(message ?? g.issue) && <span className="block text-xs text-muted-foreground">{message ?? g.issue}</span>}
      </span>
      {g.annuleLe
        ? <button type="button" disabled={occupe} onClick={retablir} className="inline-flex h-9 items-center gap-1 rounded-md border px-3 focus-ring"><Redo2 className="h-3.5 w-3.5" aria-hidden />Rétablir</button>
        : <button type="button" disabled={occupe} onClick={annuler} className="h-9 rounded-md border px-3 font-medium focus-ring">Annuler</button>}
    </div>
  );
}

export function BarreAnnulation() {
  const [d, setD] = useState<Donnees | null>(null);
  const [decalage, setDecalage] = useState(0);
  const [fermes, setFermes] = useState<Set<string>>(new Set());
  const [, battre] = useState(0);
  const charger = useCallback(async () => {
    const r = await mesGestesEtEnvoisRecents().catch(sansBloquer("barre-annulation.mesGestesEtEnvoisRecents", null));
    if (r && r.ok) { setD(r); setDecalage(Date.now() - new Date(r.maintenant).getTime()); }
  }, []);
  const g = useGestesAnnulables(charger);
  const enFenetre = (d?.envois ?? []).some((e) => e.statut === "EN_ATTENTE" || e.statut === "EN_COURS");
  const recent = (d?.gestes ?? []).some((x) => Date.now() - new Date(x.quand).getTime() < MONTRER_GESTE_MS);
  useEffect(() => {
    void charger();
    const t = setInterval(() => { if (document.visibilityState === "visible") void charger(); }, enFenetre || recent ? 4_000 : 15_000);
    const focus = () => void charger();
    window.addEventListener("focus", focus);
    return () => { clearInterval(t); window.removeEventListener("focus", focus); };
  }, [charger, enFenetre, recent]);
  useEffect(() => {
    if (!enFenetre) return;
    const t = setInterval(() => battre((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [enFenetre]);
  if (!d) return null;
  const maintenant = Date.now();
  const envois = d.envois.filter((e) => !fermes.has(e.id) && (e.statut === "EN_ATTENTE" || e.statut === "EN_COURS"
    || ((e.statut === "ANNULE" || g.messages[e.id]) && maintenant - new Date(e.creeLe).getTime() < MONTRER_ENVOI_ANNULE_MS)));
  const gestes = d.gestes.filter((x) => !fermes.has(x.id) && (maintenant - new Date(x.quand).getTime() < MONTRER_GESTE_MS || g.messages[x.id])).slice(0, 1);
  if (!envois.length && !gestes.length) return null;
  const fermer = (id: string) => setFermes((s) => new Set(s).add(id));
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 md:bottom-6">
      <div className="pointer-events-auto w-full max-w-xl space-y-2 rounded-xl border bg-card px-3 py-2.5 shadow-lg">
        {gestes.map((x) => (
          <div key={x.id} className="flex items-start gap-1">
            <div className="min-w-0 flex-1"><LigneGeste g={x} occupe={g.occupe === x.id} message={g.messages[x.id]} annuler={() => void g.annuler(x)} retablir={() => void g.retablir(x)} /></div>
            <button type="button" onClick={() => fermer(x.id)} className="rounded p-1 opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer"><X className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        {envois.map((e) => (
          <div key={e.id} className="flex items-start gap-1">
            <div className="min-w-0 flex-1"><LigneEnvoi e={e} decalage={decalage} occupe={g.occupe === e.id} message={g.messages[e.id]} agir={(x) => void g.envoi(e, x)} /></div>
            {e.statut !== "EN_ATTENTE" && <button type="button" onClick={() => fermer(e.id)} className="rounded p-1 opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer"><X className="h-3.5 w-3.5" /></button>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** L'HISTORIQUE ANNULABLE D'UNE FICHE — ses gestes journalisés et ses envois, chacun avec son bouton. */
export function HistoriqueAnnulable({ modele, id, titre = "Historique — annuler un geste" }: { modele: string; id: string; titre?: string }) {
  const [d, setD] = useState<{ gestes: Geste[]; envois: Envoi[] } | null>(null);
  const charger = useCallback(async () => {
    const r = await historiqueDeLaFiche(modele, id).catch(sansBloquer("barre-annulation.historiqueDeLaFiche", null));
    if (r && r.ok) setD(r);
  }, [modele, id]);
  const g = useGestesAnnulables(charger);
  useEffect(() => { void charger(); }, [charger]);
  if (!d || (!d.gestes.length && !d.envois.length)) return null;
  return (
    <section className="space-y-2 rounded-lg border p-3" aria-label={titre}>
      <h3 className="text-sm font-semibold">{titre}</h3>
      {d.envois.map((e) => <LigneEnvoi key={e.id} e={e} decalage={0} occupe={g.occupe === e.id} message={g.messages[e.id]} agir={(x) => void g.envoi(e, x)} />)}
      {d.gestes.map((x) => <LigneGeste key={x.id} g={x} occupe={g.occupe === x.id} message={g.messages[x.id]} annuler={() => void g.annuler(x)} retablir={() => void g.retablir(x)} />)}
    </section>
  );
}
