/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DIMENSIONS DÉRIVÉES — la part PURE des liens L3 et L9 du recensement : on ne les écrit pas sur chaque table source
 * (une visite, une ligne de vente PCH), on les DÉRIVE au moment de matérialiser un signal.
 *
 *   • L3 — une visite → sa wilaya (celle du médecin), sa BU (celle du délégué), sa société (celle de la BU, sinon celle du
 *     médecin). Un délégué SANS BU ne reçoit pas de BU inventée : la dimension reste vide, et le dit.
 *   • L9 — une ligne de vente PCH → sa ou ses wilayas : celle de l'établissement client quand il est rapproché (la plus
 *     sûre), sinon celles de la direction régionale (une DR en couvre plusieurs : la ligne n'est alors PAS attribuée à une
 *     wilaya unique, on rend la liste).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface VisiteADeriver {
  doctor: { wilayaCode: string | null; companyId: string | null } | null;
  /** La BU du délégué (`SalesRepProfile`), et la société de cette BU. */
  buDuDelegue: { id: string; companyId: string | null } | null;
}

export interface DimensionsVisite {
  wilayaCode: string | null;
  buId: string | null;
  companyId: string | null;
  /** D'où vient la société : la BU du délégué (le cas sûr) ou la fiche du médecin. */
  origineSociete: "bu" | "medecin" | null;
}

export function dimensionsDeVisite(v: VisiteADeriver): DimensionsVisite {
  const companyBu = v.buDuDelegue?.companyId ?? null;
  const companyMedecin = v.doctor?.companyId ?? null;
  return {
    wilayaCode: v.doctor?.wilayaCode ?? null,
    buId: v.buDuDelegue?.id ?? null,
    companyId: companyBu ?? companyMedecin,
    origineSociete: companyBu ? "bu" : companyMedecin ? "medecin" : null,
  };
}

export interface VentePchADeriver {
  dr: string;
  /** La wilaya de l'établissement client rapproché, s'il l'est. */
  wilayaEtablissement: string | null;
}

export interface DimensionsVentePch {
  /** La wilaya certaine (celle de l'établissement, ou l'unique wilaya de la DR) ; null quand la DR en couvre plusieurs. */
  wilayaCode: string | null;
  /** Les wilayas possibles (DR) — une seule quand `wilayaCode` est posée. */
  wilayasPossibles: string[];
  origine: "etablissement" | "dr" | null;
}

/** `wilayasParDr` : la table `PchDirectionRegionale` (code → wilayas), telle que renseignée. */
export function dimensionsDeVentePch(v: VentePchADeriver, wilayasParDr: ReadonlyMap<string, readonly string[]>): DimensionsVentePch {
  if (v.wilayaEtablissement) return { wilayaCode: v.wilayaEtablissement, wilayasPossibles: [v.wilayaEtablissement], origine: "etablissement" };
  const possibles = [...new Set(wilayasParDr.get(v.dr.trim().toUpperCase()) ?? [])].sort();
  if (possibles.length === 0) return { wilayaCode: null, wilayasPossibles: [], origine: null };
  return { wilayaCode: possibles.length === 1 ? possibles[0] : null, wilayasPossibles: possibles, origine: "dr" };
}
