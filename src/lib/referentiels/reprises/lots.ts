import { bilanVide, type BilanReprise } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARCOURS PAR LOTS D'UNE REPRISE À PLUSIEURS SOURCES — module PUR (aucune base : les sources
 * apportent leur lecture et leur traitement).
 *
 * Une reprise lit plusieurs tables l'une après l'autre (`Company`, puis `CompanyContact`…). Le curseur dit
 * où reprendre : `"<source>:<dernier id traité>"`, ou `"<source>:"` pour le début d'une source. Chaque
 * source lit ses lignes PAR ID CROISSANT, strictement après le curseur : un lot interrompu se rejoue sans
 * sauter ni doubler une ligne, et le traitement d'une ligne est lui-même idempotent.
 *
 * Une ligne en échec est DITE dans `erreurs` et n'arrête pas le lot : la suivante est traitée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type IssueLigne = "CREEE" | "LIEE" | "IGNOREE";

export interface ResultatLigne {
  issue: IssueLigne;
  /** Propositions de doublons déposées en traitant la ligne. */
  doublons?: number;
}

export interface SourceDeReprise<L extends { id: string } = { id: string }> {
  /** Nom stable (celui du curseur) : le modèle lu, `Company`. */
  nom: string;
  /** Les lignes d'id strictement supérieur à `apresId` (nul : depuis le début), par id croissant, au plus `taille`. */
  lire(apresId: string | null, taille: number): Promise<L[]>;
  traiter(ligne: L): Promise<ResultatLigne>;
}

/** Au-delà, les erreurs d'un lot sont résumées : un journal illisible ne dit plus rien. */
export const ERREURS_MAX = 30;

export function lireCurseur(curseur: string | null | undefined, noms: readonly string[]): { index: number; apresId: string | null } {
  if (!curseur) return { index: 0, apresId: null };
  const sep = curseur.indexOf(":");
  const nom = sep < 0 ? curseur : curseur.slice(0, sep);
  const index = noms.indexOf(nom);
  if (index < 0) throw new Error(`Curseur de reprise inconnu : « ${curseur} ».`);
  const id = sep < 0 ? "" : curseur.slice(sep + 1);
  return { index, apresId: id || null };
}

export function ajouter(bilan: BilanReprise, r: ResultatLigne): void {
  if (r.issue === "CREEE") bilan.creees++;
  else if (r.issue === "LIEE") bilan.liees++;
  else bilan.ignorees++;
  bilan.doublonsProposes += r.doublons ?? 0;
}

export function noterErreur(bilan: BilanReprise, message: string): void {
  if (bilan.erreurs.length < ERREURS_MAX) bilan.erreurs.push(message);
  else if (bilan.erreurs.length === ERREURS_MAX) bilan.erreurs.push("… erreurs suivantes non détaillées.");
}

/** UN LOT : au plus `taille` lignes, à travers les sources, à partir du curseur. */
export async function executerParLots(
  sources: readonly SourceDeReprise[], opts: { taille: number; apresId?: string | null },
): Promise<BilanReprise & { suite: string | null }> {
  const taille = Math.max(1, Math.floor(opts.taille));
  const bilan = bilanVide();
  let { index, apresId } = lireCurseur(opts.apresId, sources.map((s) => s.nom));
  let reste = taille;
  while (index < sources.length) {
    const source = sources[index];
    const lignes = await source.lire(apresId, reste);
    for (const ligne of lignes) {
      bilan.lues++;
      try {
        ajouter(bilan, await source.traiter(ligne));
      } catch (e) {
        noterErreur(bilan, `${source.nom} ${ligne.id} : ${e instanceof Error ? e.message : String(e)}`);
      }
      apresId = ligne.id;
    }
    reste -= lignes.length;
    if (reste <= 0) return { ...bilan, suite: `${source.nom}:${apresId ?? ""}` };
    // Moins de lignes que demandé : la source est épuisée, on passe à la suivante.
    index++;
    apresId = null;
  }
  return { ...bilan, suite: null };
}

/** L'APERÇU : la somme des aperçus de chaque source. */
export function sommer(bilans: readonly BilanReprise[]): BilanReprise {
  const total = bilanVide();
  for (const b of bilans) {
    total.lues += b.lues; total.creees += b.creees; total.liees += b.liees;
    total.doublonsProposes += b.doublonsProposes; total.ignorees += b.ignorees;
    for (const e of b.erreurs) noterErreur(total, e);
  }
  return total;
}
