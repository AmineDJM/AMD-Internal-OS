/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * D'UNE FICHE EXISTANTE À SON ORGANISATION — ce qu'une ligne de `Company`, `CompanyContact`, `Supplier`,
 * `MedicalInstitution` ou un texte « institution » d'une demande dit de l'organisation réelle qu'elle
 * désigne (refonte des données, lot V2-C, `docs/architecture/refonte-vague-2.md`).
 *
 *   identité      → raison sociale, nom court, forme juridique, site, pays ;
 *   rôles         → ce qu'elle EST pour l'entreprise (société du groupe, fournisseur, établissement…) ;
 *   identifiants  → NIF, NIS, RC, article d'imposition — NORMALISÉS par `referentiels/normalisation.ts`,
 *                   et seulement s'ils sont lisibles : « 000000 » saisi pour « néant » n'identifie personne.
 *
 * Les coordonnées (adresses, téléphones, e-mails) ne sont PAS reprises ici : `Adresse` et `PointDeContact`
 * sont le lot V2-D, qui les relit sur les mêmes fiches. Les reprendre deux fois ferait des doublons.
 *
 * L'identifiant de l'organisation est DÉTERMINISTE (`org-<source>-<id de la fiche>`) : la reprise rejouée,
 * ou la double écriture d'une fiche déjà reprise, retombe sur la même ligne au lieu d'en créer une autre.
 *
 * Module PUR : il n'importe que des modules purs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { RoleOrganisation, TypeIdentifiantOrganisation } from "@prisma/client";
import { nomDesigneUneOrganisation } from "@/lib/referentiels/doublons";
import {
  cleOrganisation, normaliserArticleImposition, normaliserNifStrict, normaliserNis, normaliserRcStrict, plier,
} from "@/lib/referentiels/normalisation";

/** Les fiches qui portent une organisation, et leur code dans l'identifiant déterministe. */
export const SOURCES_ORGANISATION = {
  COMPANY: "co",
  COMPANY_CONTACT: "cc",
  SUPPLIER: "su",
  MEDICAL_INSTITUTION: "mi",
} as const;
export type SourceOrganisation = keyof typeof SOURCES_ORGANISATION;

export interface IdentifiantCandidat {
  type: TypeIdentifiantOrganisation;
  /** Telle que saisie. */
  valeur: string;
  /** La forme comparée (chiffres et lettres, majuscules) — la clé d'unicité. */
  valeurNormalisee: string;
}

export interface CandidatOrganisation {
  raisonSociale: string;
  nomCourt: string | null;
  /** `cleOrganisation` de la raison sociale (repli simple si elle ne garde aucun mot) : recherche et rapprochement. */
  nomReplie: string;
  formeJuridique: string | null;
  siteWeb: string | null;
  /** Code ISO 3166-1 alpha-2 ; « ZZ » quand le pays saisi n'est pas reconnu (jamais deviné). */
  pays: string;
  roles: RoleOrganisation[];
  identifiants: IdentifiantCandidat[];
}

export function idOrganisationDeFiche(source: SourceOrganisation, id: string): string {
  return `org-${SOURCES_ORGANISATION[source]}-${id}`;
}

/** L'identifiant d'une organisation née d'un TEXTE : le même texte (à la clé près) donne le même id. */
export function idOrganisationDeTexte(cle: string): string {
  return `org-tx-${empreinte(cle)}`;
}

/** FNV-1a sur deux graines (64 bits) : court, stable, sans dépendance. Ce n'est pas un secret. */
function empreinte(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

const texte = (v: string | null | undefined): string | null => {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s.length ? s : null;
};

export function nomReplieOrganisation(raisonSociale: string): string {
  return cleOrganisation(raisonSociale) || plier(raisonSociale);
}

// ─────────────────────────────── Forme juridique, pays ───────────────────────────────

const FORMES = ["SARL", "SPA", "EURL", "SNC", "SASU", "SAS", "EPIC", "EPA", "EPE", "SA"] as const;

/** La forme juridique écrite dans la raison sociale (« Imprimerie du Centre SARL », « S.P.A Biopharm »). */
export function formeJuridiqueDuNom(nom: string | null | undefined): string | null {
  const mots = (nom ?? "").toUpperCase().replace(/\./g, "").split(/[^A-Z0-9]+/);
  return FORMES.find((f) => mots.includes(f)) ?? null;
}

const PAYS: Record<string, string> = {
  algerie: "DZ", france: "FR", inde: "IN", india: "IN", espagne: "ES", spain: "ES", italie: "IT", italy: "IT",
  allemagne: "DE", germany: "DE", chine: "CN", china: "CN", tunisie: "TN", tunisia: "TN", maroc: "MA", morocco: "MA",
  jordanie: "JO", jordan: "JO", turquie: "TR", turkey: "TR", turkiye: "TR", suisse: "CH", switzerland: "CH",
  belgique: "BE", belgium: "BE", "royaume uni": "GB", "united kingdom": "GB", uk: "GB", angleterre: "GB",
  "etats unis": "US", usa: "US", "united states": "US", egypte: "EG", egypt: "EG", portugal: "PT", "pays bas": "NL",
  netherlands: "NL", "coree du sud": "KR", coree: "KR", "south korea": "KR", japon: "JP", japan: "JP", canada: "CA",
  autriche: "AT", austria: "AT", irlande: "IE", ireland: "IE", grece: "GR", greece: "GR", pologne: "PL", poland: "PL",
  slovenie: "SI", slovenia: "SI", hongrie: "HU", hungary: "HU", "arabie saoudite": "SA", "saudi arabia": "SA",
  "emirats arabes unis": "AE", emirats: "AE", uae: "AE", liban: "LB", lebanon: "LB", bresil: "BR", brazil: "BR",
  argentine: "AR", argentina: "AR", suede: "SE", sweden: "SE", danemark: "DK", denmark: "DK", croatie: "HR",
  "republique tcheque": "CZ", tchequie: "CZ", chypre: "CY", cyprus: "CY", malte: "MT", malta: "MT", bangladesh: "BD",
  pakistan: "PK", "afrique du sud": "ZA", russie: "RU", russia: "RU", ukraine: "UA", israel: "IL", iran: "IR",
};

/** Le code pays d'un texte libre (« France », « fr », « Inde ») ; « ZZ » s'il n'est pas reconnu, `defaut` s'il est vide. */
export function paysDepuisTexte(v: string | null | undefined, defaut = "DZ"): string {
  const p = plier(v);
  if (!p) return defaut;
  if (/^[a-z]{2}$/.test(p) && p !== "uk") return p.toUpperCase();
  return PAYS[p] ?? "ZZ";
}

// ─────────────────────────────── Rôles ───────────────────────────────

const contient = (cle: string, mots: readonly string[]) => mots.some((m) => new RegExp(`(^| )${m}`).test(cle));

/** Le rôle d'un partenaire de l'annuaire : la sphère publique est une autorité ; sinon sa nature libre le dit. */
export function roleDuPartenaire(kind: string | null | undefined, sphere: string | null | undefined): RoleOrganisation {
  if (sphere === "PUBLIC") return "AUTORITE";
  const k = plier(kind);
  if (contient(k, ["agence", "voyag", "tourism"])) return "AGENCE";
  if (contient(k, ["transport", "livr", "transit", "logisti", "messager"])) return "TRANSPORTEUR";
  if (contient(k, ["banque", "bank"])) return "BANQUE";
  if (contient(k, ["labo"])) return "LABORATOIRE";
  return "FOURNISSEUR";
}

/** Une « société » de cardiologie, de pédiatrie, de pharmacie… est savante ; une « société de distribution » ne l'est pas. */
const SAVOIRS = /(logie|iatrie|medecin|chirurg|pharmac|sante|anesthes|reanimat|nutrition|diabet|endocrin|infectio|urolog|nephrolog|oncolog|gyneco|obstetri|dermato|ophtalmo|rhumato)/;

/**
 * LE RÔLE QU'UN NOM LAISSE LIRE, pour une organisation née d'un texte libre (« Société algérienne de
 * cardiologie », « CHU Mustapha », « Ministère de la Santé »). Rien de reconnu : AUTRE — jamais deviné.
 */
export function roleDepuisLeNom(nom: string | null | undefined): RoleOrganisation {
  const k = plier(nom);
  if (contient(k, ["societe savante", "association", "college", "federation", "academie", "syndicat", "ordre des", "club"])
    || (contient(k, ["societe"]) && SAVOIRS.test(k))) return "SOCIETE_SAVANTE";
  if (contient(k, ["ministere", "direction de la sante", "dsp", "pch", "pharmacie centrale", "anpp", "cnas", "casnos", "wilaya de"])) return "AUTORITE";
  if (contient(k, ["chu", "eph", "ehs", "epsp", "hopital", "clinique", "polyclinique", "centre hospital", "cabinet", "pharmacie", "centre de sante"])) return "ETABLISSEMENT_SANTE";
  if (contient(k, ["laboratoire", "labo"])) return "LABORATOIRE";
  if (contient(k, ["agence"])) return "AGENCE";
  if (contient(k, ["banque", "bank"])) return "BANQUE";
  return "AUTRE";
}

/** Les mots qu'on saisit pour « rien » : ils ne désignent aucune organisation. */
const NEANT = new Set(["neant", "autre", "autres", "aucun", "aucune", "inconnu", "inconnue", "divers", "test", "na", "nc", "nd", "xxx"]);
/** Les natures d'organisation que `doublons.ts` ne range pas parmi les siennes et qui, seules, ne nomment personne. */
const NATURES_SEULES = new Set(["association", "federation", "college", "academie", "syndicat", "ministere", "universite", "faculte", "fondation", "ordre"]);

/**
 * LA CLÉ D'UN TEXTE « INSTITUTION » — ou `null` s'il ne désigne personne (vide, « néant », une nature seule
 * comme « CHU » ou « Association »). Deux textes de même clé désignent la même organisation.
 */
export function cleTexteOrganisation(v: string | null | undefined): string | null {
  const t = texte(v);
  if (!t) return null;
  const cle = cleOrganisation(t);
  if (!cle || cle.split(" ").every((m) => NEANT.has(m) || NATURES_SEULES.has(m)) || !nomDesigneUneOrganisation(t)) return null;
  return cle;
}

// ─────────────────────────────── Identifiants ───────────────────────────────

function identifiant(type: TypeIdentifiantOrganisation, valeur: string | null | undefined, normaliser: (v: string) => string | null): IdentifiantCandidat[] {
  const brut = texte(valeur);
  const n = brut ? normaliser(brut) : null;
  return brut && n ? [{ type, valeur: brut, valeurNormalisee: n.toUpperCase() }] : [];
}

export function identifiantsFiscaux(f: { nif?: string | null; nis?: string | null; rc?: string | null; ai?: string | null }): IdentifiantCandidat[] {
  return [
    ...identifiant("NIF", f.nif, normaliserNifStrict),
    ...identifiant("NIS", f.nis, normaliserNis),
    ...identifiant("RC", f.rc, normaliserRcStrict),
    ...identifiant("AI", f.ai, normaliserArticleImposition),
  ];
}

// ─────────────────────────────── Les fiches ───────────────────────────────

function candidat(
  raisonSociale: string, autres: Partial<Omit<CandidatOrganisation, "raisonSociale" | "nomReplie">>,
): CandidatOrganisation {
  return {
    raisonSociale,
    nomCourt: autres.nomCourt && autres.nomCourt !== raisonSociale ? autres.nomCourt : null,
    nomReplie: nomReplieOrganisation(raisonSociale),
    formeJuridique: autres.formeJuridique ?? formeJuridiqueDuNom(raisonSociale),
    siteWeb: autres.siteWeb ?? null,
    pays: autres.pays ?? "DZ",
    roles: [...new Set(autres.roles ?? [])],
    identifiants: autres.identifiants ?? [],
  };
}

export interface FicheCompany {
  name: string;
  shortName: string | null;
  legalIdentity: {
    legalName: string | null; legalForm: string | null; nif: string | null; nis: string | null;
    rcNumber: string | null; taxArticle: string | null; website: string | null;
  } | null;
}

/** Une société du groupe : sa dénomination EXACTE au registre quand elle est connue, son nom d'usage en nom court. */
export function candidatDeCompany(c: FicheCompany): CandidatOrganisation {
  const li = c.legalIdentity;
  const raison = texte(li?.legalName) ?? c.name.trim();
  return candidat(raison, {
    nomCourt: texte(c.shortName) ?? (raison !== c.name.trim() ? c.name.trim() : null),
    formeJuridique: texte(li?.legalForm)?.toUpperCase() ?? undefined,
    siteWeb: texte(li?.website),
    roles: ["SOCIETE_DU_GROUPE"],
    identifiants: identifiantsFiscaux({ nif: li?.nif, nis: li?.nis, rc: li?.rcNumber, ai: li?.taxArticle }),
  });
}

export interface FicheCompanyContact {
  name: string; kind: string | null; sphere: string; website: string | null; nif: string | null; rc: string | null;
}

export function candidatDeCompanyContact(c: FicheCompanyContact): CandidatOrganisation {
  return candidat(c.name.trim(), {
    siteWeb: texte(c.website),
    roles: [roleDuPartenaire(c.kind, c.sphere)],
    identifiants: identifiantsFiscaux({ nif: c.nif, rc: c.rc }),
  });
}

export interface FicheSupplier { name: string; country: string | null; website: string | null }

/** Un fournisseur Regulatory est le FABRICANT d'un dossier d'enregistrement : fournisseur et laboratoire. */
export function candidatDeSupplier(s: FicheSupplier): CandidatOrganisation {
  return candidat(s.name.trim(), {
    siteWeb: texte(s.website),
    pays: paysDepuisTexte(s.country, "ZZ"),
    roles: ["FOURNISSEUR", "LABORATOIRE"],
  });
}

export interface FicheMedicalInstitution { name: string; type: string }

/** Un établissement de santé — sauf le grossiste répartiteur, qui est un CLIENT du laboratoire. */
export function candidatDeMedicalInstitution(i: FicheMedicalInstitution): CandidatOrganisation {
  return candidat(i.name.trim(), { roles: [i.type === "GROSSISTE" ? "CLIENT" : "ETABLISSEMENT_SANTE"] });
}

/** Une organisation née d'un texte libre de demande : le texte tel que saisi, le rôle que son nom laisse lire. */
export function candidatDeTexte(t: string): CandidatOrganisation {
  const raison = texte(t) ?? t;
  return candidat(raison, { roles: [roleDepuisLeNom(raison)] });
}
