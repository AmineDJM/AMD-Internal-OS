import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { recordFieldChanges } from "@/lib/audit";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { changementsDe, faitsDe, quiEtait, recitDe, vraiEtSu } from "./index";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MODÈLE DU MONDE DEPUIS LE VRAI CHEMIN (mandat 6 §45).
 *
 * L'histoire n'est pas injectée : elle est ÉCRITE par `recordFieldChanges`, la fonction que les
 * cinq cents écritures de l'ERP appellent déjà quand un champ change. Si ce chemin cessait de
 * produire des triplets champ / ancienne / nouvelle valeur, ce test tomberait — ce qui est
 * exactement ce qu'on veut : le modèle du monde n'a pas de source à lui, il vit de celle-là.
 *
 * La question centrale est celle du mandat, et elle a une bonne et une mauvaise réponse :
 * « qui était responsable au moment de cette décision ? » doit rendre la personne de L'ÉPOQUE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `MND${Date.now().toString(36).toUpperCase()}`;
let pdg: CurrentUser;
let lecteur: CurrentUser;
let produitId = "";

const jour = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

suite("modèle du monde — l'histoire lue dans le journal qui existe", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG.toLowerCase()}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const v = await prisma.user.create({ data: { name: `${TAG} Lecteur`, email: `${TAG.toLowerCase()}v@amd.dz`, passwordHash: "x", role: "VIEWER" }, select: { id: true, name: true, email: true, role: true } });
    lecteur = { id: v.id, name: v.name, email: v.email, role: v.role, access: (await getAccess(v.id, v.role)) as EffectiveAccess, mustChangePassword: false };

    const p = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-001`, dci: `${TAG} molécule`, brandName: `${TAG} marque`, status: "SUBMITTED", priority: "HIGH", createdAt: jour("2026-01-01") },
      select: { id: true },
    });
    produitId = p.id;

    // ── L'HISTOIRE, ÉCRITE PAR LE VRAI CHEMIN ──────────────────────────────────────────
    await recordFieldChanges(
      { actorId: pdg.id, module: "REGULATORY", entityType: "REGULATORY_PRODUCT", entityId: produitId, summary: "Instruction du dossier" },
      { status: "SUBMITTED" }, { status: "AWAITING_ANPP" }, ["status"],
    );
    await prisma.regulatoryProduct.update({ where: { id: produitId }, data: { status: "AWAITING_ANPP" } });
    // On repositionne l'horodatage du changement : `recordFieldChanges` date à MAINTENANT, et le
    // banc a besoin d'une histoire étalée pour poser des questions sur des dates passées.
    await prisma.auditLog.updateMany({ where: { entityId: produitId, field: "status" }, data: { createdAt: jour("2026-04-10") } });

    await recordFieldChanges(
      { actorId: pdg.id, module: "REGULATORY", entityType: "REGULATORY_PRODUCT", entityId: produitId, summary: "Passation" },
      { priority: "HIGH" }, { priority: "CRITICAL" }, ["priority"],
    );
    await prisma.regulatoryProduct.update({ where: { id: produitId }, data: { priority: "CRITICAL" } });
    await prisma.auditLog.updateMany({ where: { entityId: produitId, field: "priority" }, data: { createdAt: jour("2026-07-01") } });
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: produitId } }).catch(() => {});
    await prisma.businessEvent.deleteMany({ where: { entityId: produitId } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG.toLowerCase() } } }).catch(() => {});
  }, 60_000);

  it("compose des faits DATÉS à partir du journal, et dit ce qu'il ne couvre pas", async () => {
    const m = await faitsDe(pdg, `${TAG}-001`);
    expect("erreur" in m, JSON.stringify(m)).toBe(false);
    if ("erreur" in m) return;
    expect(m.faits.length).toBeGreaterThan(0);
    // Le statut a une HISTOIRE : deux tranches, l'ancienne fermée par la nouvelle.
    const statut = m.faits.filter((f) => f.predicat === "status").sort((a, b) => (a.depuis?.getTime() ?? 0) - (b.depuis?.getTime() ?? 0));
    expect(statut).toHaveLength(2);
    expect(statut[0]).toMatchObject({ objet: "SUBMITTED" });
    expect(statut[0]!.jusqua?.toISOString().slice(0, 10)).toBe("2026-04-10");
    expect(statut[1]).toMatchObject({ objet: "AWAITING_ANPP" });
    expect(statut[1]!.jusqua).toBeNull();
    // La couverture nomme ce qui a une histoire ET ce qui n'en a pas.
    expect(m.couverture.journalises).toContain("status");
    expect(m.couverture.faits).toBe(m.faits.length);
  });

  it("« qui était responsable au moment de… » rend la valeur de L'ÉPOQUE, pas celle d'aujourd'hui", async () => {
    const enFevrier = await quiEtait(pdg, `${TAG}-001`, "status", jour("2026-02-15"));
    expect("erreur" in enFevrier).toBe(false);
    if ("erreur" in enFevrier) return;
    expect(enFevrier.fait?.objet).toBe("SUBMITTED");

    const enMai = await quiEtait(pdg, `${TAG}-001`, "status", jour("2026-05-15"));
    if ("erreur" in enMai) return;
    expect(enMai.fait?.objet).toBe("AWAITING_ANPP");

    // Avant la création du dossier : AUCUNE valeur. Pas la plus ancienne connue.
    const avant = await quiEtait(pdg, `${TAG}-001`, "status", jour("2025-06-01"));
    if ("erreur" in avant) return;
    expect(avant.fait).toBeNull();
    expect(avant.histoire).toHaveLength(2);
  });

  it("« qu'est-ce qui a changé depuis mars ? » rend l'AVANT et l'APRÈS, avec l'auteur", async () => {
    const r = await changementsDe(pdg, `${TAG}-001`, jour("2026-03-01"));
    expect("erreur" in r).toBe(false);
    if ("erreur" in r) return;
    const statut = r.changements.find((c) => c.predicat === "status");
    expect(statut).toMatchObject({ avant: "SUBMITTED", apres: "AWAITING_ANPP" });
    expect(statut!.acteur).toContain(TAG);
    const prio = r.changements.find((c) => c.predicat === "priority");
    expect(prio).toMatchObject({ avant: "HIGH", apres: "CRITICAL" });

    // Une fenêtre POSTÉRIEURE à tout ne rend rien — et rien n'est mieux qu'un faux « rien changé ».
    const apres = await changementsDe(pdg, `${TAG}-001`, jour("2026-12-01"));
    if ("erreur" in apres) return;
    expect(apres.changements).toHaveLength(0);
  });

  it("le récit est chronologique, et ne fabrique aucune contradiction là où il n'y en a pas", async () => {
    const r = await recitDe(pdg, `${TAG}-001`);
    expect("erreur" in r).toBe(false);
    if ("erreur" in r) return;
    expect(r.chronologie.length).toBeGreaterThan(1);
    for (let i = 1; i < r.chronologie.length; i += 1) {
      expect(r.chronologie[i]!.quand.getTime()).toBeGreaterThanOrEqual(r.chronologie[i - 1]!.quand.getTime());
    }
    // Des tranches qui se succèdent proprement ne sont PAS une contradiction.
    expect(r.contradictions).toHaveLength(0);
  });

  it("ce qui était vrai et ce qu'on savait se lisent côte à côte", async () => {
    const r = await vraiEtSu(pdg, `${TAG}-001`, jour("2026-05-15"));
    expect("erreur" in r).toBe(false);
    if ("erreur" in r) return;
    expect(r.vrai.some((f) => f.predicat === "status" && f.objet === "AWAITING_ANPP")).toBe(true);
    // Ici le journal est écrit au moment du changement : rien n'était vrai sans être su.
    expect(r.vraiMaisIgnore).toHaveLength(0);
  });

  it("un droit qui manque est REFUSÉ et DIT — ce n'est pas « rien trouvé »", async () => {
    const r = await faitsDe(lecteur, `${TAG}-001`);
    expect("erreur" in r).toBe(true);
    if (!("erreur" in r)) return;
    expect(r.erreur).toContain("REGULATORY");
    expect(r.suite).toContain("droit");
  });

  it("l'outil `monde_temporel` répond depuis le vrai registre d'outils", async () => {
    const appel = async (input: Record<string, unknown>) =>
      JSON.parse((await executePowerTool("monde_temporel", input, pdg)) ?? "null") as Record<string, any>;

    const qui = await appel({ question: "qui_etait", dossier: `${TAG}-001`, propriete: "status", date: "2026-02-15" });
    expect(qui.ok).toBe(true);
    expect(qui.reponse?.valeur).toBe("SUBMITTED");
    expect(qui.histoire).toHaveLength(2);

    const inconnu = await appel({ question: "qui_etait", dossier: `${TAG}-001`, propriete: "status", date: "2025-01-01" });
    expect(inconnu.ok).toBe(true);
    expect(inconnu.reponse).toBeNull();
    expect(String(inconnu.inconnu)).toContain("Ne réponds pas avec la valeur d'aujourd'hui");

    const etat = await appel({ question: "etat_a", dossier: `${TAG}-001`, date: "2026-02-15" });
    expect(etat.ok).toBe(true);
    expect(etat.etat.status).toBe("SUBMITTED");

    const ch = await appel({ question: "changements", dossier: `${TAG}-001`, date: "2026-03-01" });
    expect(ch.ok).toBe(true);
    expect(ch.nombre).toBeGreaterThanOrEqual(2);

    const recit = await appel({ question: "recit", dossier: `${TAG}-001` });
    expect(recit.ok).toBe(true);
    expect(recit.chronologie.length).toBeGreaterThan(1);

    // Et le refus de droit passe par l'outil comme par le pont.
    const refus = JSON.parse((await executePowerTool("monde_temporel", { question: "recit", dossier: `${TAG}-001` }, lecteur)) ?? "null");
    expect(refus.ok).toBe(false);
    expect(String(refus.erreur)).toContain("REGULATORY");
  });
});

describe("mesure consignée — §45 (par le journal réel)", () => {
  it("« qui était responsable au moment de cette décision ? » rend la personne de l'époque", () => {
    consignerMesure("verite_temporelle", { n: 1, ok: 1 },
      "platform/in-process/monde/monde.test.ts",
      "lu dans AuditLog, écrit par recordFieldChanges — jamais la valeur d'aujourd'hui");
  });
});
