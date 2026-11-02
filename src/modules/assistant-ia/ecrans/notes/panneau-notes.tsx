"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CheckSquare, ChevronLeft, ChevronRight, Heading, History, List, Loader2, MoreHorizontal, NotebookPen, Pencil, Pilcrow, Plus, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import { useConfirmer } from "@/components/ui/dialogue";
import { sansBloquer } from "@/lib/journal";
import {
  accepterPropositionNote, annulerPropositionNote, creerMaPage, enregistrerMaPage, etatMesNotes, lireMaVersion, maCorbeille, oublierDeMaCorbeille,
  refuserPropositionNote, renommerMaPage, reordonnerMesPages, restaurerDeMaCorbeille, restaurerMaVersion, supprimerMaPage, toutAccepterNotes, versionsDeMaPage,
} from "@/modules/assistant-ia/actions-notes";
import { blocVide, indexDe, memesBlocs, type BlocNote, type TypeBloc } from "../../domaine/notes/blocs";
import type { PropositionNote } from "../../domaine/notes/gestes";
import { EditeurNotes } from "./editeur-notes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PANNEAU « MES NOTES » (décision 0026) — chargé À LA DEMANDE (la coque ne paie pas l'éditeur).
 *
 * Les pages (créer, nommer, renommer, réordonner, supprimer), l'éditeur, l'enregistrement automatique
 * (« Enregistrement… / Enregistré »), l'historique des versions, la corbeille (30 jours) — et les modifications
 * PROPOSÉES par l'assistant : surlignées dans la page, Accepter / Refuser, « Tout accepter », puis « Annuler ».
 * À côté de la conversation sur ordinateur ; plein écran sur téléphone.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type ResumePage = { id: string; titre: string; rang: number; cases: { total: number; faites: number } };
type Page = { id: string; titre: string; blocs: BlocNote[]; version: number };
type Sauvegarde = "enregistre" | "enregistrement" | "erreur";

const DELAI_ENREGISTREMENT_MS = 700;
const bouton = "inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800";
const boutonIcone = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800";

const AJOUTS: { type: TypeBloc; libelle: string; icone: React.ReactNode }[] = [
  { type: "tache", libelle: "Tâche", icone: <CheckSquare className="h-3.5 w-3.5" /> },
  { type: "puce", libelle: "Puce", icone: <List className="h-3.5 w-3.5" /> },
  { type: "texte", libelle: "Texte", icone: <Pilcrow className="h-3.5 w-3.5" /> },
  { type: "titre", libelle: "Titre", icone: <Heading className="h-3.5 w-3.5" /> },
];

const quand = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });

export default function PanneauNotes({ onFermer, travaille, onEnAttente }: {
  onFermer: () => void;
  /** L'assistant travaille : on relit plus souvent (une proposition peut arriver). */
  travaille: boolean;
  onEnAttente?: (n: number) => void;
}) {
  const confirmer = useConfirmer();
  const [pages, setPages] = useState<ResumePage[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [blocs, setBlocs] = useState<BlocNote[]>([]);
  const [propositions, setPropositions] = useState<PropositionNote[]>([]);
  const [sauvegarde, setSauvegarde] = useState<Sauvegarde>("enregistre");
  const [message, setMessage] = useState<string | null>(null);
  const [vue, setVue] = useState<"page" | "historique" | "corbeille">("page");
  const [renommage, setRenommage] = useState<{ id: string | null; titre: string } | null>(null);
  const [menuPage, setMenuPage] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [aFocaliser, setAFocaliser] = useState<{ id: string; jeton: number } | null>(null);
  const [neuves, setNeuves] = useState<Set<string>>(new Set());
  const [occupe, setOccupe] = useState(false);

  // L'état d'écriture vit aussi dans des références : l'enregistrement et la relecture se lisent sans attendre un rendu.
  const etat = useRef({ page: null as Page | null, blocs: [] as BlocNote[], sale: false, enVol: null as Promise<void> | null });
  const minuteur = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const appliquerEtat = useCallback((r: Awaited<ReturnType<typeof etatMesNotes>>, forcer = false) => {
    if (!r.ok) { setMessage(r.erreur ?? "Vos notes n'ont pas pu être lues."); return; }
    setPages(r.pages ?? []);
    setPropositions(r.propositions ?? []);
    onEnAttente?.((r.propositions ?? []).filter((p) => p.etat === "PROPOSEE").length);
    const p = r.page;
    if (!p) return;
    const e = etat.current;
    // Ne jamais écraser une frappe pas encore enregistrée : la version du serveur attend l'enregistrement.
    if (!forcer && e.sale && e.page?.id === p.id) return;
    if (forcer || !e.page || e.page.id !== p.id || e.page.version !== p.version) {
      e.page = { id: p.id, titre: p.titre, blocs: p.blocs, version: p.version };
      e.blocs = p.blocs.length ? p.blocs : [blocVide("texte")];
      setPage(e.page);
      setBlocs(e.blocs);
    } else if (e.page.titre !== p.titre) {
      e.page = { ...e.page, titre: p.titre };
      setPage(e.page);
    }
  }, [onEnAttente]);

  const relire = useCallback(async (pageId?: string, forcer = false) => {
    const r = await etatMesNotes(pageId ?? etat.current.page?.id);
    appliquerEtat(r, forcer);
  }, [appliquerEtat]);

  /** ENREGISTRER maintenant ce qui attend (avant de changer de page ou de décider d'une proposition). */
  const enregistrer = useCallback(async (): Promise<void> => {
    clearTimeout(minuteur.current);
    const e = etat.current;
    if (e.enVol) await e.enVol;
    if (!e.sale || !e.page) return;
    const page = e.page;
    const envoyes = e.blocs;
    e.sale = false;
    setSauvegarde("enregistrement");
    e.enVol = (async () => {
      try {
        const r = await enregistrerMaPage(page.id, page.version, JSON.stringify(envoyes));
        if (r.ok && r.page) {
          e.page = { ...page, blocs: envoyes, version: r.page.version };
          setPage(e.page);
          setSauvegarde(e.sale ? "enregistrement" : "enregistre");
        } else if (r.conflit) {
          // Modifiée ailleurs (un autre onglet, un autre appareil) : la page à jour s'affiche, rien n'est écrasé.
          e.page = { id: r.conflit.id, titre: r.conflit.titre, blocs: r.conflit.blocs, version: r.conflit.version };
          e.blocs = r.conflit.blocs;
          setPage(e.page);
          setBlocs(e.blocs);
          setSauvegarde("enregistre");
          setMessage("La page a été modifiée ailleurs : la version à jour est affichée. Votre dernière frappe n'a pas été enregistrée.");
        } else {
          e.sale = true;
          setSauvegarde("erreur");
          setMessage(r.erreur ?? "Enregistrement impossible.");
        }
      } catch {
        e.sale = true;
        setSauvegarde("erreur");
      } finally {
        e.enVol = null;
      }
    })();
    await e.enVol;
    if (e.sale) minuteur.current = setTimeout(() => void enregistrer(), DELAI_ENREGISTREMENT_MS);
  }, []);

  const modifier = useCallback((nouveaux: BlocNote[]) => {
    const e = etat.current;
    e.blocs = nouveaux;
    setBlocs(nouveaux);
    // Rien de changé depuis le dernier enregistrement (un retour arrière qui annule une frappe) : rien à envoyer.
    if (e.page && !e.sale && memesBlocs(nouveaux, e.page.blocs)) return;
    e.sale = true;
    setSauvegarde("enregistrement");
    clearTimeout(minuteur.current);
    minuteur.current = setTimeout(() => void enregistrer(), DELAI_ENREGISTREMENT_MS);
  }, [enregistrer]);

  // Ouverture, relecture (plus vive quand l'assistant travaille), et sur demande (une carte de la conversation a décidé).
  useEffect(() => {
    void relire().catch(sansBloquer("notes.relire"));
    const t = setInterval(() => { if (!etat.current.sale) void relire().catch(sansBloquer("notes.relire")); }, travaille ? 2_000 : 15_000);
    const surDemande = () => void relire().catch(sansBloquer("notes.relire"));
    window.addEventListener("notes:relire", surDemande);
    return () => { clearInterval(t); window.removeEventListener("notes:relire", surDemande); };
  }, [relire, travaille]);

  // En partant (fermeture du panneau, page quittée) : ce qui attend part.
  useEffect(() => () => { void enregistrer(); }, [enregistrer]);
  useEffect(() => {
    const avant = (ev: BeforeUnloadEvent) => { if (etat.current.sale) { void enregistrer(); ev.preventDefault(); } };
    window.addEventListener("beforeunload", avant);
    return () => window.removeEventListener("beforeunload", avant);
  }, [enregistrer]);

  const changerDePage = async (id: string) => {
    await enregistrer();
    setVue("page");
    setMenuPage(false);
    await relire(id, true);
  };

  const ajouter = (type: TypeBloc) => {
    const b = blocVide(type, 0);
    const i = active ? indexDe(blocs, active) : -1;
    const niveau = i >= 0 && type !== "titre" ? blocs[i].niveau : 0;
    const nouveau = { ...b, niveau };
    // Une page vide n'a qu'une ligne vide : elle devient la ligne demandée.
    const seuleVide = blocs.length === 1 && !blocs[0].texte;
    modifier(seuleVide ? [{ ...nouveau, id: blocs[0].id }] : i >= 0 ? [...blocs.slice(0, i + 1), nouveau, ...blocs.slice(i + 1)] : [...blocs, nouveau]);
    setAFocaliser({ id: seuleVide ? blocs[0].id : nouveau.id, jeton: Date.now() });
  };

  /** DÉCIDER d'une proposition de l'assistant — la frappe en attente part d'abord. */
  const decider = async (id: string, decision: "accepter" | "refuser" | "annuler") => {
    setOccupe(true);
    setMessage(null);
    try {
      await enregistrer();
      const p = propositions.find((x) => x.id === id);
      const r = decision === "accepter" ? await accepterPropositionNote(id) : decision === "refuser" ? await refuserPropositionNote(id) : await annulerPropositionNote(id);
      if (!r.ok) setMessage(r.erreur ?? "Rien n'a été fait.");
      if (r.ok && decision === "accepter" && p?.cible.id) {
        setNeuves(new Set([p.cible.id]));
        setTimeout(() => setNeuves(new Set()), 2_500);
      }
      // Une page proposée et acceptée : on y va.
      await relire(decision === "accepter" && p?.geste === "creer_page" && p.pageId ? p.pageId : undefined, true);
      window.dispatchEvent(new Event("assistant-fil:relancer"));
    } finally {
      setOccupe(false);
    }
  };

  const toutAccepter = async () => {
    setOccupe(true);
    try {
      await enregistrer();
      const r = await toutAccepterNotes();
      if (!r.ok) setMessage(r.erreur ?? "Certaines propositions ne s'appliquent plus.");
      await relire(undefined, true);
      window.dispatchEvent(new Event("assistant-fil:relancer"));
    } finally {
      setOccupe(false);
    }
  };

  const validerRenommage = async () => {
    if (!renommage) return;
    const titre = renommage.titre.trim();
    setRenommage(null);
    if (!titre) return;
    if (renommage.id) {
      const r = await renommerMaPage(renommage.id, titre);
      if (!r.ok) setMessage(r.erreur ?? "Renommage impossible.");
      await relire(undefined, true);
    } else {
      await enregistrer();
      const r = await creerMaPage(titre);
      if (!r.ok || !r.page) { setMessage(r.erreur ?? "Création impossible."); return; }
      await relire(r.page.id, true);
    }
  };

  const deplacerPage = async (sens: -1 | 1) => {
    if (!page) return;
    const ids = pages.map((p) => p.id);
    const i = ids.indexOf(page.id);
    const j = i + sens;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await reordonnerMesPages(ids);
    if (r.ok && r.pages) setPages(r.pages);
  };

  const supprimerPage = async () => {
    if (!page) return;
    setMenuPage(false);
    if (!(await confirmer(`Mettre la page « ${page.titre} » à la corbeille ? Vous pourrez la restaurer pendant 30 jours.`))) return;
    await enregistrer();
    const r = await supprimerMaPage(page.id);
    if (!r.ok) setMessage(r.erreur ?? "Suppression impossible.");
    etat.current.page = null;
    await relire(undefined, true);
  };

  // Échap ferme le panneau (sauf pendant un renommage).
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && !renommage) onFermer(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onFermer, renommage]);

  const enAttente = propositions.filter((p) => p.etat === "PROPOSEE");
  const acceptees = propositions.filter((p) => p.etat === "ACCEPTEE").slice(-3).reverse();
  const pagesProposees = enAttente.filter((p) => p.geste === "creer_page");
  const titreDe = (pageId: string | null) => pages.find((p) => p.id === pageId)?.titre ?? pagesProposees.find((p) => p.pageId === pageId)?.cible.titre ?? "";
  const dansLaPage = page ? enAttente.filter((p) => p.pageId === page.id) : [];

  return (
    <aside aria-label="Mes notes" data-testid="notes-panneau" className="flex h-full min-h-0 w-full flex-col bg-white dark:bg-zinc-950">
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-zinc-800">
        {vue !== "page" ? (
          <button type="button" onClick={() => setVue("page")} aria-label="Retour aux notes" className={boutonIcone}><ArrowLeft className="h-4 w-4" /></button>
        ) : <NotebookPen aria-hidden className="ml-1 h-4 w-4 text-violet-600 dark:text-violet-400" />}
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-slate-900 dark:text-zinc-100">
          {vue === "historique" ? `Historique — ${page?.titre ?? ""}` : vue === "corbeille" ? "Corbeille (30 jours)" : "Mes notes"}
        </h2>
        <span aria-live="polite" data-testid="notes-sauvegarde" className="text-[12px] text-slate-500 dark:text-zinc-400">
          {sauvegarde === "enregistrement" ? "Enregistrement…" : sauvegarde === "erreur" ? "Non enregistré" : "Enregistré"}
        </span>
        <button type="button" onClick={onFermer} aria-label="Fermer mes notes" className={boutonIcone}><X className="h-4 w-4" /></button>
      </header>

      {vue === "page" && (
        <>
          <div role="tablist" aria-label="Pages de notes" className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 px-2 py-1.5 dark:border-zinc-800">
            {pages.map((p) => (
              renommage?.id === p.id ? (
                <ChampNom
                  key={p.id} libelle="Nom de la page" valeur={renommage.titre} onChange={(titre) => setRenommage({ id: p.id, titre })}
                  onValider={() => void validerRenommage()} onRenoncer={() => setRenommage(null)}
                />
              ) : (
                <button
                  key={p.id} type="button" role="tab" aria-selected={page?.id === p.id} data-testid="notes-onglet"
                  onClick={() => void changerDePage(p.id)}
                  onDoubleClick={() => setRenommage({ id: p.id, titre: p.titre })}
                  onKeyDown={(e) => { if (e.key === "F2") setRenommage({ id: p.id, titre: p.titre }); }}
                  className={`h-8 shrink-0 rounded-lg px-2.5 text-[13px] font-medium ${page?.id === p.id ? "bg-violet-50 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200" : "text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                >
                  {p.titre}{p.cases.total > 0 && <span className="ml-1 text-[11px] font-normal text-slate-400">{p.cases.faites}/{p.cases.total}</span>}
                </button>
              )
            ))}
            {pagesProposees.map((p) => (
              <span key={p.id} data-testid="notes-onglet-propose" className="h-8 shrink-0 rounded-lg border border-dashed border-amber-400 bg-amber-50 px-2.5 text-[13px] leading-8 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {p.cible.titre} <span className="text-[11px]">(proposée)</span>
              </span>
            ))}
            {renommage?.id === null ? (
              <ChampNom
                libelle="Nom de la nouvelle page" valeur={renommage.titre} onChange={(titre) => setRenommage({ id: null, titre })}
                onValider={() => void validerRenommage()} onRenoncer={() => setRenommage(null)}
              />
            ) : (
              <button type="button" onClick={() => setRenommage({ id: null, titre: "" })} aria-label="Nouvelle page" title="Nouvelle page" className={boutonIcone}><Plus className="h-4 w-4" /></button>
            )}
            <div className="relative ml-auto">
              <button type="button" onClick={() => setMenuPage((o) => !o)} aria-expanded={menuPage} aria-label="Options de la page" className={boutonIcone}><MoreHorizontal className="h-4 w-4" /></button>
              {menuPage && page && (
                <div role="menu" className="absolute right-0 top-10 z-20 w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
                  <button type="button" role="menuitem" onClick={() => { setMenuPage(false); setRenommage({ id: page.id, titre: page.titre }); }} className={`${bouton} w-full justify-start`}><Pencil className="h-3.5 w-3.5" /> Renommer</button>
                  <button type="button" role="menuitem" onClick={() => void deplacerPage(-1)} className={`${bouton} w-full justify-start`}><ChevronLeft className="h-3.5 w-3.5" /> Avancer la page</button>
                  <button type="button" role="menuitem" onClick={() => void deplacerPage(1)} className={`${bouton} w-full justify-start`}><ChevronRight className="h-3.5 w-3.5" /> Reculer la page</button>
                  <button type="button" role="menuitem" onClick={() => void supprimerPage()} className={`${bouton} w-full justify-start text-red-700 dark:text-red-400`}><Trash2 className="h-3.5 w-3.5" /> Mettre à la corbeille</button>
                </div>
              )}
            </div>
          </div>

          {enAttente.length > 0 && (
            <section aria-label="Modifications proposées par l'assistant" data-testid="notes-propositions" className="border-b border-amber-200 bg-amber-50/70 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
              <div className="flex items-center gap-2">
                <p className="flex-1 text-[13px] font-medium text-amber-900 dark:text-amber-200">
                  L&apos;assistant propose {enAttente.length > 1 ? `${enAttente.length} modifications` : "une modification"}
                </p>
                {enAttente.length > 1 && (
                  <button type="button" disabled={occupe} onClick={() => void toutAccepter()} data-testid="notes-tout-accepter" className="inline-flex h-8 items-center gap-1 rounded-lg bg-violet-600 px-2.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-60">
                    <Check className="h-3.5 w-3.5" /> Tout accepter
                  </button>
                )}
              </div>
              <ul className="mt-1.5 space-y-1">
                {enAttente.map((p) => (
                  <li key={p.id} data-testid="note-proposition" className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-zinc-300">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{p.resume}</span>
                    {p.pageId !== page?.id && p.geste !== "creer_page" && p.pageId && titreDe(p.pageId) && (
                      <button type="button" onClick={() => void changerDePage(p.pageId!)} className="text-violet-700 underline dark:text-violet-300">Voir</button>
                    )}
                    <button type="button" disabled={occupe} onClick={() => void decider(p.id, "accepter")} className="inline-flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2 font-medium text-white hover:bg-violet-700 disabled:opacity-60"><Check className="h-3 w-3" /> Accepter</button>
                    <button type="button" disabled={occupe} onClick={() => void decider(p.id, "refuser")} className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-medium text-slate-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-900"><X className="h-3 w-3" /> Refuser</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-zinc-800" role="toolbar" aria-label="Ajouter une ligne">
            {AJOUTS.map((a) => (
              <button key={a.type} type="button" onClick={() => ajouter(a.type)} className={bouton}>{a.icone} {a.libelle}</button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
            {page ? (
              <EditeurNotes
                blocs={blocs} onChange={modifier} propositions={dansLaPage} onDecider={(id, d) => void decider(id, d)}
                neuves={neuves} onActive={setActive} aFocaliser={aFocaliser}
              />
            ) : (
              <p className="flex items-center gap-2 px-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Ouverture de vos notes…</p>
            )}
          </div>

          {acceptees.length > 0 && (
            <ul aria-label="Modifications de l'assistant acceptées" className="space-y-1 border-t border-slate-200 px-3 py-2 dark:border-zinc-800">
              {acceptees.map((p) => (
                <li key={p.id} data-testid="note-acceptee" className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-zinc-400">
                  <Check className="h-3 w-3 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1 truncate">{p.resume}</span>
                  <button type="button" disabled={occupe} onClick={() => void decider(p.id, "annuler")} className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 font-medium text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
                    <Undo2 className="h-3 w-3" /> Annuler
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {vue === "historique" && page && <Historique pageId={page.id} onRestaure={async () => { setVue("page"); await relire(page.id, true); }} />}
      {vue === "corbeille" && <VueCorbeille onRestaure={async () => { await relire(undefined, true); }} />}

      {message && <p role="status" className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">{message} <button type="button" onClick={() => setMessage(null)} className="underline">OK</button></p>}

      <footer className="flex items-center gap-1 border-t border-slate-200 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
        <button type="button" onClick={async () => { await enregistrer(); setVue("historique"); }} disabled={!page} className={bouton}><History className="h-3.5 w-3.5" /> Historique</button>
        <button type="button" onClick={async () => { await enregistrer(); setVue("corbeille"); }} className={bouton}><Trash2 className="h-3.5 w-3.5" /> Corbeille</button>
        <span className="ml-auto px-1 text-[11px] text-slate-400">Privées : vous seul les voyez.</span>
      </footer>
    </aside>
  );
}

/** Le nom d'une page, saisi en place (nouvelle page, renommage) : Entrée valide, Échap renonce. */
function ChampNom({ libelle, valeur, onChange, onValider, onRenoncer }: { libelle: string; valeur: string; onChange: (v: string) => void; onValider: () => void; onRenoncer: () => void }) {
  return (
    <input
      autoFocus value={valeur} maxLength={80} aria-label={libelle} placeholder="Nom de la page"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onValider}
      onKeyDown={(e) => { if (e.key === "Enter") onValider(); if (e.key === "Escape") onRenoncer(); }}
      className="h-8 w-36 shrink-0 rounded-lg border border-violet-400 bg-white px-2 text-[13px] outline-none dark:bg-zinc-900"
    />
  );
}

const LIBELLE_AUTEUR: Record<string, string> = {
  PERSONNE: "Avant vos modifications",
  IA: "Avant une modification de l'assistant",
  RESTAURATION: "Avant une restauration",
};

function Historique({ pageId, onRestaure }: { pageId: string; onRestaure: () => Promise<void> }) {
  const [versions, setVersions] = useState<{ id: string; version: number; auteur: string; creeLe: string; lignes: number; apercu: string }[] | null>(null);
  const [vue, setVue] = useState<{ id: string; blocs: BlocNote[] } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => { void versionsDeMaPage(pageId).then((r) => setVersions(r.versions ?? [])).catch(sansBloquer("notes.versions")); }, [pageId]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="notes-historique">
      {versions === null && <p className="text-[13px] text-slate-500">Chargement…</p>}
      {versions?.length === 0 && <p className="text-[13px] text-slate-500">Pas encore de version : elles se gardent au fil de vos modifications (au plus une toutes les 5 minutes) et avant chaque modification de l&apos;assistant.</p>}
      <ul className="space-y-1.5">
        {versions?.map((v) => (
          <li key={v.id} className="rounded-lg border border-slate-200 p-2 dark:border-zinc-800">
            <button type="button" onClick={async () => { const r = await lireMaVersion(v.id); if (r.ok && r.blocs) setVue({ id: v.id, blocs: r.blocs }); }} className="w-full text-left">
              <p className="text-[13px] font-medium text-slate-800 dark:text-zinc-100">{quand(v.creeLe)} — {LIBELLE_AUTEUR[v.auteur] ?? v.auteur}</p>
              <p className="truncate text-[12px] text-slate-500">{v.lignes} ligne{v.lignes > 1 ? "s" : ""}{v.apercu ? ` · ${v.apercu}` : ""}</p>
            </button>
            {vue?.id === v.id && (
              <div className="mt-2 rounded-md bg-slate-50 p-2 dark:bg-zinc-900">
                <EditeurNotes blocs={vue.blocs} onChange={() => {}} propositions={[]} onDecider={() => {}} neuves={new Set()} enLecture />
                <button
                  type="button" className={`${bouton} mt-1`}
                  onClick={async () => { const r = await restaurerMaVersion(v.id); if (r.ok) await onRestaure(); else setErreur(r.erreur ?? "Restauration impossible."); }}
                ><RotateCcw className="h-3.5 w-3.5" /> Restaurer cette version</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {erreur && <p role="alert" className="mt-2 text-[12.5px] text-red-700">{erreur}</p>}
    </div>
  );
}

function VueCorbeille({ onRestaure }: { onRestaure: () => Promise<void> }) {
  const [c, setC] = useState<Awaited<ReturnType<typeof maCorbeille>>["corbeille"] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const charger = useCallback(() => void maCorbeille().then((r) => setC(r.corbeille ?? { pages: [], lignes: [] })).catch(sansBloquer("notes.corbeille")), []);
  useEffect(charger, [charger]);
  const agir = async (geste: "restaurer" | "oublier", quoi: "page" | "ligne", id: string) => {
    const r = geste === "restaurer" ? await restaurerDeMaCorbeille(quoi, id) : await oublierDeMaCorbeille(quoi, id);
    if (!r.ok) setErreur(r.erreur ?? "Rien n'a été fait.");
    charger();
    if (geste === "restaurer") await onRestaure();
  };
  const vide = c && !c.pages.length && !c.lignes.length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="notes-corbeille">
      {!c && <p className="text-[13px] text-slate-500">Chargement…</p>}
      {vide && <p className="text-[13px] text-slate-500">La corbeille est vide. Une page ou une ligne supprimée y reste 30 jours.</p>}
      <ul className="space-y-1.5">
        {c?.pages.map((p) => (
          <li key={p.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 text-[13px] dark:border-zinc-800">
            <span className="min-w-0 flex-1"><span className="font-medium">Page « {p.titre} »</span> <span className="text-[12px] text-slate-500">· {p.lignes} lignes · encore {p.joursRestants} j</span></span>
            <button type="button" onClick={() => void agir("restaurer", "page", p.id)} className={bouton}><RotateCcw className="h-3.5 w-3.5" /> Restaurer</button>
            <button type="button" onClick={() => void agir("oublier", "page", p.id)} aria-label={`Supprimer définitivement la page ${p.titre}`} className={bouton}><X className="h-3.5 w-3.5" /></button>
          </li>
        ))}
        {c?.lignes.map((l) => (
          <li key={l.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 text-[13px] dark:border-zinc-800">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{l.texte} <span className="text-[12px] text-slate-500">· {l.page} · encore {l.joursRestants} j</span></span>
            <button type="button" onClick={() => void agir("restaurer", "ligne", l.id)} className={bouton}><RotateCcw className="h-3.5 w-3.5" /> Restaurer</button>
            <button type="button" onClick={() => void agir("oublier", "ligne", l.id)} aria-label="Supprimer définitivement" className={bouton}><X className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ul>
      {erreur && <p role="alert" className="mt-2 text-[12.5px] text-red-700">{erreur}</p>}
    </div>
  );
}
