import type { SessionUser } from "@/lib/rbac";
import { cheminVers, noeudsRendus, parcourir, type OptionsParcours } from "../domaine/parcours";
import type { AreteDatee, Provenance, TypeNoeud } from "../domaine/noeuds";
import { aretesDe } from "./aretes";
import { decrire, type NoeudDecrit } from "./noeuds";
import { perimetreDe } from "./perimetre";

/**
 * EXPLORER LES RELATIONS d'une entité (J9, décision 0021) : le parcours borné du domaine, branché sur les arêtes de la
 * base et sur le périmètre de la personne (les droits jugent chaque nœud AVANT qu'il ne soit traversé).
 */
export interface EtapeRendue { de: string; relation: string; a: string; depuis: string | null; jusqua: string | null; note: string | null; source: Provenance }
export interface NoeudAtteint extends NoeudDecrit { distance: number; chemin: EtapeRendue[] }
export type Exploration =
  | { ok: false; raison: "INTROUVABLE" }
  | { ok: true; depart: NoeudDecrit; noeuds: NoeudAtteint[]; aretes: number; tronque: boolean; ms: number };

const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const etape = (a: AreteDatee): EtapeRendue => ({ de: a.de, relation: a.relation, a: a.a, depuis: jour(a.depuis), jusqua: jour(a.jusqua), note: a.note ?? null, source: a.source });

export async function explorerRelations(
  user: SessionUser, depart: string, o: OptionsParcours & { exclus?: readonly TypeNoeud[]; pourModele?: boolean; limite?: number } = {},
): Promise<Exploration> {
  const t0 = Date.now();
  const perimetre = perimetreDe(user, { exclus: o.exclus, pourModele: o.pourModele });
  const r = await parcourir(depart, { etendre: (refs) => aretesDe(refs, perimetre.types), autoriser: perimetre.autoriser }, o);
  if (r.refuse) return { ok: false, raison: "INTROUVABLE" };
  const rendus = noeudsRendus(r, o.typesVises).slice(0, o.limite ?? 60);
  const decrits = await decrire([depart, ...rendus]);
  const dep = decrits.get(depart);
  if (!dep) return { ok: false, raison: "INTROUVABLE" };
  const noeuds: NoeudAtteint[] = rendus.flatMap((ref) => {
    const n = decrits.get(ref);
    return n ? [{ ...n, distance: r.noeuds.get(ref)!, chemin: cheminVers(r, ref).map(etape) }] : [];
  });
  return { ok: true, depart: dep, noeuds, aretes: r.aretes.length, tronque: r.tronque, ms: Date.now() - t0 };
}
