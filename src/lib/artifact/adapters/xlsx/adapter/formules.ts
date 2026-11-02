/**
 * L'ADAPTATEUR EXCEL — les FORMULES : réécrire les références A1 après un décalage de lignes ou de
 * colonnes.
 */
import { analyserRef, nombreEnColonne } from "@/lib/artifact/object-model/model";

/**
 * RÉÉCRIT les références A1 d'une formule après un décalage.
 *
 * Une référence ABSOLUE (`$B$4`) ne bouge pas — c'est sa définition et c'est ce qu'attend
 * quiconque a écrit `$B$4` exprès. Une référence relative se décale. Les références précédées
 * d'un `!` (autre feuille) sont laissées telles quelles.
 */
export function decalerFormule(formule: string, axe: "ligne" | "colonne", depuis: number, delta: number): string {
  return formule.replace(/(!?)(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g, (tout, bang, dCol, lettres, dRow, chiffres) => {
    if (bang === "!") return tout;
    const pos = analyserRef(`${lettres}${chiffres}`);
    if (!pos) return tout;
    if (axe === "ligne") {
      if (dRow === "$" || pos.row < depuis) return tout;
      return `${bang}${dCol}${lettres}${dRow}${pos.row + delta}`;
    }
    if (dCol === "$" || pos.col < depuis) return tout;
    return `${bang}${dCol}${nombreEnColonne(pos.col + delta)}${dRow}${chiffres}`;
  });
}
