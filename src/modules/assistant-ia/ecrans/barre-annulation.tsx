"use client";

import { useCallback, useEffect, useState } from "react";
import { Undo2, Redo2, Send, X } from "lucide-react";
import { sansBloquer } from "@/lib/journal";
import { agirSurMonEnvoi, annulerMonGeste, historiqueDeLaFiche, retablirMonGeste } from "@/modules/assistant-ia/actions-gestes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'HISTORIQUE ANNULABLE D'UNE FICHE (K10b, décision 0040) — ses gestes journalisés et ses envois, chacun avec son bouton.
 *
 * La barre flottante « Annuler » est RETIRÉE (Direction, 03/11/2026 : « pas de pop-up, rien ») : on demande à Adam
 * d'annuler (`infra/annulation-directe.ts`, à l'écrit comme à la voix), et un envoi attend 30 s avant de partir.
 * La même notification à plusieurs personnes reste UNE ligne, dite par les noms.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Donnees = Extract<Awaited<ReturnType<typeof historiqueDeLaFiche>>, { ok: true }>;
type Geste = Donnees["gestes"][number];
type Envoi = Donnees["envois"][number];


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
  /** Un envoi — ou un GROUPE (la même notification à plusieurs personnes) : un seul bouton, chaque envoi traité. */
  const envoi = (grp: GroupeEnvois, geste: "annuler" | "retablir") => agir(grp.cle, async () => {
    const issues: { ok: boolean; message: string }[] = [];
    for (const e of grp.envois) {
      const r = await agirSurMonEnvoi(e.id, geste);
      issues.push(r.ok ? { ok: r.issue.ok, message: r.issue.message } : { ok: false, message: r.error });
    }
    if (issues.length === 1) return { ok: true, message: issues[0]!.message } as never;
    const reussis = issues.filter((i) => i.ok).length;
    const echecs = issues.filter((i) => !i.ok);
    const fait = geste === "annuler" ? "annulé : rien n'est parti" : "rétabli";
    return { ok: true, message: `${reussis} sur ${issues.length} ${fait}.${echecs.length ? ` ${echecs[0]!.message}` : ""}` } as never;
  }, (r) => r.message as string);
  return { occupe, messages, annuler, retablir, envoi };
}

/**
 * LA MÊME NOTIFICATION À PLUSIEURS PERSONNES = UNE LIGNE (retour Direction du 03/11 : six lignes « La notification poussée
 * à cmqv3781e002… » pour une seule demande de paiement). Même geste, même nature, même objet, même état : un groupe,
 * dit « à 6 personnes (Karim B., Sarah M., Amine D. et 3 autres) », avec un seul bouton.
 */
export interface GroupeEnvois { cle: string; envois: Envoi[] }
export function grouperEnvois(envois: readonly Envoi[]): GroupeEnvois[] {
  const groupes = new Map<string, Envoi[]>();
  for (const e of envois) {
    const cle = e.acte === "NOTIFICATION_PUSH" ? `${e.gesteId ?? e.id}|${e.acte}|${e.apercu ?? ""}|${e.statut}` : e.id;
    groupes.set(cle, [...(groupes.get(cle) ?? []), e]);
  }
  return [...groupes].map(([cle, liste]) => ({ cle, envois: liste }));
}
const NOMS_MONTRES = 3;
export function destinataires(envois: readonly Envoi[]): string {
  const noms = [...new Set(envois.map((e) => e.cibleVue))];
  if (noms.length === 1) return noms[0]!;
  const montres = noms.slice(0, NOMS_MONTRES).join(", ");
  const autres = noms.length - NOMS_MONTRES;
  return `${noms.length} personnes (${autres > 0 ? `${montres} et ${autres} autre${autres > 1 ? "s" : ""}` : montres})`;
}
const entreGuillemets = (t: string) => (t.startsWith("«") ? t : `« ${t} »`);

function LigneEnvoi({ grp, decalage, occupe, message, agir }: { grp: GroupeEnvois; decalage: number; occupe: boolean; message?: string; agir: (g: "annuler" | "retablir") => void }) {
  const e = grp.envois.reduce((a, b) => (new Date(b.executeLe) < new Date(a.executeLe) ? b : a));
  const secondes = reste(e.executeLe, decalage);
  const quoi = `${majuscule(e.quoi)}${e.apercu ? ` ${e.acte === "NOTIFICATION_PUSH" ? entreGuillemets(e.apercu) : e.apercu}` : ""} à ${destinataires(grp.envois)}`;
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
      {grouperEnvois(d.envois).map((grp) => <LigneEnvoi key={grp.cle} grp={grp} decalage={0} occupe={g.occupe === grp.cle} message={g.messages[grp.cle]} agir={(x) => void g.envoi(grp, x)} />)}
      {d.gestes.map((x) => <LigneGeste key={x.id} g={x} occupe={g.occupe === x.id} message={g.messages[x.id]} annuler={() => void g.annuler(x)} retablir={() => void g.retablir(x)} />)}
    </section>
  );
}
