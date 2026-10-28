import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { chargerStrategie, chargerPanel, type LignePanel, type StrategieChargee } from "./service";
import { type EntreeLettre } from "./lettre-requise";

export type { EntreeLettre } from "./lettre-requise";

/**
 * LA LETTRE PARTOUT — côté BASE (Direction, 07/10). Charge, pour chaque BU, sa stratégie ACTIVE et le panel que le moteur
 * en calcule (les MÊMES fonctions que l'écran Segmentation : `chargerStrategie`, `chargerPanel`), puis indexe chaque
 * praticien → ses lettres. La règle de choix et le repli vivent dans `lettre-requise.ts` (pur).
 *
 * Une stratégie sans règles publiées valides ne donne aucune lettre : ses praticiens retombent sur le palier de
 * potentiel, comme ceux qui ne sont dans aucune stratégie — on ne devine pas une fréquence que personne n'a publiée.
 */

export interface SegmentationBu {
  buId: string;
  buNom: string;
  strategie: StrategieChargee;
  lignes: LignePanel[];
}

/**
 * Les stratégies actives (une par BU — la première créée, comme l'écran Segmentation), bornées aux BU demandées et,
 * si on les donne, aux praticiens demandés.
 */
export async function chargerSegmentations(opts: { buIds?: readonly string[] | null; doctorIds?: readonly string[] | null } = {}): Promise<SegmentationBu[]> {
  if (opts.doctorIds && opts.doctorIds.length === 0) return [];
  const bus = await prisma.businessUnit.findMany({
    where: { ...(opts.buIds ? { id: { in: [...opts.buIds] } } : {}), segmentationStrategies: { some: { statut: "ACTIVE" } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, segmentationStrategies: { where: { statut: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true } } },
  });
  const portee: Prisma.MedicalDoctorWhereInput = opts.doctorIds ? { id: { in: [...opts.doctorIds] } } : {};
  const out: SegmentationBu[] = [];
  for (const b of bus) {
    const id = b.segmentationStrategies[0]?.id;
    if (!id) continue;
    const strategie = await chargerStrategie(id);
    if (!strategie?.regle?.regles) continue;
    out.push({ buId: b.id, buNom: b.name, strategie, lignes: await chargerPanel(strategie, portee) });
  }
  return out;
}

/** Praticien → ses lettres, une entrée par stratégie où le moteur l'a classé. */
export function indexerLettres(segmentations: readonly SegmentationBu[]): Map<string, EntreeLettre[]> {
  const out = new Map<string, EntreeLettre[]>();
  for (const s of segmentations) {
    for (const l of s.lignes) {
      if (!l.resultat) continue;
      const e: EntreeLettre = {
        buId: s.buId, strategieId: s.strategie.id, lettre: l.resultat.lettre, visites: l.resultat.visites,
        statut: l.statut, secteurId: l.secteurId, secteurNom: l.secteurNom,
      };
      out.set(l.doctorId, [...(out.get(l.doctorId) ?? []), e]);
    }
  }
  return out;
}

/** Les lettres d'une liste de praticiens (toutes BU). */
export async function lettresDesPraticiens(doctorIds: readonly string[]): Promise<Map<string, EntreeLettre[]>> {
  return indexerLettres(await chargerSegmentations({ doctorIds }));
}
