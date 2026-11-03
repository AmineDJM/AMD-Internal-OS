import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { addLink, removeLink, linksOf, linksOfMany, linkedViews, refreshLinkLabels } from "./store";

/**
 * LE REGISTRE DES LIENS, DEPUIS SON VRAI POINT D'ENTRÉE (§118.14).
 *
 * On ne teste pas `prisma.entityLink` : on teste `addLink` avec un utilisateur, ses droits et le
 * flux — c'est-à-dire ce qu'un écran appelle réellement. Un test qui écrirait la ligne à la main
 * ne dirait rien des trois choses qui cassent en production : la paire rangée, le double contrôle
 * d'accès, et le libellé photographié.
 */

const TAG = "LINKSTORE-TEST";

function acteur(id: string, modules: string[]): CurrentUser {
  const map = new Map(
    modules.map((m) => [m, { module: m, actions: new Set(["VIEW", "CREATE", "UPDATE", "DELETE"]), scope: "ALL" as const }]),
  );
  return {
    id, name: "Testeur", email: `${id}@x.dz`, role: "SUPER_ADMIN",
    access: { modules: map, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let userId = "";
let tenderId = "";
let contratId = "";
let assuranceId = "";
let bonId = "";
let courrierId = "";
let user: CurrentUser;

beforeAll(async () => {
  const u = await prisma.user.create({
    data: { name: `${TAG} acteur`, email: `${TAG.toLowerCase()}@amd.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
    select: { id: true },
  });
  userId = u.id;
  user = acteur(userId, ["PCH", "LEGAL", "MAIL_REGISTER", "FINANCE"]);

  const t = await prisma.pchTender.create({
    data: { reference: `${TAG}-AO-1`, title: "Marché test", products: "—", supplier: "—", supplierCountry: "—", quantity: 1, client: "PCH" },
    select: { id: true },
  });
  tenderId = t.id;

  const c = await prisma.legalDocument.create({
    data: { title: "Contrat test", kind: "CONTRACT", reference: `${TAG}-C-1`, createdById: userId },
    select: { id: true },
  });
  contratId = c.id;
  const a = await prisma.legalDocument.create({
    data: { title: "Assurance test", kind: "INSURANCE", reference: `${TAG}-A-1`, createdById: userId },
    select: { id: true },
  });
  assuranceId = a.id;

  const b = await prisma.pchOrder.create({ data: { tenderId, reference: `${TAG}-BC-1` }, select: { id: true } });
  bonId = b.id;

  const m = await prisma.mailEntry.create({
    data: { title: "Pli test", direction: "OUTGOING", reference: `${TAG}-M-1`, createdById: userId },
    select: { id: true },
  });
  courrierId = m.id;
});

afterAll(async () => {
  await prisma.entityLink.deleteMany({
    where: { OR: [{ fromId: { in: [tenderId, contratId, assuranceId, bonId, courrierId] } }, { toId: { in: [tenderId, contratId, assuranceId, bonId, courrierId] } }] },
  });
  await prisma.auditLog.deleteMany({ where: { actorId: userId } });
  await prisma.mailEntry.deleteMany({ where: { id: courrierId } });
  await prisma.pchOrder.deleteMany({ where: { id: bonId } });
  await prisma.legalDocument.deleteMany({ where: { id: { in: [contratId, assuranceId] } } });
  await prisma.pchTender.deleteMany({ where: { id: tenderId } });
  await retirerComptesEtSemis({ where: { id: userId } });
});

describe("le registre des liens, par son vrai point d'entrée", () => {
  it("le contrat né du marché : le lien s'écrit, et se lit DES DEUX CÔTÉS", async () => {
    const r = await addLink(user, { type: "LEGAL_DOCUMENT", id: contratId }, { type: "PCH_TENDER", id: tenderId });
    expect(r.ok, "ok" in r && !r.ok ? r.error : "").toBe(true);

    const vuDuContrat = await linksOf({ type: "LEGAL_DOCUMENT", id: contratId });
    const vuDuMarche = await linksOf({ type: "PCH_TENDER", id: tenderId });
    expect(vuDuContrat).toHaveLength(1);
    expect(vuDuMarche).toHaveLength(1);
    expect(vuDuContrat[0].id).toBe(vuDuMarche[0].id);

    // Le libellé est PHOTOGRAPHIÉ à la pose — la fiche l'affiche sans re-résoudre la cible.
    const vues = await linkedViews({ type: "LEGAL_DOCUMENT", id: contratId }, vuDuContrat);
    expect(vues[0].typeLabel).toBe("Appel d'offres");
    expect(vues[0].label).toContain(`${TAG}-AO-1`);
    expect(vues[0].href).toBe(`/pch/${tenderId}`);
  });

  it("RELIER A À B PUIS B À A NE FAIT QU'UNE LIGNE — la paire est rangée avant d'être écrite", async () => {
    await addLink(user, { type: "LEGAL_DOCUMENT", id: contratId }, { type: "PCH_ORDER", id: bonId });
    await addLink(user, { type: "PCH_ORDER", id: bonId }, { type: "LEGAL_DOCUMENT", id: contratId });
    const rows = await prisma.entityLink.findMany({
      where: { OR: [{ fromId: bonId }, { toId: bonId }] },
    });
    expect(rows).toHaveLength(1);
  });

  it("le bon n'a pas de fiche : son lien mène au marché dont il dépend", async () => {
    const rows = await linksOf({ type: "LEGAL_DOCUMENT", id: contratId });
    const vues = await linkedViews({ type: "LEGAL_DOCUMENT", id: contratId }, rows);
    const bon = vues.find((v) => v.type === "PCH_ORDER");
    expect(bon?.href).toBe(`/pch/${tenderId}`);
  });

  it("deux pièces légales distinctes se tiennent — l'assurance et son contrat", async () => {
    const r = await addLink(user, { type: "LEGAL_DOCUMENT", id: assuranceId }, { type: "LEGAL_DOCUMENT", id: contratId });
    expect(r.ok).toBe(true);
    const vues = await linkedViews({ type: "LEGAL_DOCUMENT", id: assuranceId }, await linksOf({ type: "LEGAL_DOCUMENT", id: assuranceId }));
    expect(vues.map((v) => v.label).join(" ")).toContain(`${TAG}-C-1`);
  });

  it("LE RACCOURCI HORS FLUX EST REFUSÉ, et rien n'est écrit", async () => {
    const avant = await prisma.entityLink.count();
    const r = await addLink(user, { type: "PCH_ORDER", id: bonId }, { type: "PCH_TENDER", id: tenderId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/appartient déjà/i);
    expect(await prisma.entityLink.count()).toBe(avant);
  });

  it("un simple LECTEUR ne relie rien — il faut être responsable d'au moins un des deux bouts", async () => {
    const lecteur: CurrentUser = {
      ...acteur(userId, []),
      role: "VIEWER",
      access: {
        modules: new Map([
          ["LEGAL", { module: "LEGAL", actions: new Set(["VIEW"]), scope: "ALL" as const }],
          ["MAIL_REGISTER", { module: "MAIL_REGISTER", actions: new Set(["VIEW"]), scope: "ALL" as const }],
        ]),
        rowGrants: new Map(),
      } as unknown as EffectiveAccess,
    };
    const r = await addLink(lecteur, { type: "LEGAL_DOCUMENT", id: contratId }, { type: "MAIL_ENTRY", id: courrierId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/lecture/i);
  });

  it("le courrier parle de tout — et `linksOfMany` lit un lot d'objets d'un coup", async () => {
    await addLink(user, { type: "MAIL_ENTRY", id: courrierId }, { type: "PCH_ORDER", id: bonId });
    await addLink(user, { type: "MAIL_ENTRY", id: courrierId }, { type: "PCH_TENDER", id: tenderId });
    const lot = await linksOfMany("PCH_ORDER", [bonId]);
    expect(lot.some((l) => l.fromId === courrierId || l.toId === courrierId)).toBe(true);
  });

  it("CORRIGER LA RÉFÉRENCE D'UN MARCHÉ remet à jour la photo portée par ses liens", async () => {
    await prisma.pchTender.update({ where: { id: tenderId }, data: { reference: `${TAG}-AO-2` } });
    const touches = await refreshLinkLabels("PCH_TENDER", tenderId);
    expect(touches).toBeGreaterThan(0);
    const vues = await linkedViews({ type: "LEGAL_DOCUMENT", id: contratId }, await linksOf({ type: "LEGAL_DOCUMENT", id: contratId }));
    expect(vues.find((v) => v.type === "PCH_TENDER")?.label).toContain(`${TAG}-AO-2`);
  });

  it("retirer un lien laisse les DEUX objets en place — seul le fil disparaît", async () => {
    const rows = await linksOf({ type: "LEGAL_DOCUMENT", id: assuranceId });
    expect(rows).toHaveLength(1);
    const r = await removeLink(user, rows[0].id);
    expect(r.ok).toBe(true);
    expect(await linksOf({ type: "LEGAL_DOCUMENT", id: assuranceId })).toHaveLength(0);
    expect(await prisma.legalDocument.count({ where: { id: { in: [assuranceId, contratId] } } })).toBe(2);
  });
});
