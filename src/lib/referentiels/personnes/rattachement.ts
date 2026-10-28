/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RATTACHER UNE LIGNE À SA PERSONNE — le geste unique de la reprise R1 ET de la double écriture
 * (refonte des données, vague 2, lot V2-B).
 *
 *   1. La ligne porte déjà une Personne : rien à faire (« déjà reliée »).
 *   2. On remonte sa RACINE (`sources.ts` : le compte du salarié, le praticien du bénéficiaire…). Si une
 *      ligne de la chaîne porte une Personne, c'est la sienne (« reliée »).
 *   3. Sinon la Personne naît, avec l'identifiant DÉTERMINISTE de la racine (« créée ») : rejouer la
 *      reprise, ou passer par la double écriture puis par la reprise, retombe sur elle.
 *   4. Une Personne FUSIONNÉE renvoie à celle qui l'a absorbée (`fusionneeDansId`), jusqu'au bout.
 *   5. Toute la chaîne est reliée d'un coup, chaque ligne avec son rôle (`PersonneRole`, identifiant
 *      déterministe : un rôle de chaque sorte, pas un par passage).
 *
 * Une Personne qui existe déjà est COMPLÉTÉE (champs vides), jamais écrasée. Aucun rapprochement par le
 * nom, l'e-mail ou le téléphone ici : ceux-là sont PROPOSÉS (`doublons.ts`), une personne tranche.
 *
 * `aBlanc` : le même chemin, sans aucune écriture — l'aperçu chiffré que voit le Super Admin.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Prisma, PrismaClient, RolePersonne } from "@prisma/client";
import {
  SELECTION, complements, completude, idPersonnePour, idRolePour, lireLigne, nomReplie, refDe, roleApporte,
  type IdentiteSource, type LigneSource, type SourcePersonne,
} from "@/lib/referentiels/personnes/sources";

/** Le client de la base, ou celui d'une transaction en cours (la double écriture). */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Les délégués des neuf tables, vus sous la seule forme dont la reprise a besoin. Le typage par table de
 * Prisma ne se laisse pas indexer par un nom de table : cette interface étroite le remplace, et les
 * sélections (`SELECTION`) restent, elles, typées table par table.
 */
interface DelegueSource {
  findUnique(a: { where: { id: string }; select: object }): Promise<Record<string, unknown> | null>;
  findMany(a: { where?: object; select: object; orderBy?: object; take?: number }): Promise<Record<string, unknown>[]>;
  updateMany(a: { where: object; data: { personneId: string } }): Promise<{ count: number }>;
  count(a?: { where?: object }): Promise<number>;
}

export function delegue(db: Db, source: SourcePersonne): DelegueSource {
  const d = {
    User: db.user, Employee: db.employee, MedicalDoctor: db.medicalDoctor, CareBeneficiary: db.careBeneficiary,
    AdProVoyageur: db.adProVoyageur, AdProHebergement: db.adProHebergement, RecruitmentCandidate: db.recruitmentCandidate,
    DirectoryEntry: db.directoryEntry, SupplierUser: db.supplierUser,
  }[source];
  return d as unknown as DelegueSource;
}

/** Lit UNE ligne source (identité et clés de rattachement seulement). */
export async function lireSource(db: Db, source: SourcePersonne, id: string): Promise<LigneSource | null> {
  const r = await delegue(db, source).findUnique({ where: { id }, select: SELECTION[source] });
  return r ? lireLigne(source, r as never) : null;
}

/** La Personne au bout de la chaîne des fusions (dix maillons au plus : une boucle serait une donnée corrompue). */
export async function suivreFusion(db: Db, personneId: string): Promise<string> {
  let id = personneId;
  for (let i = 0; i < 10; i++) {
    const p = await db.personne.findUnique({ where: { id }, select: { fusionneeDansId: true } });
    if (!p?.fusionneeDansId) return id;
    id = p.fusionneeDansId;
  }
  return id;
}

export type EtatRattachement = "creee" | "liee" | "deja" | "ignoree";

export interface IssueRattachement {
  etat: EtatRattachement;
  personneId: string | null;
  /** Pourquoi la ligne est ignorée. */
  raison?: string;
  /** Les références des lignes reliées par ce passage (la ligne et ses racines non reliées). */
  reliees: string[];
}

export interface OptionsRattachement {
  creeParId?: string | null;
  /** Aucune écriture : on dit ce qui se passerait. */
  aBlanc?: boolean;
  /** À blanc, les Personnes « créées » plus tôt dans le même aperçu (deux lignes d'une même racine). */
  creeesABlanc?: Set<string>;
}

const fusionner = (principale: IdentiteSource, apport: IdentiteSource | null): IdentiteSource =>
  apport ? { ...principale, ...complements(principale, apport) } : principale;

/** RATTACHE une ligne déjà lue. Le cœur : voir l'en-tête. */
export async function rattacherLigne(db: Db, ligne: LigneSource, opts: OptionsRattachement = {}): Promise<IssueRattachement> {
  if (ligne.personneId) return { etat: "deja", personneId: ligne.personneId, reliees: [] };
  // Une ligne sans nom propre peut tenir son identité de sa racine (le bénéficiaire tiré de l'annuaire porte le nom
  // de son praticien) : seule une ligne sans nom NI racine est laissée de côté.
  if (ligne.ignorer || (!ligne.identite && !ligne.racine)) return { etat: "ignoree", personneId: null, raison: ligne.ignorer ?? "aucun nom", reliees: [] };

  // ── 2. LA RACINE : on remonte les liens que l'ERP porte déjà.
  const chaine: LigneSource[] = [ligne];
  let personneId: string | null = null;
  for (let courante = ligne, i = 0; courante.racine && i < 4; i++) {
    const r = await lireSource(db, courante.racine.source, courante.racine.id);
    if (!r || r.ignorer) break; // racine disparue ou technique : la ligne reste sa propre racine
    if (r.personneId) { personneId = r.personneId; break; }
    if (!r.identite) break;
    chaine.push(r);
    courante = r;
  }
  const racine = chaine[chaine.length - 1];
  if (!personneId && !racine.identite) return { etat: "ignoree", personneId: null, raison: "aucun nom, ni sur la ligne ni sur sa racine", reliees: [] };
  // La racine NOMME (le praticien plutôt que la saisie du bénéficiaire) ; les autres lignes complètent.
  const identite = racine.identite ? chaine.slice(0, -1).reduce((acc, l) => fusionner(acc, l.identite), racine.identite) : null;

  // ── 3. LA PERSONNE : celle de la chaîne, ou celle, déterministe, de la racine.
  let etat: EtatRattachement = "liee";
  if (!personneId) {
    const id = idPersonnePour(refDe(racine.source, racine.id));
    const existe = await db.personne.findUnique({ where: { id }, select: { id: true } });
    if (existe || opts.creeesABlanc?.has(id)) personneId = id;
    else {
      etat = "creee";
      personneId = id;
      if (opts.aBlanc) opts.creeesABlanc?.add(id);
      else {
        // `skipDuplicates` : deux écrivains simultanés d'une même racine ne se gênent pas — le second relie.
        const nee = identite!; // une racine sans nom a été écartée plus haut
        const { count } = await db.personne.createMany({
          data: [{
            id, nom: nee.nom, prenoms: nee.prenoms, civilite: nee.civilite, naissance: nee.naissance,
            nomReplie: nomReplie(nee), completude: completude(nee), creeParId: opts.creeParId ?? null,
          }],
          skipDuplicates: true,
        });
        if (!count) etat = "liee";
      }
    }
  }
  const reliees = chaine.map((l) => refDe(l.source, l.id));
  if (opts.aBlanc) return { etat, personneId, reliees };

  // ── 4. LES FUSIONS, puis le COMPLÉMENT d'une Personne qui existait.
  personneId = await suivreFusion(db, personneId);
  if (etat !== "creee" && identite) await completer(db, personneId, identite);

  // ── 5. TOUTE LA CHAÎNE, chaque ligne avec son rôle.
  for (const l of chaine) {
    const role = roleApporte(l);
    if (role) await assurerRole(db, personneId, role, opts.creeParId ?? null);
    // `personneId: null` dans le filtre : une ligne reliée entre-temps par un autre passage n'est pas déplacée.
    await delegue(db, l.source).updateMany({ where: { id: l.id, personneId: null }, data: { personneId } });
  }
  return { etat, personneId, reliees };
}

/** RATTACHE une ligne désignée par sa table et son identifiant. `null` : la ligne n'existe pas. */
export async function rattacher(db: Db, source: SourcePersonne, id: string, opts: OptionsRattachement = {}): Promise<IssueRattachement | null> {
  const ligne = await lireSource(db, source, id);
  return ligne ? rattacherLigne(db, ligne, opts) : null;
}

/** Complète les champs VIDES d'une Personne, et recalcule sa complétude si quelque chose change. */
async function completer(db: Db, personneId: string, apport: IdentiteSource): Promise<void> {
  const p = await db.personne.findUnique({
    where: { id: personneId }, select: { nom: true, prenoms: true, civilite: true, naissance: true, nationalite: true },
  });
  if (!p) return;
  const ajout = complements(p, apport);
  if (!Object.keys(ajout).length) return;
  await db.personne.update({ where: { id: personneId }, data: { ...ajout, completude: completude({ ...p, ...ajout }) } });
}

/** Un rôle EN COURS de cette sorte, une fois : s'il existe (posé par la reprise ou à la main), on n'en ajoute pas. */
export async function assurerRole(db: Db, personneId: string, role: RolePersonne, creeParId: string | null): Promise<void> {
  const enCours = await db.personneRole.findFirst({ where: { personneId, role, jusquA: null }, select: { id: true } });
  if (enCours) return;
  await db.personneRole.createMany({ data: [{ id: idRolePour(personneId, role), personneId, role, creeParId }], skipDuplicates: true });
}
