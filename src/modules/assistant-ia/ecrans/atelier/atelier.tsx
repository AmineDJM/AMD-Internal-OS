"use client";

import React from "react";
import { ExternalLink, FileSpreadsheet, FileText, Loader2, Maximize2, Minimize2, Presentation, Sparkles, X } from "lucide-react";
import { zonesModifiees } from "@/platform/ia/artifact/atelier/gestes";
import type { VueArtefact } from "@/platform/ia/artifact/view-types";
import {
  annulerDansAtelier, comparerOnglet, convertirDansAtelier, enregistrerOnglet, fermerOngletAtelier, ouvrirDansLAtelier, relireOnglet,
  revoirModificationAtelier, toutAccepterAtelier, type OngletOuvert,
} from "@/modules/assistant-ia/actions-atelier";
import { ActionConfirmationCard } from "../action-confirmation-card";
import { useConfirmer } from "@/components/ui/dialogue";
import { sansBloquer } from "@/lib/journal";
import { BarreOnglet, nomFormat, RevueModifications, SceneAtelier, type EtatOnglet, type Navigation } from "./document";
import { ComparaisonAtelier } from "./comparer";
import "./atelier.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATELIER (J3, décision 0017) — les documents À CÔTÉ de la conversation, en onglets, modifiés en direct.
 *
 * Il relit `/api/assistant-ia/atelier` (toutes les ~0,6 s pendant que l'assistant travaille, sinon toutes les
 * 8 s) : un onglet NEUF (l'assistant a ouvert un document) apparaît et l'Atelier s'ouvre ; une RÉVISION neuve
 * (l'assistant vient d'appliquer un geste) fait relire la vue, calculer ce qui a CHANGÉ (par contenu), aller
 * là où ça change (diapositive, feuille, page) et l'animer : surlignage, texte qui s'écrit, diapositive qui
 * apparaît (rien qui bouge sous `prefers-reduced-motion`). Chaque modification attend la revue de la personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface OngletServeur { sessionId: string; revision: number; nom: string; format: string; dirty: boolean }
interface ConversionServeur {
  id: string; nodeId: string; vers: string; libelleVoie: string; etat: string;
  resultat: { nodeId: string; nom: string } | null; note: string | null; erreur: string | null;
}
type Carte = { id: string; kind: string; title: string; fields: { label: string; value: string }[]; warnings?: string[]; libelleBouton?: string };

const ANIMATION_MS = 2400;
const NAV_VIDE: Navigation = { diapo: null, feuille: null, page: null };

function Icone({ format, className }: { format: string; className?: string }) {
  if (format === "PPTX") return <Presentation className={className} aria-hidden />;
  if (format === "XLSX") return <FileSpreadsheet className={className} aria-hidden />;
  return <FileText className={className} aria-hidden />;
}

function etatDepuis(r: OngletOuvert, avant?: EtatOnglet, animer = false): EtatOnglet | null {
  if (!r.ok || !r.vue) return null;
  const vue = r.vue;
  if (!avant) return { ...r, vue, nav: NAV_VIDE, zones: [], anime: 0 };
  const z = zonesModifiees(avant.vue.contenu, vue.contenu);
  const derniere = [...vue.historique].filter((h) => !h.annulee).sort((a, b) => b.seq - a.seq)[0];
  const touches = derniere && !avant.vue.historique.some((h) => h.operationId === derniere.operationId) ? derniere.touches ?? [] : [];
  const zones = [...new Set([...z.ids, ...touches])];
  return {
    ...r, vue,
    nav: { diapo: z.diapo ?? avant.nav.diapo, feuille: z.feuille ?? avant.nav.feuille, page: z.page ?? avant.nav.page },
    zones: zones.length ? zones : avant.zones,
    anime: animer && zones.length ? vue.revision : avant.anime,
  };
}

export function Atelier({ ouvert, travaille, aOuvrir, pleinEcran, onAfficher, onFermer, onPleinEcran, onConfirmIntent }: {
  ouvert: boolean;
  travaille: boolean;
  aOuvrir: { nodeId: string; jeton: number } | null;
  pleinEcran: boolean;
  onAfficher: () => void;
  onFermer: () => void;
  onPleinEcran: () => void;
  onConfirmIntent: (intentId: string, confirmTyped?: string) => Promise<{ ok: boolean; message?: string; link?: string; error?: string }>;
}) {
  const confirmer = useConfirmer();
  const [onglets, setOnglets] = React.useState<EtatOnglet[]>([]);
  const ongletsRef = React.useRef<EtatOnglet[]>([]);
  const [actif, setActif] = React.useState<string | null>(null);
  const [second, setSecond] = React.useState<string | null>(null);
  const [coteACote, setCoteACote] = React.useState(false);
  const [occupe, setOccupe] = React.useState(false);
  const [message, setMessage] = React.useState<{ texte: string; lien?: string; ton?: "ok" | "alerte" } | null>(null);
  const [carte, setCarte] = React.useState<Carte | null>(null);
  const [comparaison, setComparaison] = React.useState<Awaited<ReturnType<typeof comparerOnglet>> | null>(null);
  const [conversions, setConversions] = React.useState<ConversionServeur[]>([]);
  const [animant, setAnimant] = React.useState<Record<string, boolean>>({});

  const poser = React.useCallback((liste: EtatOnglet[]) => { ongletsRef.current = liste; setOnglets(liste); }, []);
  const remplacer = React.useCallback((e: EtatOnglet) => {
    const liste = ongletsRef.current.some((o) => o.vue.sessionId === e.vue.sessionId)
      ? ongletsRef.current.map((o) => (o.vue.sessionId === e.vue.sessionId ? e : o))
      : [...ongletsRef.current, e];
    poser(liste);
    if (e.anime) {
      const id = e.vue.sessionId;
      setAnimant((a) => ({ ...a, [id]: true }));
      setTimeout(() => setAnimant((a) => ({ ...a, [id]: false })), ANIMATION_MS);
    }
  }, [poser]);

  /** Une vue rendue par un geste de la personne : on garde la navigation, on surligne ce qui a changé. */
  const appliquerVue = React.useCallback((vue: VueArtefact) => {
    const avant = ongletsRef.current.find((o) => o.vue.sessionId === vue.sessionId);
    if (!avant || vue.revision < avant.vue.revision) return;
    const e = etatDepuis({ ...avant, ok: true, vue }, avant, true);
    if (e) remplacer(e);
  }, [remplacer]);

  // ── LA RELECTURE : les onglets du serveur, leurs révisions, les conversions ────────────────────────
  const relire = React.useCallback(async (): Promise<void> => {
    let d: { onglets: OngletServeur[]; conversions: ConversionServeur[]; vueExacte?: boolean };
    try {
      const r = await fetch("/api/assistant-ia/atelier", { cache: "no-store" });
      if (!r.ok) return;
      d = await r.json();
    } catch { return; }
    if (d.vueExacte) return;
    setConversions(d.conversions ?? []);
    const serveur = new Map(d.onglets.map((o) => [o.sessionId, o]));
    let liste = ongletsRef.current.filter((o) => serveur.has(o.vue.sessionId));
    if (liste.length !== ongletsRef.current.length) poser(liste);
    for (const s of d.onglets) {
      const local = liste.find((o) => o.vue.sessionId === s.sessionId);
      if (local && local.vue.revision === s.revision && local.vue.dirty === s.dirty) continue;
      const r = await relireOnglet(s.sessionId).catch(sansBloquer("atelier.relireOnglet", null));
      if (!r?.ok) continue;
      const e = etatDepuis(r, local, true);
      if (!e) continue;
      remplacer(e);
      liste = ongletsRef.current;
      // Un document que l'assistant vient d'ouvrir ou de modifier : on le montre.
      if (!local || e.anime) { setActif(s.sessionId); onAfficher(); }
    }
  }, [onAfficher, poser, remplacer]);

  React.useEffect(() => {
    let arret = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const boucle = async () => {
      await relire();
      if (!arret) t = setTimeout(boucle, travaille ? 600 : 8000);
    };
    void boucle();
    return () => { arret = true; clearTimeout(t); };
  }, [relire, travaille]);

  // ── OUVRIR à la demande de l'écran (aperçu d'une pièce, résultat d'une conversion) ────────────────
  const ouvrir = React.useCallback(async (nodeId: string) => {
    setOccupe(true);
    setMessage(null);
    try {
      const r = await ouvrirDansLAtelier(nodeId);
      if (!r.ok || !r.vue) { setMessage({ texte: r.erreur ?? "Ouverture impossible.", ton: "alerte" }); return; }
      const avant = ongletsRef.current.find((o) => o.vue.sessionId === r.vue!.sessionId);
      const e = etatDepuis(r, avant);
      if (e) remplacer(e);
      setActif((a) => { if (a && a !== r.vue!.sessionId) setSecond(a); return r.vue!.sessionId; });
      onAfficher();
    } finally { setOccupe(false); }
  }, [onAfficher, remplacer]);
  React.useEffect(() => { if (aOuvrir) void ouvrir(aOuvrir.nodeId); }, [aOuvrir, ouvrir]);

  const courant = onglets.find((o) => o.vue.sessionId === actif) ?? onglets[onglets.length - 1] ?? null;
  const autre = coteACote ? onglets.find((o) => o.vue.sessionId === second && o.vue.sessionId !== courant?.vue.sessionId) ?? onglets.find((o) => o.vue.sessionId !== courant?.vue.sessionId) ?? null : null;

  const geste = async <T,>(travail: () => Promise<T>): Promise<T | null> => {
    setOccupe(true);
    setMessage(null);
    try { return await travail(); } catch { setMessage({ texte: "La connexion a été interrompue. Réessayez.", ton: "alerte" }); return null; } finally { setOccupe(false); }
  };

  const fermerOnglet = async (o: EtatOnglet) => {
    if (o.vue.dirty && !(await confirmer(`« ${o.vue.nom} » a des modifications non enregistrées. Fermer quand même ?`))) return;
    await fermerOngletAtelier(o.vue.sessionId);
    const liste = ongletsRef.current.filter((x) => x.vue.sessionId !== o.vue.sessionId);
    poser(liste);
    if (!liste.length) onFermer();
  };

  if (!ouvert) return null;

  // La revue passe par `geste` (try / catch, l'occupation relâchée en `finally`).
  const revoir = (o: EtatOnglet, seq: number, d: "ACCEPTER" | "REFUSER" | "A_REVOIR") => void geste(async () => {
    const r = await revoirModificationAtelier(o.vue.sessionId, seq, d);
    if (r.vue) appliquerVue(r.vue);
    if (!r.ok) setMessage({ texte: r.erreur ?? "", ton: "alerte" });
  });
  const toutAccepterOnglet = (o: EtatOnglet) => void geste(async () => {
    const r = await toutAccepterAtelier(o.vue.sessionId);
    if (r.vue) appliquerVue(r.vue);
  });

  const panneau = (o: EtatOnglet, principal: boolean) => (
    // Côte à côte : à partir de la tablette — sur un téléphone, deux documents empilés ne se lisent pas.
    <div key={o.vue.sessionId} className={`relative min-h-0 min-w-0 flex-1 flex-col ${principal ? "flex" : "hidden md:flex"}`} data-testid="atelier-onglet-contenu" data-format={o.vue.format}>
      <BarreOnglet
        o={o} occupe={occupe} coteACote={coteACote} peutCote={principal && onglets.length > 1}
        onCote={() => setCoteACote((c) => !c)}
        onAnnuler={() => void geste(async () => { const r = await annulerDansAtelier(o.vue.sessionId, "annuler"); if (r.vue) appliquerVue(r.vue); setMessage({ texte: r.message ?? r.erreur ?? "" }); })}
        onRetablir={() => void geste(async () => { const r = await annulerDansAtelier(o.vue.sessionId, "retablir"); if (r.vue) appliquerVue(r.vue); setMessage({ texte: r.message ?? r.erreur ?? "" }); })}
        onComparer={() => void geste(async () => setComparaison(await comparerOnglet(o.vue.sessionId)))}
        onConvertir={(vers) => void geste(async () => {
          const r = await convertirDansAtelier(o.vue.nodeId, vers, o.vue.sessionId);
          const avert = o.vue.dirty ? " (dernière version enregistrée : vos modifications en cours n'y sont pas)" : "";
          setMessage(r.ok
            ? { texte: r.etat === "EN_FILE" ? `Conversion en file — ${r.libelleVoie} ; ${r.note}.${avert}` : `Converti par ${r.libelleVoie} : « ${r.resultat?.nom} »${r.note ? ` — ${r.note}` : ""}.${avert}`, lien: r.resultat ? `/drive/${r.resultat.nodeId}` : undefined, ton: "ok" }
            : { texte: r.motif ?? "La conversion a échoué.", ton: "alerte" });
          void relire();
        })}
        onEnregistrer={() => void geste(async () => {
          const r = await enregistrerOnglet(o.vue.sessionId);
          if (r.ok) { if (r.vue) appliquerVue(r.vue); setMessage({ texte: r.message, lien: r.nodeId ? `/drive/${r.nodeId}` : undefined, ton: "ok" }); return; }
          if ("carte" in r) { setCarte(r.carte); return; }
          setMessage({ texte: r.erreur, ton: "alerte" });
        })}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <SceneAtelier vue={o.vue} nav={o.nav} zones={o.zones} anime={Boolean(animant[o.vue.sessionId])}
          onNav={(n) => remplacer({ ...o, nav: { ...o.nav, ...n } })} />
      </div>
      <RevueModifications vue={o.vue} occupe={occupe}
        onRevoir={(seq, d) => revoir(o, seq, d)} onToutAccepter={() => toutAccepterOnglet(o)} />
      {principal && comparaison && <ComparaisonAtelier vue={o.vue} c={comparaison} onFermer={() => setComparaison(null)} />}
    </div>
  );

  return (
    <section aria-label="Atelier — documents" data-testid="atelier" className="atelier relative flex h-full min-h-0 w-full flex-col bg-white lg:bg-white/95 dark:bg-zinc-950 lg:dark:bg-zinc-950/95">
      <header className="flex items-center gap-1 border-b border-slate-200 px-2 pt-1.5 dark:border-zinc-800">
        <Sparkles className="mx-1 h-4 w-4 shrink-0 text-violet-600" aria-hidden />
        <div role="tablist" aria-label="Documents ouverts" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {onglets.map((o) => {
            const choisi = o.vue.sessionId === courant?.vue.sessionId;
            return (
              <div key={o.vue.sessionId} className={`group flex max-w-[14rem] shrink-0 items-center rounded-t-lg border border-b-0 ${choisi ? "border-slate-200 bg-white dark:border-zinc-700 dark:bg-zinc-900" : "border-transparent bg-slate-100/70 dark:bg-zinc-900/40"}`}>
                <button type="button" role="tab" aria-selected={choisi} data-testid="atelier-onglet"
                  onClick={() => { if (courant && courant.vue.sessionId !== o.vue.sessionId) setSecond(courant.vue.sessionId); setActif(o.vue.sessionId); }}
                  className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-xs text-slate-700 dark:text-zinc-200">
                  <Icone format={o.vue.format} className="h-3.5 w-3.5 shrink-0 text-violet-600" />
                  <span className="truncate" title={`${o.vue.nom} (${nomFormat(o.vue.format)})`}>{o.vue.nom}</span>
                  {o.vue.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-label="modifié" />}
                  {animant[o.vue.sessionId] && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-violet-500" aria-label="l'assistant modifie ce document" />}
                </button>
                <button type="button" onClick={() => void fermerOnglet(o)} aria-label={`Fermer ${o.vue.nom}`} className="mr-1 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-zinc-800"><X className="h-3 w-3" /></button>
              </div>
            );
          })}
        </div>
        <button type="button" onClick={onPleinEcran} aria-pressed={pleinEcran} aria-label={pleinEcran ? "Quitter le plein écran" : "Plein écran"} title={pleinEcran ? "Quitter le plein écran" : "Plein écran"} className="hidden h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:flex dark:hover:bg-zinc-800">
          {pleinEcran ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button type="button" onClick={onFermer} aria-label="Masquer l'Atelier" title="Masquer l'Atelier" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800"><X className="h-4 w-4" /></button>
      </header>

      {!courant && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-500 dark:text-zinc-400">
          <Sparkles className="h-6 w-6 text-violet-500" aria-hidden />
          <p>Aucun document ouvert. Ouvrez une pièce (« Ouvrir dans l&apos;Atelier ») ou demandez à l&apos;assistant de modifier un document : il s&apos;affichera ici, et chaque modification apparaîtra en direct.</p>
        </div>
      )}
      {courant && (
        <div className={`flex min-h-0 flex-1 ${autre ? "flex-col divide-y divide-slate-200 md:flex-row md:divide-x md:divide-y-0 dark:divide-zinc-800" : ""}`}>
          {panneau(courant, true)}
          {autre && panneau(autre, false)}
        </div>
      )}

      {carte && (
        <div className="border-t border-slate-200 p-2 dark:border-zinc-800" data-testid="atelier-carte">
          <ActionConfirmationCard intentId={carte.id} kind={carte.kind} title={carte.title} fields={carte.fields} warnings={carte.warnings} libelleBouton={carte.libelleBouton}
            onConfirm={async (id, t) => {
              try {
                const r = await onConfirmIntent(id, t);
                if (r.ok) { setCarte(null); setMessage({ texte: r.message ?? "Enregistré.", lien: r.link, ton: "ok" }); void relire(); }
                return r;
              } catch {
                return { ok: false, error: "La connexion a été interrompue. Réessayez." };
              }
            }} />
        </div>
      )}
      <p role="status" aria-live="polite" data-testid="atelier-message"
        className={message?.texte ? `flex items-center gap-2 border-t px-3 py-1.5 text-xs [overflow-wrap:anywhere] ${message.ton === "alerte" ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "border-slate-200 bg-slate-50 text-slate-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"}` : "sr-only"}>
        {message?.texte}
        {message?.lien && <a href={message.lien} target="_blank" rel="noopener" className="inline-flex shrink-0 items-center gap-1 font-medium text-violet-700 hover:underline dark:text-violet-300">Drive <ExternalLink className="h-3 w-3" /></a>}
      </p>
      {conversions.some((c) => c.etat === "EN_FILE" || c.etat === "EN_COURS") && (
        <p className="border-t border-slate-200 px-3 py-1 text-[11px] text-slate-500 dark:border-zinc-800">
          {conversions.filter((c) => c.etat === "EN_FILE" || c.etat === "EN_COURS").map((c) => `Conversion vers ${c.vers} en cours (${c.libelleVoie})`).join(" · ")}
        </p>
      )}
    </section>
  );
}
