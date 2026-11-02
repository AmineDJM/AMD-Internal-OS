/**
 * LES AIDES INTERNES D'UN FICHIER D'ACTIONS COMPTENT COMME SES FONCTIONS LOCALES — et elles seules.
 *
 * Un fichier `"use server"` ne peut exporter que des actions : ce qui l'aide (une lecture, un corps qui reçoit le
 * formulaire, un lecteur de champ) vit donc à côté, dans `src/lib/actions/internes/<domaine>/` (lot V4), sans
 * directive. Pour la dérivation, ce code-là EST celui du fichier d'actions : déplacé là, il ne doit rien perdre de
 * ce qu'il disait sur place.
 *
 * ── CE QUE LA RÈGLE DONNE, EXACTEMENT ────────────────────────────────────────────────────
 *
 *   • une fonction de `actions/internes/` IMPORTÉE par le fichier d'actions entre dans ses fonctions locales : quand
 *     l'action lui passe le FORMULAIRE, elle est suivie comme un délégué local (`deleguesDuCorps`) — ses champs, ses
 *     écritures et l'attribution de ses références comptent pour l'action ;
 *   • les LECTEURS de champ définis dans un module de `actions/internes/` importé comptent comme ceux du fichier
 *     (pour l'action, et pour les délégués de ce module) ;
 *   • les écrivains IMPORTÉS par le module d'un tel délégué sont suivis comme s'ils étaient appelés dans le corps de
 *     l'action (`faitsEcritureImportes`, un niveau, sur le corps du délégué).
 *
 * ── CE QU'ELLE NE DONNE PAS ──────────────────────────────────────────────────────────────
 *
 * Rien hors du préfixe `@/lib/actions/internes/` : un module de domaine reste un module importé, suivi pour ses
 * seuls faits d'écriture (`faitsEcritureImportes`), jamais pour ses champs. Une aide appelée SANS le formulaire
 * garde ce traitement d'import (inchangé). Les GARDES et le module de l'audit se lisent toujours dans le corps de
 * l'action : une garde déplacée dans une aide disparaîtrait de la fiche, et c'est voulu — la porte se lit là où
 * l'action la franchit. Un appel d'une aide interne à une autre par chemin relatif n'est pas suivi (un niveau).
 *
 * Pur, sans import hors du dossier : le scanner fournit le source des modules.
 */
import { fonctionsLocales } from "./decoupage";
import { importsProjet } from "./ecritures";
import { helpersDuFichier } from "./lecture-champs";
import type { SourceAction, TypeChamp } from "./types";

/** Le seul préfixe dont les fonctions comptent comme celles du fichier d'actions. */
export const PREFIXE_INTERNES = "@/lib/actions/internes/";

/** Les modules internes importés par le fichier d'actions, et leur source (fourni par le scanner). */
function modulesInternes(
  imports: Readonly<Record<string, string>>, sourcesImportees: Readonly<Record<string, string>>,
): string[] {
  return [...new Set(Object.values(imports))]
    .filter((spec) => spec.startsWith(PREFIXE_INTERNES) && sourcesImportees[spec] !== undefined);
}

/**
 * Les fonctions internes importées par le fichier, telles que la dérivation les lit en local — chacune avec les
 * imports et les lecteurs de SON module, pour suivre ses écrivains et lire ses champs.
 */
export function fonctionsInternes(
  imports: Readonly<Record<string, string>>, sourcesImportees: Readonly<Record<string, string>>,
): Record<string, SourceAction> {
  const out: Record<string, SourceAction> = {};
  const parModule = new Map<string, Record<string, SourceAction>>();
  for (const spec of modulesInternes(imports, sourcesImportees)) {
    const src = sourcesImportees[spec]!;
    const interne = { imports: importsProjet(src), lecteurs: helpersDuFichier(src) };
    const fonctions = fonctionsLocales(src);
    for (const f of Object.values(fonctions)) f.interne = interne;
    parModule.set(spec, fonctions);
  }
  for (const [nom, spec] of Object.entries(imports)) {
    const f = parModule.get(spec)?.[nom];
    if (f) out[nom] = f;
  }
  return out;
}

/** Les lecteurs de champ que le fichier d'actions importe d'un module interne. */
export function lecteursInternes(
  imports: Readonly<Record<string, string>>, sourcesImportees: Readonly<Record<string, string>>,
): Record<string, TypeChamp> {
  const out: Record<string, TypeChamp> = {};
  for (const spec of modulesInternes(imports, sourcesImportees)) {
    const lecteurs = helpersDuFichier(sourcesImportees[spec]!);
    // Seulement ceux que le fichier IMPORTE : un lecteur du module qu'il n'importe pas n'est pas le sien.
    for (const [nom, depuis] of Object.entries(imports)) if (depuis === spec && lecteurs[nom]) out[nom] = lecteurs[nom]!;
  }
  return out;
}
