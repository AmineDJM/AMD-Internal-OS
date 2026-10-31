"use client";

import React from "react";
import { BookOpen, FileText, NotebookPen, Sparkles, X } from "lucide-react";
import { useMissions } from "../missions/use-missions";
import { BarreAvancement } from "../missions/tableau-missions";
import { avancement, LIBELLE_MISSION, missionVivante } from "../../domaine/sous-missions";
import type { PieceOuvrable } from "../pieces-jointes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TIROIR D'ADVENTUM IA — Notes, Travaux, Documents (décision 0027, point 8), à droite sur ordinateur, plein écran
 * sur téléphone. Rien n'y est réécrit : chaque onglet ouvre le travail des autres lots par les portes du module.
 *
 *   • Notes — le bloc-notes « Mes notes » du lot Notes (`jarvis/notes`) : POINT D'ACCROCHE (`PanneauNotes`), le seul
 *     composant à remplacer quand le lot sera sur la base.
 *   • Travaux — les travaux longs (J2) : la liste, l'état, l'ouverture du panneau complet (approuver, suivre).
 *   • Documents — les pièces de la conversation et du dossier, ouvrables dans l'aperçu ou l'Atelier (J3) ; la
 *     Bibliothèque (J1) se consulte en le demandant à l'assistant (`chercher_documents`, sous les droits).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type OngletTiroir = "notes" | "travaux" | "documents";

export function Tiroir({ onglet, onOnglet, onFermer, onOuvrirTravaux, onOuvrirDemandes, documents, onOuvrirPiece, onAtelier, onDemander }: {
  onglet: OngletTiroir;
  onOnglet: (o: OngletTiroir) => void;
  onFermer: () => void;
  /** K3 : ouvre le tableau de bord des missions (sur une mission). */
  onOuvrirTravaux: (travailId?: string) => void;
  /** Les demandes reçues et la vue d'équipe (J8) : le panneau « Travaux » complet. */
  onOuvrirDemandes?: () => void;
  documents: { titre: string; pieces: PieceOuvrable[] }[];
  onOuvrirPiece: (p: PieceOuvrable) => void;
  onAtelier: () => void;
  onDemander: (texte: string) => void;
}) {
  const onglets: { id: OngletTiroir; libelle: string }[] = [{ id: "notes", libelle: "Notes" }, { id: "travaux", libelle: "Missions" }, { id: "documents", libelle: "Documents" }];
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
        {onglet === "notes" && <PanneauNotes />}
        {onglet === "travaux" && <OngletTravaux onOuvrir={onOuvrirTravaux} onDemandes={onOuvrirDemandes} />}
        {onglet === "documents" && <OngletDocuments documents={documents} onOuvrirPiece={onOuvrirPiece} onAtelier={onAtelier} onDemander={onDemander} />}
      </div>
    </aside>
  );
}

/**
 * LE POINT D'ACCROCHE DES NOTES — le lot Notes (`jarvis/notes` : bloc-notes « Mes notes », pages, outils de
 * l'assistant) n'est pas encore sur la base. À son arrivée, ce composant rend son panneau par la porte du module.
 */
export function PanneauNotes() {
  return (
    <div className="flex flex-col gap-2" data-testid="panneau-notes">
      <div className="flex items-center gap-2 font-semibold"><NotebookPen className="h-4 w-4 text-[var(--aia-accent)]" aria-hidden /> Mes notes</div>
      <p className="text-[13px] text-[var(--aia-discret)]">
        Le bloc-notes « Mes notes » (pages que vous créez et nommez, cases à cocher, ajouts proposés par l&apos;assistant) s&apos;affichera ici, le même que dans l&apos;ERP.
      </p>
      <p className="rounded-lg bg-[var(--aia-accent-doux)] px-3 py-2 text-[12.5px] text-[var(--aia-accent)]">Bientôt disponible : il arrive avec le lot Notes.</p>
    </div>
  );
}

/** K3 (décision 0033) : les missions, EN TEMPS RÉEL (le flux du tableau de bord) — plus de sondage toutes les 20 s. */
function OngletTravaux({ onOuvrir, onDemandes }: { onOuvrir: (id?: string) => void; onDemandes?: () => void }) {
  const { tableau } = useMissions(true);
  const missions = tableau?.missions ?? [];
  return (
    <>
      {!tableau && <p className="text-[13px] text-[var(--aia-discret)]">Chargement…</p>}
      {missions.slice(0, 12).map((t) => {
        const part = t.etat === "TERMINE" ? 100 : avancement(t.etapes);
        return (
          <button key={t.id} type="button" onClick={() => onOuvrir(t.id)} className="flex min-h-11 flex-col gap-1 rounded-lg px-2 py-2 text-left hover:bg-[var(--aia-survol)]">
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{t.titre}</span>
              <span className={`whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px] ${t.etat === "TERMINE" ? "bg-[var(--aia-accent-doux)] text-[var(--aia-accent)]" : t.etat === "A_APPROUVER" ? "bg-[var(--aia-prive-doux)] text-[var(--aia-prive)]" : missionVivante(t.etat) ? "bg-[var(--aia-voix-doux)] text-[var(--aia-voix)]" : "bg-[var(--aia-cote)] text-[var(--aia-discret)]"}`}>
                {LIBELLE_MISSION[t.etat] ?? t.etat}
              </span>
            </span>
            {missionVivante(t.etat) && <BarreAvancement part={part} vivante libelle={`Avancement de ${t.titre}`} />}
          </button>
        );
      })}
      {tableau && !missions.length && <p className="text-[13px] text-[var(--aia-discret)]">Aucune mission. Confiez une analyse longue à l&apos;assistant : elle tourne sur le serveur, même app fermée, et vous continuez de discuter.</p>}
      <button type="button" onClick={() => onOuvrir()} className="mt-1 min-h-11 self-start text-[13px] text-[var(--aia-accent)] underline">Ouvrir le tableau de bord des missions</button>
      {onDemandes && <button type="button" onClick={onDemandes} className="min-h-11 self-start text-[13px] text-[var(--aia-discret)] underline">Demandes reçues, travaux de l&apos;équipe</button>}
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
