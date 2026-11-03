import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { executePowerTool } from "@/lib/assistant/power-tools";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL DE VÉRITÉ, DEPUIS LE VRAI REGISTRE (mandat 6 §46).
 *
 * Les questions ouvertes et les hypothèses ne sont pas une table nouvelle : ce sont des lectures
 * du registre des décisions, écrit par `record_decision`. Ce test les crée par ce chemin-là — si
 * la forme du registre change, il tombe, ce qui est exactement le lien qu'on veut.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `VER${Date.now().toString(36).toUpperCase()}`;
let pdg: CurrentUser;

const appel = async (input: Record<string, unknown>, u?: CurrentUser): Promise<Record<string, any>> =>
  JSON.parse((await executePowerTool("verite_reconcilier", input, u ?? pdg)) ?? "null");

suite("verite_reconcilier — réconcilier, tracer, et ne jamais choisir au hasard", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG.toLowerCase()}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };

    // Une QUESTION OUVERTE et une HYPOTHÈSE, écrites par le vrai outil du registre.
    await executePowerTool("record_decision", {
      title: `${TAG} Choix du façonnier`, status: "PROPOSED",
      problem: "Faut-il rester chez le façonnier actuel ou lancer un appel d'offres ?",
      options: ["Rester", "Appel d'offres"],
    }, pdg);
    await executePowerTool("record_decision", {
      title: `${TAG} Passage au conditionnement local`, status: "DECIDED",
      expected_outcome: "−12 % sur le coût unitaire d'ici décembre",
      review_on: "2026-08-01",
    }, pdg);
  }, 60_000);

  afterAll(async () => {
    await prisma.executiveDecision.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG.toLowerCase() } } }).catch(() => {});
  }, 60_000);

  it("l'ERP, le classeur et l'e-mail : le moteur tranche AVEC sa raison", async () => {
    const r = await appel({
      question: "reconcilier", fait: "chiffre d'affaires 2026",
      valeurs: [
        { valeur: "15000000", source: "ERP Finance", nature: "ERP", arrete_le: "2026-07-31" },
        { valeur: "17000000", source: "classeur budget", nature: "TABLEUR", arrete_le: "2026-07-31" },
        { valeur: "16500000", source: "e-mail de Khaled", nature: "EMAIL", arrete_le: "2026-07-31" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.issue).toBe("RESOLUE");
    expect(r.detail.retenue.source.nature).toBe("ERP");
    expect(r.phrase).toContain("autorité");
    // Les valeurs écartées sont NOMMÉES avec leur pourquoi — pas silencieusement jetées.
    expect(r.detail.ecartees).toHaveLength(2);
    expect(r.a_faire).toContain("jamais le chiffre seul");
    // Et la moyenne des trois n'apparaît nulle part.
    expect(JSON.stringify(r)).not.toContain("16166");
  });

  it("HT contre TTC : « pas la même question », et Adam reçoit la consigne de ne pas parler de contradiction", async () => {
    const r = await appel({
      question: "reconcilier", fait: "chiffre d'affaires 2026",
      valeurs: [
        { valeur: "15000000", source: "ERP Finance", nature: "ERP", contexte: "HT" },
        { valeur: "17850000", source: "classeur", nature: "TABLEUR", contexte: "TTC" },
      ],
    });
    expect(r.issue).toBe("PAS_LA_MEME_QUESTION");
    expect(r.a_faire).toContain("Ne dis pas qu'il y a contradiction");
  });

  it("une clause contractuelle INVERSE l'autorité : le document signé prime sur l'ERP", async () => {
    const r = await appel({
      question: "reconcilier", fait: "préavis du contrat Hetero", type_de_fait: "clause_contractuelle",
      valeurs: [
        { valeur: "préavis 30 jours", source: "fiche ERP", nature: "ERP" },
        { valeur: "préavis 90 jours", source: "contrat signé du 12/03", nature: "DOCUMENT_SIGNE" },
      ],
    });
    expect(r.issue).toBe("RESOLUE");
    expect(r.detail.retenue.valeur).toContain("90");
  });

  it("quand rien ne départage, il dit QUOI CHERCHER et interdit de donner un chiffre", async () => {
    const r = await appel({
      question: "reconcilier", fait: "coût du lot",
      valeurs: [
        { valeur: "17000000", source: "classeur A", nature: "TABLEUR", arrete_le: "2026-06-01" },
        { valeur: "18200000", source: "classeur B", nature: "TABLEUR", arrete_le: "2026-06-01" },
      ],
    });
    expect(r.issue).toBe("A_CHERCHER");
    expect(r.detail.quoiChercher.join(" ")).toContain("périmètre");
    expect(r.a_faire).toContain("Ne donne PAS de chiffre");
  });

  it("la lignée raconte la fabrication du chiffre, et refuse ce qui ne remonte à rien", async () => {
    const bonne = await appel({
      question: "lignee",
      etapes: [
        { id: "s1", nature: "SOURCE", libelle: "export Adventum", lignes_sortantes: 12400 },
        { id: "s2", nature: "SOURCE", libelle: "export Pharmagène", lignes_sortantes: 8900 },
        { id: "n1", nature: "NETTOYAGE", libelle: "doublons supprimés", entrees: ["s1", "s2"], lignes_entrantes: 21300, lignes_sortantes: 20080, perte: "1 220 doublons de facture" },
        { id: "t1", nature: "TRANSFORMATION", libelle: "conversion DZD → USD", entrees: ["n1"] },
        { id: "r", nature: "RESULTAT", libelle: "CA consolidé", entrees: ["t1"], valeur: "41,3 M$" },
      ],
    });
    expect(bonne.ok).toBe(true);
    expect(bonne.prouve).toBe(true);
    expect(bonne.phrase).toContain("41,3 M$");
    expect(bonne.phrase).toContain("2 sources");
    expect(bonne.phrase).toContain("doublons supprimés");

    const orpheline = await appel({
      question: "lignee",
      etapes: [{ id: "r", nature: "RESULTAT", libelle: "total", entrees: [], valeur: "41,3 M$" }],
    });
    expect(orpheline.prouve).toBe(false);
    expect(orpheline.avertissement).toContain("ne PROUVE pas");
  });

  it("les questions ouvertes et les hypothèses à rejuger se LISENT au registre des décisions", async () => {
    const r = await appel({ question: "ouvertes" });
    expect(r.ok).toBe(true);
    const q = r.questions_ouvertes.find((x: any) => String(x.titre).includes(TAG));
    expect(q, JSON.stringify(r.questions_ouvertes).slice(0, 300)).toBeTruthy();
    expect(q.question).toContain("appel d'offres");
    expect(q.options).toHaveLength(2);

    const h = r.hypotheses_a_rejuger.find((x: any) => String(x.decision).includes(TAG));
    expect(h).toBeTruthy();
    expect(h.attendu).toContain("−12 %");
    expect(h.echue).toBe(true);
    expect(r.lecture).toContain("update_decision_outcome");
  });

  it("le registre des décisions reste réservé à la direction", async () => {
    const v = await prisma.user.create({ data: { name: `${TAG} V`, email: `${TAG.toLowerCase()}v@amd.dz`, passwordHash: "x", role: "VIEWER" }, select: { id: true, name: true, email: true, role: true } });
    const lecteur: CurrentUser = { id: v.id, name: v.name, email: v.email, role: v.role, access: (await getAccess(v.id, v.role)) as EffectiveAccess, mustChangePassword: false };
    const r = await appel({ question: "ouvertes" }, lecteur);
    expect(r.ok).toBe(false);
    expect(r.erreur).toContain("direction");
    // …mais la réconciliation, qui ne lit rien, lui reste ouverte : elle raisonne sur ce qu'IL a lu.
    const rec = await appel({ question: "reconcilier", valeurs: [{ valeur: "1", source: "a", nature: "ERP" }] }, lecteur);
    expect(rec.ok).toBe(true);
  });
});
