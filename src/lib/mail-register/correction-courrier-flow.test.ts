import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MODULE COURRIER, AUDIT DU 24/11 — les défauts graves, rejoués sur la base.
 *
 *   1. Corriger un pli depuis sa FICHE effaçait l'expéditeur et le destinataire en texte libre.
 *   2. Adam, en corrigeant un titre, effaçait les dates, le porteur, les parties ; en créant un
 *      pli, il annonçait un expéditeur qui n'était jamais enregistré.
 *   3. L'API v1 `mail.update` écrasait tout ce que l'appel n'envoyait pas — et retournait le pli.
 *   5. Le droit `DELETE` du registre supprimait le pli d'une société qu'on ne voit pas ; un créateur
 *      dont le module a été bloqué supprimait encore le sien.
 *   6. Adam détruisait (fichiers compris) ce que la fiche met à la corbeille.
 *   4 et 7. Les dossiers : journalisés comme des courriers, et non cloisonnés au classement.
 *
 * L'assistante relève de la société Alpha ; un pli de Beta témoigne du cloisonnement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { createMailEntry, editMailEntry } from "@/lib/actions/mail-register-actions";
import { createMailFolder, moveMailEntries } from "@/lib/actions/mail-folder-actions";
import { deleteOwnRecord } from "@/lib/actions/admin-delete-actions";
import { MAIL_OPS_IMPL } from "@/lib/assistant/ops/impl-mail";
import { getOperation, validateParams } from "@/lib/api/registry/operations";
import type { OpProposalDraft } from "@/lib/assistant/ops/types";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zcourrier${Date.now().toString(36)}`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const ids = { A: "", B: "", assistante: "", bloquee: "" };
let assistante: CurrentUser | null = null;
let bloquee: CurrentUser | null = null;

const SENT = new Date("2026-11-02T09:30:00Z");
const RECU = new Date("2026-11-05T00:00:00Z");

/** Un pli complet, en texte libre, comme l'import et l'API en créent — sans contact d'annuaire. */
async function pliComplet(titre: string, companyId = ids.A, createdById = ids.assistante) {
  return prisma.mailEntry.create({
    data: {
      title: `${TAG} ${titre}`, direction: "INCOMING", reference: `${TAG}-${titre}`,
      sender: "CNAS — Direction régionale", recipient: "Direction Générale",
      sentAt: SENT, receivedAt: RECU, acknowledgedAt: RECU, carrier: "Coursier", notes: "à traiter",
      companyId, createdById,
    },
  });
}

/** La carte d'Adam, puis son exécution — comme la confirmation dans le chat. */
async function adam(op: string, input: Record<string, unknown>) {
  const p = await MAIL_OPS_IMPL[op].propose(input, ACTEUR!);
  if ("error" in p) return { carte: null, erreur: p.error, r: null };
  const r = await MAIL_OPS_IMPL[op].execute((p as OpProposalDraft).args, ACTEUR!);
  return { carte: p as OpProposalDraft, erreur: null, r };
}

suite("Courrier — corriger sans effacer, supprimer dans son périmètre", () => {
  beforeAll(async () => {
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const [u1, u2] = await Promise.all(["assistante", "bloquee"].map((q) =>
      prisma.user.create({ data: { name: `${TAG} ${q}`, email: `${TAG}${q}@t.dz`, role: "COORDINATOR", passwordHash: "x" } })));
    ids.assistante = u1.id; ids.bloquee = u2.id;
    await Promise.all([
      ...[u1.id, u2.id].map((userId) => prisma.employee.create({ data: { fullName: `${TAG} ${userId}`, companyId: ids.A, userId, isActive: true } })),
      prisma.userAccess.createMany({
        data: [
          { userId: u1.id, module: "MAIL_REGISTER", canView: true, canCreate: true, canUpdate: true, canDelete: true, scope: "ALL" },
          // LE MODULE BLOQUÉ par l'administrateur : la ligne « Bloqué » de la console.
          { userId: u2.id, module: "MAIL_REGISTER", canView: false, canCreate: false, canUpdate: false, canDelete: false, scope: "ALL" },
        ],
      }),
    ]);
    const lu = async (id: string) => ({ id, name: `${TAG}`, email: `${TAG}${id}@t.dz`, role: "COORDINATOR", secondaryRole: null, access: await getAccess(id, "COORDINATOR") }) as unknown as CurrentUser;
    assistante = await lu(u1.id);
    bloquee = await lu(u2.id);
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    const comptes = [ids.assistante, ids.bloquee];
    await prisma.deletedRecord.deleteMany({ where: { deletedById: { in: comptes } } }).catch(() => {});
    await prisma.mailEntry.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => {});
  }, 60_000);

  it("1. LA FICHE corrige un champ sans effacer l'expéditeur en texte libre ; RETIRER le contact, seul, efface", async () => {
    ACTEUR = assistante;
    const pli = await pliComplet("fiche");
    // Le formulaire de la fiche, tel qu'il part : tous ses champs, AUCUN contact (le sélecteur vide
    // ne poste rien), le porteur corrigé.
    const r = await editMailEntry(pli.id, undefined, fd({
      title: pli.title, direction: "INCOMING", reference: pli.reference!, sentAt: "2026-11-02T10:30",
      receivedAt: "2026-11-05", acknowledgedAt: "2026-11-05", carrier: "La Poste", notes: "à traiter",
    }));
    expect(r.ok, r.error).toBe(true);
    const apres = await prisma.mailEntry.findUniqueOrThrow({ where: { id: pli.id } });
    expect(apres.sender).toBe("CNAS — Direction régionale");
    expect(apres.recipient).toBe("Direction Générale");
    expect(apres.carrier).toBe("La Poste");
    // LE JOURNAL EST EXACT : le porteur, et pas d'expéditeur « effacé ».
    const lignes = await prisma.auditLog.findMany({ where: { entityType: "MAIL_ENTRY", entityId: pli.id, field: { not: null } } });
    expect(lignes.map((l) => l.field)).toContain("Porteur");
    expect(lignes.map((l) => l.field)).not.toContain("Expéditeur");
    expect(lignes.map((l) => l.field)).not.toContain("Destinataire");

    // Le VIDAGE VOLONTAIRE (contact retiré dans le sélecteur) efface — et se journalise.
    const v = await editMailEntry(pli.id, undefined, fd({ title: pli.title, senderContactId__vide: "1" }));
    expect(v.ok, v.error).toBe(true);
    const vide = await prisma.mailEntry.findUniqueOrThrow({ where: { id: pli.id } });
    expect(vide.sender).toBeNull();
    expect(vide.recipient).toBe("Direction Générale");
    expect(vide.receivedAt?.getTime()).toBe(RECU.getTime());
    const effacement = await prisma.auditLog.findFirst({ where: { entityType: "MAIL_ENTRY", entityId: pli.id, field: "Expéditeur" } });
    expect(effacement?.oldValue).toBe("CNAS — Direction régionale");
    expect(effacement?.newValue).toBe("");
  });

  it("2. ADAM corrige le titre sans toucher aux dates, au porteur ni aux parties ; il ENREGISTRE l'expéditeur qu'il annonce", async () => {
    ACTEUR = assistante;
    const pli = await pliComplet("adam");
    const { erreur, r } = await adam("edit_entry", { reference: pli.reference, newLabel: `${TAG} adam corrigé` });
    expect(erreur).toBeNull();
    expect(r?.ok, r && !r.ok ? r.error : "").toBe(true);
    const apres = await prisma.mailEntry.findUniqueOrThrow({ where: { id: pli.id } });
    expect(apres.title).toBe(`${TAG} adam corrigé`);
    expect(apres.direction).toBe("INCOMING");
    expect([apres.sender, apres.recipient, apres.carrier, apres.notes]).toEqual(["CNAS — Direction régionale", "Direction Générale", "Coursier", "à traiter"]);
    expect(apres.sentAt?.getTime()).toBe(SENT.getTime());
    expect(apres.receivedAt?.getTime()).toBe(RECU.getTime());
    expect(apres.acknowledgedAt?.getTime()).toBe(RECU.getTime());
    // Le journal ne porte QUE l'objet.
    const champs = (await prisma.auditLog.findMany({ where: { entityType: "MAIL_ENTRY", entityId: pli.id, field: { not: null } } })).map((l) => l.field);
    expect(champs).toEqual(["Objet"]);

    // LA CRÉATION : l'expéditeur que la carte montre est celui qui est enregistré.
    const c = await adam("create_entry", { label: `${TAG} adam nouveau`, direction: "entrant", sender: "Ministère de la Santé", recipient: "DG" });
    expect(c.carte?.fields.map((f) => f.value)).toContain("Ministère de la Santé");
    expect(c.r?.ok).toBe(true);
    const cree = await prisma.mailEntry.findFirstOrThrow({ where: { title: `${TAG} adam nouveau` } });
    expect([cree.sender, cree.recipient]).toEqual(["Ministère de la Santé", "DG"]);
  });

  it("3. L'API `mail.update` ne modifie QUE les paramètres envoyés — le sens reste entrant", async () => {
    const pli = await pliComplet("api");
    const def = getOperation("mail.update")!;
    const v = validateParams(def, { id: pli.id, reference: `${TAG}-api-v2` });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = await def.run(assistante!, v.values);
    expect(r.ok, r.error).toBe(true);
    const apres = await prisma.mailEntry.findUniqueOrThrow({ where: { id: pli.id } });
    expect(apres.reference).toBe(`${TAG}-api-v2`);
    expect(apres.direction).toBe("INCOMING");
    expect(apres.title).toBe(pli.title);
    expect([apres.sender, apres.carrier, apres.notes]).toEqual(["CNAS — Direction régionale", "Coursier", "à traiter"]);
    expect(apres.receivedAt?.getTime()).toBe(RECU.getTime());

    // Une valeur VIDE envoyée est un effacement voulu.
    const v2 = validateParams(def, { id: pli.id, carrier: "" });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect((await def.run(assistante!, v2.values)).ok).toBe(true);
    const efface = await prisma.mailEntry.findUniqueOrThrow({ where: { id: pli.id } });
    expect(efface.carrier).toBeNull();
    expect(efface.notes).toBe("à traiter");
  });

  it("5. SUPPRIMER : le droit du module ne franchit pas la société ; un créateur BLOQUÉ ne supprime plus", async () => {
    const voisin = await pliComplet("beta", ids.B, ids.bloquee);
    ACTEUR = assistante;
    const refus = await deleteOwnRecord(fd({ kind: "MAIL_ENTRY", id: voisin.id }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toContain("périmètre");
    expect(await prisma.mailEntry.findUnique({ where: { id: voisin.id } })).not.toBeNull();

    const sien = await pliComplet("bloquee", ids.A, ids.bloquee);
    ACTEUR = bloquee;
    const bloque = await deleteOwnRecord(fd({ kind: "MAIL_ENTRY", id: sien.id }));
    expect(bloque.ok).toBe(false);
    expect(await prisma.mailEntry.findUnique({ where: { id: sien.id } })).not.toBeNull();

    // TÉMOIN : dans sa société, la même assistante supprime — c'est la société de l'objet qui bloquait.
    ACTEUR = assistante;
    const ok = await deleteOwnRecord(fd({ kind: "MAIL_ENTRY", id: sien.id }));
    expect(ok.ok, ok.error).toBe(true);
  });

  it("6. ADAM met à la CORBEILLE, comme la fiche — et le dit", async () => {
    ACTEUR = assistante;
    const pli = await pliComplet("corbeille");
    const { carte, r } = await adam("delete_entry", { reference: pli.reference });
    expect(carte?.warnings?.join(" ")).toContain("CORBEILLE");
    expect(carte?.warnings?.join(" ")).not.toMatch(/définitive/i);
    expect(r?.ok).toBe(true);
    expect(await prisma.mailEntry.findUnique({ where: { id: pli.id } })).toBeNull();
    const range = await prisma.deletedRecord.findFirst({ where: { kind: "MAIL_ENTRY", sourceId: pli.id } });
    expect(range, "le pli doit être restaurable depuis la corbeille").not.toBeNull();
  });

  it("4. UN DOSSIER se journalise sans se faire passer pour un courrier", async () => {
    ACTEUR = assistante;
    const r = await createMailFolder(undefined, fd({ name: `${TAG} dossier`, companyId: ids.A }));
    expect(r.ok, r.error).toBe(true);
    const ligne = await prisma.auditLog.findFirstOrThrow({ where: { entityId: r.id!, actorId: ids.assistante } });
    expect(ligne.entityType).toBeNull();
  });

  it("7. CLASSER : un dossier d'Alpha ne range pas un pli d'une autre entité ; une cible inconnue est refusée en clair", async () => {
    ACTEUR = assistante;
    const dossierA = await prisma.mailEntryFolder.create({ data: { name: `${TAG} plis Alpha`, companyId: ids.A } });
    const dossierB = await prisma.mailEntryFolder.create({ data: { name: `${TAG} plis Beta`, companyId: ids.B } });
    const sansEntite = await prisma.mailEntry.create({ data: { title: `${TAG} sans entité`, direction: "INCOMING", companyId: null } });
    const pliA = await pliComplet("classer");

    // Le dossier de Beta est introuvable pour qui ne voit pas Beta.
    const versB = await moveMailEntries((() => { const f = fd({ folderId: dossierB.id }); f.append("entryId", pliA.id); return f; })());
    expect(versB.ok).toBe(false);
    // Le pli d'Alpha va dans le dossier d'Alpha ; le pli sans entité aussi.
    const versA = await moveMailEntries((() => { const f = fd({ folderId: dossierA.id }); f.append("entryId", pliA.id); f.append("entryId", sansEntite.id); return f; })());
    expect(versA.ok, versA.error).toBe(true);

    // Création : un dossier d'une autre entité, un partenaire et un objet d'origine inventés → une phrase.
    const autreDossier = await createMailEntry(undefined, fd({ title: `${TAG} création B`, folderId: dossierB.id }));
    expect(autreDossier.ok).toBe(false);
    expect(autreDossier.error).toContain("dossier");
    const partenaire = await createMailEntry(undefined, fd({ title: `${TAG} création P`, partnerId: "inexistant" }));
    expect(partenaire.ok).toBe(false);
    expect(partenaire.error).toContain("partenaire");
    const origine = await createMailEntry(undefined, fd({ title: `${TAG} création O`, sourceType: "N_IMPORTE_QUOI", sourceId: "x" }));
    expect(origine.ok).toBe(false);
    expect(origine.error).toContain("origine");
  });
});
