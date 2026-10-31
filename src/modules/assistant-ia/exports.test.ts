import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR,
  getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR,
}));

import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { getBlob } from "@/lib/drive-storage";
import { POST as routeRegulatory } from "@/app/api/regulatory/export/route";
import { produireExport } from "@/lib/exports/producteurs";
import { DOSSIER_EXPORTS } from "@/lib/exports/catalogue";
import { outilsExports } from "./infra/exports";
import { MESSAGE_DIRECT } from "./infra/operations/quotidien";
import { executerOperationIA } from "./infra/operations";

/**
 * K7 (décision 0037) — LE SCÉNARIO DE LA DIRECTION, sur la vraie base : « Envoie à <collègue> l'Excel du suivi
 * Regulatory ». L'outil d'export appelle la fonction de la route (même portée), dépose le classeur dans le Drive de la
 * personne (« Exports ») ; la carte d'envoi joint la pièce ; confirmée, le message part avec elle et le collègue peut
 * l'ouvrir. Qui n'a pas l'écran n'a pas l'outil ; un filtre qui ne désigne rien est refusé, pas deviné.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__k7exp_${Date.now().toString(36)}_`;
let direction: CurrentUser;
let collegue: CurrentUser;
let sansDroit: CurrentUser;

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom.replace(/\s+/g, "")}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

const lancer = async (u: CurrentUser, outil: string, entree: Record<string, unknown>) => {
  const o = outilsExports(u).find((t) => t.def.name === outil)!;
  return JSON.parse(await o.run(entree, u)) as Record<string, unknown> & { fichier?: { nodeId: string; nom: string; ouvrir: string; telecharger: string; contenu: string } };
};

suite("K7 — exporter depuis l'assistant, puis envoyer à un collègue", () => {
  beforeAll(async () => {
    direction = await compte("Direction", "SUPER_ADMIN");
    collegue = await compte("Zephyrin Collegue", "VIEWER");
    sansDroit = await compte("Sans Droit", "VIEWER");
    await prisma.regulatoryProduct.createMany({
      data: [
        { reference: `${TAG}REG-1`, dci: `Nivolumab${TAG}`, status: "AWAITING_ANPP" },
        { reference: `${TAG}REG-2`, dci: `Pembrolizumab${TAG}`, status: "SUBMITTED" },
      ],
    });
  });

  afterAll(async () => {
    const ids = [direction?.id, collegue?.id, sansDroit?.id].filter(Boolean) as string[];
    await prisma.message.deleteMany({ where: { senderId: { in: ids } } }).catch(() => {});
    await prisma.driveShare.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
  });

  it("l'outil produit le classeur de la route, le dépose au Drive « Exports » et rend les deux liens", async () => {
    const r = await lancer(direction, "exporter_suivi_regulatory", { recherche: TAG });
    expect(r.statut).toBe("FAIT");
    const f = r.fichier!;
    expect(f.contenu).toBe("2 dossier(s) réglementaire(s)");
    expect(f.ouvrir).toBe(`/drive/${f.nodeId}`);
    expect(f.telecharger).toBe(`/api/drive/${f.nodeId}/raw?dl=1`);
    const node = await prisma.driveNode.findUniqueOrThrow({ where: { id: f.nodeId }, select: { ownerId: true, name: true, parent: { select: { name: true } }, versions: { select: { blobId: true } } } });
    expect(node.ownerId).toBe(direction.id);
    expect(node.parent?.name).toBe(DOSSIER_EXPORTS);
    // Le classeur est un vrai .xlsx qui porte les deux dossiers filtrés.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await getBlob(node.versions[0]!.blobId))! as unknown as ArrayBuffer);
    const texte = JSON.stringify(wb.worksheets[0]!.getSheetValues());
    expect(texte).toContain(`Nivolumab${TAG}`);
    expect(texte).toContain(`Pembrolizumab${TAG}`);
    // MÊME AUDIT que le bouton de l'écran.
    expect(await prisma.auditLog.count({ where: { actorId: direction.id, action: "EXPORT", module: "Regulatory" } })).toBeGreaterThan(0);
  });

  it("les filtres de l'écran : un statut par son libellé ; un statut inconnu est refusé, pas deviné", async () => {
    const r = await produireExport("exporter_suivi_regulatory", direction, { recherche: TAG, statuts: ["Attente ANPP"] });
    expect(r.ok && r.fichier.resume).toBe("1 dossier(s) réglementaire(s)");
    const k = await lancer(direction, "exporter_suivi_regulatory", { statuts: ["Presque fini"] });
    expect(k.statut).toBe("REFUS");
    expect(String(k.raison)).toMatch(/Statut « Presque fini » inconnu/);
    expect(k.ecran).toBe("/regulatory");
  });

  it("la route de l'écran appelle la même fonction (portée, droits) : 200 pour la Direction, 403 sans le module", async () => {
    ACTOR = direction;
    const ok = await routeRegulatory(new Request("http://x/api/regulatory/export", { method: "POST", body: JSON.stringify({ ids: [] }) }) as never);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/spreadsheetml/);
    ACTOR = sansDroit;
    const non = await routeRegulatory(new Request("http://x/api/regulatory/export", { method: "POST" }) as never);
    expect(non.status).toBe(403);
  });

  it("qui n'a pas le bouton n'a pas l'outil (et la fonction refuse quand même)", async () => {
    const o = outilsExports(sansDroit).find((t) => t.def.name === "exporter_suivi_regulatory")!;
    expect(o.allowed(sansDroit)).toBe(false);
    const r = await produireExport("exporter_suivi_regulatory", sansDroit, {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.statut).toBe(403);
  });

  it("« envoie-le au collègue » : la carte joint la pièce, confirmée le message part avec elle et le collègue l'ouvre", async () => {
    const f = (await lancer(direction, "exporter_suivi_regulatory", { recherche: TAG })).fichier!;
    const p = await MESSAGE_DIRECT.proposer({ recipientName: collegue.name, body: "Voici le suivi Regulatory.", pieces: [f.nodeId] }, direction);
    if (!("carte" in p) || !p.carte) throw new Error(`carte attendue : ${JSON.stringify(p)}`);
    expect(p.carte.fields.find((x) => x.label === "Pièce(s) jointe(s)")?.value).toBe(f.nom);
    expect(p.carte.warnings?.[0]).toMatch(/pourra ouvrir ce fichier/);
    // Rien n'est parti avant la confirmation.
    expect(await prisma.message.count({ where: { senderId: direction.id } })).toBe(0);
    ACTOR = direction;
    const r = await executerOperationIA(direction, { kind: "assistant_ia_op", op: MESSAGE_DIRECT.nom, args: p.args });
    expect(r.ok).toBe(true);
    expect(r.ok && r.message).toBe("Message envoyé avec la pièce jointe.");
    const m = await prisma.message.findFirstOrThrow({ where: { senderId: direction.id }, select: { body: true, conversation: { select: { members: { select: { userId: true } } } }, attachments: { select: { driveNodeId: true, name: true } } } });
    expect(m.attachments).toEqual([{ driveNodeId: f.nodeId, name: f.nom }]);
    expect(m.conversation.members.map((x) => x.userId)).toContain(collegue.id);
    // Le destinataire reçoit l'accès en lecture à CE fichier, par la messagerie.
    expect(await prisma.driveShare.count({ where: { nodeId: f.nodeId, userId: collegue.id } })).toBe(1);
  });

  it("le destinataire ne reçoit que ce que l'expéditeur voit : une pièce hors de sa portée refuse la carte", async () => {
    const f = (await lancer(direction, "exporter_suivi_regulatory", { recherche: TAG })).fichier!;
    const p = await MESSAGE_DIRECT.proposer({ recipientName: direction.name, pieces: [f.nodeId] }, sansDroit);
    expect("erreur" in p && p.erreur).toMatch(/pas accessible/);
  });
});
