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
import { CelluleEnTete } from "@/components/grille/en-tete-filtre";
import type { PiloteTableur } from "@/components/grille/use-tableur";
import { type ColonneVue, type Edition, valeurAffichee, valeurBrute, groupesDeLaCellule } from "./colonnes";
import { EditeurCellule } from "./editeur-cellule";

/** La colonne des cases et du lien vers la fiche — figée à gauche, avec le nom. */
const LARGEUR_CASES = 64;

const BADGE = "shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-warning";

/**
 * LE QUADRILLAGE — des CELLULES, comme dans un tableur.
 *
 * Un annuaire se lit à l'horizontale (« quelle est la wilaya de cette ligne ? ») et à la
 * verticale (« qui est en cardiologie ? »). Sans trait vertical, l'œil perd la colonne dès la
 * cinquième ligne et l'on corrige la mauvaise cellule. D'où le quadrillage complet, et le
 * surlignage de la ligne survolée. `offset` est le rang de la première ligne de cette tranche
 * dans la feuille entière : c'est ce qui rend la sélection continue entre deux groupes.
 *
 * COMME EXCEL (recette du 23/11) : l'en-tête reste collé en haut et le NOM figé à gauche pendant
 * qu'on fait défiler la feuille dans son cadre ; chaque en-tête porte son filtre automatique (▾),
 * trie au clic et s'élargit en glissant son bord ; les lignes sont serrées, une sur deux teintée.
 * Les fonds sont OPAQUES (une cellule figée laisserait voir défiler le texte de ses voisines), et
 * une cellule colorée garde sa couleur : la teinte d'une ligne sur deux ne s'y pose pas.
 */
export function GridTable({
  rows, offset, colonnes, pilote, borne, editable, selected, onToggle, onToggleAll, grille, edition, onCommit, onCancel,
  couleurs, overrides, etablissements, effective,
}: {
  rows: AnnuaireRow[];
  offset: number;
  /** Les colonnes AFFICHÉES (celles qu'on a masquées n'y sont pas). */
  colonnes: ColonneVue[];
  /** Filtres, tri, largeurs — l'état « comme Excel » de la feuille entière. */
  pilote: PiloteTableur;
  /** Vrai : la feuille défile dans un cadre à hauteur d'écran (en-tête collé). Faux dans la vue par spécialité. */
  borne: boolean;
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
  const parCle = new Map(pilote.colonnes.map((c) => [c.cle, c]));
  const largeurTotale = colonnes.reduce((s, c) => s + pilote.largeur(c.cle), LARGEUR_CASES);
  const ENTETE = "sticky top-0 border-b border-r border-border bg-secondary text-muted-foreground";
  // UN TABLEAU RESTE UN TABLEAU au téléphone (Direction, 07/10) : la feuille défile dans son cadre, jamais en cartes.
  return (
    <div className={cn("surface overflow-auto", borne && "max-h-[75vh]")}>
      <table className="min-w-full table-fixed border-separate border-spacing-0 text-[13px] select-none" style={{ width: largeurTotale }}>
        <colgroup>
          <col style={{ width: LARGEUR_CASES }} />
          {colonnes.map((c) => <col key={c.cle} style={{ width: pilote.largeur(c.cle) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={cn(ENTETE, "left-0 z-30 px-2")}>
              <input
                type="checkbox" checked={allChecked}
                onChange={(e) => onToggleAll(rows.map((r) => r.id), e.target.checked)}
                aria-label="Tout sélectionner" className="h-4 w-4 rounded border-input"
              />
            </th>
            {colonnes.map((c, j) => (
              <CelluleEnTete
                key={c.cle} pilote={pilote}
                colonne={parCle.get(c.cle) ?? { cle: c.cle, libelle: c.header, largeur: c.width * 12 }}
                className={cn(ENTETE, j === 0 ? "z-30" : "z-20", c.custom && "text-primary")}
                style={j === 0 ? { left: LARGEUR_CASES } : undefined}
                titre={c.custom ? "Colonne propre à cet annuaire" : undefined}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const r = offset + i;
            const fond = selected.has(row.id) ? "bg-accent" : i % 2 === 1 ? "bg-muted" : "bg-card";
            return (
              <tr key={row.id} className="group">
                <td className={cn("sticky left-0 z-10 border-b border-r border-border px-1 group-hover:bg-accent", fond)}>
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
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-primary/10 hover:text-primary"
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
                      title={affichee || undefined}
                      style={c === 0 ? { left: LARGEUR_CASES } : undefined}
                      className={cn(
                        "scroll-mt-10 border-b border-r border-border align-middle",
                        c === 0 && "sticky z-10",
                        col.cle === "lastName" && "font-medium",
                        couleur ? classeCouleurCellule(couleur) : cn(fond, "group-hover:bg-accent"),
                        selectionnee && "shadow-[inset_0_0_0_2px_hsl(var(--primary))]",
                        selectionnee && !couleur && "bg-accent",
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
                        <span className="flex min-h-7 items-center gap-1.5 px-2 py-0.5">
                          <span className="min-w-0 truncate">{affichee || <span className="text-muted-foreground/40">—</span>}</span>
                          {/* UN TEXTE SANS LIEN SE DIT COMME TEL (§118.172) : « EPH Rouiba » tapé
                              à la main n'est rattaché à aucun établissement de l'annuaire — il ne
                              compte dans aucun secteur et n'a pas de service. */}
                          {col.reference === "etablissement" && estARattacher(row) && !overrides.has(cleCellule(row.id, col.cle)) && (
                            <span className={BADGE}
                              title="Texte saisi à la main, sans lien vers l'annuaire des établissements : choisissez l'établissement dans la liste.">
                              à rattacher
                            </span>
                          )}
                          {/* À TRANCHER : plusieurs hôpitaux possibles dans la wilaya — la cellule les propose en tête. */}
                          {col.reference === "etablissement" && !row.institutionId && row.deduction?.statut === "a_trancher" && !overrides.has(cleCellule(row.id, col.cle)) && (
                            <span className={BADGE}
                              title={`${row.deduction.raison} Choisissez l'établissement : les possibles sont en tête de la liste.`}>
                              à trancher ({row.deduction.candidats.length})
                            </span>
                          )}
                          {/* LA MÊME RÈGLE POUR LA SPÉCIALITÉ (§118.180) : « Cardio » écrit sans lien
                              n'est rattaché à aucune spécialité du référentiel — rien de ce qui lit le
                              référentiel ne le voit. */}
                          {col.field === "specialty" && specialiteEstARattacher(row) && !overrides.has(cleCellule(row.id, col.cle)) && (
                            <span className={BADGE}
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
