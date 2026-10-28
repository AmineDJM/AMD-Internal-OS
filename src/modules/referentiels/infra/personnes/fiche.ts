/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE PERSONNE 360° — en LECTURE (lot V2-B, `/personnes/[id]`).
 *
 * Tout ce que l'ERP sait d'une personne réelle, réuni : son identité, ses rôles, ses affiliations, ses
 * fiches (compte, salarié, praticien…), ses prises en charge, ses voyages, ses pièces. CHAQUE ligne passe
 * la porte de SON écran d'origine — la même fonction, pas une copie :
 *
 *   compte           Administration (`ADMIN` VIEW), ou l'annuaire interne pour un compte actif
 *   salarié          `/rh/[id]` (`EMPLOYEES` VIEW + `entitePermisePourFiche`), ou l'annuaire pour un actif
 *   praticien        `/praticiens/[id]` (`praticienVisible`)
 *   bénéficiaire     son congrès (`canAccessEntity`)
 *   voyage, hôtel    son poste Ad & Pro (`canAccessEntity` AD_PRO_ITEM, qui suit l'opération)
 *   candidat         sa demande de recrutement (`canAccessEntity` RECRUITMENT_CANDIDATE)
 *   annuaire         `DIRECTORIES` VIEW, entrée active
 *   portail fourn.   Super Admin (l'écran `/admin/suppliers` ne s'ouvre qu'à lui)
 *   pièce            l'un de ses sujets « entité » s'ouvre (`canAccessEntity`) — une pièce sans sujet
 *                    d'écran n'est montrée qu'au Super Admin
 *
 * Le reste (rôles, date de naissance, ouverture même de la fiche) suit `visibilite.ts`. Aucune colonne
 * sensible n'est lue : NIN, IBAN, salaires relèvent du coffre (lot V2-E).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { EntityType, type CareBeneficiaryStatus, type RecruitmentCandidateStatus, type RolePersonne } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { entitePermisePourFiche } from "@/lib/company";
import { canAccessEntity } from "@/lib/entity-access";
import { praticienVisible } from "@/lib/queries/vue-360";
import { entityHref } from "@/lib/entity-href";
import { PARENT_ENTITE, parentDuPoste } from "@/lib/ad-pro-items";
import { lireLigne, type SourcePersonne } from "./sources";
import { ficheOuverte, naissanceVisible, rolesVisibles, type Regard } from "./visibilite";

/** Une ligne d'une table source, telle que la fiche la montre. */
export interface LigneFiche {
  source: SourcePersonne;
  id: string;
  libelle: string;
  detail: string | null;
  /** L'écran d'origine, quand on peut l'ouvrir. */
  lien: string | null;
}

export interface PriseEnChargeFiche { id: string; operation: string; statut: CareBeneficiaryStatus; lien: string | null }
export interface VoyageFiche { id: string; nature: "VOL" | "HOTEL"; poste: string; trajet: string | null; du: Date | null; au: Date | null; lien: string | null }
export interface PieceFiche { id: string; nom: string; nature: string | null; deposeeLe: Date; lien: string | null }
export interface AffiliationFiche { id: string; organisation: string; fonction: string | null; service: string | null; principale: boolean }

export interface FichePersonne {
  id: string;
  civilite: string | null;
  nom: string;
  prenoms: string | null;
  naissance: Date | null;
  nationalite: string | null;
  completude: number;
  roles: RolePersonne[];
  affiliations: AffiliationFiche[];
  fiches: LigneFiche[];
  prisesEnCharge: PriseEnChargeFiche[];
  voyages: VoyageFiche[];
  pieces: PieceFiche[];
  /** Le Super Admin voit les Personnes absorbées par celle-ci. */
  fusionnees: { id: string; nom: string }[];
}

export type LectureFiche = { etat: "ABSENTE" } | { etat: "FUSIONNEE"; versId: string } | { etat: "OUVERTE"; fiche: FichePersonne };

const ENTITES = new Set<string>(Object.values(EntityType));
const joindre = (...xs: (string | null | undefined)[]) => xs.filter((x) => x && x.trim()).join(" · ") || null;

export async function lireFichePersonne(user: SessionUser, personneId: string): Promise<LectureFiche> {
  const p = await prisma.personne.findUnique({
    where: { id: personneId },
    select: {
      id: true, civilite: true, nom: true, prenoms: true, naissance: true, nationalite: true, completude: true, fusionneeDansId: true,
      roles: { where: { jusquA: null }, select: { role: true } },
      affiliations: { where: { jusquA: null }, select: { id: true, fonction: true, service: true, principale: true, organisation: { select: { raisonSociale: true, nomCourt: true } } } },
      fusionnees: { select: { id: true, nom: true, prenoms: true } },
    },
  });
  if (!p) return { etat: "ABSENTE" };
  const conduitLaRefonte = user.role === "SUPER_ADMIN";
  // Une Personne absorbée renvoie à celle qui l'a absorbée — sauf au Super Admin, qui doit pouvoir la relire.
  if (p.fusionneeDansId && !conduitLaRefonte) return { etat: "FUSIONNEE", versId: p.fusionneeDansId };

  const where = { personneId };
  const [comptes, salaries, praticiens, beneficiaires, voyageurs, hebergements, candidats, annuaire, portail] = await Promise.all([
    prisma.user.findMany({ where, select: { id: true, name: true, title: true, isActive: true, isSystem: true } }),
    prisma.employee.findMany({ where, select: { id: true, fullName: true, position: true, department: true, isActive: true, companyId: true, userId: true, company: { select: { name: true, shortName: true } } } }),
    prisma.medicalDoctor.findMany({ where, select: { id: true, name: true, specialty: true, institution: true, wilaya: true, specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } } } }),
    prisma.careBeneficiary.findMany({ where, select: { id: true, doctorId: true, status: true, congressNationalId: true, congressInternationalId: true, congressNational: { select: { name: true, city: true } }, congressInternational: { select: { name: true, city: true, country: true } } } }),
    prisma.adProVoyageur.findMany({ where, select: { id: true, itemId: true, villeDepart: true, villeArrivee: true, dateDepart: true, dateRetour: true, item: { select: { label: true, sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true } } } }),
    prisma.adProHebergement.findMany({ where, select: { id: true, itemId: true, hotel: true, ville: true, dateArrivee: true, dateDepart: true, item: { select: { label: true, sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true, otherRequestId: true, trainingId: true } } } }),
    prisma.recruitmentCandidate.findMany({ where, select: { id: true, status: true, requestId: true, employeeId: true, request: { select: { position: true } } } }),
    prisma.directoryEntry.findMany({ where, select: { id: true, displayName: true, jobTitle: true, location: true, isActive: true, userId: true, employeeId: true, contactId: true } }),
    prisma.supplierUser.findMany({ where, select: { id: true, name: true, active: true, supplier: { select: { name: true } } } }),
  ]);

  // ── LES PORTES, ligne par ligne.
  const voitAdmin = userCan(user, "ADMIN", "VIEW");
  const voitAnnuaire = userCan(user, "DIRECTORIES", "VIEW");
  const voitRh = userCan(user, "EMPLOYEES", "VIEW");
  const fiches: LigneFiche[] = [];
  const lignesVues: Regard["lignesVues"][number][] = [];
  const vue = (source: SourcePersonne, racine: Regard["lignesVues"][number]["racine"] = null) => lignesVues.push({ source, racine });
  let salarieVuParLesRh = false;

  for (const u of comptes) {
    if (!(voitAdmin || (voitAnnuaire && u.isActive && !u.isSystem))) continue;
    vue("User");
    fiches.push({ source: "User", id: u.id, libelle: u.name, detail: joindre(u.title, u.isActive ? null : "compte désactivé"), lien: userCan(user, "ADMIN", "UPDATE") ? `/admin/users/${u.id}` : null });
  }
  for (const e of salaries) {
    const parLesRh = voitRh && (await entitePermisePourFiche(user.id, e.companyId));
    if (!parLesRh && !(voitAnnuaire && e.isActive)) continue;
    salarieVuParLesRh ||= parLesRh;
    vue("Employee");
    fiches.push({
      source: "Employee", id: e.id, libelle: e.fullName,
      detail: joindre(e.position, e.department, e.company?.shortName ?? e.company?.name, e.isActive ? null : "sorti des effectifs"),
      lien: parLesRh ? `/rh/${e.id}` : null,
    });
  }
  for (const d of praticiens) {
    if (!(await praticienVisible(user, d.id))) continue;
    vue("MedicalDoctor");
    fiches.push({ source: "MedicalDoctor", id: d.id, libelle: d.name, detail: joindre(d.specialtyRef?.name ?? d.specialty, d.institutionRef?.name ?? d.institution, d.wilaya), lien: `/praticiens/${d.id}` });
  }
  const prisesEnCharge: PriseEnChargeFiche[] = [];
  for (const b of beneficiaires) {
    const [type, parentId] = b.congressNationalId ? (["CONGRESS_NATIONAL", b.congressNationalId] as const)
      : b.congressInternationalId ? (["CONGRESS_INTERNATIONAL", b.congressInternationalId] as const) : [null, null];
    if (!type || !parentId || !(await canAccessEntity(user, type, parentId, "VIEW"))) continue;
    vue("CareBeneficiary", b.doctorId ? { source: "MedicalDoctor", id: b.doctorId } : null);
    const c = b.congressNational ?? b.congressInternational;
    prisesEnCharge.push({ id: b.id, operation: joindre(c?.name, c?.city) ?? "Congrès", statut: b.status, lien: entityHref(type, parentId) });
  }
  const voyages: VoyageFiche[] = [];
  const lienDuPoste = (item: Parameters<typeof parentDuPoste>[0]) => {
    const parent = parentDuPoste(item);
    return parent ? entityHref(PARENT_ENTITE[parent.parent], parent.id) : null;
  };
  for (const v of voyageurs) {
    if (!(await canAccessEntity(user, "AD_PRO_ITEM", v.itemId, "VIEW"))) continue;
    vue("AdProVoyageur");
    voyages.push({ id: v.id, nature: "VOL", poste: v.item.label, trajet: v.villeDepart || v.villeArrivee ? `${v.villeDepart ?? "?"} → ${v.villeArrivee ?? "?"}` : null, du: v.dateDepart, au: v.dateRetour, lien: lienDuPoste(v.item) });
  }
  for (const h of hebergements) {
    if (!(await canAccessEntity(user, "AD_PRO_ITEM", h.itemId, "VIEW"))) continue;
    vue("AdProHebergement");
    voyages.push({ id: h.id, nature: "HOTEL", poste: h.item.label, trajet: joindre(h.hotel, h.ville), du: h.dateArrivee, au: h.dateDepart, lien: lienDuPoste(h.item) });
  }
  for (const c of candidats) {
    if (!(await canAccessEntity(user, "RECRUITMENT_CANDIDATE", c.id, "VIEW"))) continue;
    vue("RecruitmentCandidate", c.employeeId ? { source: "Employee", id: c.employeeId } : null);
    fiches.push({ source: "RecruitmentCandidate", id: c.id, libelle: `Candidature — ${c.request.position}`, detail: LIBELLE_CANDIDATURE[c.status], lien: entityHref("RECRUITMENT_REQUEST", c.requestId) });
  }
  for (const a of annuaire) {
    if (!(voitAnnuaire && a.isActive)) continue;
    vue("DirectoryEntry", lireLigne("DirectoryEntry", { ...a, personneId }).racine);
    fiches.push({ source: "DirectoryEntry", id: a.id, libelle: a.displayName, detail: joindre(a.jobTitle, a.location), lien: "/annuaires/personnes" });
  }
  for (const s of portail) {
    if (!conduitLaRefonte) continue;
    vue("SupplierUser");
    fiches.push({ source: "SupplierUser", id: s.id, libelle: s.name, detail: joindre(s.supplier.name, s.active ? null : "accès coupé"), lien: "/admin/suppliers" });
  }

  const regard: Regard = { lignesVues, salarieVuParLesRh, conduitLaRefonte };
  if (!ficheOuverte(regard)) return { etat: "ABSENTE" };

  return {
    etat: "OUVERTE",
    fiche: {
      id: p.id, civilite: p.civilite, nom: p.nom, prenoms: p.prenoms,
      naissance: naissanceVisible(regard) ? p.naissance : null,
      nationalite: p.nationalite, completude: p.completude,
      roles: rolesVisibles(p.roles.map((r) => r.role), regard),
      affiliations: p.affiliations.map((a) => ({ id: a.id, organisation: a.organisation.nomCourt ?? a.organisation.raisonSociale, fonction: a.fonction, service: a.service, principale: a.principale })),
      fiches, prisesEnCharge, voyages,
      pieces: await piecesVisibles(user, personneId, conduitLaRefonte),
      fusionnees: conduitLaRefonte ? p.fusionnees.map((f) => ({ id: f.id, nom: joindre(f.prenoms, f.nom) ?? f.nom })) : [],
    },
  };
}

/** Les pièces liées à la Personne dont l'un des sujets d'écran s'ouvre à ce regard. Le nom et la nature, pas le contenu. */
async function piecesVisibles(user: SessionUser, personneId: string, conduitLaRefonte: boolean): Promise<PieceFiche[]> {
  const liens = await prisma.pieceLien.findMany({
    where: { sujetType: "PERSONNE", sujetId: personneId },
    select: { piece: { select: { id: true, nom: true, nature: true, deposeeLe: true, liens: { where: { sujetType: "ENTITE" }, select: { entityType: true, sujetId: true } } } } },
  });
  const out = new Map<string, PieceFiche>();
  for (const { piece } of liens) {
    if (out.has(piece.id)) continue;
    let lien: string | null = null;
    let ouverte = conduitLaRefonte;
    for (const s of piece.liens) {
      if (!s.entityType || !ENTITES.has(s.entityType)) continue;
      if (await canAccessEntity(user, s.entityType as EntityType, s.sujetId, "VIEW")) { ouverte = true; lien = entityHref(s.entityType, s.sujetId); break; }
    }
    if (ouverte) out.set(piece.id, { id: piece.id, nom: piece.nom, nature: piece.nature, deposeeLe: piece.deposeeLe, lien });
  }
  return [...out.values()].sort((a, b) => b.deposeeLe.getTime() - a.deposeeLe.getTime());
}

const LIBELLE_CANDIDATURE: Record<RecruitmentCandidateStatus, string> = {
  RECEIVED: "reçue", SHORTLISTED: "présélectionnée", SELECTED: "retenue", INTERVIEWED: "entretien passé", HIRED: "embauchée", DECLINED: "non retenue",
};

export const LIBELLE_PRISE_EN_CHARGE: Record<CareBeneficiaryStatus, string> = {
  PROPOSED: "proposée", APPROVED: "accordée", REJECTED: "écartée", WITHDRAWN: "retirée",
};
