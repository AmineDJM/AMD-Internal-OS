import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "@/lib/agent/generer";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { effacerJournalDe } from "@/lib/agent/testing/journal";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { deposerMessage } from "@/lib/agent/fil/service";
import { jouerTour } from "@/lib/agent/fil/tour";
import { piecesCitees, piecesDuMessage } from "@/lib/agent/operations/pieces";
import { PIECES_PAR_ENVOI_MAX } from "@/lib/agent/lecture/depot";
import { PIECES_LUES_MAX } from "@/lib/agent/lecture/regles";

/**
 * L'ENVOI MULTI-PIÈCES (décision 0015, glisser-déposer) — de bout en bout côté serveur : un dossier
 * déposé arrive en une dizaine de pièces au chemin relatif ; le fil en garde 10 au plus, avec leur
 * chemin ; une pièce d'un collègue glissée dans la liste est écartée ; au-delà de 6, les pièces sont
 * jointes mais pas lues — et la lecture le dit, pièce par pièce. Les pièces que l'assistant renvoie
 * ne sont montrées que si la personne les voit.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iadep_${Date.now().toString(36)}_`;
let moi: CurrentUser;
let collegue: CurrentUser;

async function compte(nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "DRIVE", canView: true, canCreate: true, scope: "ALL" } }).catch(() => {});
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

async function deposer(u: CurrentUser, nom: string, texte: string): Promise<string> {
  const blob = await putBlob(Buffer.from(texte));
  const { id } = await enregistrerFichierDrive(u, {}, { blobId: blob.blobId, size: blob.size, mimeType: "text/plain", name: nom, sha256: blob.sha256 });
  return id;
}

suite("Assistant IA — l'envoi de plusieurs pièces (dossier déposé)", () => {
  const miennes: { id: string; nom: string }[] = [];
  let sienne = "";

  beforeAll(async () => {
    moi = await compte("moi");
    collegue = await compte("collegue");
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    for (let i = 1; i <= 8; i++) {
      const nom = `devis-${i}.txt`;
      miennes.push({ id: await deposer(moi, nom, `Devis numéro ${i} — imprimeur Oran, montant ${i}0 000 DZD.`), nom: `Congrès Oran/devis/${nom}` });
    }
    sienne = await deposer(collegue, "prive.txt", "Note privée du collègue.");
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(null);
    const ids = [moi?.id, collegue?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.modelCallLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le fil garde 10 pièces au plus, avec leur chemin relatif", async () => {
    const douze = [...miennes, ...miennes.slice(0, 4).map((p) => ({ ...p, nom: `copie/${p.nom}` }))];
    expect(douze).toHaveLength(12);
    const r = await deposerMessage(moi.id, "Voici le dossier du congrès.", douze);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gardees = r.tour.pieces as { id: string; nom: string }[];
    expect(gardees).toHaveLength(PIECES_PAR_ENVOI_MAX);
    expect(gardees[0]!.nom).toBe("Congrès Oran/devis/devis-1.txt");
  });

  it("une pièce que la personne ne voit pas est écartée ; les autres sont revérifiées", async () => {
    const r = await piecesDuMessage(moi, [{ id: miennes[0]!.id }, { id: sienne }, { id: miennes[1]!.id }, { id: "pas-un-id" }]);
    expect(r.map((p) => p.id)).toEqual([miennes[0]!.id, miennes[1]!.id]);
    expect(await piecesCitees(moi, [sienne, miennes[2]!.id])).toEqual([{ id: miennes[2]!.id, nom: "devis-3.txt" }]);
  });

  it("huit pièces : six lues, deux jointes et nommées — la limite est dite, rien de silencieux", async () => {
    const faux = modeleFactice([{ texte: JSON.stringify({ message: "Huit devis reçus ; six lus.", components: [] }) }]);
    remplacerModelesPourTests([faux.modele as never]);
    let lectures: { statut: string; limite?: string }[] = [];
    const r = await jouerTour(moi, {
      texte: "Compare ces devis", pieces: miennes, historique: [],
      surLecture: async (l) => { lectures = l; },
    });
    expect(r.ok).toBe(true);
    expect(lectures).toHaveLength(8);
    expect(lectures.filter((l) => l.statut === "LUE")).toHaveLength(PIECES_LUES_MAX);
    const nommees = lectures.filter((l) => l.statut === "NOMMEE");
    expect(nommees).toHaveLength(2);
    expect(nommees[0]!.limite).toMatch(/jointe mais n'a pas été lue/);
    const prompt = JSON.stringify(faux.promptsRecus[0]);
    expect(prompt).toContain("Devis numéro 1");
    expect(prompt).toContain("Devis numéro 6");
    expect(prompt).not.toContain("Devis numéro 7");
  });
});
