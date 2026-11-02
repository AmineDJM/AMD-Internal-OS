"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, EyeOff, Folder, FolderPlus, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { grouperConversations, type ConversationResumee } from "../../domaine/conversations";
import type { EtatConversations } from "./use-conversations";
import { useConfirmer } from "@/components/ui/dialogue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA LISTE DES CONVERSATIONS (décision 0027) — la barre de gauche de l'app Adventum IA et de l'écran `/assistant`.
 *
 * Nouvelle conversation, recherche (titres et contenu), dossiers, puis les conversations regroupées par date
 * (Épinglées / Aujourd'hui / 7 derniers jours / Plus ancien). Chaque conversation a son menu : renommer, épingler,
 * ranger dans un dossier, archiver, supprimer. Couleurs : les jetons du thème Adventum IA (`app/theme.css`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ListeConversationsProps {
  etat: EtatConversations;
  courante: string | null;
  onOuvrir: (id: string) => void;
  onNouvelle: (dossierId?: string | null) => void;
  onDossier: (id: string | null) => void;
  /** Le dossier ouvert : la liste ne montre que ses conversations. */
  dossierOuvert: string | null;
  /** Un dossier créé depuis la liste : l'écran ouvre son panneau. */
  onCreerDossier: () => void;
  pied?: React.ReactNode;
  entete?: React.ReactNode;
}

export function ListeConversations({ etat, courante, onOuvrir, onNouvelle, onDossier, dossierOuvert, onCreerDossier, pied, entete }: ListeConversationsProps) {
  const [maintenant, setMaintenant] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setMaintenant(new Date()), 60_000); return () => clearInterval(t); }, []);
  const visibles = useMemo(
    () => (dossierOuvert ? etat.conversations.filter((c) => c.dossierId === dossierOuvert) : etat.conversations),
    [etat.conversations, dossierOuvert],
  );
  const groupes = useMemo(() => grouperConversations(visibles, maintenant), [visibles, maintenant]);
  const dossier = etat.dossiers.find((d) => d.id === dossierOuvert) ?? null;

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col bg-[var(--aia-cote)] text-[var(--aia-texte)]">
      {entete}
      <div className="flex flex-col gap-2 px-2.5 pb-2">
        <button
          type="button" onClick={() => onNouvelle(dossierOuvert)} data-testid="nouvelle-conversation"
          className="flex items-center gap-2 rounded-[10px] border border-[var(--aia-filet)] bg-[var(--aia-panneau)] px-3 py-2.5 text-left text-[14px] font-medium hover:bg-[var(--aia-survol)]"
        >
          <Plus className="h-4 w-4" aria-hidden /> Nouvelle conversation
        </button>
        <label className="relative block">
          <span className="sr-only">Rechercher dans les conversations</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--aia-discret)]" aria-hidden />
          <input
            type="search" value={etat.recherche} onChange={(e) => etat.setRecherche(e.target.value)}
            placeholder="Rechercher dans les conversations"
            className="w-full rounded-[10px] border border-[var(--aia-filet)] bg-[var(--aia-panneau)] py-2 pl-8 pr-3 text-[14px] text-[var(--aia-texte)] outline-none placeholder:text-[var(--aia-discret)] focus-visible:ring-2 focus-visible:ring-[var(--aia-accent)]"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3">
        {etat.erreur && <p role="alert" className="mx-2 mb-2 rounded-md bg-[var(--aia-prive-doux)] px-2 py-1.5 text-[12px] text-[var(--aia-danger)]">{etat.erreur}</p>}

        {etat.trouvees ? (
          <section aria-label="Résultats de la recherche">
            <h3 className="px-2 pb-1 pt-2.5 text-[11.5px] font-semibold text-[var(--aia-discret)]">
              {etat.trouvees.length ? `${etat.trouvees.length} résultat${etat.trouvees.length > 1 ? "s" : ""}` : "Aucun résultat"}
            </h3>
            {etat.trouvees.map((c) => (
              <LigneConversation key={c.id} c={c} active={c.id === courante} etat={etat} onOuvrir={onOuvrir} />
            ))}
          </section>
        ) : (
          <>
            <section aria-label="Dossiers" className="pb-1">
              <div className="flex items-center px-2 pb-1 pt-2.5">
                <h3 className="flex-1 text-[11.5px] font-semibold text-[var(--aia-discret)]">Dossiers</h3>
                <button type="button" onClick={onCreerDossier} aria-label="Nouveau dossier" title="Nouveau dossier"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--aia-discret)] hover:bg-[var(--aia-survol)]">
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>
              </div>
              {etat.dossiers.map((d) => (
                <button
                  key={d.id} type="button" onClick={() => onDossier(dossierOuvert === d.id ? null : d.id)} aria-pressed={dossierOuvert === d.id}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[14px] hover:bg-[var(--aia-survol)] aria-pressed:bg-[var(--aia-accent-doux)] aria-pressed:text-[var(--aia-accent)]"
                >
                  <Folder className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{d.nom}</span>
                  <span className="font-mono text-[10.5px] text-[var(--aia-discret)]">{d.conversations}</span>
                </button>
              ))}
              {!etat.dossiers.length && etat.charge && (
                <p className="px-2 py-1 text-[12px] text-[var(--aia-discret)]">Rangez vos conversations, avec des consignes et des documents propres.</p>
              )}
            </section>

            {dossier && (
              <p className="mx-2 mb-1 mt-2 rounded-md bg-[var(--aia-accent-doux)] px-2 py-1.5 text-[12px] text-[var(--aia-accent)]">
                Dossier « {dossier.nom} » ·{" "}
                <button type="button" className="underline" onClick={() => onDossier(null)}>toutes les conversations</button>
              </p>
            )}

            {groupes.map((g) => (
              <section key={g.groupe} aria-label={g.groupe}>
                <h3 className="px-2 pb-1 pt-2.5 text-[11.5px] font-semibold text-[var(--aia-discret)]">{g.groupe}</h3>
                {g.conversations.map((c) => (
                  <LigneConversation key={c.id} c={c} active={c.id === courante} etat={etat} onOuvrir={onOuvrir} />
                ))}
              </section>
            ))}
            {etat.charge && !groupes.length && (
              <p className="px-2 py-3 text-[13px] text-[var(--aia-discret)]">{dossier ? "Aucune conversation dans ce dossier." : "Aucune conversation pour l'instant."}</p>
            )}

            <section aria-label="Conversations archivées" className="pt-2">
              <button type="button" onClick={() => void etat.voirArchivees(!etat.archivees)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-[var(--aia-discret)] hover:bg-[var(--aia-survol)]">
                <Archive className="h-3.5 w-3.5" aria-hidden /> {etat.archivees ? "Masquer les archivées" : "Conversations archivées"}
              </button>
              {etat.archivees?.map((c) => (
                <LigneConversation key={c.id} c={c} active={c.id === courante} etat={etat} onOuvrir={onOuvrir} />
              ))}
              {etat.archivees && !etat.archivees.length && <p className="px-2 py-1 text-[12px] text-[var(--aia-discret)]">Aucune conversation archivée.</p>}
            </section>
          </>
        )}
      </div>
      {pied && <div className="border-t border-[var(--aia-filet)] px-2.5 py-2">{pied}</div>}
    </nav>
  );
}

function LigneConversation({ c, active, etat, onOuvrir }: { c: ConversationResumee; active: boolean; etat: EtatConversations; onOuvrir: (id: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [edition, setEdition] = useState(false);
  const [titre, setTitre] = useState(c.titre);
  const [ranger, setRanger] = useState(false);
  const confirmer = useConfirmer();
  const boite = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dehors = (e: PointerEvent) => { if (!boite.current?.contains(e.target as Node)) { setMenu(false); setRanger(false); } };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); setRanger(false); } };
    window.addEventListener("pointerdown", dehors);
    window.addEventListener("keydown", echap);
    return () => { window.removeEventListener("pointerdown", dehors); window.removeEventListener("keydown", echap); };
  }, [menu]);

  if (edition) {
    return (
      <form className="px-1 py-0.5" onSubmit={(e) => { e.preventDefault(); setEdition(false); if (titre.trim() && titre !== c.titre) void etat.renommer(c.id, titre); }}>
        <label className="sr-only" htmlFor={`titre-${c.id}`}>Nouveau titre</label>
        <input id={`titre-${c.id}`} autoFocus value={titre} onChange={(e) => setTitre(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()}
          onKeyDown={(e) => { if (e.key === "Escape") { setTitre(c.titre); setEdition(false); } }}
          className="w-full rounded-md border border-[var(--aia-accent)] bg-[var(--aia-panneau)] px-2 py-1.5 text-[14px] text-[var(--aia-texte)] outline-none" />
      </form>
    );
  }
  const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13.5px] hover:bg-[var(--aia-survol)]";
  return (
    <div ref={boite} className="group relative">
      <button
        type="button" onClick={() => onOuvrir(c.id)} aria-current={active ? "page" : undefined} data-testid="conversation"
        className={`flex w-full items-center gap-1.5 rounded-lg py-1.5 pl-2 pr-8 text-left text-[14px] hover:bg-[var(--aia-survol)] ${active ? "bg-[var(--aia-survol)] font-semibold" : ""}`}
      >
        {c.epingle && <Pin className="h-3 w-3 shrink-0 text-[var(--aia-discret)]" aria-label="Épinglée" />}
        <span className="min-w-0 flex-1 truncate">{c.titre}</span>
        {c.prive && <span className="shrink-0 font-mono text-[10.5px] text-[var(--aia-prive)]">privée</span>}
      </button>
      {c.extrait && <p className="truncate px-2 pb-1 text-[11.5px] text-[var(--aia-discret)]">{c.extrait}</p>}
      <button
        type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label={`Options de « ${c.titre} »`}
        className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md text-[var(--aia-discret)] opacity-100 hover:bg-[var(--aia-panneau)] sm:opacity-0 sm:focus:opacity-100 sm:group-hover:opacity-100 aria-expanded:opacity-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menu && (
        <div role="menu" className="absolute right-1 top-9 z-50 w-56 rounded-xl border border-[var(--aia-filet)] bg-[var(--aia-panneau)] p-1 text-[var(--aia-texte)] shadow-xl">
          {ranger ? (
            <>
              <p className="px-2.5 py-1.5 text-[11.5px] font-semibold text-[var(--aia-discret)]">Ranger dans…</p>
              {etat.dossiers.map((d) => (
                <button key={d.id} type="button" role="menuitemradio" aria-checked={c.dossierId === d.id} className={item}
                  onClick={() => { setMenu(false); setRanger(false); void etat.ranger(c.id, d.id); }}>
                  <Folder className="h-3.5 w-3.5" /> <span className="truncate">{d.nom}</span>
                </button>
              ))}
              {c.dossierId && (
                <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); setRanger(false); void etat.ranger(c.id, null); }}>
                  Sortir du dossier
                </button>
              )}
              {!etat.dossiers.length && <p className="px-2.5 py-1.5 text-[12px] text-[var(--aia-discret)]">Créez d&apos;abord un dossier.</p>}
            </>
          ) : (
            <>
              <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); setTitre(c.titre); setEdition(true); }}><Pencil className="h-3.5 w-3.5" /> Renommer</button>
              {!c.archive && (
                <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); void etat.epingler(c.id, !c.epingle); }}>
                  {c.epingle ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />} {c.epingle ? "Désépingler" : "Épingler"}
                </button>
              )}
              <button type="button" role="menuitem" className={item} onClick={() => setRanger(true)}><Folder className="h-3.5 w-3.5" /> Ranger dans un dossier</button>
              <button type="button" role="menuitem" className={item} onClick={() => { setMenu(false); void etat.archiver(c.id, !c.archive); }}>
                {c.archive ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />} {c.archive ? "Désarchiver" : "Archiver"}
              </button>
              <button type="button" role="menuitem" className={`${item} text-[var(--aia-danger)]`}
                onClick={async () => { setMenu(false); if (await confirmer(`Supprimer « ${c.titre} » ? La conversation et ses messages seront effacés.`)) void etat.supprimer(c.id); }}>
                <Trash2 className="h-3.5 w-3.5" /> Supprimer
              </button>
              {c.prive && <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-[var(--aia-prive)]"><EyeOff className="h-3 w-3" /> Privée · supprimée 30 jours après sa création</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
