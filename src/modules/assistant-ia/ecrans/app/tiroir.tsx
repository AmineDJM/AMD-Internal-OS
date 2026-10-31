"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { BookOpen, FileText, Sparkles, X } from "lucide-react";
import { listerMesTravaux } from "@/modules/assistant-ia/actions";
import type { PieceOuvrable } from "../pieces-jointes";
import { sansBloquer } from "@/lib/journal";

/**
 * « MES NOTES » (décision 0026) — le même bloc-notes que dans l'ERP, chargé au premier affichage de l'onglet. L'app
 * affichait encore un point d'accroche « bientôt disponible », posé avant l'arrivée du lot Notes (31/10/2026).
 */
const PanneauNotes = dynamic(() => import("../notes/panneau-notes"), {
  ssr: false,
  loading: () => <p className="p-4 text-[13px] text-[var(--aia-discret)]">Ouverture de vos notes…</p>,
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TIROIR D'ADVENTUM IA — Notes, Travaux, Documents (décision 0027, point 8), à droite sur ordinateur, plein écran
 * sur téléphone. Rien n'y est réécrit : chaque onglet ouvre le travail des autres lots par les portes du module.
 *
 *   • Notes — le bloc-notes « Mes notes » (décision 0026, `ecrans/notes/panneau-notes.tsx`), le même que dans l'ERP ; le seul
 *     composant à remplacer quand le lot sera sur la base.
 *   • Travaux — les travaux longs (J2) : la liste, l'état, l'ouverture du panneau complet (approuver, suivre).
 *   • Documents — les pièces de la conversation et du dossier, ouvrables dans l'aperçu ou l'Atelier (J3) ; la
 *     Bibliothèque (J1) se consulte en le demandant à l'assistant (`chercher_documents`, sous les droits).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type OngletTiroir = "notes" | "travaux" | "documents";

export function Tiroir({ onglet, onOnglet, onFermer, onOuvrirTravaux, documents, onOuvrirPiece, onAtelier, onDemander, travaille = false }: {
  onglet: OngletTiroir;
  /** L'assistant travaille : les notes se relisent plus souvent (une proposition peut arriver). */
  travaille?: boolean;
  onOnglet: (o: OngletTiroir) => void;
  onFermer: () => void;
  onOuvrirTravaux: (travailId?: string) => void;
  documents: { titre: string; pieces: PieceOuvrable[] }[];
  onOuvrirPiece: (p: PieceOuvrable) => void;
  onAtelier: () => void;
  onDemander: (texte: string) => void;
}) {
  const onglets: { id: OngletTiroir; libelle: string }[] = [{ id: "notes", libelle: "Notes" }, { id: "travaux", libelle: "Travaux" }, { id: "documents", libelle: "Documents" }];
  return (
    <aside aria-label="Notes, travaux et documents" data-testid="tiroir" className="flex h-full min-w-0 flex-col border-l border-[var(--aia-filet)] bg-[var(--aia-panneau)]">
      <div role="tablist" aria-label="Panneau" className="flex gap-0.5 border-b border-[var(--aia-filet)] p-2">
        {onglets.map((o) => (
          <button key={o.id} type="button" role="tab" aria-selected={onglet === o.id} onClick={() => onOnglet(o.id)}
            className="flex-1 rounded-lg px-1 py-1.5 text-[13px] hover:bg-[var(--aia-survol)] aria-selected:bg-[var(--aia-accent-doux)] aria-selected:font-semibold aria-selected:text-[var(--aia-accent)]">
            {o.libelle}
          </button>
        ))}
        <button type="button" onClick={onFermer} aria-label="Fermer le panneau" className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--aia-survol)]"><X className="h-4 w-4" /></button>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-3 text-[14px]">
        {onglet === "notes" && <PanneauNotes onFermer={onFermer} travaille={travaille} />}
        {onglet === "travaux" && <OngletTravaux onOuvrir={onOuvrirTravaux} />}
        {onglet === "documents" && <OngletDocuments documents={documents} onOuvrirPiece={onOuvrirPiece} onAtelier={onAtelier} onDemander={onDemander} />}
      </div>
    </aside>
  );
}

interface TravailCourt { id: string; titre: string; etat: string }

const ETATS: Record<string, string> = {
  A_APPROUVER: "à approuver", EN_COURS: "en cours", EN_ATTENTE: "en attente", BUDGET_HOLD: "plafond atteint", EN_PAUSE: "en pause",
  BLOQUE: "bloqué", TERMINE: "terminé", ECHEC: "échec", ANNULE: "annulé",
};

function OngletTravaux({ onOuvrir }: { onOuvrir: (id?: string) => void }) {
  const [travaux, setTravaux] = useState<TravailCourt[] | null>(null);
  useEffect(() => {
    const lire = () => void listerMesTravaux().then((r) => {
      if (r.ok) setTravaux(r.travaux.map((t) => ({ id: t.id, titre: t.titre, etat: t.etat })));
    }).catch(sansBloquer("tiroir.travaux"));
    lire();
    const t = setInterval(lire, 20_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {travaux === null && <p className="text-[13px] text-[var(--aia-discret)]">Chargement…</p>}
      {travaux?.map((t) => (
        <button key={t.id} type="button" onClick={() => onOuvrir(t.id)} className="flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--aia-survol)]">
          <span className="min-w-0 flex-1 truncate">{t.titre}</span>
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px] ${t.etat === "TERMINE" ? "bg-[var(--aia-accent-doux)] text-[var(--aia-accent)]" : t.etat === "A_APPROUVER" ? "bg-[var(--aia-prive-doux)] text-[var(--aia-prive)]" : "bg-[var(--aia-cote)] text-[var(--aia-discret)]"}`}>
            {ETATS[t.etat] ?? t.etat.toLowerCase()}
          </span>
        </button>
      ))}
      {travaux && !travaux.length && <p className="text-[13px] text-[var(--aia-discret)]">Aucun travail. Confiez une analyse longue à l&apos;assistant : elle tourne sur le serveur, même app fermée, et vous êtes prévenu à la fin.</p>}
      <button type="button" onClick={() => onOuvrir()} className="mt-1 self-start text-[13px] text-[var(--aia-accent)] underline">Ouvrir le suivi complet des travaux</button>
      <p className="text-[12px] text-[var(--aia-discret)]">Ces travaux tournent sur le serveur, même app fermée.</p>
    </>
  );
}

function OngletDocuments({ documents, onOuvrirPiece, onAtelier, onDemander }: {
  documents: { titre: string; pieces: PieceOuvrable[] }[];
  onOuvrirPiece: (p: PieceOuvrable) => void;
  onAtelier: () => void;
  onDemander: (texte: string) => void;
}) {
  const vides = documents.every((g) => !g.pieces.length);
  return (
    <>
      {documents.filter((g) => g.pieces.length).map((g) => (
        <section key={g.titre} className="flex flex-col gap-1">
          <h3 className="text-[11.5px] font-semibold text-[var(--aia-discret)]">{g.titre}</h3>
          {g.pieces.map((p) => (
            <button key={p.id} type="button" onClick={() => onOuvrirPiece(p)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--aia-survol)]">
              <FileText className="h-4 w-4 shrink-0 text-[var(--aia-discret)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{p.nom}</span>
            </button>
          ))}
        </section>
      ))}
      {vides && <p className="text-[13px] text-[var(--aia-discret)]">Les pièces de cette conversation et de son dossier s&apos;affichent ici.</p>}
      <div className="mt-2 flex flex-col gap-1.5 border-t border-[var(--aia-filet)] pt-3">
        <button type="button" onClick={onAtelier} className="flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--aia-survol)]">
          <Sparkles className="h-4 w-4 text-[var(--aia-accent)]" aria-hidden /> Ouvrir l&apos;Atelier — documents modifiés en direct
        </button>
        <button type="button" onClick={() => onDemander("Cherche dans la Bibliothèque : ")} className="flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--aia-survol)]">
          <BookOpen className="h-4 w-4 text-[var(--aia-accent)]" aria-hidden /> Chercher dans la Bibliothèque
        </button>
      </div>
    </>
  );
}
