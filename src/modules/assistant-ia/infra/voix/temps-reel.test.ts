import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { effacerJournalDe } from "../testing/journal";
import { executerOutilVocal, journaliserVoix, ouvrirVoixAssistant, OUTIL_UTILISER } from "./temps-reel";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX TEMPS RÉEL SOUS LES MÊMES DROITS QUE LE TEXTE (lot J13, décision 0025) — vraie base, fournisseur simulé.
 *
 * On tient : la session ne s'ouvre qu'avec l'Assistant IA ; elle ne porte que le socle des outils DE LA PERSONNE, plus
 * `trouver_outil` / `utiliser_outil` ; aucun nom de confirmation n'est exécutable à la voix ; une écriture rend une
 * CARTE (affichée) et la voix ne reçoit que « carte à l'écran » ; un outil hors droits est refusé en le disant ; la
 * consommation de la session est comptée au nom de la personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iavoixtr_${Date.now().toString(36)}_`;
let kam: CurrentUser;
let sansAssistant: CurrentUser;
const cleAvant = process.env.OPENAI_API_KEY;

async function compte(nom: string, assistant: boolean): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
  if (assistant) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

suite("Assistant IA — voix temps réel", () => {
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    kam = await compte("kam", true);
    sansAssistant = await compte("sans", false);
  });
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    await effacerJournalDe([kam?.id, sansAssistant?.id]);
    await prisma.assistantActionIntent.deleteMany({ where: { userId: kam?.id } });
  });

  it("la session porte le socle de SES outils, la recherche et l'appel — rien d'autre ; refusée sans l'Assistant IA", async () => {
    let corps: { session: { tools: { name: string }[]; instructions: string } } | null = null;
    const f = (async (_u: string | URL, init?: RequestInit) => { corps = JSON.parse(String(init?.body)); return Response.json({ value: "ek_banc" }); }) as typeof fetch;
    const s = await ouvrirVoixAssistant(kam, { fetchImpl: f });
    expect(s.ok).toBe(true);
    const noms = corps!.session.tools.map((t) => t.name);
    expect(noms[0]).toBe("trouver_outil");
    expect(noms.at(-1)).toBe(OUTIL_UTILISER);
    expect(noms.length).toBeLessThanOrEqual(12);
    expect(noms.some((n) => /confirm/i.test(n))).toBe(false);
    expect(corps!.session.instructions).toContain("Une valeur confidentielle n'est JAMAIS prononcée");
    expect(await ouvrirVoixAssistant(sansAssistant, { fetchImpl: f })).toMatchObject({ ok: false, statut: 403 });
  });

  it("aucune confirmation à la voix : un nom qui confirme est refusé, même par `utiliser_outil`", async () => {
    for (const [nom, args] of [["confirmer_intention", {}], [OUTIL_UTILISER, { outil: "executer_paiement" }]] as const) {
      const r = await executerOutilVocal(kam, nom, args);
      expect(JSON.parse(r.pourModele).statut).toBe("REFUS");
      expect(r.carte).toBeUndefined();
    }
  });

  it("une écriture rend une CARTE pour l'écran ; la voix n'entend que « carte à l'écran »", async () => {
    const r = await executerOutilVocal(kam, OUTIL_UTILISER, {
      outil: "terrain_compte_rendu", arguments: { medecin: "Dr Inconnu", synthese: "Visite du Dr Inconnu : intéressé par Cardiovex." },
    });
    expect(r.carte?.title).toContain("Compte rendu");
    expect(r.carte?.status).toBe("PROPOSED");
    expect(JSON.parse(r.pourModele)).toMatchObject({ statut: "CARTE_A_L_ECRAN" });
    expect(await prisma.fieldReport.count({ where: { delegateId: kam.id } })).toBe(0);
  });

  it("un outil hors des droits est refusé en le disant ; `trouver_outil` rend les schémas pour la voix", async () => {
    const hors = await executerOutilVocal(kam, OUTIL_UTILISER, { outil: "lire_paie", arguments: {} });
    expect(JSON.parse(hors.pourModele).statut).toBe("REFUS");
    const t = JSON.parse((await executerOutilVocal(kam, "trouver_outil", { intention: "préparer le compte rendu de ma visite médicale" })).pourModele);
    expect(t.trouves.map((x: { outil: string }) => x.outil)).toContain("terrain_compte_rendu");
    expect(t.schemas.terrain_compte_rendu.properties.synthese).toBeTruthy();
  });

  it("la consommation de la session est comptée au nom de la personne", async () => {
    await journaliserVoix(kam, { entree: 1200, sortie: 300, latences: [900, 1100], dureeMs: 60_000 });
    const l = await prisma.modelCallLog.findFirst({ where: { userId: kam.id, provider: "openai-realtime" }, select: { inputTokens: true, outputTokens: true } });
    expect(l).toMatchObject({ inputTokens: 1200, outputTokens: 300 });
  });
});
