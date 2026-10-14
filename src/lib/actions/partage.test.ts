import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { partagerParMessagerie, listerDestinatairesPartage } from "./partage-actions";
import { AD_PRO_ENTITY_TYPE } from "@/lib/ad-pro/unified";
import { ENTITY_MODULE } from "@/lib/entity-access";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__partage__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PARTAGER PAR LA MESSAGERIE — un seul geste, et la messagerie n'est pas une porte dérobée.
 *
 * Ces essais partent du VRAI point d'entrée (`partagerParMessagerie`) et vérifient en BASE ce
 * qui compte : le message existe, il porte la référence, le fil est réutilisé, et — surtout —
 * ce qu'on ne voit pas ne se partage pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Partage par messagerie", () => {
  let pdgId = "", collegueId = "", tiersId = "", produitId = "", companyId = "";
  let nodePriveId = "", nodePartageId = "";

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [pdg, collegue, tiers] = await Promise.all([
      mk("pdg", "SUPER_ADMIN"), mk("collegue", "HEAD_OF_REGULATORY"), mk("tiers", "SALES_USER"),
    ]);
    pdgId = pdg.id; collegueId = collegue.id; tiersId = tiers.id;

    const company = await prisma.company.create({ data: { name: `${TAG}co` } });
    companyId = company.id;
    const produit = await prisma.regulatoryProduct.create({
      data: {
        reference: `${TAG}REF-1`, dci: "Nivolex", brandName: "Nivolex",
        companyId, createdById: pdg.id,
      },
      select: { id: true },
    });
    produitId = produit.id;

    // DEUX NŒUDS DU DRIVE, et c'est la PAIRE qui prouve quelque chose : l'un appartient au
    // PDG et n'est partagé avec personne, l'autre appartient au collègue qui le partagera.
    // Un seul nœud ne dirait pas si le refus vient de la garde ou d'un Drive vide.
    const [prive, aMoi] = await Promise.all([
      prisma.driveNode.create({ data: { name: `${TAG}prive.pdf`, type: "FILE", ownerId: pdg.id, mimeType: "application/pdf", size: 12 }, select: { id: true } }),
      prisma.driveNode.create({ data: { name: `${TAG}amoi.pdf`, type: "FILE", ownerId: collegue.id, mimeType: "application/pdf", size: 12 }, select: { id: true } }),
    ]);
    nodePriveId = prive.id; nodePartageId = aMoi.id;
  }, 120_000);

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { sender: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.conversationMember.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { createdBy: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.messageAttachment.deleteMany({ where: { driveNode: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.driveShare.deleteMany({ where: { node: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };

  it("partage un dossier réglementaire : le message existe, porte la référence, et le fil est ouvert", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await partagerParMessagerie(fd({
      collegueId: collegueId,
      refType: "REGULATORY_PRODUCT", refId: produitId, refLabel: "Nivolex",
      href: `/regulatory/${produitId}`, note: "Regarde les pièces manquantes.",
    }));
    expect(r.ok, r.error).toBe(true);
    expect(r.conversationId).toBeTruthy();

    const msg = await prisma.message.findFirst({
      where: { conversationId: r.conversationId! },
      orderBy: { createdAt: "desc" },
      select: { body: true, refType: true, refId: true, refLabel: true },
    });
    // LE MESSAGE EXISTE EN BASE — « c'est partagé » sans ligne serait le faux succès parfait.
    expect(msg?.refType).toBe("REGULATORY_PRODUCT");
    expect(msg?.refId).toBe(produitId);
    expect(msg?.refLabel).toBe("Nivolex");
    expect(msg?.body).toContain("Regarde les pièces manquantes.");
    // ET LE LIEN, sans quoi le destinataire doit chercher lui-même ce qu'on vient de lui envoyer.
    expect(msg?.body).toContain(`/regulatory/${produitId}`);
  });

  it("RÉUTILISE la conversation directe — deux partages ne font pas deux fils avec la même personne", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const a = await partagerParMessagerie(fd({
      collegueId: collegueId,
      refType: "REGULATORY_PRODUCT", refId: produitId, refLabel: "Nivolex",
    }));
    const b = await partagerParMessagerie(fd({
      collegueId: collegueId,
      refType: "REGULATORY_PRODUCT", refId: produitId, refLabel: "Nivolex (bis)",
    }));
    expect(a.ok && b.ok).toBe(true);
    expect(b.conversationId).toBe(a.conversationId);
  });

  /**
   * LA GARDE QUI COMPTE. Sans elle, deviner un identifiant suffirait à faire apparaître le
   * libellé d'un dossier chez quelqu'un d'autre — la messagerie deviendrait un révélateur.
   * CE QUI FERAIT TOMBER CE TEST : remplacer `canAccessEntity` par un simple `userCan` sur le
   * module. Un commercial ne voit pas Regulatory, mais le jour où un rôle voit le module sans
   * voir CE dossier (verrou du pipeline, périmètre société), le module ne suffirait plus.
   */
  it("REFUSE de partager un élément auquel l'expéditeur n'a pas accès", async () => {
    ACTOR = await acteur(tiersId, "SALES_USER");
    const r = await partagerParMessagerie(fd({
      collegueId: collegueId,
      refType: "REGULATORY_PRODUCT", refId: produitId, refLabel: "Nivolex",
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("auquel vous n'avez pas accès");
    // ET RIEN N'A ÉTÉ ÉCRIT : un refus qui laisse une trace partielle est pire qu'un refus.
    const fuite = await prisma.message.findFirst({ where: { senderId: tiersId } });
    expect(fuite).toBeNull();
  });

  it("refuse un partage sans destinataire, et un partage sans objet", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    expect((await partagerParMessagerie(fd({ refType: "REGULATORY_PRODUCT", refId: produitId }))).ok).toBe(false);
    expect((await partagerParMessagerie(fd({ collegueId: collegueId }))).ok).toBe(false);
  });

  it("ne s'envoie pas à soi-même : le demandeur est retiré des destinataires", async () => {
    // On ne s'écrit pas à soi-même (§118.21) — et un partage qui ne vise que soi n'a pas d'objet.
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await partagerParMessagerie(fd({
      collegueId: pdgId,
      refType: "REGULATORY_PRODUCT", refId: produitId, refLabel: "Nivolex",
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("vous-même");
  });

  it("un type d'objet inconnu est refusé — l'énumération fait foi, pas le formulaire", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await partagerParMessagerie(fd({
      collegueId: collegueId,
      refType: "N_IMPORTE_QUOI", refId: produitId,
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("inconnu");
  });

  /**
   * LE DRIVE SE CONTRÔLE PAR NŒUD, ET `canAccessEntity` NE LE FAIT PAS.
   *
   * `DRIVE_NODE` n'a aucune branche dans l'aiguillage de `canAccessEntity` : il retombe sur le
   * droit de MODULE, vrai pour quiconque a le Drive. La porte par nœud est `resolveDriveAccess`.
   * CE QUI FERAIT TOMBER CE TEST : retirer l'appel à `resolveDriveAccess` de l'action — le
   * partage de la PIÈCE resterait gardé (`parseDriveRefs`) et celui de la RÉFÉRENCE ne le serait
   * plus, c'est-à-dire la même chose par deux portes dont une seule fermée.
   */
  it("REFUSE la référence d'un nœud du Drive que l'expéditeur ne voit pas", async () => {
    ACTOR = await acteur(collegueId, "HEAD_OF_REGULATORY");
    const r = await partagerParMessagerie(fd({
      collegueId: tiersId,
      refType: "DRIVE_NODE", refId: nodePriveId, refLabel: "prive.pdf",
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("auquel vous n'avez pas accès");
  });

  it("partage un nœud du Drive qu'on possède : la pièce est attachée ET la lecture est accordée", async () => {
    ACTOR = await acteur(collegueId, "HEAD_OF_REGULATORY");
    const r = await partagerParMessagerie(fd({
      collegueId: tiersId,
      refType: "DRIVE_NODE", refId: nodePartageId, refLabel: `${TAG}amoi.pdf`,
      driveRefs: JSON.stringify([nodePartageId]),
    }));
    expect(r.ok, r.error).toBe(true);

    // LA PIÈCE — sans elle, le destinataire reçoit un nom de fichier et rien à ouvrir.
    const piece = await prisma.messageAttachment.findFirst({
      where: { message: { conversationId: r.conversationId! }, driveNodeId: nodePartageId },
      select: { id: true },
    });
    expect(piece).not.toBeNull();

    // LA LECTURE — c'est `sendMessage` qui l'accorde ; on vérifie qu'on ne l'a pas court-circuité
    // en écrivant le message nous-mêmes (§118.5 : un seul écrivain).
    const droit = await prisma.driveShare.findFirst({
      where: { nodeId: nodePartageId, userId: tiersId },
      select: { access: true },
    });
    expect(droit).not.toBeNull();
  });

  it("l'annuaire des destinataires ne contient jamais soi-même", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await listerDestinatairesPartage();
    expect(r.ok).toBe(true);
    expect(r.people.some((p) => p.id === pdgId)).toBe(false);
    expect(r.people.some((p) => p.id === collegueId)).toBe(true);
  });

  /**
   * CINQ NOMS SUR SEPT COÏNCIDENT ENTRE `AdProKind` ET `EntityType` — donc deux ne coïncident
   * pas, et ce sont exactement ceux qu'un appelant qui recopie le nom écrirait faux. Ce test
   * tombe si quelqu'un « simplifie » la table en `kind as EntityType`.
   */
  it("chaque nature Ad&Pro désigne un type d'entité RÉEL, et les deux exceptions sont les bonnes", () => {
    for (const [kind, type] of Object.entries(AD_PRO_ENTITY_TYPE)) {
      expect(type in ENTITY_MODULE, `${kind} → ${type} absent du registre`).toBe(true);
    }
    expect(AD_PRO_ENTITY_TYPE.CONSULTING).toBe("CONSULTING_CONTRACT");
    expect(AD_PRO_ENTITY_TYPE.OTHER).toBe("AD_PRO_OTHER");
  });
});
