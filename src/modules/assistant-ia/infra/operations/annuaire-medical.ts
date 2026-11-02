import { prisma } from "@/lib/prisma";
import { scopeMedicalDoctors } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";

/**
 * L'ANNUAIRE MÉDICAL, VU PAR LA PERSONNE — pour pré-remplir et pour désigner un médecin.
 *
 * On ne cherche QUE dans ce que la personne voit à l'écran (`scopeMedicalDoctors` : son panel, ses
 * droits par ligne, ou tout si sa portée est globale). Un nom qui désigne plusieurs fiches n'est
 * jamais tranché en silence : il revient avec ses candidats, et l'agent demande lequel.
 */
export interface MedecinLu {
  id: string;
  nom: string;
  specialite: string | null;
  wilaya: string | null;
}

export interface LectureMedecins {
  connus: MedecinLu[];
  /** Aucun praticien visible ne porte ce nom. */
  inconnus: string[];
  /** Plusieurs praticiens visibles portent ce nom : à préciser. */
  ambigus: { nom: string; candidats: string[] }[];
}

export const replier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export async function lireMedecins(user: CurrentUser, noms: string[]): Promise<LectureMedecins> {
  const out: LectureMedecins = { connus: [], inconnus: [], ambigus: [] };
  for (const nom of noms) {
    const trouves = await prisma.medicalDoctor.findMany({
      where: { AND: [scopeMedicalDoctors(user), { name: { contains: nom, mode: "insensitive" } }] },
      select: { id: true, name: true, specialty: true, wilaya: true, city: true, specialtyRef: { select: { name: true } } },
      take: 6,
    });
    const exacts = trouves.filter((d) => replier(d.name) === replier(nom));
    const un = exacts.length === 1 ? exacts[0] : trouves.length === 1 ? trouves[0] : null;
    if (un) {
      if (!out.connus.some((m) => m.id === un.id)) {
        out.connus.push({ id: un.id, nom: un.name, specialite: un.specialtyRef?.name ?? un.specialty ?? null, wilaya: un.wilaya ?? un.city ?? null });
      }
    } else if (trouves.length > 1) {
      out.ambigus.push({ nom, candidats: trouves.map((d) => d.name) });
    } else {
      out.inconnus.push(nom);
    }
  }
  return out;
}

/** Une seule valeur commune, ou rien : on ne pré-remplit pas d'une voix discordante. */
export const valeurCommune = (xs: (string | null)[]): string | null => {
  const v = [...new Set(xs.filter((x): x is string => !!x))];
  return v.length === 1 ? v[0]! : null;
};
