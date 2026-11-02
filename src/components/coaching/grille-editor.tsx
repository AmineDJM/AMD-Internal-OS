"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { enregistrerGrilleCoaching } from "@/lib/actions/coaching-actions";
import {
  cleProvisoire, GRILLE_PAR_DEFAUT, LIMITES_GRILLE, NOMBRE_NIVEAUX, validerGrille, type GrilleCoaching,
} from "@/lib/coaching/grille";
import { Button } from "@/components/ui/button";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { tonsDuNiveau } from "./fiche-grille";
import { cn } from "@/lib/utils";
import { InfoBulle } from "@/components/ui/info-bulle";
import { EntreeMenu, MenuPlus } from "@/app/(app)/medical/menu-plus";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉDITEUR DE LA GRILLE DE COACHING (§118.157) — l'outil du directeur des opérations.
 *
 * Tout ce qui est écrit sur la fiche se règle ici : le titre, les libellés des quatre niveaux,
 * les axes (ajouter, retirer, réordonner, renommer) et leurs critères, les libellés du bilan.
 * « Publier » crée une VERSION : les fiches déjà remplies gardent la leur.
 *
 * La validation tourne ICI aussi, avec le même module pur que l'action : les erreurs s'affichent
 * avant l'envoi, toutes à la fois. L'action la refait — l'écran n'est pas une garde.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export function EditeurGrille({ initiale, version }: { initiale: GrilleCoaching; version: number }) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [grille, setGrille] = React.useState<GrilleCoaching>(initiale);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; texte: string } | null>(null);

  const verdict = validerGrille(grille);
  const modifiee = JSON.stringify(grille) !== JSON.stringify(initiale);

  const maj = (f: (g: GrilleCoaching) => GrilleCoaching) => { setGrille((g) => f(structuredClone(g))); setMessage(null); };

  // UNE CLÉ PROVISOIRE (`nouveau_1`…), jamais une lettre : retirer l'axe E puis en ajouter un
  // ne doit pas rendre « E », que le serveur lirait comme une modification de l'axe E.
  const ajouterAxe = () => maj((g) => {
    g.axes.push({ cle: cleProvisoire(g.axes.map((a) => a.cle)), titre: "", criteres: Array.from({ length: NOMBRE_NIVEAUX }, () => "") });
    return g;
  });
  const deplacer = (i: number, d: -1 | 1) => maj((g) => {
    const j = i + d;
    if (j < 0 || j >= g.axes.length) return g;
    [g.axes[i], g.axes[j]] = [g.axes[j]!, g.axes[i]!];
    return g;
  });
  const retirer = async (i: number) => {
    const axe = grille.axes[i];
    if (!(await confirmer(`Retirer l'axe « ${axe?.titre || `n° ${i + 1}`} » ? Les fiches déjà remplies le gardent ; les prochaines ne l'auront plus.`))) return;
    maj((g) => { g.axes.splice(i, 1); return g; });
  };

  const publier = async () => {
    if (!verdict.ok) return;
    setBusy(true); setMessage(null);
    const fd = new FormData();
    fd.set("grille", JSON.stringify(grille));
    if (note.trim()) fd.set("note", note.trim());
    try {
      const r = await enregistrerGrilleCoaching(fd);
      setMessage({ ok: r.ok, texte: r.ok ? (r.message ?? "Grille publiée.") : (r.error ?? "Publication impossible.") });
      if (r.ok) { setNote(""); rafraichir(); }
    } catch {
      setMessage({ ok: false, texte: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  };

  // 16 px au téléphone : en dessous, iOS zoome sur le champ touché.
  const champ = "h-10 w-full min-w-0 rounded-[var(--radius)] border border-border bg-card px-3 text-base focus-ring sm:text-sm";
  const zone = "min-h-[4.5rem] w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-base leading-snug focus-ring sm:text-sm";

  return (
    <div className="space-y-6">
      <section className="surface space-y-4 p-4 sm:p-5">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Titre de la fiche</span>
          <input className={champ} value={grille.titre} maxLength={LIMITES_GRILLE.titreMax} onChange={(e) => maj((g) => { g.titre = e.target.value; return g; })} />
        </label>
      </section>

      <section className="surface space-y-3 p-4 sm:p-5">
        <div className="flex items-center gap-1">
          <h2 className="text-sm font-semibold text-foreground">Échelle d&apos;évaluation — points 1 à 4</h2>
          <InfoBulle label="Pourquoi un barème fixe" align="left">
            Les libellés s&apos;éditent ; le barème reste de 1 à 4, pour que les totaux restent comparables d&apos;une fiche à l&apos;autre.
          </InfoBulle>
        </div>
        <div className="space-y-2">
          {grille.niveaux.map((n, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[5rem_1fr_1fr_3rem] sm:items-center">
              <input aria-label={`Code du niveau ${i + 1}`} className={cn(champ, "font-bold uppercase")} value={n.code} maxLength={LIMITES_GRILLE.codeMax}
                onChange={(e) => maj((g) => { g.niveaux[i]!.code = e.target.value; return g; })} />
              <input aria-label={`Libellé du niveau ${i + 1}`} className={champ} value={n.libelle} maxLength={LIMITES_GRILLE.libelleMax} placeholder="Maîtrise…"
                onChange={(e) => maj((g) => { g.niveaux[i]!.libelle = e.target.value; return g; })} />
              <input aria-label={`Qualification du niveau ${i + 1}`} className={champ} value={n.qualification} maxLength={LIMITES_GRILLE.qualificationMax} placeholder="Qualification"
                onChange={(e) => maj((g) => { g.niveaux[i]!.qualification = e.target.value; return g; })} />
              <span className={cn("inline-flex h-10 items-center justify-center rounded-md border text-sm font-bold", tonsDuNiveau(i + 1).puce)}>{i + 1}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Axes d&apos;évaluation ({grille.axes.length} / {LIMITES_GRILLE.axesMax})</h2>
          <Button size="sm" variant="outline" onClick={ajouterAxe} disabled={grille.axes.length >= LIMITES_GRILLE.axesMax}>
            <Plus className="h-4 w-4" /> Ajouter un axe
          </Button>
        </div>
        {grille.axes.map((axe, i) => (
          <div key={axe.cle} className="surface space-y-3 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label={`Titre de l'axe ${i + 1}`} className={cn(champ, "min-w-0 flex-1 font-semibold")} value={axe.titre} maxLength={LIMITES_GRILLE.titreMax}
                placeholder="Ex. F. Suivi post-visite" onChange={(e) => maj((g) => { g.axes[i]!.titre = e.target.value; return g; })} />
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Monter l'axe" onClick={() => deplacer(i, -1)} disabled={i === 0}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Descendre l'axe" onClick={() => deplacer(i, 1)} disabled={i === grille.axes.length - 1}><ArrowDown className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-9 w-9 text-destructive" aria-label="Retirer l'axe" onClick={() => retirer(i)} disabled={grille.axes.length <= 1}><Trash2 className="h-4 w-4" /></Button>
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {axe.criteres.map((c, k) => (
                <label key={k} className="space-y-1">
                  <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span className={cn("inline-flex h-5 min-w-[2rem] items-center justify-center rounded border px-1 text-[11px] font-bold", tonsDuNiveau(k + 1).puce)}>
                      {grille.niveaux[k]?.code || k + 1}
                    </span>
                    Critère du niveau {k + 1}
                  </span>
                  <textarea className={zone} value={c} maxLength={LIMITES_GRILLE.critereMax}
                    onChange={(e) => maj((g) => { g.axes[i]!.criteres[k] = e.target.value; return g; })} />
                </label>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="surface space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">Bilan</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {([["titre", "Titre du bilan"], ["pointsForts", "Libellé — points forts"], ["pointsAAmeliorer", "Libellé — points à améliorer"]] as const).map(([cle, libelle]) => (
            <label key={cle} className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">{libelle}</span>
              <input className={champ} value={grille.bilan[cle]} maxLength={LIMITES_GRILLE.bilanMax}
                onChange={(e) => maj((g) => { g.bilan[cle] = e.target.value; return g; })} />
            </label>
          ))}
        </div>
      </section>

      {!verdict.ok && modifiee && (
        <ul className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {verdict.erreurs.map((e) => <li key={e}>• {e}</li>)}
        </ul>
      )}

      <div className="sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-3 shadow-[0_8px_24px_-8px_rgba(15,23,42,0.28)] sm:flex-row sm:items-center sm:px-4">
        <input className={cn(champ, "sm:max-w-md")} value={note} maxLength={300} placeholder="Motif de la modification (facultatif)" onChange={(e) => setNote(e.target.value)} aria-label="Motif de la modification" />
        {message && <p className={cn("min-w-0 text-sm [overflow-wrap:anywhere]", message.ok ? "text-success" : "text-destructive")} role="status">{message.texte}</p>}
        {/* UN GESTE PRINCIPAL (Publier) ; « Annuler les changements » discret, « Grille d'origine » dans « ⋯ » (Direction, 07/10). */}
        <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <MenuPlus label="Autres actions sur la grille" vers="haut">
            <EntreeMenu onClick={() => { setGrille(structuredClone(GRILLE_PAR_DEFAUT)); setMessage(null); }} title="Recharger le contenu du classeur d'origine (à publier ensuite)">
              <RotateCcw className="h-4 w-4" /> Recharger la grille d&apos;origine
            </EntreeMenu>
            <EntreeMenu onClick={() => { setGrille(initiale); setMessage(null); }} disabled={!modifiee || busy}>
              Annuler les changements
            </EntreeMenu>
          </MenuPlus>
          <Button size="sm" className="h-10 flex-1 sm:h-8 sm:flex-none" onClick={() => void publier()} disabled={!modifiee || !verdict.ok || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Publier la version {version + 1}
          </Button>
        </span>
      </div>
    </div>
  );
}
