import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { ROLE_LABELS } from "@/lib/labels";
import type { AccesIa } from "../domaine/acces-regles";
import { fonctionEnVigueur, perimetreEnVigueur } from "../domaine/perimetres";
import { adresseDe, libelleAvenant, prenomDe, sectionProfil, type Adresse, type ProfilPersonne } from "../domaine/profil-personne";
import { ficheEtAvenantsDe } from "./role-config";

/**
 * S1 (décision 0048) — LE PROFIL DE LA PERSONNE, construit par le serveur à chaque tour depuis le compte de la SESSION et
 * la fiche RH LIÉE à ce compte. La part lue en base (fiche, avenants, entités, préférence) est gardée 60 s par personne :
 * un tour ne relit pas la fiche ; un avenant saisi vaut au plus tard une minute après. Les familles et périmètres, eux,
 * viennent de l'accès du TOUR (relu à chaque tour) : jamais en cache.
 */
const TTL_MS = 60_000;
type PartFiche = { fiche: ProfilPersonne["fiche"]; adresse: Adresse; entites: Map<string, string> };
const cacheFiche = new Map<string, { a: number; v: PartFiche }>();

/** Après une écriture qui le change (avenant, préférence) : la prochaine lecture repart de la base. */
export function oublierProfil(userId?: string): void {
  if (userId) cacheFiche.delete(userId); else cacheFiche.clear();
}

async function partFiche(userId: string): Promise<PartFiche> {
  const c = cacheFiche.get(userId);
  if (c && Date.now() - c.a < TTL_MS) return c.v;
  const [f, pref, societes] = await Promise.all([
    ficheEtAvenantsDe(userId),
    prisma.assistantIaPreference.findUnique({ where: { userId }, select: { adresse: true } }),
    prisma.company.findMany({ select: { id: true, shortName: true, name: true } }),
  ]);
  const entites = new Map(societes.map((s) => [s.id, s.shortName ?? s.name]));
  const maintenant = new Date();
  const fiche: ProfilPersonne["fiche"] = f ? (() => {
    const fonction = fonctionEnVigueur(f.position, f.avenants, maintenant);
    const enVigueur = f.avenants.filter((a) => perimetreEnVigueur({ du: a.effetLe, au: a.finLe }, maintenant));
    return {
      poste: f.position, fonction: fonction.fonction, fonctionOrigine: fonction.origine,
      departement: f.departmentRef?.name ?? f.department ?? null,
      entite: f.company?.shortName ?? f.company?.name ?? null,
      responsable: f.manager?.fullName ?? null,
      contrat: {
        type: f.contractType ?? null,
        debut: (f.contractStart ?? f.hireDate)?.toISOString().slice(0, 10) ?? null,
        fin: f.contractEnd?.toISOString().slice(0, 10) ?? null,
        enVigueur: f.contratValide,
      },
      avenants: enVigueur.map((a) => ({ objet: a.objet, libelle: libelleAvenant(a, entites), du: a.effetLe.slice(0, 10), au: a.finLe?.slice(0, 10) ?? null })),
    };
  })() : null;
  const v = { fiche, adresse: adresseDe(pref?.adresse), entites };
  cacheFiche.set(userId, { a: Date.now(), v });
  return v;
}

/** Le profil complet de la personne de la session — rien d'une autre personne. */
export async function profilDeLaPersonne(user: CurrentUser, acces: AccesIa): Promise<{ profil: ProfilPersonne; section: string }> {
  const p = await partFiche(user.id);
  const profil: ProfilPersonne = {
    userId: user.id, nom: user.name, prenom: prenomDe(user.name), adresse: p.adresse,
    role: ROLE_LABELS[user.role] ?? user.role,
    roleSecondaire: user.secondaryRole ? ROLE_LABELS[user.secondaryRole] ?? user.secondaryRole : null,
    fiche: p.fiche,
    famillesOuvertes: [...acces.ouvertes],
    perimetres: acces.superAdmin ? [] : [...(acces.perimetres ?? [])],
    superAdmin: acces.superAdmin,
  };
  return { profil, section: sectionProfil(profil, p.entites) };
}

/** La préférence d'adresse (accueil de l'écran). */
export async function adresseDeLaPersonne(userId: string): Promise<Adresse> {
  return (await partFiche(userId)).adresse;
}

export async function reglerAdresse(userId: string, adresse: Adresse): Promise<void> {
  await prisma.assistantIaPreference.upsert({ where: { userId }, create: { userId, adresse }, update: { adresse } });
  oublierProfil(userId);
}
