import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { deposerMessage, nouvelleConversation, traiterFil } from "./service";
import { effacerJournalDe } from "../testing/journal";
import { Budget } from "../consommation";
import { REGLAGES_PAR_DEFAUT } from "../../domaine/consommation-regles";
import { SEUIL_TEXTE_EN_PIECE, jetonsDuTexte } from "../../domaine/fil/texte-long";

/**
 * Direction (02/11/2026) : « enlève la limite : quand j'envoie des textes trop longs, ça les coupe ». Un message n'est
 * jamais coupé : 60 000 caractères arrivent ENTIERS au modèle ; 600 000 deviennent une pièce, déposée en entier et dite.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__textelong_${Date.now().toString(36)}_`;
let moi: CurrentUser;

/** Un texte long, différent d'un bout à l'autre (la fin se reconnaît). */
const texte = (n: number) => Array.from({ length: Math.ceil(n / 60) }, (_, i) => `Paragraphe ${i} du compte rendu de la réunion de direction. `).join("").slice(0, n - 20) + " FIN-DU-TEXTE-ENTIER";

describe("le plafond par tour compte la boucle, pas le message de la personne", () => {
  it("un long message renvoyé à chaque étape ne déclenche pas le garde-fou ; une boucle d'outils, si", () => {
    const b = new Budget("u", "fil", null, { ...REGLAGES_PAR_DEFAUT, plafondJetonsJour: 0, plafondJetonsTour: 150_000 }, 0);
    b.franchiseParAppel = jetonsDuTexte(texte(60_000));
    const etape = (entree: number) => ({ provider: "openai", model: "x", entree, sortie: 300, cache: 0, raisonnement: 0, ms: 1 });
    for (let i = 0; i < 8; i++) b.enregistrer(etape(b.franchiseParAppel + 9_000));
    expect(b.consomme).toBeGreaterThan(150_000);
    expect(b.depasse).toBe(false);
    const boucle = new Budget("u", "fil", null, { ...REGLAGES_PAR_DEFAUT, plafondJetonsTour: 150_000 }, 0);
    for (let i = 0; i < 12; i++) boucle.enregistrer(etape(14_000));
    expect(boucle.depasse).toBe(true);
  });
});

suite("un texte long n'est jamais coupé", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    const access = await getAccess(u.id, u.role);
    moi = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    await effacerJournalDe([moi.id]);
    await prisma.assistantIaFil.deleteMany({ where: { userId: moi.id } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: moi.id } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: moi.id } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: moi.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("60 000 caractères arrivent ENTIERS au modèle", async () => {
    const faux = modeleFactice([{ texte: JSON.stringify({ message: "Lu en entier.", components: [] }) }]);
    remplacerModelesPourTests([faux.modele as never]);
    await nouvelleConversation(moi.id);
    const t = texte(60_000);
    const d = await deposerMessage(moi.id, t, []);
    expect(d.ok && d.tour.contenu.length).toBe(t.length);
    await traiterFil(moi.id);
    const recu = faux.promptsRecus.map((p) => JSON.stringify(p)).find((p) => p.includes("Paragraphe 0 du compte rendu")) ?? "";
    expect(recu).toContain("FIN-DU-TEXTE-ENTIER");
    expect(recu).toContain(`Paragraphe ${Math.floor(55_000 / 60)} du compte rendu`);
  });

  it("600 000 caractères deviennent une PIÈCE déposée en entier, et le message le dit", async () => {
    const t = texte(600_000);
    expect(t.length).toBeGreaterThan(SEUIL_TEXTE_EN_PIECE);
    const d = await deposerMessage(moi.id, t, []);
    if (!d.ok) throw new Error(d.erreur);
    const pieces = d.tour.pieces as { id: string; nom: string }[];
    expect(pieces).toHaveLength(1);
    expect(pieces[0].nom).toMatch(/^Texte collé — .*\(\d{3} \d{3} caractères\)\.txt$/);
    expect(d.tour.contenu).toContain("Rien n'a été coupé");
    expect(d.tour.contenu.startsWith("Paragraphe 0")).toBe(true);
    const n = await prisma.driveNode.findUniqueOrThrow({ where: { id: pieces[0].id }, select: { size: true, mimeType: true, ownerId: true } });
    expect(Number(n.size)).toBe(Buffer.byteLength(t, "utf8"));
    expect(n.mimeType).toBe("text/plain");
    expect(n.ownerId).toBe(moi.id);
  });
});
