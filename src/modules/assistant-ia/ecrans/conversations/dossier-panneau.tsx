"use client";

import React, { useEffect, useRef, useState } from "react";
import { FileText, Folder, Loader2, Paperclip, Plus, Trash2, X } from "lucide-react";
import { CONSIGNES_DOSSIER_MAX, type DossierVue } from "../../domaine/dossiers";
import {
  ajouterDocumentsAuDossier, creerMonDossier, modifierMonDossier, retirerDocumentDuDossier, supprimerMonDossier,
} from "@/modules/assistant-ia/actions-conversations";
import { televerser } from "../depot-navigateur";
import { useConfirmer } from "@/components/ui/dialogue";
import { useEchap } from "../use-echap";
import type { EtatConversations } from "./use-conversations";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PANNEAU D'UN DOSSIER (décision 0027, point 5) — son nom, ses CONSIGNES, ses DOCUMENTS de référence.
 *
 * Un document s'ajoute en le déposant (il rejoint le Drive de la personne) ou en collant un lien / un identifiant du
 * Drive ou de la Bibliothèque : le serveur ne garde que ceux que la personne peut ouvrir, et les revérifie à chaque
 * tour. `dossier` absent : création (le nom d'abord).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function DossierPanneau({ dossier, onFermer, onChange, onNouvelleConversation }: {
  dossier: DossierVue | null;
  onFermer: () => void;
  onChange: (dossierId?: string) => void | Promise<void>;
  onNouvelleConversation: (dossierId: string) => void;
}) {
  const [nom, setNom] = useState(dossier?.nom ?? "");
  const [consignes, setConsignes] = useState(dossier?.consignes ?? "");
  const [lien, setLien] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [avis, setAvis] = useState<string | null>(null);
  const fichier = useRef<HTMLInputElement>(null);
  const confirmer = useConfirmer();
  useEffect(() => { setNom(dossier?.nom ?? ""); setConsignes(dossier?.consignes ?? ""); setAvis(null); }, [dossier?.id, dossier?.nom, dossier?.consignes]);
  useEchap(onFermer);

  const faire = async (f: () => Promise<{ ok: boolean; erreur?: string }>, reussite?: string) => {
    setOccupe(true);
    setAvis(null);
    try {
      const r = await f();
      setAvis(r.ok ? reussite ?? null : r.erreur ?? "Le geste n'a pas abouti.");
      return r.ok;
    } catch {
      setAvis("Le geste n'a pas abouti. Réessayez.");
      return false;
    } finally {
      setOccupe(false);
    }
  };

  const creer = async (e: React.FormEvent) => {
    e.preventDefault();
    setOccupe(true);
    const r = await creerMonDossier(nom).catch(sansBloquer("dossier-panneau.creer", null));
    setOccupe(false);
    if (r?.ok) await onChange(r.dossier.id);
    else setAvis(r && !r.ok ? r.erreur : "Le dossier n'a pas été créé.");
  };

  const ajouterIds = async (ids: string[]) => {
    if (!dossier || !ids.length) return;
    await faire(async () => {
      const r = await ajouterDocumentsAuDossier(dossier.id, JSON.stringify(ids));
      if (r.ok) await onChange();
      return r.ok && r.refuses ? { ok: false, erreur: `${r.refuses} document${r.refuses > 1 ? "s" : ""} non ajouté${r.refuses > 1 ? "s" : ""} : vous ne pouvez pas l'ouvrir, ou il n'existe plus.` } : r;
    }, "Document ajouté.");
  };

  const deposer = async (liste: FileList | null) => {
    if (!dossier || !liste?.length) return;
    setOccupe(true);
    const ids: string[] = [];
    for (const f of Array.from(liste).slice(0, 10)) {
      const r = await televerser(f, () => {});
      if ("erreur" in r) { setAvis(`« ${f.name} » : ${r.erreur}`); continue; }
      ids.push(r.id);
    }
    setOccupe(false);
    await ajouterIds(ids);
  };

  /** Un lien `…/drive/<id>`, `…/bibliotheque/<id>`, ou l'identifiant seul. */
  const idDuLien = (s: string): string | null => {
    const m = s.trim().match(/(c[a-z0-9]{20,})/);
    return m ? m[1] : null;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-stretch sm:justify-end" role="dialog" aria-modal="true" aria-label={dossier ? `Dossier « ${dossier.nom} »` : "Nouveau dossier"}>
      <button type="button" aria-label="Fermer" onClick={onFermer} className="absolute inset-0 bg-slate-950/40" />
      <div className="adventum-ia relative flex max-h-[88dvh] w-full flex-col rounded-t-2xl bg-[var(--aia-panneau)] text-[var(--aia-texte)] shadow-2xl sm:max-h-none sm:w-[440px] sm:rounded-none">
        <header className="flex items-center gap-2 border-b border-[var(--aia-filet)] px-4 py-3">
          <Folder className="h-4 w-4 text-[var(--aia-accent)]" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{dossier ? dossier.nom : "Nouveau dossier"}</h2>
          <button type="button" onClick={onFermer} aria-label="Fermer" className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[var(--aia-survol)]"><X className="h-4 w-4" /></button>
        </header>

        {!dossier ? (
          <form onSubmit={creer} className="flex flex-col gap-3 px-4 py-4">
            <label className="text-[13px] font-medium" htmlFor="dossier-nom">Nom du dossier</label>
            <input id="dossier-nom" autoFocus value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Congrès, Réglementaire…"
              className="rounded-lg border border-[var(--aia-filet)] bg-[var(--aia-panneau)] px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--aia-accent)]" />
            <p className="text-[12.5px] text-[var(--aia-discret)]">Un dossier range vos conversations et leur donne des consignes et des documents de référence que l&apos;assistant utilise à chaque échange.</p>
            {avis && <p role="alert" className="text-[12.5px] text-[var(--aia-danger)]">{avis}</p>}
            <button type="submit" disabled={occupe || !nom.trim()} className="self-end rounded-lg bg-[var(--aia-accent)] px-4 py-2 text-[14px] font-medium text-[var(--aia-accent-fg)] hover:bg-[var(--aia-accent-fort)] disabled:opacity-50">
              Créer le dossier
            </button>
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <section className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium" htmlFor="dossier-nom">Nom</label>
              <input id="dossier-nom" value={nom} onChange={(e) => setNom(e.target.value)}
                onBlur={() => { if (nom.trim() && nom !== dossier.nom) void faire(() => modifierMonDossier(dossier.id, nom).then(async (r) => { if (r.ok) await onChange(); return r; })); }}
                className="rounded-lg border border-[var(--aia-filet)] bg-[var(--aia-panneau)] px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--aia-accent)]" />
            </section>

            <section className="flex flex-col gap-1.5">
              <label className="text-[13px] font-medium" htmlFor="dossier-consignes">Consignes du dossier</label>
              <textarea id="dossier-consignes" rows={6} maxLength={CONSIGNES_DOSSIER_MAX} value={consignes} onChange={(e) => setConsignes(e.target.value)}
                placeholder="Ex. : « Réponds en tableau, montants en DZD. Le congrès a lieu à Oran du 12 au 14 décembre. »"
                className="resize-y rounded-lg border border-[var(--aia-filet)] bg-[var(--aia-panneau)] px-3 py-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--aia-accent)]" />
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] text-[var(--aia-discret)]">Elles valent pour toutes les conversations du dossier.</span>
                <button type="button" disabled={occupe || consignes === dossier.consignes}
                  onClick={() => void faire(() => modifierMonDossier(dossier.id, undefined, consignes).then(async (r) => { if (r.ok) await onChange(); return r; }), "Consignes enregistrées.")}
                  className="rounded-lg bg-[var(--aia-accent)] px-3 py-1.5 text-[13px] font-medium text-[var(--aia-accent-fg)] hover:bg-[var(--aia-accent-fort)] disabled:opacity-40">
                  Enregistrer
                </button>
              </div>
            </section>

            <section className="flex flex-col gap-2" aria-label="Documents de référence">
              <h3 className="text-[13px] font-medium">Documents de référence</h3>
              {dossier.documents.map((d) => (
                <div key={d.id} className="flex items-center gap-2 rounded-lg border border-[var(--aia-filet)] px-2.5 py-2 text-[13.5px]">
                  <FileText className="h-4 w-4 shrink-0 text-[var(--aia-discret)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{d.nom}</span>
                  <button type="button" aria-label={`Retirer « ${d.nom} »`} disabled={occupe}
                    onClick={() => void faire(() => retirerDocumentDuDossier(dossier.id, d.id).then(async (r) => { if (r.ok) await onChange(); return r; }))}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--aia-danger)] hover:bg-[var(--aia-survol)]">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {!dossier.documents.length && <p className="text-[12.5px] text-[var(--aia-discret)]">Aucun document. Ajoutez des pièces du Drive ou de la Bibliothèque : l&apos;assistant les lira quand la question s&apos;y rapporte, avec vos droits.</p>}
              <div className="flex flex-wrap gap-2">
                <input ref={fichier} type="file" multiple hidden onChange={(e) => { void deposer(e.target.files); e.target.value = ""; }} />
                <button type="button" disabled={occupe} onClick={() => fichier.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--aia-filet)] px-3 py-1.5 text-[13px] hover:bg-[var(--aia-survol)]">
                  <Paperclip className="h-3.5 w-3.5" /> Déposer un fichier
                </button>
              </div>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const id = idDuLien(lien); if (!id) { setAvis("Collez un lien du Drive ou de la Bibliothèque."); return; } setLien(""); void ajouterIds([id]); }}>
                <label className="sr-only" htmlFor="dossier-lien">Lien d&apos;un document du Drive ou de la Bibliothèque</label>
                <input id="dossier-lien" value={lien} onChange={(e) => setLien(e.target.value)} placeholder="Coller un lien du Drive ou de la Bibliothèque"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--aia-filet)] bg-[var(--aia-panneau)] px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--aia-accent)]" />
                <button type="submit" disabled={occupe || !lien.trim()} className="inline-flex items-center gap-1 rounded-lg border border-[var(--aia-filet)] px-3 py-1.5 text-[13px] hover:bg-[var(--aia-survol)] disabled:opacity-40">
                  <Plus className="h-3.5 w-3.5" /> Ajouter
                </button>
              </form>
            </section>

            <p aria-live="polite" className="min-h-[1.25rem] text-[12.5px] text-[var(--aia-discret)]">{occupe ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : avis}</p>

            <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-[var(--aia-filet)] pt-3">
              <button type="button" onClick={() => onNouvelleConversation(dossier.id)}
                className="rounded-lg bg-[var(--aia-accent)] px-3 py-2 text-[13.5px] font-medium text-[var(--aia-accent-fg)] hover:bg-[var(--aia-accent-fort)]">
                Nouvelle conversation dans ce dossier
              </button>
              <button type="button" className="ml-auto text-[13px] text-[var(--aia-danger)] hover:underline"
                onClick={async () => { if (await confirmer(`Supprimer le dossier « ${dossier.nom} » ? Ses conversations sont gardées (elles sortent du dossier).`)) { await supprimerMonDossier(dossier.id); await onChange(); onFermer(); } }}>
                Supprimer le dossier
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Le panneau du dossier tel que l'ouvrent l'ERP et l'app : « nouveau » (création), l'identifiant d'un dossier, ou rien.
 * Une création ou une modification relit la liste ; un dossier créé s'ouvre aussitôt.
 */
export function PanneauDuDossier({ panneau, etat, onPanneau, onDossierOuvert, onNouvelleConversation }: {
  panneau: "nouveau" | string | null;
  etat: EtatConversations;
  onPanneau: (p: "nouveau" | string | null) => void;
  onDossierOuvert: (id: string) => void;
  onNouvelleConversation: (dossierId: string) => void;
}) {
  if (!panneau) return null;
  const dossier = panneau === "nouveau" ? null : etat.dossiers.find((d) => d.id === panneau) ?? null;
  return (
    <DossierPanneau
      dossier={dossier} onFermer={() => onPanneau(null)}
      onChange={async (id) => { await etat.relire(); if (id) { onPanneau(id); onDossierOuvert(id); } }}
      onNouvelleConversation={(id) => { onPanneau(null); onDossierOuvert(id); onNouvelleConversation(id); }}
    />
  );
}
