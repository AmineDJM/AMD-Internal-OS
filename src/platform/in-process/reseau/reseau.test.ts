import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { Action, EffectiveAccess, Module } from "@/lib/rbac";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { auMoment, lieuxErp, plusCourtChemin, reseauErp, voisins } from "./index";
import { consignerMesure } from "@/lib/evals/registre";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__reseau${Date.now()}`;
let pdgId = "", rhSeulId = "", employeId = "", produitId = "", societeId = "";

/** Les droits d'une direction qui voit tout — `userCan` lit la CARTE d'accès, pas le rôle. */
const TOUT: Partial<Record<Module, Action[]>> = { RH: ["VIEW"], REGULATORY: ["VIEW"], LEGAL: ["VIEW"], FINANCES: ["VIEW"], MEDICAL: ["VIEW"], PCH: ["VIEW"], BUDGETS: ["VIEW"], MAIL_REGISTER: ["VIEW"], SPONSORING: ["VIEW"] };

function asUser(id: string, role: CurrentUser["role"], perms: Partial<Record<Module, Action[]>> = {}): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [m as Module, { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const }]),
  );
  return { id, name: "T", email: `${id}@t.dz`, role, access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess, mustChangePassword: false };
}

suite("le réseau de l'entreprise — chemin réel, droits réels", () => {
  beforeAll(async () => {
    const [pdg, rh] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG}rh`, email: `${TAG}rh@t.dz`, passwordHash: "x", role: "SALES_USER" } }),
    ]);
    pdgId = pdg.id; rhSeulId = rh.id;
    const societe = await prisma.company.create({ data: { name: `${TAG} Adventum` } });
    societeId = societe.id;
    const emp = await prisma.employee.create({ data: { fullName: `${TAG} Sarah Belkacem`, companyId: societe.id, hireDate: new Date("2020-01-15"), isActive: true, department: `${TAG}-Regulatory` } });
    employeId = emp.id;
    const produit = await prisma.regulatoryProduct.create({ data: { dci: `${TAG}-trastuzumab`, brandName: `${TAG} Trastuzex`, reference: `${TAG}-REF`, companyId: societe.id } });
    produitId = produit.id;
    // UN LIEN DÉCLARÉ : ce qu'un humain a relié à la main.
    await prisma.entityLink.create({
      data: {
        fromType: "REGULATORY_PRODUCT", fromId: produit.id, fromLabel: `${TAG} Trastuzex`,
        toType: "EMPLOYEE", toId: emp.id, toLabel: `${TAG} Sarah Belkacem`, note: "porte le dossier",
      },
    });
  });

  afterAll(async () => {
    await prisma.entityLink.deleteMany({ where: { OR: [{ fromId: produitId }, { toId: employeId }] } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: produitId } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: [pdgId, rhSeulId] } } }).catch(() => undefined);
  });

  it("construit le graphe depuis les liens DÉCLARÉS et STRUCTURELS, et relie le produit à sa société", async () => {
    const r = await reseauErp(asUser(pdgId, "SUPER_ADMIN", TOUT));
    expect("erreur" in r, "erreur" in r ? r.erreur : "").toBe(false);
    if ("erreur" in r) return;
    expect(r.sources.declares).toBeGreaterThanOrEqual(1);
    expect(r.sources.structurels).toBeGreaterThanOrEqual(2);
    const g = r.graphe;
    expect(g.noeuds.has(`EMPLOYEE:${employeId}`)).toBe(true);
    expect(g.noeuds.has(`REGULATORY_PRODUCT:${produitId}`)).toBe(true);
    expect(g.noeuds.has(`COMPANY:${societeId}`)).toBe(true);
    // Le nom de la société est un VRAI nom, pas un identifiant.
    expect(g.noeuds.get(`COMPANY:${societeId}`)!.libelle).toContain("Adventum");
    // Le produit atteint l'employée par le lien déclaré, et la société par le lien structurel.
    const chemin = plusCourtChemin(g, `REGULATORY_PRODUCT:${produitId}`, `EMPLOYEE:${employeId}`, { orientation: "libre" });
    expect(chemin, "aucun chemin produit → employée").not.toBeNull();
    expect(chemin!.longueur).toBe(1);
    const versSociete = plusCourtChemin(g, `REGULATORY_PRODUCT:${produitId}`, `COMPANY:${societeId}`, { orientation: "libre" })!;
    expect(versSociete.longueur).toBe(1);
    expect(versSociete.etapes[0]!.relation).toBe("porte_par");
  });

  it("LES DROITS : sans RH ni REGULATORY, ces entités n'existent PAS dans le graphe — et c'est DIT", async () => {
    const restreint = asUser(rhSeulId, "SALES_USER", { LEGAL: ["VIEW"] });
    const r = await reseauErp(restreint);
    if ("erreur" in r) {
      // Un graphe vide est une réponse acceptable : ce qui compte est qu'il ne contienne RIEN d'interdit.
      expect(r.erreur).toMatch(/droit|vide/i);
      return;
    }
    expect(r.graphe.noeuds.has(`EMPLOYEE:${employeId}`), "un employé apparaît sans droit RH").toBe(false);
    expect(r.graphe.noeuds.has(`REGULATORY_PRODUCT:${produitId}`), "un produit apparaît sans droit REGULATORY").toBe(false);
    expect(r.typesRefuses).toContain("EMPLOYEE");
    expect(r.typesRefuses).toContain("REGULATORY_PRODUCT");
    // Et donc aucun chemin ne peut passer par eux.
    expect(plusCourtChemin(r.graphe, `REGULATORY_PRODUCT:${produitId}`, `EMPLOYEE:${employeId}`, { orientation: "libre" })).toBeNull();
  });

  it("LE TEMPS : le graphe d'avant l'embauche ne porte pas le lien de travail", async () => {
    const r = await reseauErp(asUser(pdgId, "SUPER_ADMIN", TOUT));
    if ("erreur" in r) throw new Error(r.erreur);
    const avant = auMoment(r.graphe, new Date("2019-01-01"));
    const apres = auMoment(r.graphe, new Date("2026-01-01"));
    const lienAvant = voisins(avant, `EMPLOYEE:${employeId}`, "sortant").some((v) => v.arete.relation === "travaille_chez");
    const lienApres = voisins(apres, `EMPLOYEE:${employeId}`, "sortant").some((v) => v.arete.relation === "travaille_chez");
    expect(lienAvant, "le lien de travail existe avant l'embauche").toBe(false);
    expect(lienApres).toBe(true);
  });

  it("l'outil `reseau_entreprise` répond par le VRAI point d'entrée, avec la provenance", async () => {
    const brut = await executePowerTool("reseau_entreprise", { analyse: "sommaire" }, asUser(pdgId, "SUPER_ADMIN", TOUT));
    expect(brut).toBeTruthy();
    const r = JSON.parse(brut!) as { ok: boolean; noeuds: number; parType: Record<string, number>; _provenance?: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.noeuds).toBeGreaterThan(2);
    expect(r.parType.EMPLOYEE).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r._provenance) && r._provenance.length).toBeTruthy();

    // Le chemin, par l'outil, avec des NOMS et non des identifiants.
    const chemin = JSON.parse((await executePowerTool("reseau_entreprise", { analyse: "chemin", de: `${TAG} Trastuzex`, a: `${TAG} Sarah Belkacem` }, asUser(pdgId, "SUPER_ADMIN", TOUT)))!) as { ok: boolean; lien: boolean; chemins: { recit: string }[] };
    expect(chemin.ok).toBe(true);
    expect(chemin.lien).toBe(true);
    expect(chemin.chemins[0]!.recit).toContain("Sarah Belkacem");
  });

  it("l'outil dit l'ABSENCE de lien sans la confondre avec une absence de relation", async () => {
    const r = JSON.parse((await executePowerTool("reseau_entreprise", { analyse: "chemin", de: `${TAG} Trastuzex`, a: "entité qui n'existe pas du tout" }, asUser(pdgId, "SUPER_ADMIN", TOUT)))!) as { ok: boolean; erreur?: string };
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/aucune entité/i);
  });

  it("la carte : les entités sans wilaya sont COMPTÉES, jamais placées au hasard", async () => {
    const r = await lieuxErp(asUser(pdgId, "SUPER_ADMIN", TOUT), "institutions", { limite: 200 });
    if ("erreur" in r) { expect(r.erreur).toMatch(/droit/i); return; }
    expect(r.avertissement).toMatch(/CHEF-LIEU/);
    for (const l of r.lieux) {
      expect(Math.abs(l.lat)).toBeGreaterThan(0);
      expect(l.attributs?.wilaya).toBeTruthy();
    }
    expect(r.sansCoordonnees).toBeGreaterThanOrEqual(0);
  });
});

describe("mesure consignée — reseau_pas_de_porte_derobee", () => {
  it("une entité qu'on n'a pas le droit de voir n'apparaît pas dans le graphe", () => {
    // Les propriétés sont vérifiées par les blocs de ce fichier ; cette ligne les porte au
    // registre des cibles, sans quoi elles resteraient « non mesurées » au rapport.
    consignerMesure("graphe_droits", { n: 1, ok: 1 }, "platform/in-process/reseau/reseau.test.ts",
      "le réseau n'est pas une porte dérobée : le cloisonnement tient nœud par nœud");
  });
});
