/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES NEUF TABLES OÙ VIT UNE PERSONNE, ET CE QU'ELLES DISENT D'ELLE (refonte des données, vague 2,
 * lot V2-B — `docs/architecture/refonte-vague-2.md`).
 *
 * Une même personne réelle peut être un compte (`User`), un salarié (`Employee`), un praticien
 * (`MedicalDoctor`), un bénéficiaire de prise en charge, un voyageur, un client d'hôtel, un candidat,
 * une entrée d'annuaire ou un compte du portail fournisseur. Ce module dit, pour chaque table :
 *
 *   • le RÔLE que la ligne donne à la personne (`PersonneRole`) ;
 *   • l'IDENTITÉ qu'elle porte (nom, prénoms, civilité, date de naissance) — jamais une donnée sensible :
 *     NIN, IBAN et salaires relèvent du coffre (lot V2-E) ;
 *   • sa RACINE : la ligne que l'ERP relie DÉJÀ à celle-ci par une clé étrangère (le salarié et son
 *     compte, le bénéficiaire tiré de l'annuaire et son praticien, le candidat embauché et sa fiche
 *     salarié). C'est la SEULE clé de rapprochement sûre : deux lignes que l'ERP relie déjà sont la même
 *     personne par construction. Tout autre rapprochement (même nom, même e-mail…) est un DOUBLON PROPOSÉ,
 *     jamais une fusion d'office (`doublons.ts`) ;
 *   • l'identifiant DÉTERMINISTE de la Personne née d'une racine : rejouer la reprise, ou créer la ligne
 *     par la double écriture puis rejouer la reprise, retombe sur la même Personne.
 *
 * Module PUR : aucune base ; seul `node:crypto` (empreinte) et les normalisations des référentiels.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import type { RolePersonne } from "@prisma/client";
import { cleNomPersonne, plier } from "@/lib/referentiels/normalisation";

export const SOURCES_PERSONNE = [
  "User", "Employee", "MedicalDoctor", "CareBeneficiary", "AdProVoyageur", "AdProHebergement",
  "RecruitmentCandidate", "DirectoryEntry", "SupplierUser",
] as const;
export type SourcePersonne = (typeof SOURCES_PERSONNE)[number];

export const estSourcePersonne = (v: unknown): v is SourcePersonne => (SOURCES_PERSONNE as readonly unknown[]).includes(v);

/** Ce que chaque table fait de la personne. Un hébergement est un déplacement : la personne VOYAGE. */
export const ROLE_DE_LA_SOURCE: Record<SourcePersonne, RolePersonne> = {
  User: "COLLABORATEUR",
  Employee: "COLLABORATEUR",
  MedicalDoctor: "PROFESSIONNEL_SANTE",
  CareBeneficiary: "BENEFICIAIRE",
  AdProVoyageur: "VOYAGEUR",
  AdProHebergement: "VOYAGEUR",
  RecruitmentCandidate: "CANDIDAT",
  DirectoryEntry: "CONTACT_TIERS",
  SupplierUser: "CONTACT_TIERS",
};

export const LIBELLE_SOURCE: Record<SourcePersonne, string> = {
  User: "Compte applicatif",
  Employee: "Salarié",
  MedicalDoctor: "Praticien",
  CareBeneficiary: "Bénéficiaire de prise en charge",
  AdProVoyageur: "Voyageur",
  AdProHebergement: "Hébergement",
  RecruitmentCandidate: "Candidat",
  DirectoryEntry: "Entrée d'annuaire",
  SupplierUser: "Compte du portail fournisseur",
};

export const LIBELLE_ROLE: Record<RolePersonne, string> = {
  COLLABORATEUR: "Collaborateur",
  PROFESSIONNEL_SANTE: "Professionnel de santé",
  BENEFICIAIRE: "Bénéficiaire",
  VOYAGEUR: "Voyageur",
  CANDIDAT: "Candidat",
  CONTACT_TIERS: "Contact d'un tiers",
  INTERVENANT: "Intervenant",
};

/** « MedicalDoctor:ck… » — la référence d'une ligne source, unique dans toute la base. */
export const refDe = (source: SourcePersonne, id: string): string => `${source}:${id}`;

/**
 * L'IDENTIFIANT DÉTERMINISTE de la Personne née d'une racine : « per_ » + 25 caractères hexadécimaux de
 * l'empreinte SHA-256 de sa référence (100 bits : aucune collision à l'échelle de l'ERP).
 */
export function idPersonnePour(racine: string): string {
  return `per_${createHash("sha256").update(`personne|${racine}`).digest("hex").slice(0, 25)}`;
}

/** L'identifiant déterministe d'un rôle : une personne n'a qu'UN rôle en cours de chaque sorte par la reprise. */
export function idRolePour(personneId: string, role: RolePersonne): string {
  return `prl_${createHash("sha256").update(`role|${personneId}|${role}`).digest("hex").slice(0, 25)}`;
}

// ─────────────────────────────── Identité ───────────────────────────────

export interface IdentiteSource {
  nom: string;
  prenoms: string | null;
  civilite: string | null;
  naissance: Date | null;
}

/** Les titres qu'une fiche écrit DEVANT le nom (« Dr BENALI Ahmed ») : ils deviennent la civilité. */
const TITRES_EN_TETE: [RegExp, string][] = [
  [/^(pr|prof|professeur|professeure)\b\.?\s*/i, "Pr"],
  [/^(dr|docteur|doctoresse)\b\.?\s*/i, "Dr"],
  [/^(mme|madame)\b\.?\s*/i, "Mme"],
  [/^(mlle|mademoiselle)\b\.?\s*/i, "Mlle"],
  [/^(m|mr|monsieur)\b\.\s*|^(mr|monsieur)\b\s*/i, "M."],
];

/** Sépare le titre écrit en tête du nom : « Dr BENALI Ahmed » → { civilite: « Dr », reste: « BENALI Ahmed » }. */
export function separerTitre(brut: string): { civilite: string | null; reste: string } {
  let reste = brut.trim().replace(/\s+/g, " ");
  let civilite: string | null = null;
  for (let tour = 0; tour < 3; tour++) {
    const t = TITRES_EN_TETE.find(([re]) => re.test(reste));
    if (!t) break;
    civilite ??= t[1];
    reste = reste.replace(t[0], "").trim();
  }
  return { civilite, reste: reste || brut.trim() };
}

const texte = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim().replace(/\s+/g, " ");
  return s ? s : null;
};

/**
 * L'identité d'une fiche qui porte nom et prénom à part (voyageur, bénéficiaire, praticien renseigné), ou
 * un seul libellé (compte, salarié, candidat). Un libellé seul n'est PAS découpé en nom / prénoms : on ne
 * sait pas lequel est lequel (« Benali Ahmed » / « Ahmed Benali »), on ne devine pas.
 */
export function identiteDepuis(p: {
  nom?: string | null; prenom?: string | null; libelle?: string | null; civilite?: string | null; naissance?: Date | null;
}): IdentiteSource | null {
  const nom = texte(p.nom);
  const prenom = texte(p.prenom);
  if (nom) {
    const t = separerTitre(nom);
    return { nom: t.reste, prenoms: prenom, civilite: p.civilite ?? t.civilite, naissance: p.naissance ?? null };
  }
  const libelle = texte(p.libelle) ?? prenom;
  if (!libelle) return null;
  const t = separerTitre(libelle);
  return { nom: t.reste, prenoms: null, civilite: p.civilite ?? t.civilite, naissance: p.naissance ?? null };
}

/**
 * LA CLÉ DE RECHERCHE d'une personne : nom + prénoms repliés, mots triés, titres retirés
 * (`cleNomPersonne`). Un nom fait seulement d'initiales garde sa forme pliée plutôt qu'une clé vide.
 */
export function nomReplie(id: Pick<IdentiteSource, "nom" | "prenoms">): string {
  const complet = [id.prenoms, id.nom].filter(Boolean).join(" ");
  return cleNomPersonne(complet) || plier(complet);
}

/** Les attributs attendus d'une fiche Personne, pour sa complétude (0-100). */
const ATTENDUS = ["nom", "prenoms", "civilite", "naissance", "nationalite"] as const;

export function completude(p: { nom?: string | null; prenoms?: string | null; civilite?: string | null; naissance?: Date | null; nationalite?: string | null }): number {
  const remplis = ATTENDUS.filter((k) => {
    const v = p[k];
    return v instanceof Date ? !Number.isNaN(v.getTime()) : typeof v === "string" && v.trim().length > 0;
  }).length;
  return Math.round((remplis / ATTENDUS.length) * 100);
}

/**
 * CE QUE LA LIGNE APPORTE à une Personne qui existe déjà : les champs VIDES seulement. Une reprise
 * complète, elle n'écrase jamais — un désaccord est l'affaire de la décision des faits (lot V2-A).
 */
export function complements(
  existante: { prenoms: string | null; civilite: string | null; naissance: Date | null },
  apport: IdentiteSource,
): Partial<Pick<IdentiteSource, "prenoms" | "civilite" | "naissance">> {
  const out: Partial<Pick<IdentiteSource, "prenoms" | "civilite" | "naissance">> = {};
  if (!existante.prenoms && apport.prenoms) out.prenoms = apport.prenoms;
  if (!existante.civilite && apport.civilite) out.civilite = apport.civilite;
  if (!existante.naissance && apport.naissance) out.naissance = apport.naissance;
  return out;
}

// ─────────────────────────────── Les lignes de chaque table ───────────────────────────────

/** Une ligne source, vue par la reprise. `ignorer` : pourquoi elle ne devient pas une Personne. */
export interface LigneSource {
  source: SourcePersonne;
  id: string;
  personneId: string | null;
  identite: IdentiteSource | null;
  /** La ligne que l'ERP relie déjà à celle-ci : la même personne, par construction. */
  racine: { source: SourcePersonne; id: string } | null;
  ignorer: string | null;
}

/**
 * LES COLONNES LUES DANS CHAQUE TABLE — l'identité et les clés de rattachement, rien d'autre.
 * Aucune colonne sensible (`Employee.iban`, `nationalId`, salaires) n'y figure : la reprise ne peut pas
 * les recopier par mégarde.
 */
export const SELECTION = {
  User: { id: true, personneId: true, name: true, isSystem: true },
  Employee: { id: true, personneId: true, fullName: true, birthDate: true, userId: true },
  MedicalDoctor: { id: true, personneId: true, name: true, lastName: true, firstName: true, title: true },
  CareBeneficiary: { id: true, personneId: true, lastName: true, firstName: true, doctorId: true },
  AdProVoyageur: { id: true, personneId: true, nom: true, prenom: true },
  AdProHebergement: { id: true, personneId: true, nom: true, prenom: true },
  RecruitmentCandidate: { id: true, personneId: true, fullName: true, employeeId: true },
  DirectoryEntry: { id: true, personneId: true, displayName: true, userId: true, employeeId: true, contactId: true },
  SupplierUser: { id: true, personneId: true, name: true },
} as const;

type Ligne<K extends SourcePersonne> = { [C in keyof (typeof SELECTION)[K]]: unknown } & { id: string; personneId: string | null };

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const d = (v: unknown): Date | null => (v instanceof Date && !Number.isNaN(v.getTime()) ? v : null);

/** Le titre universitaire d'un praticien qui en fait la civilité : le professeur seulement — le reste ne se devine pas. */
const civiliteDuTitre = (titre: unknown): string | null => (titre === "PROFESSEUR" ? "Pr" : null);

/** LA LECTURE D'UNE LIGNE, table par table. */
export function lireLigne<K extends SourcePersonne>(source: K, r: Ligne<K>): LigneSource {
  const base = { source, id: r.id, personneId: r.personneId, racine: null, ignorer: null } as LigneSource;
  const x = r as Record<string, unknown>;
  switch (source) {
    case "User":
      // Le compte technique d'Adam (`assurerCompteAgent`) n'est personne.
      if (x.isSystem === true) return { ...base, identite: null, ignorer: "compte technique" };
      return { ...base, identite: identiteDepuis({ libelle: s(x.name) }) };
    case "Employee":
      return {
        ...base,
        identite: identiteDepuis({ libelle: s(x.fullName), naissance: d(x.birthDate) }),
        racine: s(x.userId) ? { source: "User", id: s(x.userId)! } : null,
      };
    case "MedicalDoctor":
      return { ...base, identite: identiteDepuis({ nom: s(x.lastName), prenom: s(x.firstName), libelle: s(x.name), civilite: civiliteDuTitre(x.title) }) };
    case "CareBeneficiary":
      // Un bénéficiaire tiré de l'annuaire EST le praticien (`doctorId`) : l'ERP les relie déjà.
      return {
        ...base,
        identite: identiteDepuis({ nom: s(x.lastName), prenom: s(x.firstName) }),
        racine: s(x.doctorId) ? { source: "MedicalDoctor", id: s(x.doctorId)! } : null,
      };
    case "AdProVoyageur":
    case "AdProHebergement":
      return { ...base, identite: identiteDepuis({ nom: s(x.nom), prenom: s(x.prenom) }) };
    case "RecruitmentCandidate":
      // Le candidat embauché a sa fiche salarié (`onboardRecruitment`) : la même personne.
      return {
        ...base,
        identite: identiteDepuis({ libelle: s(x.fullName) }),
        racine: s(x.employeeId) ? { source: "Employee", id: s(x.employeeId)! } : null,
      };
    case "DirectoryEntry": {
      // L'entrée d'annuaire d'un tiers (`contactId`) décrit une ORGANISATION (lot V2-C), pas une personne.
      if (s(x.contactId)) return { ...base, identite: null, ignorer: "fiche d'un tiers (organisation)" };
      const racine = s(x.userId) ? { source: "User" as const, id: s(x.userId)! }
        : s(x.employeeId) ? { source: "Employee" as const, id: s(x.employeeId)! } : null;
      return { ...base, identite: identiteDepuis({ libelle: s(x.displayName) }), racine };
    }
    case "SupplierUser":
      return { ...base, identite: identiteDepuis({ libelle: s(x.name) }) };
  }
  return { ...base, identite: null, ignorer: "table inconnue" };
}

/** Le rôle qu'apporte une ligne d'annuaire : un collègue (racine compte / salarié) n'y gagne pas « contact d'un tiers ». */
export function roleApporte(l: Pick<LigneSource, "source" | "racine">): RolePersonne | null {
  if (l.source === "DirectoryEntry" && l.racine) return null;
  return ROLE_DE_LA_SOURCE[l.source];
}
