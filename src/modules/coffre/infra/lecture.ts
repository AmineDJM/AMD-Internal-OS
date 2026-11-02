import type { SessionUser } from "@/lib/rbac";
import { ErreurDechiffrement } from "./chiffrement";
import { dechiffrer, recomposer } from "./dechiffrement";
import { lecteurDepuisSession } from "./lecteur";
import { controlerLecture, type DemandeLecture, type DependancesLecture, type Lecture } from "./acces";

export type { DemandeLecture, DependancesLecture, Lecture } from "./acces";

/**
 * LA DOUBLE LECTURE DU COFFRE (refonte V2-E) — ce que lisent les ÉCRANS (pages serveur, jamais
 * atteintes par l'assistant) : le contrôle d'accès de `acces.ts` (politique, journal d'abord, masque à
 * qui n'a pas le droit), puis la valeur DÉCHIFFRÉE du coffre quand sa copie correspond à la colonne.
 * Une copie illisible (autre clé) laisse la valeur de la colonne, qui fait foi jusqu'au palier P5.
 */
export async function lireSensibles(d: DemandeLecture, dep: DependancesLecture = {}): Promise<Lecture> {
  const { lecture, copiesAJour, cles } = await controlerLecture(d, dep);
  if (!cles) return lecture;
  let illisibles = 0;
  for (const a of copiesAJour) {
    try {
      lecture.get(a.ligne)![a.champ].valeur = dechiffrer(cles, a.copie.nature, a.copie.id, recomposer(a.copie));
    } catch (err) {
      if (!(err instanceof ErreurDechiffrement)) throw err;
      illisibles++;
    }
  }
  if (illisibles) console.warn(`[coffre] ${d.modele} : ${illisibles} copie(s) illisible(s) avec la clé actuelle — la colonne a été lue.`);
  return lecture;
}

/** La même lecture, pour la personne connectée. */
export function lireSensiblesPour(user: SessionUser, d: Omit<DemandeLecture, "lecteur">, dep?: DependancesLecture): Promise<Lecture> {
  return lireSensibles({ ...d, lecteur: lecteurDepuisSession(user) }, dep);
}
