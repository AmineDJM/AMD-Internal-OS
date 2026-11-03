import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { viderCacheDictionnaire } from "@/lib/fabric";
import { capacitesPour, domaineDe, enqueter, resumerSituation } from "@/platform/in-process/missions/situation";

/**
 * L'ENQUÊTEUR, par l'entrée réelle : un produit semé avec un blocage et un responsable, une
 * demande vague qui ne nomme que la DCI — la situation doit porter le statut, le responsable,
 * le domaine réglementaire et les capacités qui vont avec. Et une personne sans le module
 * Regulatory ne doit PAS voir le statut du produit dans sa situation.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `enq${Date.now().toString(36)}`;
const DCI = `Zorbamyxine${TAG}`;
let pdg: CurrentUser;
let delegue: CurrentUser;
let companyId = "";

async function compte(email: string, name: string, role: "SUPER_ADMIN" | "MEDICAL_DELEGATE"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name, email, passwordHash: "x", role }, select: { id: true, name: true, email: true, role: true } });
  return { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
}

suite("enquête — la situation d'une demande vague est établie par le code, sous droits", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    pdg = await compte(`${TAG}pdg@amd.dz`, `${TAG} PDG`, "SUPER_ADMIN");
    delegue = await compte(`${TAG}del@amd.dz`, `${TAG} Déléguée`, "MEDICAL_DELEGATE");
    const resp = await prisma.user.create({ data: { name: `Raihana ${TAG}`, email: `${TAG}resp@amd.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" }, select: { id: true } });
    await prisma.regulatoryProduct.create({
      data: {
        reference: `REG-${TAG}`, dci: DCI, brandName: `Zorbex ${TAG}`, status: "BLOCKED", partnerLab: `Hetero ${TAG}`,
        responsibleId: resp.id, companyId,
      } as never,
    });
    viderCacheDictionnaire();
  }, 120_000);

  afterAll(async () => {
    await prisma.regulatoryProduct.deleteMany({ where: { dci: DCI } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    viderCacheDictionnaire();
  }, 120_000);

  it("le dirigeant : le produit est reconnu par sa DCI, la situation porte statut, responsable, domaine et capacités", async () => {
    const s = await enqueter(pdg, `Occupe-toi du dossier ${DCI} et fais avancer le projet aussi vite que possible.`, { delaiMs: 20_000 });
    expect(s).not.toBeNull();
    const produit = s!.entites.find((e) => e.type === "PRODUIT");
    expect(produit?.ref).toBe(`REG-${TAG}`);
    expect(produit?.domaine).toBe("REGULATORY");
    const fiche = s!.faits.find((f) => f.source === "ERP:RegulatoryProduct");
    expect(fiche?.texte).toContain("statut BLOCKED");
    expect(fiche?.texte).toContain(`Raihana ${TAG}`);
    expect(s!.acteurs.some((a) => a.startsWith(`Raihana ${TAG}`))).toBe(true);
    expect(s!.domaines).toContain("REGULATORY");
    expect(s!.capacitesSuggerees).toContain("regulatory_operation");
    expect(s!.capacitesSuggerees).toContain("inspect_record");
    expect(s!.couverture.sources).toContain("dictionnaire");
    expect(resumerSituation(s!)).toMatch(/Enquête : \d+ entité/);
  }, 60_000);

  it("une déléguée sans le module Regulatory : le nom est reconnu, le statut ne lui est PAS révélé", async () => {
    const s = await enqueter(delegue, `Occupe-toi du dossier ${DCI}.`, { delaiMs: 20_000 });
    // La situation peut exister (recherche, documents) mais aucun fait ERP:RegulatoryProduct ne sort.
    expect(s?.faits.some((f) => f.source === "ERP:RegulatoryProduct") ?? false).toBe(false);
    expect(s?.faits.some((f) => f.texte.includes("statut BLOCKED")) ?? false).toBe(false);
  }, 60_000);

  it("une demande sans entité connue rend une situation sans faits ERP, ou null — jamais une invention", async () => {
    const s = await enqueter(pdg, "Prépare une note sur le climat social en général.", { delaiMs: 15_000 });
    if (s) {
      expect(s.entites.filter((e) => e.type === "PRODUIT")).toHaveLength(0);
      expect(s.faits.every((f) => f.source !== "ERP:RegulatoryProduct")).toBe(true);
    }
  }, 60_000);
});

describe("enquête — les tables pures", () => {
  it("domaineDe classe les familles de la recherche et les types d'entité", () => {
    expect(domaineDe("Factures")).toBe("FINANCE");
    expect(domaineDe("Courriers")).toBe("MAIL");
    expect(domaineDe("Legal")).toBe("LEGAL");
    expect(domaineDe("Appel d'offres PCH")).toBe("REGULATORY");
    expect(domaineDe("Calendrier")).toBe("CALENDAR");
    expect(domaineDe("Personnes")).toBe("HR");
    expect(domaineDe("Inconnu")).toBe("GENERAL");
  });
  it("capacitesPour rend le socle puis les capacités des domaines, sans doublon, sous plafond", () => {
    const caps = capacitesPour(["REGULATORY", "MAIL"]);
    expect(caps[0]).toBe("search_everything");
    expect(caps).toContain("regulatory_operation");
    expect(caps).toContain("gmail_prepare_mail");
    expect(new Set(caps).size).toBe(caps.length);
    expect(capacitesPour(["REGULATORY", "MAIL", "FINANCE", "LEGAL", "CALENDAR"], 12)).toHaveLength(12);
  });
});
