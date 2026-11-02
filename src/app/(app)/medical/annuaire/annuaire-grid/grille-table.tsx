"use client";

/**
 * L'ANNUAIRE — la table de la feuille : en-têtes, lignes, sélection et couleurs des cellules.
 */
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { estARattacher, specialiteEstARattacher, type AnnuaireRow } from "@/lib/medical/directory-grid";
import type { EtablissementOption } from "@/lib/annuaires/types";
import { cleCellule } from "@/lib/grille/couleurs";
import { useSelectionGrille } from "@/components/grille/use-selection";
import { classeCouleurCellule } from "@/components/grille/barre-selection";
import { type ColonneVue, type Edition, valeurAffichee, valeurBrute, groupesDeLaCellule } from "./colonnes";
import { EditeurCellule } from "./editeur-cellule";

/**
 * LE QUADRILLAGE — des CELLULES, comme dans un tableur.
 *
 * Un annuaire se lit à l'horizontale (« quelle est la wilaya de cette ligne ? ») et à la
 * verticale (« qui est en cardiologie ? »). Sans trait vertical, l'œil perd la colonne dès la
 * cinquième ligne et l'on corrige la mauvaise cellule. D'où le quadrillage complet, et le
 * surlignage de la ligne survolée. `offset` est le rang de la première ligne de cette tranche
 * dans la feuille entière : c'est ce qui rend la sélection continue entre deux groupes.
 */
export function GridTable({
  rows, offset, colonnes, editable, selected, onToggle, onToggleAll, grille, edition, onCommit, onCancel,
  couleurs, overrides, etablissements, effective,
}: {
  rows: AnnuaireRow[];
  offset: number;
  colonnes: ColonneVue[];
  etablissements: readonly EtablissementOption[];
  editable: boolean;
  selected: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
  grille: ReturnType<typeof useSelectionGrille>;
  edition: Edition | null;
  onCommit: (row: AnnuaireRow, col: ColonneVue, next: string, suite?: "bas" | "droite" | "gauche") => void;
  onCancel: () => void;
  couleurs: Record<string, string>;
  overrides: Map<string, string>;
  /** La ligne telle qu'elle EST : la base, plus ce qu'on vient d'y écrire (§118.172). */
  effective: (row: AnnuaireRow) => AnnuaireRow;
}) {
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  // UN TABLEAU RESTE UN TABLEAU au téléphone (Direction, 07/10) : la feuille défile dans son cadre, jamais en cartes.
  return (
    <div className="surface overflow-x-auto">
      <table className="w-full min-w-[72rem] border-collapse text-sm select-none">
        <thead>
          <tr className="bg-secondary/60 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="w-16 border border-border px-2 py-2">
              <input
                type="checkbox" checked={allChecked}
                onChange={(e) => onToggleAll(rows.map((r) => r.id), e.target.checked)}
                aria-label="Tout sélectionner" className="h-4 w-4 rounded border-input"
              />
            </th>
            {colonnes.map((c) => (
              <th
                key={c.cle}
                className={cn("whitespace-nowrap border border-border px-2 py-2 text-left font-medium", c.custom && "text-primary")}
                style={{ minWidth: `${c.width}rem` }}
                title={c.custom ? "Colonne propre à cet annuaire" : undefined}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const r = offset + i;
            return (
              <tr key={row.id} className={cn("hover:bg-secondary/20", selected.has(row.id) && "bg-primary/5")}>
                <td className="border border-border px-2">
                  <span className="flex items-center justify-center gap-1.5">
                    <input
                      type="checkbox" checked={selected.has(row.id)}
                      onChange={(e) => onToggle(row.id, e.target.checked)}
                      aria-label={`Sélectionner ${row.lastName ?? row.firstName ?? "cette ligne"}`}
                      className="h-4 w-4 rounded border-input"
                    />
                    {/* La fiche du praticien (lettre, délégué, dernière visite, Ad & Pro) — hors de la grille éditable. */}
                    <Link
                      href={`/praticiens/${row.id}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-primary/10 hover:text-primary"
                      aria-label={`Ouvrir la fiche de ${row.lastName ?? row.firstName ?? "ce praticien"}`}
                      title="Ouvrir la fiche"
                    >
                      <ArrowUpRight className="h-4 w-4" />
                    </Link>
                  </span>
                </td>
                {colonnes.map((col, c) => {
                  const enEdition = edition !== null && edition.r === r && edition.c === c;
                  const selectionnee = grille.estSelectionnee(r, c);
                  const couleur = couleurs[cleCellule(row.id, col.cle)];
                  const affichee = overrides.get(cleCellule(row.id, col.cle)) ?? valeurAffichee(row, col);
                  return (
                    <td
                      key={col.cle}
                      {...grille.propsCellule(r, c)}
                      className={cn(
                        "border border-border align-middle",
                        col.cle === "lastName" && "font-medium",
                        classeCouleurCellule(couleur),
                        selectionnee && "shadow-[inset_0_0_0_2px_hsl(var(--primary))] bg-primary/5",
                        !editable && "text-muted-foreground",
                      )}
                    >
                      {enEdition && editable ? (
                        <EditeurCellule
                          col={col}
                          valeur={valeurBrute(effective(row), col)}
                          initial={edition.initial}
                          groupes={col.editor === "reference" ? groupesDeLaCellule(col, effective(row), etablissements) : undefined}
                          onCommit={(next, suite) => onCommit(effective(row), col, next, suite)}
                          onCancel={onCancel}
                        />
                      ) : (
                        <span className="block min-h-[2rem] px-2 py-1.5">
                          {affichee || <span className="text-muted-foreground/40">—</span>}
                          {/* UN TEXTE SANS LIEN SE DIT COMME TEL (§118.172) : « EPH Rouiba » tapé
                              à la main n'est rattaché à aucun établissement de l'annuaire — il ne
                              compte dans aucun secteur et n'a pas de service. */}
                          {col.reference === "etablissement" && estARattacher(row) && !overrides.has(cleCellule(row.id, col.cle)) && (
                            <span className="ml-1.5 inline-block rounded bg-warning/15 px-1.5 py-0.5 align-middle text-[0.6875rem] font-medium uppercase tracking-wide text-warning"
                              title="Texte saisi à la main, sans lien vers l'annuaire des établissements : choisissez l'établissement dans la liste.">
                              à rattacher
                            </span>
                          )}
                          {/* À TRANCHER : plusieurs hôpitaux possibles dans la wilaya — la cellule les propose en tête. */}
                          {col.reference === "etablissement" && !row.institutionId && row.deduction?.statut === "a_trancher" && !overrides.has(cleCellule(row.id, col.cle)) && (
                            <span className="ml-1.5 inline-block rounded bg-warning/15 px-1.5 py-0.5 align-middle text-[0.6875rem] font-medium uppercase tracking-wide text-warning"
                              title={`${row.deduction.raison} Choisissez l'établissement : les possibles sont en tête de la liste.`}>
                              à trancher ({row.deduction.candidats.length})
                            </span>
                          )}
                          {/* LA MÊME RÈGLE POUR LA SPÉCIALITÉ (§118.180) : « Cardio » écrit sans lien
                              n'est rattaché à aucune spécialité du référentiel — rien de ce qui lit le
                              référentiel ne le voit. */}
                          {col.field === "specialty" && specialiteEstARattacher(row) && !overrides.has(cleCellule(row.id, col.cle)) && (
                            <span className="ml-1.5 inline-block rounded bg-warning/15 px-1.5 py-0.5 align-middle text-[0.6875rem] font-medium uppercase tracking-wide text-warning"
                              title="Spécialité écrite sans lien vers le référentiel : retapez-la telle que le référentiel la nomme, ou rattachez-la dans Annuaires › Spécialités.">
                              à rattacher
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
