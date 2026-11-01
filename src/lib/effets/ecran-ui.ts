/**
 * LE GESTE D'ÉCRAN ANNULABLE, CÔTÉ NAVIGATEUR (K10a, décision 0039) — pur, sans import : le bandeau « Annuler » le lit.
 *
 * Une action d'argent faite depuis l'ERP laisse, à son retour, un témoin court (`amd-geste-annulable`) : l'identifiant
 * du geste journalisé et son libellé. Le bandeau de l'application le lit et offre « Annuler » ; rien d'autre n'y est.
 */
export const COOKIE_GESTE_ANNULABLE = "amd-geste-annulable";
/** Combien de temps le bandeau « Annuler » reste offert après l'action (l'historique, lui, garde le geste 180 jours). */
export const DUREE_BANDEAU_SECONDES = 120;

export interface GesteAnnulable { id: string; libelle: string; mode: "retour" | "compensation" }

export const valeurGesteAnnulable = (g: GesteAnnulable): string => `${g.id}~${g.mode}~${encodeURIComponent(g.libelle.slice(0, 120))}`;

export function lireGesteAnnulable(cookie: string): GesteAnnulable | null {
  const brut = cookie.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_GESTE_ANNULABLE}=`))?.slice(COOKIE_GESTE_ANNULABLE.length + 1);
  if (!brut) return null;
  const [id, mode, libelle] = decodeURIComponent(brut).split("~");
  if (!id || (mode !== "retour" && mode !== "compensation")) return null;
  let texte = libelle ?? "";
  try { texte = decodeURIComponent(texte); } catch { /* libellé déjà décodé */ }
  return { id, mode, libelle: texte };
}
