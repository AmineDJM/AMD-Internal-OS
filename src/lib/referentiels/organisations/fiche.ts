import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasGlobalView, peutAnnuaire, userCan, type SessionUser } from "@/lib/rbac";
import { companyScopedWhere } from "@/lib/company";
import {
  clauseCongresInternationauxVisibles, clauseCongresNationauxVisibles, clauseSponsoringsVisibles, perimetreLegal,
} from "@/lib/queries/visibilite-listes";
import { origineAffiliation, type CodeOrigineAffiliation } from "./affiliations";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE ORGANISATION 360° — EN LECTURE (`/organisations/[id]`, lot V2-C).
 *
 * Ce que l'ERP sait d'une organisation réelle, réuni en une page : identifiants, rôles, coordonnées,
 * personnes affiliées, fiches d'origine, pièces commerciales (devis, BC, factures — `LegalDocument`) et
 * demandes Ad & Pro. Une organisation FUSIONNÉE renvoie à sa survivante, qui réunit les deux.
 *
 * LES MÊMES PORTES QUE LES ÉCRANS D'ORIGINE — chaque bloc est lu avec la clause de SON écran, jamais une
 * clause écrite ici :
 *   société du groupe   Legal ou Administration (`/legal/identites`, `/admin/entites`)
 *   partenaire          l'annuaire Partenaires / Partenaires publics, dans le périmètre d'entité
 *   fournisseur         l'annuaire Fournisseurs Regulatory
 *   établissement       l'annuaire Établissements
 *   pièces commerciales `perimetreLegal` (la liste Legal)
 *   demandes            `clauseSponsoringsVisibles`, `clauseCongres…Visibles` (les listes Ad & Pro)
 * La fiche elle-même s'ouvre à qui voit AU MOINS un de ces blocs ; sinon elle n'existe pas pour lui.
 *
 * RIB et IBAN n'y figurent PAS : ils iront au coffre (lot V2-E) et se liront par lui, journalisés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, la fiche dit « et N de plus » : elle résume, la liste complète vit dans l'écran d'origine. */
const PLAFOND = 50;

export interface FicheSource { type: "COMPANY" | "COMPANY_CONTACT" | "SUPPLIER" | "MEDICAL_INSTITUTION"; id: string; libelle: string; detail: string | null; lien: string }
export interface Coordonnee { nature: "ADRESSE" | "TELEPHONE" | "EMAIL" | "SITE"; valeur: string; source: string }
export interface PersonneAffiliee { personneId: string; nom: string; fonction: string | null; service: string | null; principale: boolean; origine: CodeOrigineAffiliation | null }
export interface PieceCommerciale { id: string; reference: string | null; titre: string; nature: string; statut: string; montant: string | null; date: Date | null }
export interface DemandeLiee { type: "SPONSORING" | "CONGRES_NATIONAL" | "CONGRES_INTERNATIONAL"; id: string; libelle: string; statut: string; date: Date | null; lien: string }

export type FicheOrganisation =
  | { etat: "INTROUVABLE" }
  | { etat: "FUSIONNEE"; survivanteId: string }
  | {
    etat: "OK";
    organisation: {
      id: string; raisonSociale: string; nomCourt: string | null; formeJuridique: string | null; pays: string;
      statut: string; siteWeb: string | null; createdAt: Date;
    };
    roles: string[];
    identifiants: { type: string; valeur: string; verifieLe: Date | null }[];
    absorbees: { id: string; raisonSociale: string }[];
    sources: FicheSource[];
    coordonnees: Coordonnee[];
    personnes: PersonneAffiliee[];
    pieces: { lignes: PieceCommerciale[]; total: number } | null;
    /** `tronquee` : une des listes dépasse le plafond — la fiche résume, l'écran d'origine liste tout. */
    demandes: { lignes: DemandeLiee[]; tronquee: boolean };
    doublonsEnAttente: number;
  };

/** L'organisation et toutes celles qui ont été fusionnées dans elle, de proche en proche. */
async function groupeDeFusion(id: string): Promise<string[]> {
  const groupe = [id];
  for (let i = 0; i < groupe.length && groupe.length < 200; i++) {
    const enfants = await prisma.organisation.findMany({ where: { fusionneeDansId: groupe[i] }, select: { id: true } });
    for (const e of enfants) if (!groupe.includes(e.id)) groupe.push(e.id);
  }
  return groupe;
}

/** Qui voit une affiliation : la porte de l'écran qui porte sa fiche d'origine. */
function voitAffiliation(user: SessionUser, origine: CodeOrigineAffiliation | null, partenairesVisibles: boolean): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  switch (origine) {
    case "emp": return userCan(user, "RH", "VIEW");
    case "md": return peutAnnuaire(user, "MEDECINS", "VIEW");
    case "de": return partenairesVisibles;
    case "cb": return hasGlobalView(user);
    case "su": return false; // les comptes du portail fournisseur sont au Super Admin (`/admin/suppliers`)
    default: return hasGlobalView(user);
  }
}

const pousser = (out: Coordonnee[], nature: Coordonnee["nature"], valeur: string | null | undefined, source: string) => {
  const v = (valeur ?? "").trim();
  if (v && !out.some((c) => c.nature === nature && c.valeur.toLowerCase() === v.toLowerCase())) out.push({ nature, valeur: v, source });
};
const lieu = (...parts: (string | null | undefined)[]) => parts.map((p) => (p ?? "").trim()).filter(Boolean).join(", ");

export async function chargerFicheOrganisation(user: SessionUser, id: string): Promise<FicheOrganisation> {
  const racine = await prisma.organisation.findUnique({ where: { id }, select: { id: true, fusionneeDansId: true } });
  if (!racine) return { etat: "INTROUVABLE" };
  if (racine.fusionneeDansId) {
    let survivanteId = racine.fusionneeDansId;
    for (let i = 0; i < 20; i++) {
      const s = await prisma.organisation.findUnique({ where: { id: survivanteId }, select: { fusionneeDansId: true } });
      if (!s?.fusionneeDansId) break;
      survivanteId = s.fusionneeDansId;
    }
    return { etat: "FUSIONNEE", survivanteId };
  }

  const groupe = await groupeDeFusion(id);
  const dansGroupe = { organisationId: { in: groupe } };
  const sa = user.role === "SUPER_ADMIN";
  const voitSocietes = sa || userCan(user, "LEGAL", "VIEW") || userCan(user, "ADMIN", "VIEW");
  const voitFournisseurs = sa || peutAnnuaire(user, "FOURNISSEURS", "VIEW");
  const voitEtablissements = sa || peutAnnuaire(user, "ETABLISSEMENTS", "VIEW");
  const voitPrives = sa || peutAnnuaire(user, "PARTENAIRES", "VIEW");
  const voitPublics = sa || peutAnnuaire(user, "PARTENAIRES_PUBLICS", "VIEW");
  const spheres = [...(voitPrives ? ["PRIVE"] : []), ...(voitPublics ? ["PUBLIC"] : [])];

  const [orgs, companies, contacts, tousContacts, suppliers, institutions] = await Promise.all([
    prisma.organisation.findMany({
      where: { id: { in: groupe } },
      select: {
        id: true, raisonSociale: true, nomCourt: true, formeJuridique: true, pays: true, statut: true, siteWeb: true, createdAt: true,
        roles: { select: { role: true } },
        identifiants: { select: { type: true, valeur: true, verifieLe: true }, orderBy: { type: "asc" } },
        adresses: { select: { ligne1: true, ligne2: true, codePostal: true, wilayaCode: true } },
        pointsDeContact: { select: { type: true, valeur: true } },
      },
    }),
    voitSocietes ? prisma.company.findMany({
      where: dansGroupe,
      select: { id: true, name: true, shortName: true, legalIdentity: { select: { headOffice: true, phone: true, email: true, website: true } } },
    }) : [],
    spheres.length ? prisma.companyContact.findMany({
      where: { AND: [await companyScopedWhere(user.id, {} as Prisma.CompanyContactWhereInput), dansGroupe, { sphere: { in: spheres } }] },
      select: { id: true, name: true, kind: true, sphere: true, contactName: true, phone: true, phoneAlt: true, email: true, website: true, address: true, city: true, wilaya: true },
    }) : [],
    prisma.companyContact.findMany({ where: dansGroupe, select: { id: true } }),
    voitFournisseurs ? prisma.supplier.findMany({
      where: dansGroupe, select: { id: true, name: true, country: true, contactName: true, contactEmail: true, phone: true, website: true, address: true, city: true },
    }) : [],
    voitEtablissements ? prisma.medicalInstitution.findMany({
      where: dansGroupe, select: { id: true, name: true, type: true, wilaya: true, city: true, address: true, phone: true, email: true },
    }) : [],
  ]);
  const org = orgs.find((o) => o.id === id)!;

  // ── Les fiches d'origine visibles, et les coordonnées qu'elles portent ──
  const sources: FicheSource[] = [];
  const coordonnees: Coordonnee[] = [];
  for (const o of orgs) {
    for (const a of o.adresses) pousser(coordonnees, "ADRESSE", lieu(a.ligne1, a.ligne2, a.codePostal), "Référentiel");
    for (const p of o.pointsDeContact) pousser(coordonnees, p.type === "TELEPHONE" ? "TELEPHONE" : p.type === "EMAIL" ? "EMAIL" : "SITE", p.valeur, "Référentiel");
    pousser(coordonnees, "SITE", o.siteWeb, "Référentiel");
  }
  for (const c of companies) {
    sources.push({ type: "COMPANY", id: c.id, libelle: c.shortName ?? c.name, detail: "Société du groupe", lien: "/legal/identites" });
    const li = c.legalIdentity;
    pousser(coordonnees, "ADRESSE", li?.headOffice, "Identité légale");
    pousser(coordonnees, "TELEPHONE", li?.phone, "Identité légale");
    pousser(coordonnees, "EMAIL", li?.email, "Identité légale");
    pousser(coordonnees, "SITE", li?.website, "Identité légale");
  }
  for (const c of contacts) {
    const publics = c.sphere === "PUBLIC";
    sources.push({ type: "COMPANY_CONTACT", id: c.id, libelle: c.name, detail: c.kind, lien: publics ? "/annuaires/partenaires-publics" : "/annuaires/partenaires" });
    const etiquette = publics ? "Partenaires publics" : "Partenaires";
    pousser(coordonnees, "ADRESSE", lieu(c.address, c.city, c.wilaya), etiquette);
    pousser(coordonnees, "TELEPHONE", c.phone, etiquette);
    pousser(coordonnees, "TELEPHONE", c.phoneAlt, etiquette);
    pousser(coordonnees, "EMAIL", c.email, etiquette);
    pousser(coordonnees, "SITE", c.website, etiquette);
  }
  for (const s of suppliers) {
    sources.push({ type: "SUPPLIER", id: s.id, libelle: s.name, detail: s.country, lien: "/annuaires/fournisseurs" });
    pousser(coordonnees, "ADRESSE", lieu(s.address, s.city, s.country), "Fournisseurs Regulatory");
    pousser(coordonnees, "TELEPHONE", s.phone, "Fournisseurs Regulatory");
    pousser(coordonnees, "EMAIL", s.contactEmail, "Fournisseurs Regulatory");
    pousser(coordonnees, "SITE", s.website, "Fournisseurs Regulatory");
  }
  for (const i of institutions) {
    sources.push({ type: "MEDICAL_INSTITUTION", id: i.id, libelle: i.name, detail: i.wilaya, lien: "/annuaires/etablissements" });
    pousser(coordonnees, "ADRESSE", lieu(i.address, i.city, i.wilaya), "Établissements");
    pousser(coordonnees, "TELEPHONE", i.phone, "Établissements");
    pousser(coordonnees, "EMAIL", i.email, "Établissements");
  }

  // ── Les demandes Ad & Pro, chacune avec la clause de SA liste ──
  const [spo, cn, ci] = await Promise.all([
    prisma.sponsoringRequest.findMany({
      where: { AND: [await clauseSponsoringsVisibles(user), dansGroupe] }, orderBy: { requestDate: "desc" }, take: PLAFOND + 1,
      select: { id: true, reference: true, institution: true, type: true, status: true, requestDate: true },
    }),
    prisma.congressNational.findMany({
      where: { AND: [await clauseCongresNationauxVisibles(user), dansGroupe] }, orderBy: { createdAt: "desc" }, take: PLAFOND + 1,
      select: { id: true, name: true, requestStatus: true, date: true },
    }),
    prisma.congressInternational.findMany({
      where: { AND: [await clauseCongresInternationauxVisibles(user), dansGroupe] }, orderBy: { createdAt: "desc" }, take: PLAFOND + 1,
      select: { id: true, name: true, requestStatus: true, startDate: true },
    }),
  ]);
  const demandesToutes: DemandeLiee[] = [
    ...spo.map((s) => ({ type: "SPONSORING" as const, id: s.id, libelle: `${s.reference} — ${s.type}`, statut: s.status, date: s.requestDate, lien: `/sponsoring/${s.id}` })),
    ...cn.map((c) => ({ type: "CONGRES_NATIONAL" as const, id: c.id, libelle: c.name, statut: c.requestStatus, date: c.date, lien: `/congress-national/${c.id}` })),
    ...ci.map((c) => ({ type: "CONGRES_INTERNATIONAL" as const, id: c.id, libelle: c.name, statut: c.requestStatus, date: c.startDate, lien: `/congress-international/${c.id}` })),
  ];

  // ── Les pièces commerciales : celles dont une partie est un partenaire de ce groupe, dans le périmètre Legal ──
  let pieces: { lignes: PieceCommerciale[]; total: number } | null = null;
  const { where: legalVisible } = await perimetreLegal(user);
  if (legalVisible && tousContacts.length) {
    const where: Prisma.LegalDocumentWhereInput = { AND: [legalVisible, { counterpartyIds: { hasSome: tousContacts.map((c) => c.id) } }] };
    const [lignes, total] = await Promise.all([
      prisma.legalDocument.findMany({
        where, orderBy: { createdAt: "desc" }, take: PLAFOND,
        select: { id: true, reference: true, title: true, kind: true, status: true, amount: true, startDate: true, createdAt: true },
      }),
      prisma.legalDocument.count({ where }),
    ]);
    pieces = {
      total,
      lignes: lignes.map((d) => ({
        id: d.id, reference: d.reference, titre: d.title, nature: d.kind, statut: d.status,
        montant: d.amount ? d.amount.toString() : null, date: d.startDate ?? d.createdAt,
      })),
    };
  }

  // La fiche n'existe que pour qui voit au moins un de ses blocs.
  if (!sa && sources.length === 0 && demandesToutes.length === 0 && !(pieces && pieces.total > 0)) return { etat: "INTROUVABLE" };

  // ── Les personnes affiliées, chacune derrière la porte de sa fiche d'origine ──
  const affiliations = await prisma.affiliation.findMany({
    where: { ...dansGroupe, jusquA: null },
    orderBy: [{ principale: "desc" }, { createdAt: "asc" }],
    take: 500,
    select: { id: true, fonction: true, service: true, principale: true, personne: { select: { id: true, nom: true, prenoms: true } } },
  });
  const personnes = affiliations
    .map((a) => ({ a, origine: origineAffiliation(a.id) }))
    .filter(({ origine }) => voitAffiliation(user, origine, voitPrives || voitPublics))
    .slice(0, PLAFOND)
    .map(({ a, origine }) => ({
      personneId: a.personne.id, nom: [a.personne.prenoms, a.personne.nom].filter(Boolean).join(" "),
      fonction: a.fonction, service: a.service, principale: a.principale, origine,
    }));

  const doublonsEnAttente = sa
    ? await prisma.propositionDoublonOrganisation.count({
      where: { statut: "PROPOSEE", OR: [{ organisationAId: { in: groupe } }, { organisationBId: { in: groupe } }] },
    })
    : 0;

  const ordre = (d: Date | null) => d?.getTime() ?? 0;
  return {
    etat: "OK",
    organisation: {
      id: org.id, raisonSociale: org.raisonSociale, nomCourt: org.nomCourt, formeJuridique: org.formeJuridique, pays: org.pays,
      statut: org.statut, siteWeb: org.siteWeb, createdAt: org.createdAt,
    },
    roles: [...new Set(orgs.flatMap((o) => o.roles.map((r) => r.role)))],
    identifiants: orgs.flatMap((o) => o.identifiants),
    absorbees: orgs.filter((o) => o.id !== id).map((o) => ({ id: o.id, raisonSociale: o.raisonSociale })),
    sources,
    coordonnees,
    personnes,
    pieces,
    demandes: {
      lignes: demandesToutes.sort((x, y) => ordre(y.date) - ordre(x.date)).slice(0, PLAFOND),
      tronquee: [spo, cn, ci].some((l) => l.length > PLAFOND) || demandesToutes.length > PLAFOND,
    },
    doublonsEnAttente,
  };
}
