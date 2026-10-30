import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { performAction, type AssistantActionPayload } from "@/lib/assistant";
import { compileContext } from "./infra/contexte";
import { outilsV1, type PropositionPreparee } from "./infra/outils-v1";
import { repondreAvecSecours } from "./infra/repondre";
import { modeleFactice } from "./infra/testing/modele-factice";
import { effacerJournalDe } from "./infra/testing/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIMITES NON NÉGOCIABLES DE L'ASSISTANT IA — une preuve par limite, sur un rôle restreint.
 *
 * Le rôle : l'ASSISTANTE DE DIRECTION, à qui l'Assistant IA a été ouvert. Sur la vraie base de
 * test (Q17), avec le FAUX MODÈLE : il garde tout ce qu'il a reçu, donc on vérifie ce qui est
 * RÉELLEMENT entré dans le contexte du modèle — pas seulement ce qu'un filtre prétend retirer.
 *
 *   L1  l'agent ne possède que ce que la personne voit : ses outils sont ceux de son RBAC ;
 *   L2  rien de personnel d'un autre employé au-delà de l'annuaire (salaire, contrat, dossier
 *       RH, adresse, date de naissance) — l'information n'entre jamais dans le contexte ;
 *   L3  rien ne s'écrit sans confirmation explicite ;
 *   L4  le droit est revérifié au moment de l'exécution ;
 *   L5  rémunération, coordonnées bancaires et pièce d'identité ne partent jamais au modèle ;
 *   L6  la mémoire et les conversations d'un autre ne sont jamais dans son contexte.
 *
 * Toute capacité future (Ad & Pro, BC, documents, routines) s'ajoute à `outilsV1` et passe donc
 * ces mêmes preuves.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const TAG = `__limites_${Date.now()}_`;
const SALAIRE = "345678";
const IBAN = "DZ5900010002000300040005";
const NIN = "109870123456789012";
let assistante: CurrentUser;
let collegue: { id: string; name: string };
let employeId = "";

async function compte(nom: string, role: UserRole, ouvrirAssistant = false): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  if (ouvrirAssistant) await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  return relire(u.id);
}

async function relire(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

beforeAll(async () => {
  assistante = await compte("Assistante", "DIRECTION_ASSISTANT", true);
  const c = await compte("Zephyrin Collegue", "VIEWER");
  collegue = { id: c.id, name: c.name };
  const e = await prisma.employee.create({
    data: {
      fullName: `${TAG}Zephyrin Collegue`, position: "Délégué médical", email: `${TAG}zc@t.dz`,
      baseSalary: Number(SALAIRE), grossSalary: 456789, iban: IBAN, nationalId: NIN,
      contractType: "CDI", birthDate: new Date("1988-04-12"), address: "12 rue Introuvable, Hydra",
    },
  });
  employeId = e.id;
  await prisma.assistantMemoryItem.create({ data: { userId: c.id, type: "USER_PREFERENCE", content: `${TAG} préférence secrète du collègue` } });
});

afterAll(async () => {
  await effacerJournalDe([assistante?.id]);
  await prisma.assistantActionIntent.deleteMany({ where: { userId: assistante?.id } }).catch(() => {});
  await prisma.assistantMemoryItem.deleteMany({ where: { content: { startsWith: TAG } } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
});

/** Un tour complet : le faux modèle appelle `outil`, puis répond. Rend tout ce que le modèle a reçu. */
async function tour(user: CurrentUser, outil: string, entree: Record<string, unknown>) {
  const propositions: PropositionPreparee[] = [];
  const sorties: string[] = [];
  const { modele, promptsRecus } = modeleFactice([{ appel: { outil, entree } }, { texte: '{"message":"ok","components":[]}' }]);
  const { systemPrompt } = await compileContext({ user });
  await repondreAvecSecours({
    user, message: "test", historique: [], instructions: systemPrompt,
    outils: outilsV1(user, propositions, sorties), modeles: [modele], delaiMs: 20_000,
    propositionsFaites: () => propositions.length,
  });
  return { recu: JSON.stringify(promptsRecus), sorties, propositions };
}

describe("L1 — l'agent ne possède que ce que la personne voit", () => {
  it("aucun outil hors de son RBAC ne lui est offert, et un appel forcé est refusé sans rien lire", async () => {
    const offerts = outilsV1(assistante, []).filter((o) => o.allowed(assistante)).map((o) => o.def.name);
    expect(offerts).not.toContain("regulatory_portfolio");
    const { recu } = await tour(assistante, "regulatory_portfolio", {});
    expect(recu).not.toMatch(/"dossiers"|REG-\d/);
  });
});

describe("L2 + L5 — rien de personnel d'un collègue, rien de sensible au modèle", () => {
  it("chercher le collègue dans l'annuaire : nom et poste oui ; salaire, IBAN, NIN, contrat, adresse, naissance JAMAIS dans le contexte", async () => {
    const { recu, sorties } = await tour(assistante, "directory_lookup", { name: `${TAG}Zephyrin` });
    expect(sorties.join("")).toMatch(/Délégué médical/);
    for (const interdit of [SALAIRE, "456789", IBAN, NIN, "CDI", "Introuvable", "1988"]) {
      expect(recu, interdit).not.toContain(interdit);
    }
  });
});

describe("L3 + L4 — rien sans confirmation, et le droit revérifié à l'exécution", () => {
  it("un message demandé n'est qu'une intention : aucun message écrit avant confirmation", async () => {
    const { propositions } = await tour(assistante, "send_message", { recipientName: collegue.name, body: "Bonjour" });
    expect(propositions).toHaveLength(1);
    expect(await prisma.message.count({ where: { senderId: assistante.id } })).toBe(0);
    const intent = await prisma.assistantActionIntent.findUnique({ where: { id: propositions[0]!.intentId } });
    expect(intent?.status).toBe("PROPOSED");
  });

  it("le droit retiré entre la proposition et la confirmation : l'exécution refuse, rien n'est écrit", async () => {
    const { propositions } = await tour(assistante, "send_message", { recipientName: collegue.name, body: "Relance" });
    const payload = propositions[0]!.proposition.payload as AssistantActionPayload;
    await prisma.userAccess.create({ data: { userId: assistante.id, module: "MESSAGING", canView: true, canCreate: false, scope: "ASSIGNED" } });
    try {
      const sansDroit = await relire(assistante.id);
      const r = await performAction(sansDroit, payload);
      expect(r.ok).toBe(false);
      expect(await prisma.message.count({ where: { senderId: assistante.id } })).toBe(0);
    } finally {
      await prisma.userAccess.deleteMany({ where: { userId: assistante.id, module: "MESSAGING" } });
    }
  });
});

describe("L6 — la mémoire d'un autre n'entre jamais dans le contexte", () => {
  it("le contexte de l'assistante ne porte pas la mémoire du collègue", async () => {
    const { systemPrompt } = await compileContext({ user: assistante });
    expect(systemPrompt).not.toContain("préférence secrète du collègue");
  });
});
