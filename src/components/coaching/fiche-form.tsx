"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Send } from "lucide-react";
import { creerFicheCoaching, modifierFicheCoaching } from "@/lib/actions/coaching-actions";
import { bilanDesNotes, type GrilleCoaching, type Points } from "@/lib/coaching/grille";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { EchelleNiveaux, GrilleEvaluation, TotalFiche } from "./fiche-grille";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REMPLIR UNE FICHE DE COACHING (§118.157) — la grille de la Direction, cliquable.
 *
 * Le manager coche un niveau par axe (le total se calcule sous ses yeux), écrit le bilan, puis
 * enregistre un BROUILLON ou FINALISE. Finaliser partage la fiche avec le collaborateur, qui en
 * est prévenu : le bouton ne s'active qu'une fois chaque axe noté, et le dit tant qu'il manque
 * quelque chose — un bouton grisé sans explication fait chercher ce qui cloche.
 *
 * Toutes les RÈGLES sont revérifiées par l'action : cet écran ne fait que ne pas proposer
 * l'impossible.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface OptionPersonne { id: string; nom: string; secteur?: string }

export interface ValeursFiche {
  collaboratorId: string;
  managerId: string;
  visitDate: string;
  sector: string;
  notes: Record<string, Points>;
  strengths: string;
  improvements: string;
}

export function FicheCoachingForm({
  mode, ficheId, grille, collaborateurs, managers, valeurs, finalisee, peutFinaliser, aujourdHui, nomManagerParDefaut,
}: {
  mode: "creation" | "modification";
  ficheId?: string;
  grille: GrilleCoaching;
  /** La version de la grille — plus affichée sous l'en-tête (Direction, 07/10) ; gardée au contrat des pages. */
  gridVersion: number;
  collaborateurs: OptionPersonne[];
  /** La liste des managers — présente seulement pour l'administration, qui peut en désigner un autre. */
  managers: OptionPersonne[] | null;
  valeurs: ValeursFiche;
  finalisee: boolean;
  peutFinaliser: boolean;
  aujourdHui: string;
  nomManagerParDefaut: string;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [collaboratorId, setCollaboratorId] = React.useState(valeurs.collaboratorId);
  const [managerId, setManagerId] = React.useState(valeurs.managerId);
  const [visitDate, setVisitDate] = React.useState(valeurs.visitDate);
  const [sector, setSector] = React.useState(valeurs.sector);
  // LE SECTEUR SE PRÉ-REMPLIT tant que la personne n'y a pas touché : changer de collaborateur
  // reprend le sien ; une saisie à la main n'est jamais écrasée.
  const [secteurTouche, setSecteurTouche] = React.useState(mode === "modification" || valeurs.sector !== "");
  const [notes, setNotes] = React.useState<Record<string, Points>>(valeurs.notes);
  const [strengths, setStrengths] = React.useState(valeurs.strengths);
  const [improvements, setImprovements] = React.useState(valeurs.improvements);
  const [busy, setBusy] = React.useState<"brouillon" | "finaliser" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const bilan = bilanDesNotes(grille, notes);
  const collaborateur = collaborateurs.find((c) => c.id === collaboratorId) ?? null;

  const choisirCollaborateur = (id: string) => {
    setCollaboratorId(id);
    if (!secteurTouche) setSector(collaborateurs.find((c) => c.id === id)?.secteur ?? "");
  };

  const choisir = (cle: string, points: Points | null) => {
    setNotes((n) => {
      const suivant = { ...n };
      if (points === null) delete suivant[cle];
      else suivant[cle] = points;
      return suivant;
    });
  };

  const envoyer = async (finaliser: boolean) => {
    setErr(null);
    if (!collaboratorId) { setErr("Choisissez le collaborateur évalué."); return; }
    if (finaliser && !(await confirmer(
      `Finaliser la fiche et la partager avec ${collaborateur?.nom ?? "le collaborateur"} ?\n\n`
      + "Il en sera prévenu et pourra la consulter. Une fois finalisée, seule la direction des opérations pourra la modifier.",
    ))) return;
    setBusy(finaliser ? "finaliser" : "brouillon");
    const fd = new FormData();
    if (ficheId) fd.set("id", ficheId);
    fd.set("collaboratorId", collaboratorId);
    if (managers) fd.set("managerId", managerId);
    fd.set("visitDate", visitDate);
    fd.set("sector", sector);
    fd.set("scores", JSON.stringify(notes));
    fd.set("strengths", strengths);
    fd.set("improvements", improvements);
    if (finaliser) fd.set("finaliser", "true");
    try {
      const r = mode === "creation" ? await creerFicheCoaching(fd) : await modifierFicheCoaching(fd);
      if (!r.ok) { setErr(r.error ?? "Enregistrement impossible."); return; }
      router.push(`/medical/coaching/${r.id ?? ficheId}`);
      rafraichir();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  };

  // 16 px au téléphone : en dessous, iOS zoome sur le champ touché.
  const champ = "h-10 w-full min-w-0 rounded-[var(--radius)] border border-border bg-card px-3 text-base focus-ring sm:text-sm";
  const zone = "min-h-[7rem] w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-base leading-relaxed focus-ring sm:text-sm";

  return (
    <div className="space-y-6">
      <section className="surface space-y-4 p-4 sm:p-5" aria-label="En-tête de la fiche">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="min-w-0 space-y-1.5">
            <span className="text-sm font-medium text-foreground">Collaborateur <span className="text-destructive">*</span></span>
            <select className={champ} value={collaboratorId} onChange={(e) => choisirCollaborateur(e.target.value)} disabled={finalisee && mode === "modification"}>
              <option value="">— Choisir —</option>
              {collaborateurs.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Manager</span>
            {managers ? (
              <select className={champ} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.nom}</option>)}
              </select>
            ) : (
              <p className="flex h-10 min-w-0 items-center truncate rounded-[var(--radius)] border border-border bg-muted/40 px-3 text-sm text-foreground">{nomManagerParDefaut}</p>
            )}
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Date de la tournée <span className="text-destructive">*</span></span>
            <input type="date" className={champ} value={visitDate} max={aujourdHui} onChange={(e) => setVisitDate(e.target.value)} required />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Secteur / Région / CDR</span>
            <input
              className={champ}
              value={sector}
              maxLength={200}
              placeholder="Secteur, région, CDR"
              onChange={(e) => { setSector(e.target.value); setSecteurTouche(true); }}
            />
          </label>
        </div>
      </section>

      <EchelleNiveaux grille={grille} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
        <GrilleEvaluation grille={grille} notes={notes} onChoisir={choisir} nomGroupe={ficheId ?? "nouvelle"} />
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <TotalFiche grille={grille} notes={notes} />
        </aside>
      </div>

      <section className="space-y-3" aria-label={grille.bilan.titre}>
        <h2 className="text-sm font-semibold text-foreground">{grille.bilan.titre}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">{grille.bilan.pointsForts}</span>
            <textarea className={zone} value={strengths} maxLength={4000} onChange={(e) => setStrengths(e.target.value)} />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">{grille.bilan.pointsAAmeliorer}</span>
            <textarea className={zone} value={improvements} maxLength={4000} onChange={(e) => setImprovements(e.target.value)} />
          </label>
        </div>
      </section>

      {/*
        LA BARRE D'ACTIONS reste sous le pouce pendant qu'on parcourt les cinq axes. Au téléphone,
        elle tient sur UNE ligne et porte le total : la carte du total vit sous la grille à cette
        largeur, donc sans lui on noterait à l'aveugle. Mesuré sur la première version — trois
        boutons empilés — elle masquait près d'un quart de l'écran. C'est une carte FLOTTANTE à
        toutes les tailles : le conteneur principal garde une marge basse (la barre d'onglets du
        téléphone), donc un bandeau « collé » laissait défiler une bande de contenu sous lui. Les
        noms accessibles restent les libellés complets (`aria-label`), quel que soit le libellé
        court affiché.
      */}
      <div className="sticky bottom-0 z-10 rounded-xl border border-border bg-card px-3 py-2.5 shadow-[0_8px_24px_-8px_rgba(15,23,42,0.28)] sm:px-4 sm:py-3">
        {err && <p className="mb-2 text-sm text-destructive" role="alert">{err}</p>}
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
            <span className="font-semibold tabular-nums text-foreground lg:hidden">{bilan.total} / {bilan.max}</span>
            {bilan.complet ? (
              <span className="lg:hidden"> · <span className="sm:hidden">complet</span><span className="hidden sm:inline">tous les axes sont notés</span></span>
            ) : (
              <span>
                <span className="lg:hidden"> · </span>encore {bilan.manquants.length} axe(s)
                <span className="hidden sm:inline"> à noter{peutFinaliser && !finalisee ? " pour finaliser" : ""}</span>
              </span>
            )}
          </p>
          <Button variant="outline" className="hidden sm:inline-flex" onClick={() => router.back()} disabled={busy !== null}>Annuler</Button>
          {!finalisee && (
            <Button variant="secondary" onClick={() => void envoyer(false)} disabled={busy !== null} aria-label="Enregistrer le brouillon">
              {busy === "brouillon" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              <span className="sm:hidden">Brouillon</span>
              <span className="hidden sm:inline">Enregistrer le brouillon</span>
            </Button>
          )}
          {finalisee ? (
            <Button onClick={() => void envoyer(false)} disabled={busy !== null || !bilan.complet} aria-label="Enregistrer les modifications">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              <span className="sm:hidden">Enregistrer</span>
              <span className="hidden sm:inline">Enregistrer les modifications</span>
            </Button>
          ) : peutFinaliser && (
            <Button onClick={() => void envoyer(true)} disabled={busy !== null || !bilan.complet} aria-label="Finaliser et partager">
              {busy === "finaliser" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              <span className="sm:hidden">Finaliser</span>
              <span className="hidden sm:inline">Finaliser et partager</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
