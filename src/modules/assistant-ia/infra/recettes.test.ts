import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, MODULES, userCan, type Module } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { getDefinition } from "@/lib/workflow/engine";
import { WORKFLOW_CATEGORIES } from "@/lib/workflow/types";
import { approuverTravail } from "@/lib/missions/travaux/service";
import { lirePlan } from "@/lib/missions/travaux/plan";
import {
  corrigerEtValider, decrireCircuit, designerResponsable, lireEcranRecettes, proposerLesRecettes, recettePour, rejeterVersion, retirerRecette,
  seuilRond, statsUsages, validerVersion, voitLeCircuit, type ContenuRecette,
} from "@/modules/recettes/api";
import { outilRecettePour } from "./recettes";
import { outilTravailPour, PERSONA_ASSISTANT_IA } from "./travaux";
import { repondreAvecSecours } from "./repondre";
import { effacerJournalDe } from "./testing/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DES RECETTES (J10, décision 0028) — vraie base, corpus SEMÉ, faux modèle (aucun appel payant).
 *
 *   1. EXTRACTION : sur le corpus semé (12 circuits au-dessus du seuil, 2 en dessous), chaque recette est juste —
 *      étapes dans l'ordre, qui valide, pièces habituelles, seuil observé « la DG signe au-delà de… », durée médiane,
 *      piège répété ; rien sous le seuil ; une seconde extraction ne propose rien de neuf ;
 *   2. AUCUNE RECETTE AVANT VALIDATION : tant que le responsable n'a pas validé, `recette_pour` ne rend rien ; un
 *      non-responsable (même Super Admin) ne valide pas ; une recette rejetée ou retirée n'est jamais servie ;
 *   3. ≥ 70 % DE PLANS ACCEPTÉS SANS RETOUCHE : des demandes de référence jouées au FAUX MODÈLE (il suit la recette :
 *      recette_pour → lancer_un_travail avec le plan rendu) ; la personne simulée approuve le plan tel quel quand il
 *      vient de la bonne recette ; le taux mesuré par les statistiques de l'écran est le même ;
 *   4. DROITS : une recette ne se montre qu'à qui voit l'écran de son circuit (par rôle), une famille fermée retire ses
 *      processus, le contenu ne porte ni dossier, ni nom, ni montant d'un dossier.
 *
 * Le corpus est daté de 2031 et l'extraction lit la fenêtre qui finit le 01/07/2031 : les dossiers des autres bancs
 * (datés d'aujourd'hui) n'y entrent pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `r10${Date.now().toString(36)}`;
const MAINTENANT = new Date("2031-07-01T12:00:00Z");
const JOUR = 86_400_000;
const SEUIL_DG = 1_200_000;

const utilisateurs: CurrentUser[] = [];
const parRole = new Map<string, CurrentUser>();
const semes = { instances: [] as string[], validations: [] as string[], recrutements: [] as string[], missions: [] as string[], pieces: [] as string[], formes: [] as string[], entites: [] as string[], montants: [] as number[] };
const montantsDe = new Map<string, number[]>();
const attendu = new Map<string, { cles: string[]; validateurs: Record<string, string[]>; pieces: string[]; mediane: number; occurrences: number; seuil?: { etape: string; montant: number; source: string }; piege?: string }>();
const processusDesignes: string[] = [];

async function compte(nom: string, role: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: role as never } });
  const access = await getAccess(u.id, u.role);
  const c = { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  utilisateurs.push(c);
  return c;
}
async function acteur(role: string): Promise<CurrentUser> {
  const deja = parRole.get(role);
  if (deja) return deja;
  const c = await compte(`acteur-${role.toLowerCase()}`, role);
  parRole.set(role, c);
  return c;
}

const mediane = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function pieces(entite: string, natures: string[]) {
  for (const nature of natures) {
    const p = await prisma.piece.create({ data: { empreinte: `${TAG}-${entite}-${nature}`, nom: `${nature}.pdf`, nature, liens: { create: { sujetType: "ENTITE", sujetId: entite, role: "JUSTIFICATIF" } } } });
    semes.pieces.push(p.id);
  }
}

/**
 * Le circuit de la catégorie, semé par le MOTEUR lui-même s'il manque (`getDefinition`) — jamais une copie simplifiée :
 * la base est partagée par les fichiers de test qui tournent en parallèle, et un circuit semé ici (sans seuils ni
 * configuration d'étape) devenait LE circuit des tests Ad & Pro voisins ; il ne se supprimait plus ensuite (des
 * instances l'utilisaient). Le circuit par défaut reste en place : c'est celui que l'application sèmerait.
 */
async function definitionDe(categorie: string) {
  const def = await getDefinition(categorie as never);
  return { id: def.id, steps: [...def.steps].sort((a, b) => a.position - b.position).map((st) => ({ slug: st.slug, title: st.title, actorRoles: st.actorRoles, autoSkipMaxAmount: st.autoSkipMaxAmount })) };
}

const ENTITE_WF: Record<string, string> = { SPONSORING: "SPONSORING", CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL", CONGRESS_NATIONAL: "CONGRESS_NATIONAL", EVENTS: "EVENT", OTHER: "AD_PRO_OTHER" };

/** Un circuit Ad & Pro semé : `montants.length` dossiers acceptés, l'étape DG seulement au-delà de 1,2 M, deux renvois au même motif. */
async function semerAdPro(categorie: string, montants: number[], natures: (i: number) => string[], debut: Date) {
  const def = await definitionDe(categorie);
  const dg = def.steps.find((s) => s.slug === "dg") ?? def.steps[def.steps.length - 1];
  const demandeur = await acteur("MEDICAL_DELEGATE");
  const durees: number[] = [];
  for (const [i, montant] of montants.entries()) {
    const t0 = new Date(debut.getTime() + i * 3 * JOUR);
    const route = def.steps.filter((s) => s !== dg || montant > SEUIL_DG);
    const entityId = `${TAG}-${categorie}-${i}`;
    let t = t0.getTime();
    const evts: { stepSlug: string; stepTitle: string; action: string; actorId: string; actorName: string; note: string | null; createdAt: Date }[] = [
      { stepSlug: route[0].slug, stepTitle: route[0].title, action: "CREATE", actorId: demandeur.id, actorName: demandeur.name, note: null, createdAt: new Date(t) },
    ];
    for (const [k, s] of route.entries()) {
      const qui = await acteur(s.actorRoles[0] ?? "GENERAL_MANAGER");
      if (k === 0 && i < 2) {
        t += JOUR;
        evts.push({ stepSlug: s.slug, stepTitle: s.title, action: "RETURN", actorId: qui.id, actorName: qui.name, note: `Programme du congrès manquant (dossier ${i + 1}, ${montant} DZD)`, createdAt: new Date(t) });
        t += JOUR;
        evts.push({ stepSlug: s.slug, stepTitle: s.title, action: "RESUBMIT", actorId: demandeur.id, actorName: demandeur.name, note: null, createdAt: new Date(t) });
      }
      t += (k + 1) * JOUR + (i % 3) * 0.5 * JOUR;
      evts.push({ stepSlug: s.slug, stepTitle: s.title, action: "APPROVE", actorId: qui.id, actorName: qui.name, note: null, createdAt: new Date(t) });
    }
    durees.push((t - t0.getTime()) / JOUR);
    const inst = await prisma.workflowInstance.create({
      data: { definitionId: def.id, entityType: ENTITE_WF[categorie] as never, entityId, category: categorie, status: "APPROVED", amount: montant, createdAt: t0, events: { create: evts } },
    });
    semes.instances.push(inst.id);
    semes.entites.push(entityId);
    semes.montants.push(montant);
    montantsDe.set(`WF:${categorie}`, [...(montantsDe.get(`WF:${categorie}`) ?? []), montant]);
    await pieces(entityId, natures(i));
  }
  // Deux dossiers en cours : ils ne comptent pas.
  for (let j = 0; j < 2; j++) {
    const inst = await prisma.workflowInstance.create({
      data: { definitionId: def.id, entityType: ENTITE_WF[categorie] as never, entityId: `${TAG}-${categorie}-ouvert-${j}`, category: categorie, status: "IN_PROGRESS", amount: 99_999, createdAt: new Date(debut.getTime() + 60 * JOUR) },
    });
    semes.instances.push(inst.id);
  }
  const n = montants.length;
  const avecDg = montants.filter((m) => m > SEUIL_DG);
  const sansDg = montants.filter((m) => m <= SEUIL_DG);
  const cles = def.steps.filter((s) => s !== dg || avecDg.length / n >= 0.2).map((s) => s.slug);
  const toutesNatures = new Map<string, number>();
  montants.forEach((_, i) => natures(i).forEach((x) => toutesNatures.set(x, (toutesNatures.get(x) ?? 0) + 1)));
  attendu.set(`WF:${categorie}`, {
    cles,
    validateurs: Object.fromEntries(def.steps.filter((s) => s.actorRoles.length).map((s) => [s.slug, s.actorRoles])),
    pieces: [...toutesNatures.entries()].filter(([, k]) => k / n >= 0.5).map(([x]) => x).sort(),
    mediane: mediane(durees),
    occurrences: n,
    ...(dg.autoSkipMaxAmount
      ? { seuil: { etape: dg.slug, montant: Number(dg.autoSkipMaxAmount), source: "DEFINITION" } }
      : avecDg.length >= 2 && sansDg.length >= 2 ? { seuil: { etape: dg.slug, montant: seuilRond(Math.max(...sansDg), Math.min(...avecDg))!, source: "OBSERVE" } } : {}),
    piege: "Programme du congrès manquant",
  });
}

/** Une validation générique semée : niveaux par rôle ; `niveau2Au-dela` = le second niveau n'apparaît qu'au-dessus de ce montant. */
async function semerValidation(module: string, n: number, roles: string[], opts: { niveau2AuDela?: number; statut?: string } = {}, debut: Date) {
  const demandeur = await acteur("PRODUCT_MANAGER");
  const durees: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = new Date(debut.getTime() + i * 2 * JOUR);
    const montant = 200_000 + i * 150_000;
    const niveaux = roles.filter((_, k) => k === 0 || opts.niveau2AuDela === undefined || montant > opts.niveau2AuDela);
    let t = t0.getTime();
    const steps = [];
    for (const [k, r] of niveaux.entries()) {
      t += (k + 2) * JOUR;
      steps.push({ order: k + 1, validatorId: (await acteur(r)).id, status: (opts.statut ? "PENDING" : "APPROVED") as never, decidedAt: opts.statut ? null : new Date(t) });
    }
    durees.push((t - t0.getTime()) / JOUR);
    const v = await prisma.validationRequest.create({
      data: {
        reference: `VAL-${TAG}-${module}-${i}`, module, title: `${TAG} validation ${i}`, requesterId: demandeur.id, mode: "SEQUENTIAL",
        status: (opts.statut ?? "APPROVED") as never, amount: montant, createdAt: t0, decidedAt: opts.statut ? null : new Date(t), steps: { create: steps },
      },
    });
    semes.validations.push(v.id);
    semes.montants.push(montant);
    montantsDe.set(`VAL:${module}`, [...(montantsDe.get(`VAL:${module}`) ?? []), montant]);
  }
  const montants = Array.from({ length: n }, (_, i) => 200_000 + i * 150_000);
  const sans = opts.niveau2AuDela !== undefined ? montants.filter((m) => m <= opts.niveau2AuDela!) : [];
  attendu.set(`VAL:${module}`, {
    cles: roles.map((_, k) => `n${k + 1}`),
    validateurs: Object.fromEntries(roles.map((r, k) => [`n${k + 1}`, [r]])),
    pieces: [],
    mediane: mediane(durees),
    occurrences: n,
    ...(opts.niveau2AuDela !== undefined ? { seuil: { etape: "n2", montant: seuilRond(Math.max(...sans), Math.min(...montants.filter((m) => m > opts.niveau2AuDela!)))!, source: "OBSERVE" } } : {}),
  });
}

async function semerRecrutement(n: number, debut: Date) {
  const demandeur = await acteur("HEAD_OF_SALES");
  const durees: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = new Date(debut.getTime() + i * 4 * JOUR);
    const d1 = new Date(t0.getTime() + 2 * JOUR);
    const d2 = new Date(d1.getTime() + (3 + i) * JOUR);
    durees.push((d2.getTime() - t0.getTime()) / JOUR);
    const r = await prisma.recruitmentRequest.create({
      data: {
        reference: `REC-${TAG}-${i}`, requesterId: demandeur.id, position: "Délégué médical", contractType: "CDI", stage: "SOURCING", createdAt: t0,
        approvals: { create: [
          { order: 1, approverId: (await acteur("OPERATIONS_DIRECTOR")).id, status: "APPROVED", decidedAt: d1 },
          { order: 2, approverId: (await acteur("GENERAL_MANAGER")).id, status: "APPROVED", decidedAt: d2 },
        ] },
      },
    });
    semes.recrutements.push(r.id);
    await pieces(r.id, ["CV", "DIPLOME"]);
  }
  attendu.set("REC", { cles: ["n1", "n2"], validateurs: { n1: ["OPERATIONS_DIRECTOR"], n2: ["GENERAL_MANAGER"] }, pieces: ["CV", "DIPLOME"], mediane: mediane(durees), occurrences: n });
}

const PLAN_RAPPORT = {
  titre: "Rapport mensuel des visites terrain",
  objectif: "Le rapport mensuel des visites terrain.",
  etapes: [
    { cle: "synthese", type: "ANALYSE", titre: "Synthèse des visites du mois", consigne: "Résumer les visites, par délégué et par produit." },
    { cle: "rapport", type: "LIVRABLE", titre: "Rapport mensuel des visites", apres: ["synthese"], consigne: "Rédiger le rapport mensuel des visites terrain." },
  ],
};

async function semerTravaux(n: number, debut: Date) {
  const qui = await acteur("SUPER_ADMIN");
  for (let i = 0; i < n; i++) {
    const t0 = new Date(debut.getTime() + i * 30 * JOUR);
    const m = await prisma.mission.create({
      data: {
        ownerId: qui.id, principalId: qui.id, persona: "ASSISTANT_IA", kind: "TRAVAIL", status: "COMPLETED", title: PLAN_RAPPORT.titre, objective: PLAN_RAPPORT.objectif,
        carnet: { objectif: PLAN_RAPPORT.objectif, plan: PLAN_RAPPORT, notes: [], trouvailles: [], livrables: [] }, createdAt: t0, updatedAt: new Date(t0.getTime() + 2 * JOUR),
      },
    });
    semes.missions.push(m.id);
  }
}

const CIRCUITS_ATTENDUS = ["WF:SPONSORING", "WF:CONGRESS_INTERNATIONAL", "WF:CONGRESS_NATIONAL", "WF:EVENTS", "WF:OTHER", "VAL:REGULATORY", "VAL:RH", "VAL:FINANCES", "VAL:MARKETING", "REC"];
const SOUS_LE_SEUIL = ["VAL:LEGAL", "VAL:BUDGETS"];

async function nettoyerRecettes() {
  await prisma.recette.deleteMany({ where: { OR: [{ circuit: { in: [...CIRCUITS_ATTENDUS, ...SOUS_LE_SEUIL] } }, { circuit: { startsWith: "TRAVAIL:" } }, { circuit: { startsWith: `FORME:${TAG}` } }] } });
}

const recetteDe = (circuit: string) => prisma.recette.findUnique({ where: { circuit }, select: { id: true, statut: true, versions: { orderBy: { numero: "desc" }, select: { id: true, numero: true, statut: true, contenu: true } } } });
const circuitTravail = async () => (await prisma.recette.findFirst({ where: { circuit: { startsWith: "TRAVAIL:" }, titre: PLAN_RAPPORT.titre }, select: { circuit: true } }))?.circuit ?? "?";

let superAdmin: CurrentUser;
let responsableAdPro: CurrentUser;

suite("Recettes (J10) — banc sur base réelle, corpus semé, faux modèle", () => {
  beforeAll(async () => {
    await nettoyerRecettes();
    superAdmin = await acteur("SUPER_ADMIN");
    // K3 (décision 0033) : le Super Admin démarre d'office les plans sans geste — ici, la personne simulée APPROUVE.
    await prisma.assistantIaPreference.upsert({ where: { userId: superAdmin.id }, create: { userId: superAdmin.id, travauxDOffice: false }, update: { travauxDOffice: false } });
    const d0 = new Date("2031-01-05T08:00:00Z");
    const montantsNat = [300_000, 500_000, 800_000, 950_000, 1_500_000, 2_000_000, 3_000_000, 1_100_000];
    await semerAdPro("CONGRESS_NATIONAL", montantsNat, (i) => ["PROGRAMME_CONGRES", "INVITATION", ...(i < 3 ? ["DEVIS"] : [])], d0);
    await semerAdPro("CONGRESS_INTERNATIONAL", [600_000, 900_000, 1_000_000, 1_800_000, 2_500_000, 4_000_000], () => ["PROGRAMME_CONGRES", "PASSEPORT", "BILLET_TRANSPORT"], d0);
    await semerAdPro("SPONSORING", [200_000, 400_000, 700_000, 1_400_000, 1_600_000, 900_000], () => ["CONVENTION", "DEVIS"], d0);
    await semerAdPro("EVENTS", [250_000, 450_000, 650_000, 1_300_000, 1_900_000], () => ["DEVIS"], d0);
    await semerAdPro("OTHER", [100_000, 150_000, 300_000, 1_250_000, 1_350_000], () => ["DEVIS", "FACTURE"], d0);
    await semerValidation("REGULATORY", 6, ["HEAD_OF_REGULATORY", "GENERAL_MANAGER"], {}, d0);
    await semerValidation("RH", 5, ["GENERAL_MANAGER"], {}, d0);
    await semerValidation("FINANCES", 6, ["FINANCE_BUDGET_MANAGER", "GENERAL_MANAGER"], { niveau2AuDela: 500_000 }, d0);
    await semerValidation("MARKETING", 5, ["MEDICAL_PROMOTION_MANAGER"], {}, d0);
    await semerValidation("LEGAL", 3, ["GENERAL_MANAGER"], {}, d0); // sous le seuil (5)
    await semerValidation("BUDGETS", 6, ["FINANCE_BUDGET_MANAGER"], { statut: "PENDING" }, d0); // aucun dossier clos
    attendu.delete("VAL:LEGAL");
    attendu.delete("VAL:BUDGETS");
    await semerRecrutement(5, d0);
    await semerTravaux(3, d0);
    const f = await prisma.missionPlanPattern.create({
      data: { signature: `${TAG}-forme`, profil: "SIMPLE", forme: ["CAPABILITY(search_people)", "CAPABILITY(send_message)[éventail]"], succes: 6, statut: "VALIDATED", createdAt: d0, updatedAt: new Date("2031-05-01T00:00:00Z") },
    });
    semes.formes.push(f.id);
    // Les travaux se proposent à partir de 3 réussites (le seuil réglé par la Direction ; 5 par défaut).
    for (const p of ["TRAVAUX"]) {
      const r = await designerResponsable(superAdmin, p, { role: "SUPER_ADMIN", seuil: 3 });
      expect(r.ok).toBe(true);
      processusDesignes.push(p);
    }
    responsableAdPro = await acteur("PRODUCT_MANAGER");
  }, 180_000);

  afterAll(async () => {
    if (!dbOk) return;
    await prisma.assistantIaPreference.deleteMany({ where: { userId: superAdmin?.id } }).catch(() => undefined);
    await nettoyerRecettes();
    await prisma.recetteResponsable.deleteMany({ where: { processus: { in: processusDesignes } } });
    await prisma.recetteUsage.deleteMany({ where: { userId: { in: utilisateurs.map((u) => u.id) } } });
    await prisma.mission.deleteMany({ where: { OR: [{ id: { in: semes.missions } }, { principalId: { in: utilisateurs.map((u) => u.id) } }] } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: semes.instances } } });
    await prisma.validationRequest.deleteMany({ where: { id: { in: semes.validations } } });
    await prisma.recruitmentRequest.deleteMany({ where: { id: { in: semes.recrutements } } });
    await prisma.piece.deleteMany({ where: { id: { in: semes.pieces } } });
    await prisma.missionPlanPattern.deleteMany({ where: { id: { in: semes.formes } } });
    await effacerJournalDe(utilisateurs.map((u) => u.id));
    await prisma.auditLog.deleteMany({ where: { actorId: { in: utilisateurs.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: utilisateurs.map((u) => u.id) } } });
  }, 120_000);

  it("1 · extraction : ≥ 10 recettes justes sur le corpus semé, rien sous le seuil, une seconde extraction ne propose rien", async () => {
    const bilan = await proposerLesRecettes({ maintenant: MAINTENANT });
    expect(bilan.creees).toBeGreaterThanOrEqual(12);
    let justes = 0;
    const fautes: string[] = [];
    for (const [circuit, a] of attendu) {
      const r = await recetteDe(circuit);
      const c = r?.versions[0]?.contenu as unknown as ContenuRecette | undefined;
      if (!r || !c) { fautes.push(`${circuit} : aucune recette`); continue; }
      const f: string[] = [];
      if (r.statut !== "PROPOSEE" || r.versions[0].statut !== "PROPOSEE") f.push(`statut ${r.statut}`);
      if (JSON.stringify(c.etapes.map((e) => e.cle)) !== JSON.stringify(a.cles)) f.push(`étapes ${c.etapes.map((e) => e.cle)} ≠ ${a.cles}`);
      for (const [cle, roles] of Object.entries(a.validateurs)) {
        const e = c.etapes.find((x) => x.cle === cle);
        if (e && JSON.stringify([...e.validateurs].sort()) !== JSON.stringify([...roles].sort())) f.push(`validateurs de ${cle} : ${e.validateurs} ≠ ${roles}`);
      }
      if (JSON.stringify(c.pieces.map((p) => p.nature).sort()) !== JSON.stringify(a.pieces)) f.push(`pièces ${c.pieces.map((p) => p.nature)} ≠ ${a.pieces}`);
      if (Math.abs((c.duree.medianeJours ?? -1) - a.mediane) > 1e-6) f.push(`médiane ${c.duree.medianeJours} ≠ ${a.mediane}`);
      if (c.observation.occurrences !== a.occurrences) f.push(`occurrences ${c.observation.occurrences} ≠ ${a.occurrences}`);
      if (a.seuil) {
        const s = c.seuils.find((x) => x.etape === a.seuil!.etape);
        if (!s || s.montant !== a.seuil.montant || s.source !== a.seuil.source) f.push(`seuil ${JSON.stringify(s)} ≠ ${JSON.stringify(a.seuil)}`);
      }
      if (a.piege && !c.pieges.some((p) => p.texte.includes(a.piege!))) f.push(`piège « ${a.piege} » absent (${c.pieges.map((p) => p.texte).join(" | ")})`);
      if (f.length) fautes.push(`${circuit} : ${f.join(" ; ")}`); else justes++;
    }
    // Les travaux (forme du plan) et la forme de mission d'Adam validée.
    const travail = await recetteDe(await circuitTravail());
    const cT = travail?.versions[0]?.contenu as unknown as ContenuRecette | undefined;
    if (cT && cT.observation.occurrences === 3 && cT.formePlan?.map((e) => e.cle).join() === "synthese,rapport") justes++; else fautes.push("TRAVAIL : recette absente ou fausse");
    const forme = await recetteDe(`FORME:${TAG}-forme`);
    const cF = forme?.versions[0]?.contenu as unknown as ContenuRecette | undefined;
    if (cF && cF.etapes.length === 2 && cF.observation.occurrences === 6) justes++; else fautes.push("FORME : recette absente ou fausse");
    console.info(`[banc recettes] ${justes}/${attendu.size + 2} recettes justes`);
    expect(fautes).toEqual([]);
    expect(justes).toBeGreaterThanOrEqual(10);

    for (const circuit of SOUS_LE_SEUIL) expect(await recetteDe(circuit), `${circuit} sous le seuil`).toBeNull();

    // Le seuil observé se lit en français dans la recette : « la DG signe au-delà de… ».
    const nat = (await recetteDe("WF:CONGRESS_NATIONAL"))!.versions[0].contenu as unknown as ContenuRecette;
    expect(nat.resume).toMatch(/au-delà d'environ 1,2 M DZD/);

    const encore = await proposerLesRecettes({ maintenant: MAINTENANT });
    expect(encore.creees).toBe(0);
    expect(encore.nouvellesVersions).toBe(0);
    expect(encore.remplacees).toBe(0);
  }, 120_000);

  it("2 · aucune recette servie avant validation ; seul le responsable tranche ; rejet et retrait ne servent jamais", async () => {
    const outil = outilRecettePour(superAdmin, []);
    const avant = JSON.parse(await outil.run({ intention: "Prépare une prise en charge nationale pour le congrès d'Oran" }, superAdmin));
    expect(avant.statut).toBe("AUCUNE");

    const nat = (await recetteDe("WF:CONGRESS_NATIONAL"))!;
    // Personne n'est désigné pour Ad & Pro : même le Super Admin ne valide pas.
    const refus = await validerVersion(superAdmin, nat.versions[0].id);
    expect(refus.ok).toBe(false);

    // La Direction désigne les responsables ; chacun valide son processus.
    for (const [p, role] of [["AD_PRO", "PRODUCT_MANAGER"], ["REGLEMENTAIRE", "HEAD_OF_REGULATORY"], ["RH", "GENERAL_MANAGER"], ["FINANCES", "FINANCE_BUDGET_MANAGER"], ["MARKETING", "PRODUCT_MANAGER"]] as const) {
      expect((await designerResponsable(responsableAdPro, p, { role })).ok).toBe(false); // pas la Direction
      expect((await designerResponsable(superAdmin, p, { role })).ok).toBe(true);
      processusDesignes.push(p);
    }
    const valider = async (circuit: string, qui: CurrentUser) => {
      const r = (await recetteDe(circuit))!;
      const v = await validerVersion(qui, r.versions[0].id);
      expect(v.ok, `${circuit} : ${"erreur" in v ? v.erreur : ""}`).toBe(true);
    };
    // Un responsable désigné qui ne VOIT pas l'écran du circuit ne le tranche pas (le chef de promotion n'ouvre pas le sponsoring).
    const spo = (await recetteDe("WF:SPONSORING"))!;
    const mpm = await acteur("MEDICAL_PROMOTION_MANAGER");
    expect((await designerResponsable(superAdmin, "AD_PRO", { role: "MEDICAL_PROMOTION_MANAGER" })).ok).toBe(true);
    expect((await validerVersion(mpm, spo.versions[0].id)).ok).toBe(false);
    expect((await designerResponsable(superAdmin, "AD_PRO", { role: "PRODUCT_MANAGER" })).ok).toBe(true);
    // Corriger = une version de plus, écrite par le responsable ; l'originale reste lisible (remplacée).
    const corr = await corrigerEtValider(responsableAdPro, nat.versions[0].id, { note: "Joindre le programme dès le dépôt.", etapes: (nat.versions[0].contenu as unknown as ContenuRecette).etapes.map((e) => ({ cle: e.cle, libelle: e.libelle })) });
    expect(corr.ok).toBe(true);
    const natApres = (await recetteDe("WF:CONGRESS_NATIONAL"))!;
    expect(natApres.versions.map((v) => `${v.numero}:${v.statut}`)).toEqual(["2:VALIDEE", "1:REMPLACEE"]);
    for (const c of ["WF:CONGRESS_INTERNATIONAL", "WF:SPONSORING", "WF:EVENTS", "WF:OTHER"]) await valider(c, responsableAdPro);
    await valider("VAL:REGULATORY", await acteur("HEAD_OF_REGULATORY"));
    await valider("VAL:RH", await acteur("GENERAL_MANAGER"));
    await valider("VAL:FINANCES", await acteur("FINANCE_BUDGET_MANAGER"));
    await valider("REC", await acteur("GENERAL_MANAGER"));
    await valider(await circuitTravail(), superAdmin);
    // La validation marketing est REJETÉE : elle ne sera jamais servie.
    const mk = (await recetteDe("VAL:MARKETING"))!;
    expect((await rejeterVersion(responsableAdPro, mk.versions[0].id, "Circuit en cours de refonte")).ok).toBe(true);
    const marketing = JSON.parse(await outil.run({ intention: "Faire valider la campagne marketing de lancement" }, superAdmin));
    expect(marketing.statut).not.toBe("RECETTE");

    // La forme de mission d'Adam reste proposée (personne ne l'a validée) : jamais servie.
    expect((await recetteDe(`FORME:${TAG}-forme`))!.statut).toBe("PROPOSEE");
    const apres = JSON.parse(await outil.run({ intention: "Prépare une prise en charge nationale pour le congrès d'Oran, 900 000 DZD" }, superAdmin));
    expect(apres.statut).toBe("RECETTE");
    expect(apres.selon).toMatch(/selon la recette « Prise en charge nationale » \(version 2\) validée par .+ le \d{2}\/\d{2}\/\d{4}/);
    expect(apres.recette.note_du_responsable).toBe("Joindre le programme dès le dépôt.");
    // Une seconde extraction : la recette corrigée et validée reste en usage, rien n'est reproposé.
    const b = await proposerLesRecettes({ maintenant: MAINTENANT });
    expect(b.nouvellesVersions + b.creees).toBe(0);
  }, 120_000);

  it("3 · ≥ 70 % des plans tirés d'une recette acceptés sans retouche (faux modèle, demandes de référence)", async () => {
    // [demande, circuit attendu (null = aucune recette ne doit servir), écart attendu]
    const REFERENCES: [string, string | null, RegExp | null][] = [
      ["Prépare une prise en charge nationale pour 3 médecins au congrès de cardiologie d'Oran, budget 900 000 DZD", "WF:CONGRESS_NATIONAL", null],
      ["Prise en charge nationale de 12 médecins à Constantine pour 2,5 M DZD, il faut que ce soit validé sous 3 jours", "WF:CONGRESS_NATIONAL", /au-delà du seuil.*délai demandé/s],
      ["Organise la prise en charge internationale de deux pneumologues au congrès ERS à l'étranger, avec visa et billet d'avion", "WF:CONGRESS_INTERNATIONAL", null],
      ["Lance un sponsoring pour la société savante de pneumologie", "WF:SPONSORING", null],
      ["Comment on fait un parrainage d'association chez nous ? Prépare-le", "WF:SPONSORING", null],
      ["Organise une soirée symposium avec les gastro-entérologues d'Alger", "WF:EVENTS", null],
      ["Je dois faire une autre demande Ad & Pro pour des kits", "WF:OTHER", null],
      ["Dépôt du dossier d'enregistrement AMM à l'ANPP pour le daclatasvir : prépare la validation réglementaire", "VAL:REGULATORY", null],
      ["Fais valider une dépense fournisseur de 800 000 DZD aux finances", "VAL:FINANCES", /au-delà du seuil/],
      ["Recruter un délégué médical pour Sétif, CDI", "REC", null],
      ["Une validation RH pour un avenant au contrat", "VAL:RH", null],
      ["Refais le rapport mensuel des visites terrain comme d'habitude", "TRAVAIL", null],
      ["Une prise en charge de médecins nationale, ils prennent l'avion pour Tamanrasset", "WF:CONGRESS_NATIONAL", null],
      ["Prépare la demande de financement d'un staff hospitalier", "WF:EVENTS", null],
      // Témoins : aucune recette ne doit servir.
      ["Faire valider la campagne marketing de lancement", null, null],
      ["Quel temps fait-il à Alger ?", null, null],
    ];
    const travail = await circuitTravail();
    const titreDe = new Map<string, string>();
    for (const c of [...CIRCUITS_ATTENDUS, travail]) {
      const r = await prisma.recette.findUnique({ where: { circuit: c }, select: { titre: true } });
      if (r) titreDe.set(c === travail ? "TRAVAIL" : c, r.titre);
    }
    const catalogue = await PERSONA_ASSISTANT_IA.catalogue(superAdmin.id);
    const outils = [outilRecettePour(superAdmin, []), outilTravailPour(superAdmin) as unknown as PowerTool];
    let plans = 0;
    let acceptes = 0;
    let temoinsJustes = 0;
    const journal: string[] = [];
    for (const [demande, circuit, ecart] of REFERENCES) {
      const fm = fauxModeleQuiSuitLaRecette();
      const avant = new Date();
      await repondreAvecSecours({
        user: superAdmin, message: demande, historique: [], instructions: "Banc des recettes.", outils, modeles: [fm.modele as never], delaiMs: 20_000, propositionsFaites: () => 0,
      });
      const r = fm.recette();
      if (circuit === null) {
        if (!r || r.statut !== "RECETTE") temoinsJustes++;
        else journal.push(`témoin servi à tort : « ${demande} » → ${String(r.recette?.titre)}`);
        continue;
      }
      if (!r || r.statut !== "RECETTE" || !r.plan) { journal.push(`pas de plan : « ${demande} » (${r?.statut})`); plans++; continue; }
      plans++;
      expect(lirePlan(r.plan, catalogue).ok, `plan valide pour « ${demande} »`).toBe(true);
      const travailCree = await prisma.mission.findFirst({ where: { kind: "TRAVAIL", principalId: superAdmin.id, createdAt: { gte: avant, lte: new Date(Date.now() + 60_000) } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true } });
      if (travailCree && travailCree.status !== "AWAITING_APPROVAL") journal.push(`travail ${travailCree.status}`);
      // La personne simulée approuve le plan TEL QUEL s'il vient de la bonne recette et dit l'écart attendu.
      const bonneRecette = r.recette?.titre === titreDe.get(circuit);
      const ecartDit = !ecart || ecart.test((r.ecarts ?? []).join(" ; "));
      if (travailCree && bonneRecette && ecartDit) {
        const ok = await approuverTravail(travailCree.id, superAdmin.id, PERSONA_ASSISTANT_IA);
        expect(ok.ok, "erreur" in ok ? ok.erreur : "").toBe(true);
        acceptes++;
      } else {
        journal.push(`retouché : « ${demande} » → ${String(r.recette?.titre)} (attendu ${titreDe.get(circuit)}) ; écarts ${JSON.stringify(r.ecarts)}`);
      }
      expect(fm.texteFinal()).toMatch(/selon la recette/);
    }
    const taux = acceptes / plans;
    console.info(`[banc recettes] plans acceptés sans retouche : ${acceptes}/${plans} (${Math.round(taux * 100)} %) ; témoins justes ${temoinsJustes}/2${journal.length ? `\n  ${journal.join("\n  ")}` : ""}`);
    expect(taux).toBeGreaterThanOrEqual(0.7);
    expect(temoinsJustes).toBe(2);

    // Les statistiques de l'écran mesurent la même chose (usage → travail approuvé au même plan).
    const ids = (await prisma.recette.findMany({ where: { circuit: { in: [...CIRCUITS_ATTENDUS, travail] } }, select: { id: true } })).map((x) => x.id);
    const stats = [...(await statsUsages(ids)).values()];
    expect(stats.reduce((a, s) => a + s.sansRetouche, 0)).toBe(acceptes);
    const ecran = await lireEcranRecettes(superAdmin);
    const nat = ecran.recettes.find((x) => x.circuit === "WF:CONGRESS_NATIONAL")!;
    expect(nat.stats.utilisations).toBeGreaterThanOrEqual(3);
    expect(nat.validee?.decidePar).toBe(responsableAdPro.name);
  }, 300_000);

  it("4 · droits : une recette ne se montre qu'à qui voit l'écran de son circuit ; famille fermée ; contenu sans dossier ni nom ni montant", async () => {
    const roles = ["VIEWER", "MEDICAL_DELEGATE", "HEAD_OF_REGULATORY", "FINANCE_BUDGET_MANAGER", "PRODUCT_MANAGER", "GENERAL_MANAGER", "SUPER_ADMIN"];
    const hors: string[] = [];
    let vues = 0;
    for (const role of roles) {
      const u = await acteur(role);
      const ecran = await lireEcranRecettes(u);
      for (const r of ecran.recettes) {
        vues++;
        const d = decrireCircuit(r.circuit)!;
        const connus = d.modules.filter((m) => (MODULES as readonly string[]).includes(m));
        const portes = connus.length ? connus : r.circuit.startsWith("VAL:") ? ["VALIDATIONS"] : [];
        const ouvert = d.superAdminSeul ? u.role === "SUPER_ADMIN" : portes.some((m) => userCan(u, m as Module, "VIEW"));
        if (!ouvert) hors.push(`${role} voit ${r.circuit}`);
      }
      // L'assistant ne sert, à cette personne, que ce qu'elle verrait à l'écran.
      for (const demande of ["Prépare une prise en charge nationale pour le congrès d'Oran", "Recruter un délégué médical", "Dépôt d'un dossier AMM à l'ANPP"]) {
        const rep = await recettePour(u, demande);
        if (rep.statut === "RECETTE") {
          const r = await prisma.recette.findFirst({ where: { titre: String(rep.recette.titre) }, select: { circuit: true } });
          if (!r || !voitLeCircuit(u, r.circuit)) hors.push(`${role} reçoit « ${String(rep.recette.titre)} » à « ${demande} »`);
        }
      }
    }
    expect(hors).toEqual([]);
    expect(vues).toBeGreaterThan(0);
    // Le lecteur ne voit pas le recrutement ; la forme de mission d'Adam n'est qu'au Super Admin.
    const viewer = await acteur("VIEWER");
    expect(voitLeCircuit(viewer, "REC")).toBe(userCan(viewer, "RECRUITMENT", "VIEW"));
    expect((await lireEcranRecettes(await acteur("GENERAL_MANAGER"))).recettes.some((r) => r.circuit.startsWith("FORME:"))).toBe(false);

    // Une famille FERMÉE de la console retire les recettes de ses processus.
    const ferme = JSON.parse(await outilRecettePour(superAdmin, ["AD_PRO"]).run({ intention: "Prépare une prise en charge nationale pour le congrès d'Oran" }, superAdmin));
    expect(ferme.statut).toBe("AUCUNE");
    const ouvert = JSON.parse(await outilRecettePour(superAdmin, ["AD_PRO"]).run({ intention: "Recruter un délégué médical pour Sétif" }, superAdmin));
    expect(ouvert.statut).toBe("RECETTE");

    // Le contenu ne porte ni identifiant de dossier, ni nom de personne, ni montant d'un dossier.
    const versions = await prisma.recetteVersion.findMany({ where: { recette: { circuit: { in: [...CIRCUITS_ATTENDUS] } } }, select: { contenu: true, recette: { select: { circuit: true } } } });
    const tout = JSON.stringify(versions.map((v) => v.contenu));
    // Les montants cités par une recette (seuils, textes) ne sont jamais ceux de SES dossiers.
    const montantsCites = (c: ContenuRecette) => [
      ...c.seuils.map((x) => x.montant),
      ...[...JSON.stringify(c).matchAll(/(\d[\d ,]*)( M)? DZD/g)].map((m) => Math.round(Number(m[1].replace(/ /g, "").replace(",", ".")) * (m[2] ? 1_000_000 : 1))),
    ];
    const fuites = [
      ...semes.entites.filter((x) => tout.includes(x)), ...semes.validations.filter((x) => tout.includes(x)), ...semes.instances.filter((x) => tout.includes(x)),
      ...utilisateurs.map((u) => u.name).filter((x) => tout.includes(x)), ...(tout.includes(TAG) ? [TAG] : []),
      ...versions.flatMap((v) => montantsCites(v.contenu as unknown as ContenuRecette).filter((m) => (montantsDe.get(v.recette.circuit) ?? []).includes(m)).map((m) => `${v.recette.circuit} cite ${m}`)),
    ];
    expect(fuites).toEqual([]);
    // Le motif de renvoi cité ne garde ni le numéro du dossier ni son montant.
    expect(tout).toContain("Programme du congrès manquant (dossier …");
    expect(tout).not.toMatch(/dossier \d/);

    // Retirée : plus jamais servie.
    const intl = (await recetteDe("WF:CONGRESS_INTERNATIONAL"))!;
    expect((await retirerRecette(responsableAdPro, intl.versions[0].id, "Remplacée par la note de la DG")).ok).toBe(true);
    const retiree = JSON.parse(await outilRecettePour(superAdmin, []).run({ intention: "Organise la prise en charge internationale au congrès ERS à l'étranger" }, superAdmin));
    expect(retiree.statut === "RECETTE" && retiree.recette.titre === "Prise en charge internationale").toBe(false);
    const b = await proposerLesRecettes({ maintenant: MAINTENANT });
    expect(b.creees + b.nouvellesVersions).toBe(0);
    expect((await recetteDe("WF:CONGRESS_INTERNATIONAL"))!.statut).toBe("RETIREE");
  }, 120_000);
});

// ───────────────────────────── Le faux modèle qui suit la recette ─────────────────────────────

type Json = Record<string, unknown>;

/** La dernière sortie d'outil du prompt (texte JSON), relue où que l'AI SDK l'ait rangée. */
function derniereSortie(prompt: unknown): { outil: string; valeur: Json } | null {
  const messages = Array.isArray(prompt) ? (prompt as Json[]) : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    const part = (m.content as Json[]).filter((p) => p.type === "tool-result").pop();
    if (!part) continue;
    return { outil: String(part.toolName), valeur: lireJson(part.output ?? part.result) ?? {} };
  }
  return null;
}
function lireJson(v: unknown): Json | null {
  if (typeof v === "string") { try { return lireJson(JSON.parse(v)) ?? null; } catch { return null; } }
  if (v && typeof v === "object") {
    const o = v as Json;
    if ("statut" in o) return o;
    if ("value" in o) return lireJson(o.value);
  }
  return null;
}
function texteUtilisateur(prompt: unknown): string {
  const messages = Array.isArray(prompt) ? (prompt as Json[]) : [];
  const u = [...messages].reverse().find((m) => m.role === "user");
  const parts = Array.isArray(u?.content) ? (u!.content as Json[]) : [];
  return parts.filter((p) => p.type === "text").map((p) => String(p.text)).join(" ");
}

/**
 * LE FAUX MODÈLE « QUI SUIT LA RECETTE » — l'élève modèle : recette_pour avec la demande, puis, s'il y a une recette
 * validée, lancer_un_travail avec le plan rendu (titre, objectif, étapes) TEL QUEL, puis une phrase qui dit d'où il vient.
 * Aucun réseau, aucun coût ; la boucle de l'agent (Mastra), la validation des entrées et les outils tournent pour de bon.
 */
function fauxModeleQuiSuitLaRecette() {
  let recette: Json | null = null;
  let texte = "";
  let n = 0;
  const decider = (prompt: unknown): { type: "tool-call"; toolCallId: string; toolName: string; input: string } | { type: "text"; text: string } => {
    const s = derniereSortie(prompt);
    if (!s) return { type: "tool-call", toolCallId: `c${++n}`, toolName: "recette_pour", input: JSON.stringify({ intention: texteUtilisateur(prompt) }) };
    if (s.outil === "recette_pour") {
      recette = s.valeur;
      const plan = s.valeur.plan as Json | null;
      if (s.valeur.statut === "RECETTE" && plan) return { type: "tool-call", toolCallId: `c${++n}`, toolName: "lancer_un_travail", input: JSON.stringify({ titre: plan.titre, objectif: plan.objectif, etapes: plan.etapes }) };
      texte = s.valeur.statut === "RECETTE" ? `Voici comment on fait, ${String(s.valeur.selon)}.` : "Je n'ai pas de recette validée pour cela.";
      return { type: "text", text: texte };
    }
    texte = `Le plan vous attend dans « Travaux », ${String(recette?.selon ?? "")}.`;
    return { type: "text", text: texte };
  };
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  const modele = {
    specificationVersion: "v2" as const, provider: "factice", modelId: "suit-la-recette", supportedUrls: {},
    async doGenerate(o: { prompt: unknown }) {
      const d = decider(o.prompt);
      return { content: [d], finishReason: d.type === "text" ? ("stop" as const) : ("tool-calls" as const), usage, warnings: [] };
    },
    async doStream(o: { prompt: unknown }) {
      const d = decider(o.prompt);
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if (d.type === "text") parts.push({ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: d.text }, { type: "text-end", id: "t1" });
      else parts.push(d);
      parts.push({ type: "finish", finishReason: d.type === "text" ? "stop" : "tool-calls", usage });
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  return {
    modele,
    recette: () => recette as (Json & { statut: string; plan?: Json; recette?: Json; ecarts?: string[]; selon?: string }) | null,
    texteFinal: () => texte,
  };
}

// La sélection des catégories du corpus suit le moteur : une catégorie neuve dans `WORKFLOW_CATEGORIES` se sème ici.
if (WORKFLOW_CATEGORIES.length !== 5) throw new Error("banc des recettes : une catégorie Ad & Pro neuve est à semer");
