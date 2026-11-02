import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Action, EffectiveAccess, Module, SessionUser } from "@/lib/rbac";
import { repriseOrganisations } from "../reprises/organisations";
import { repriseOrganisationsTextes } from "../reprises/organisations-textes";
import { sourcesDesAffiliations } from "./affiliations";
import { enregistrerDoublons } from "./doublons-service";
import { doubleEcrireOrganisation } from "./double-ecriture";
import { chargerFicheOrganisation } from "./fiche";
import { annulerFusionOrganisation, ecarter, fusionner } from "./fusion";
import { idOrganisationDeFiche } from "../../domaine/organisations/candidats";
import { executerParLots } from "../../domaine/reprises/lots";
import type { BilanReprise, Reprise } from "../../domaine/reprises/types";

/**
 * LE BANC DE LA REPRISE R2 — sur la base LOCALE, avec des fiches marquées : la reprise rejouée deux fois ne
 * crée rien de plus ; un NIF partagé PROPOSE un doublon sans rien fusionner ; un texte de demande se rattache ;
 * la double écriture obéit à son interrupteur ; la fiche 360° garde les portes et ne montre aucun RIB.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zv2c${Date.now()}`;
const RIB = "00799999000123456789";
const ids = {
  admin: "", lecteur: "", societe: "", contactA: "", contactB: "", contactGroupe: "", fournisseur: "", chu: "",
  spoChu: "", spoSac1: "", spoSac2: "", spoVide: "", spoAutre: "", congres: "", personne: "", salarie: "", medecin: "",
};

function asUser(id: string, role: SessionUser["role"], perms: Partial<Record<Module, Action[]>> = {}, scope: "ALL" | "OWN" = "ALL"): SessionUser {
  const modules = new Map(Object.entries(perms).map(([m, a]) => [m as Module, { module: m as Module, actions: new Set(a as Action[]), scope }]));
  return { id, role, access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess };
}

/** Tous les lots, jusqu'au bout. */
async function jusquAuBout(r: Reprise): Promise<BilanReprise> {
  const total: BilanReprise = { lues: 0, creees: 0, liees: 0, doublonsProposes: 0, ignorees: 0, erreurs: [] };
  let curseur: string | null = null;
  for (let i = 0; i < 50; i++) {
    const b: BilanReprise & { suite: string | null } = await r.executer({ taille: 2, apresId: curseur });
    total.lues += b.lues; total.creees += b.creees; total.liees += b.liees;
    total.doublonsProposes += b.doublonsProposes; total.ignorees += b.ignorees; total.erreurs.push(...b.erreurs);
    curseur = b.suite;
    if (!curseur) break;
  }
  return total;
}

const portee = () => ({
  COMPANY: [ids.societe], COMPANY_CONTACT: [ids.contactA, ids.contactB, ids.contactGroupe],
  SUPPLIER: [ids.fournisseur], MEDICAL_INSTITUTION: [ids.chu],
});

suite("reprise R2 — organisations", () => {
  let interrupteurAvant: boolean | null = null;

  beforeAll(async () => {
    const [admin, lecteur] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} délégué`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SALES_USER" } }),
    ]);
    ids.admin = admin.id; ids.lecteur = lecteur.id;
    const societe = await prisma.company.create({
      data: { name: `${TAG} Groupe`, legalIdentity: { create: { legalName: `${TAG} Groupe SPA`, nif: "000199912345678", rcNumber: "16/00-9912345 B 01" } } },
    });
    ids.societe = societe.id;
    // A AVANT B, pas en parallèle : la reprise parcourt les fiches par identifiant, et c'est la PREMIÈRE qui porte le
    // NIF. Créées ensemble, l'ordre des deux identifiants n'était pas garanti (rouge sous la charge de la suite complète).
    const a = await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie du Centre SARL`, kind: "Imprimeur", nif: "0991 2345 6789 012", rib: RIB, wilaya: "Blida" } });
    const [b, g] = await Promise.all([
      prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Centre`, kind: "Imprimeur", nif: "099123456789012", wilaya: "Blida" } }),
      // Le NIF de la société du GROUPE recopié sur un tiers : il ne le désigne pas.
      prisma.companyContact.create({ data: { name: `${TAG} Transports Atlas`, kind: "Livreur", nif: "000199912345678" } }),
    ]);
    ids.contactA = a.id; ids.contactB = b.id; ids.contactGroupe = g.id;
    ids.fournisseur = (await prisma.supplier.create({ data: { name: `${TAG} Hetero Labs`, country: "Inde" } })).id;
    ids.chu = (await prisma.medicalInstitution.create({ data: { name: `C.H.U ${TAG} Mustapha`, type: "CHU" } })).id;
    const spo = (institution: string, requesterId: string | null = null) => prisma.sponsoringRequest.create({
      data: { reference: `${TAG}-${Math.random().toString(36).slice(2, 8)}`, institution, type: "Congrès", requesterId },
      select: { id: true },
    });
    ids.spoChu = (await spo(`CHU ${TAG} Mustapha`, lecteur.id)).id;
    ids.spoSac1 = (await spo(`Société Algérienne de ${TAG} Cardiologie`, lecteur.id)).id;
    ids.spoSac2 = (await spo(`societe algerienne de ${TAG} cardiologie`)).id;
    ids.spoVide = (await spo("CHU")).id;
    ids.spoAutre = (await spo(`Association ${TAG} Diabète`, admin.id)).id;
    ids.congres = (await prisma.congressNational.create({ data: { name: `${TAG} JNC`, hostInstitution: `chu ${TAG} mustapha` } })).id;
    ids.personne = (await prisma.personne.create({ data: { nom: `${TAG}Belkacem`, prenoms: "Sarah", nomReplie: `${TAG.toLowerCase()}belkacem sarah` } })).id;
    ids.salarie = (await prisma.employee.create({ data: { fullName: `${TAG} Sarah Belkacem`, companyId: societe.id, personneId: ids.personne, position: "Pharmacienne", department: "Regulatory" } })).id;
    // Un praticien SANS personne reprise : son affiliation attend le lot Personnes.
    ids.medecin = (await prisma.medicalDoctor.create({ data: { name: `${TAG} Dr Benali`, institutionId: ids.chu } })).id;
    interrupteurAvant = (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { doubleEcritureOrganisations: true } }))?.doubleEcritureOrganisations ?? null;
  });

  afterAll(async () => {
    if (!dbOk) return;
    const orgs = await prisma.organisation.findMany({ where: { OR: [{ raisonSociale: { contains: TAG } }, { raisonSociale: { contains: TAG.toLowerCase() } }] }, select: { id: true } });
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    await prisma.personne.deleteMany({ where: { nom: { startsWith: TAG } } });
    await prisma.medicalInstitution.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.organisation.updateMany({ where: { id: { in: orgs.map((o) => o.id) } }, data: { fusionneeDansId: null } });
    await prisma.organisation.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.admin, ids.lecteur] } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
    if (interrupteurAvant !== null) await prisma.appSetting.update({ where: { id: "global" }, data: { doubleEcritureOrganisations: interrupteurAvant } });
  });

  it("l'aperçu chiffre à blanc ce que l'exécution fera — et n'écrit rien", async () => {
    const r = repriseOrganisations(portee());
    const apercu = await r.apercu();
    expect(apercu).toMatchObject({ lues: 6, creees: 6, liees: 0, ignorees: 0, doublonsProposes: 1 });
    expect(await prisma.organisation.count({ where: { id: { in: [idOrganisationDeFiche("COMPANY", ids.societe)] } } })).toBe(0);
  });

  it("la reprise crée une organisation par fiche et pose le lien ; rejouée, elle ne refait rien", async () => {
    const r = repriseOrganisations(portee(), ids.admin);
    const premier = await jusquAuBout(r);
    expect(premier).toMatchObject({ lues: 6, creees: 6, doublonsProposes: 1, erreurs: [] });
    const second = await jusquAuBout(r);
    expect(second).toMatchObject({ lues: 0, creees: 0, doublonsProposes: 0 });

    const fournisseur = await prisma.supplier.findUniqueOrThrow({ where: { id: ids.fournisseur }, select: { organisationId: true } });
    expect(fournisseur.organisationId).toBe(idOrganisationDeFiche("SUPPLIER", ids.fournisseur));
    const org = await prisma.organisation.findUniqueOrThrow({
      where: { id: fournisseur.organisationId! }, include: { roles: true },
    });
    expect(org.pays).toBe("IN");
    expect(org.roles.map((x) => x.role).sort()).toEqual(["FOURNISSEUR", "LABORATOIRE"]);

    const societe = await prisma.organisation.findUniqueOrThrow({ where: { id: idOrganisationDeFiche("COMPANY", ids.societe) }, include: { identifiants: true } });
    expect(societe.identifiants.map((i) => i.type).sort()).toEqual(["NIF", "RC"]);
  });

  it("un NIF partagé PROPOSE un doublon certain sans rien fusionner ; le NIF du groupe sur un tiers ne propose rien", async () => {
    const [orgA, orgB, orgG] = [ids.contactA, ids.contactB, ids.contactGroupe].map((id) => idOrganisationDeFiche("COMPANY_CONTACT", id));
    const nif = await prisma.organisationIdentifiant.findMany({ where: { valeurNormalisee: "099123456789012" } });
    expect(nif.map((n) => n.organisationId)).toEqual([orgA]);
    const props = await prisma.propositionDoublonOrganisation.findMany({ where: { OR: [{ organisationAId: { in: [orgA, orgB, orgG] } }, { organisationBId: { in: [orgA, orgB, orgG] } }] } });
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ niveau: "CERTAIN", statut: "PROPOSEE" });
    expect([props[0].organisationAId, props[0].organisationBId].sort()).toEqual([orgA, orgB].sort());
    expect(await prisma.organisation.count({ where: { id: { in: [orgA, orgB] }, fusionneeDansId: { not: null } } })).toBe(0);
    expect(await prisma.organisationIdentifiant.count({ where: { organisationId: orgG } })).toBe(0);
  });

  it("les textes des demandes : rattachés à l'établissement de même nom, une organisation par nom nouveau, rien pour « CHU »", async () => {
    const r = repriseOrganisationsTextes({ SponsoringRequest: [ids.spoChu, ids.spoSac1, ids.spoSac2, ids.spoVide, ids.spoAutre], CongressNational: [ids.congres] }, ids.admin);
    const apercu = await r.apercu();
    expect(apercu).toMatchObject({ lues: 6, creees: 2, liees: 3, ignorees: 1 });
    const fait = await jusquAuBout(r);
    expect(fait).toMatchObject({ creees: 2, liees: 3, ignorees: 1, erreurs: [] });
    expect(await jusquAuBout(r)).toMatchObject({ creees: 0, liees: 0 });

    const chuOrg = idOrganisationDeFiche("MEDICAL_INSTITUTION", ids.chu);
    const spo = await prisma.sponsoringRequest.findMany({ where: { id: { in: [ids.spoChu, ids.spoSac1, ids.spoSac2, ids.spoVide] } }, select: { id: true, organisationId: true, institution: true } });
    const lien = new Map(spo.map((s) => [s.id, s.organisationId]));
    expect(lien.get(ids.spoChu)).toBe(chuOrg);
    expect(lien.get(ids.spoSac1)).toBeTruthy();
    expect(lien.get(ids.spoSac1)).toBe(lien.get(ids.spoSac2));
    expect(lien.get(ids.spoVide)).toBeNull();
    expect(spo.find((s) => s.id === ids.spoSac2)!.institution).toBe(`societe algerienne de ${TAG} cardiologie`); // le texte reste
    const sac = await prisma.organisation.findUniqueOrThrow({ where: { id: lien.get(ids.spoSac1)! }, include: { roles: true } });
    expect(sac.roles.map((x) => x.role)).toEqual(["SOCIETE_SAVANTE"]);
    expect((await prisma.congressNational.findUniqueOrThrow({ where: { id: ids.congres } })).organisationId).toBe(chuOrg);
  });

  it("les affiliations sûres seulement : le salarié et sa société ; le praticien sans personne attend", async () => {
    const sources = sourcesDesAffiliations(ids.admin);
    for (let i = 0; i < 2; i++) {
      let curseur: string | null = null;
      do { curseur = (await executerParLots(sources, { taille: 500, apresId: curseur })).suite; } while (curseur);
    }
    const aff = await prisma.affiliation.findMany({ where: { personneId: ids.personne } });
    expect(aff).toHaveLength(1);
    expect(aff[0]).toMatchObject({ id: `aff-emp-${ids.salarie}`, organisationId: idOrganisationDeFiche("COMPANY", ids.societe), fonction: "Pharmacienne", principale: true });
    expect(await prisma.affiliation.count({ where: { id: `aff-md-${ids.medecin}` } })).toBe(0);
    expect(await prisma.personne.count({ where: { nom: { startsWith: TAG } } })).toBe(1); // aucune personne créée
  });

  it("les doublons de noms proches sont proposés ; une paire écartée n'est jamais reproposée", async () => {
    let curseur: string | null = null;
    do { curseur = (await enregistrerDoublons({ taille: 500, apresId: curseur })).suite; } while (curseur);
    const [orgA, orgB] = [ids.contactA, ids.contactB].map((id) => idOrganisationDeFiche("COMPANY_CONTACT", id));
    const [a, b] = orgA < orgB ? [orgA, orgB] : [orgB, orgA];
    const p = await prisma.propositionDoublonOrganisation.findUniqueOrThrow({ where: { organisationAId_organisationBId: { organisationAId: a, organisationBId: b } } });
    expect(p.raisons.join(" ")).toMatch(/même NIF/);

    await ecarter(p.id, ids.admin);
    curseur = null;
    do { curseur = (await enregistrerDoublons({ taille: 500, apresId: curseur })).suite; } while (curseur);
    expect((await prisma.propositionDoublonOrganisation.findUniqueOrThrow({ where: { id: p.id } })).statut).toBe("ECARTEE");
  });

  it("la fusion est un geste humain, réversible : la fiche absorbée renvoie à la survivante, qui réunit les deux", async () => {
    const [orgA, orgB] = [ids.contactA, ids.contactB].map((id) => idOrganisationDeFiche("COMPANY_CONTACT", id));
    const [a, b] = orgA < orgB ? [orgA, orgB] : [orgB, orgA];
    await prisma.propositionDoublonOrganisation.update({ where: { organisationAId_organisationBId: { organisationAId: a, organisationBId: b } }, data: { statut: "PROPOSEE" } });
    const p = await prisma.propositionDoublonOrganisation.findUniqueOrThrow({ where: { organisationAId_organisationBId: { organisationAId: a, organisationBId: b } } });
    await fusionner(p.id, orgA, ids.admin);
    await expect(fusionner(p.id, orgA, ids.admin)).rejects.toThrow(/déjà été tranchée/);

    const admin = asUser(ids.admin, "SUPER_ADMIN");
    expect(await chargerFicheOrganisation(admin, orgB)).toEqual({ etat: "FUSIONNEE", survivanteId: orgA });
    const fiche = await chargerFicheOrganisation(admin, orgA);
    if (fiche.etat !== "OK") throw new Error(fiche.etat);
    expect(fiche.sources.map((s) => s.id).sort()).toEqual([ids.contactA, ids.contactB].sort());
    expect(fiche.absorbees.map((x) => x.id)).toEqual([orgB]);
    expect(JSON.stringify(fiche)).not.toContain(RIB); // le RIB n'est jamais sur la fiche

    await annulerFusionOrganisation(orgB);
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: orgB } })).fusionneeDansId).toBeNull();
    expect((await prisma.propositionDoublonOrganisation.findUniqueOrThrow({ where: { id: p.id } })).statut).toBe("PROPOSEE");
  });

  it("la fiche 360° garde les portes des écrans d'origine : un délégué ne voit que ce que ses demandes lui montrent", async () => {
    const delegue = asUser(ids.lecteur, "SALES_USER", { SPONSORING: ["VIEW"] }, "OWN");
    const spo = await prisma.sponsoringRequest.findMany({ where: { id: { in: [ids.spoSac1, ids.spoAutre] } }, select: { id: true, organisationId: true } });
    const sacOrg = spo.find((s) => s.id === ids.spoSac1)!.organisationId!;
    const autreOrg = spo.find((s) => s.id === ids.spoAutre)!.organisationId!;

    const sienne = await chargerFicheOrganisation(delegue, sacOrg);
    if (sienne.etat !== "OK") throw new Error(sienne.etat);
    // Il voit SA demande, pas celle de l'autre demandeur sur la même société savante.
    expect(sienne.demandes.lignes.map((d) => d.id)).toEqual([ids.spoSac1]);
    expect(sienne.pieces).toBeNull();
    // L'organisation d'une demande qui n'est pas la sienne n'existe pas pour lui.
    expect(await chargerFicheOrganisation(delegue, autreOrg)).toEqual({ etat: "INTROUVABLE" });
    // Le salarié affilié à la société du groupe ne se lit pas sans la porte RH.
    const sansRh = asUser(ids.lecteur, "SALES_USER", { LEGAL: ["VIEW"] });
    const groupe = await chargerFicheOrganisation(sansRh, idOrganisationDeFiche("COMPANY", ids.societe));
    if (groupe.etat !== "OK") throw new Error(groupe.etat);
    expect(groupe.personnes).toEqual([]);
    const avecRh = await chargerFicheOrganisation(asUser(ids.lecteur, "SALES_USER", { LEGAL: ["VIEW"], RH: ["VIEW"] }), idOrganisationDeFiche("COMPANY", ids.societe));
    if (avecRh.etat !== "OK") throw new Error(avecRh.etat);
    expect(avecRh.personnes.map((p) => p.nom)).toEqual([`Sarah ${TAG}Belkacem`]);
  });

  it("la double écriture obéit à son interrupteur et ne casse jamais la création", async () => {
    const f1 = await prisma.supplier.create({ data: { name: `${TAG} Fournisseur fermé` } });
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", doubleEcritureOrganisations: false }, update: { doubleEcritureOrganisations: false } });
    await doubleEcrireOrganisation("SUPPLIER", f1.id, ids.admin);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: f1.id } })).organisationId).toBeNull();

    await prisma.appSetting.update({ where: { id: "global" }, data: { doubleEcritureOrganisations: true } });
    await doubleEcrireOrganisation("SUPPLIER", f1.id, ids.admin);
    await doubleEcrireOrganisation("SUPPLIER", f1.id, ids.admin); // rejouée : rien de plus
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: f1.id } })).organisationId).toBe(idOrganisationDeFiche("SUPPLIER", f1.id));
    await expect(doubleEcrireOrganisation("SUPPLIER", "inexistant", ids.admin)).resolves.toBeUndefined();
  });
});
