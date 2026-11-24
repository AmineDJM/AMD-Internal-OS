"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { peutAnnuaire } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { estCouleurCellule, cleCellule, lireCleCellule, type CibleCellule } from "@/lib/grille/couleurs";
import { isAnnuaireField } from "@/lib/medical/directory-grid";
import { isEtablissementField } from "@/lib/medical/etablissements-grid";
import type { ActionResult } from "@/lib/actions/types";

/**
 * COLORER DES CELLULES D'ANNUAIRE — le surlignage d'un tableur, persisté (§118.133).
 *
 * ── CE QU'EST UNE COULEUR, ET CE QU'ELLE N'EST PAS ────────────────────────────────────────
 *
 * Une couleur est une ANNOTATION PARTAGÉE de la feuille : « ces praticiens à revoir », « ces
 * hôpitaux couverts ». Elle ne change aucune donnée métier, mais elle se LIT comme la feuille —
 * par tous ceux qui la voient — donc elle se POSE sous le même droit que la cellule qu'elle
 * colore : un délégué colore ses praticiens et pas ceux des autres (`canAccessEntity`, la même
 * garde que `saveDirectoryCell`) ; les établissements, référentiel sans portée, demandent le
 * droit de modification de LEUR annuaire, comme leur formulaire (§118.147).
 *
 * ── LE VOCABULAIRE EST FERMÉ DES DEUX CÔTÉS ─────────────────────────────────────────────
 *
 * La couleur est une CLÉ de la palette (`lib/grille/couleurs.ts`) — un code libre finirait dans
 * un attribut de style. La colonne est une colonne DE LA FEUILLE (`directory-grid.ts`,
 * `etablissements-grid.ts`) ou la clé d'une colonne sur mesure de l'annuaire du praticien :
 * une couleur posée sur une colonne que la feuille n'affiche pas vivrait en base pour toujours
 * sans que personne ne la voie.
 *
 * ── UNE SÉLECTION QUI DÉBORDE NE COLORE QUE CE QU'ELLE AVAIT LE DROIT DE COLORER ───────
 *
 * Comme la suppression par lots : ligne par ligne, jamais tout ou rien, jamais plus que le
 * droit — et le compte de ce qui a été laissé de côté est RENDU, pas tu.
 */

export type FeuilleAnnuaire = "praticiens" | "etablissements";

export interface ResultatColoration extends ActionResult {
  /** Cellules réellement écrites (colorées ou effacées). */
  touchees: number;
  /** Cellules laissées de côté : ligne hors de portée, colonne inconnue, ligne disparue. */
  ignorees: number;
}

/** Au-delà, ce n'est plus un geste d'écran : un tableur ne colore pas dix mille cellules d'un clic. */
const CELLULES_MAX = 5_000;
const LOT_PERMISSION = 25;

const refus = (error: string): ResultatColoration => ({ ok: false, error, touchees: 0, ignorees: 0 });

export async function colorerCellulesAnnuaire(input: {
  feuille: "praticiens" | "etablissements";
  /** Les cellules visées, chacune sous la forme `<identifiant de ligne>:<colonne>` (`cleCellule`). */
  cellules: string[];
  /** Une clé de palette (jaune, vert, bleu, orange, rose, violet, rouge, gris), ou `null` pour EFFACER. */
  couleur: string | null;
}): Promise<ResultatColoration> {
  const user = await requireUser();
  const feuille = input.feuille as FeuilleAnnuaire;
  if (feuille !== "praticiens" && feuille !== "etablissements") return refus("Feuille inconnue.");
  // LA PORTE est celle de l'ANNUAIRE (§118.147), pas du module : la feuille des établissements
  // se colore sous le droit de modifier cet annuaire ; celle des praticiens sous l'un des deux
  // annuaires de praticiens — et chaque LIGNE est revérifiée plus bas dans l'annuaire de son grade.
  const porte = feuille === "etablissements"
    ? peutAnnuaire(user, "ETABLISSEMENTS", "UPDATE")
    : peutAnnuaire(user, "MEDECINS", "UPDATE") || peutAnnuaire(user, "PHARMACIENS", "UPDATE");
  if (!porte) return refus("Colorer la feuille demande le droit de modification sur cet annuaire (Visite médicale, ou accès ouvert depuis Administration › Comptes).");

  const couleur = input.couleur === null || input.couleur === "" ? null : input.couleur;
  if (couleur !== null && !estCouleurCellule(couleur)) return refus("Couleur hors de la palette.");

  // Dédoublonnage : la même cellule deux fois n'est qu'une cellule.
  const vues = new Set<string>();
  const cibles: CibleCellule[] = [];
  for (const brut of input.cellules ?? []) {
    const c = lireCleCellule(brut);
    if (!c) continue;
    const k = cleCellule(c.id, c.field);
    if (vues.has(k)) continue;
    vues.add(k);
    cibles.push(c);
  }
  if (cibles.length === 0) return refus("Aucune cellule sélectionnée.");
  if (cibles.length > CELLULES_MAX) return refus(`Au plus ${CELLULES_MAX} cellules par geste — resserrez la sélection.`);

  const ids = [...new Set(cibles.map((c) => c.id))];

  // ── LES LIGNES QU'ON A LE DROIT DE TOUCHER, ET LES COLONNES QU'ELLES CONNAISSENT ──
  // id → clés des colonnes sur mesure de son annuaire (null = aucune).
  let autorisees: Map<string, Set<string> | null>;
  if (feuille === "praticiens") {
    // Même garde que l'écriture d'une cellule — ligne par ligne, par lots pour ne pas payer une
    // requête à la fois sur une feuille entière.
    const ok: string[] = [];
    for (let i = 0; i < ids.length; i += LOT_PERMISSION) {
      const lot = ids.slice(i, i + LOT_PERMISSION);
      const verdicts = await Promise.all(lot.map((id) => canAccessEntity(user, "DOCTOR", id, "UPDATE")));
      lot.forEach((id, j) => { if (verdicts[j]) ok.push(id); });
    }
    const lignes = ok.length
      ? await prisma.medicalDoctor.findMany({
          where: { id: { in: ok } },
          select: { id: true, directory: { select: { columns: { select: { key: true } } } } },
        })
      : [];
    autorisees = new Map(lignes.map((l) => [l.id, l.directory ? new Set(l.directory.columns.map((c) => c.key)) : null]));
  } else {
    const lignes = await prisma.medicalInstitution.findMany({ where: { id: { in: ids } }, select: { id: true } });
    autorisees = new Map(lignes.map((l) => [l.id, null]));
  }

  const champConnu = (id: string, field: string): boolean => {
    if (feuille === "etablissements") return isEtablissementField(field);
    if (isAnnuaireField(field)) return true;
    return autorisees.get(id)?.has(field) ?? false;
  };

  const retenues = cibles.filter((c) => autorisees.has(c.id) && champConnu(c.id, c.field));
  const ignorees = cibles.length - retenues.length;
  if (retenues.length === 0) {
    return { ok: false, error: "Aucune de ces cellules n'est à votre portée.", touchees: 0, ignorees };
  }

  // ── L'ÉCRITURE : par colonne (une poignée), jamais par cellule (des milliers). ──
  const parChamp = new Map<string, string[]>();
  for (const c of retenues) (parChamp.get(c.field) ?? parChamp.set(c.field, []).get(c.field)!).push(c.id);
  const colonneLigne = feuille === "praticiens" ? "doctorId" : "institutionId";

  await prisma.$transaction(async (tx) => {
    for (const [field, lignes] of parChamp) {
      await tx.directoryCellStyle.deleteMany({ where: { field, [colonneLigne]: { in: lignes } } });
    }
    if (couleur !== null) {
      await tx.directoryCellStyle.createMany({
        data: retenues.map((c) => ({ [colonneLigne]: c.id, field: c.field, color: couleur, setById: user.id })),
        skipDuplicates: true,
      });
    }
  });

  revalidatePath("/medical/annuaire");
  revalidatePath("/annuaires");
  revalidatePath("/annuaires/etablissements");

  const verbe = couleur === null ? "effacée" : "colorée";
  return {
    ok: true,
    touchees: retenues.length,
    ignorees,
    message: ignorees > 0
      ? `${retenues.length} cellule(s) ${verbe}(s) · ${ignorees} hors de votre portée, laissée(s) telle(s) quelle(s)`
      : `${retenues.length} cellule(s) ${verbe}(s)`,
  };
}
