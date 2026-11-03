import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EntityType, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, MODULES } from "./rbac";
import { isRetiredModule } from "./modules-retired";

/**
 * Accès TEMPORAIRE de validation (bug rapporté : un validateur ne pouvait ni ouvrir ni voir
 * le bon de commande à valider). Un validateur dont une étape est EN ATTENTE obtient une
 * LECTURE du module concerné (résolu depuis le libellé OU l'URL de l'objet) + l'accès à la
 * ligne liée — puis PERD cet accès dès que l'étape est traitée. `getAccess` étant mémoïsé
 * par (userId, role), chaque scénario utilise SON PROPRE validateur.
 */

// Sonde DB ; suite sautée proprement sans base (CI sans Postgres).
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__valaccess__";
const ids: Record<string, string> = {};
let requesterId = "";

async function mkUser(slug: string, role: UserRole): Promise<string> {
  const u = await prisma.user.create({ data: { name: `${TAG}${slug}`, email: `${TAG}${slug}@t.dz`, passwordHash: "x", role } });
  return u.id;
}
async function mkValidation(validatorId: string, opts: {
  module: string; link?: string; entityType?: EntityType; entityId?: string;
  status?: "PENDING" | "APPROVED"; stepStatus?: "PENDING" | "APPROVED";
}) {
  await prisma.validationRequest.create({
    data: {
      reference: `${TAG}-${Math.random().toString(36).slice(2, 10)}`,
      module: opts.module, title: "Bon de commande à valider", requesterId,
      status: opts.status ?? "PENDING", currentOrder: 1, mode: "SEQUENTIAL",
      link: opts.link ?? null, entityType: opts.entityType ?? null, entityId: opts.entityId ?? null,
      steps: { create: [{ order: 1, validatorId, status: opts.stepStatus ?? "PENDING" }] },
    },
  });
}

suite("getAccess — accès temporaire de validation", () => {
  beforeAll(async () => {
    requesterId = await mkUser("req", "DIRECTION_ASSISTANT");
    // Direction Marketing : AUCUN accès PCH / Ventes par défaut → parfait pour prouver l'octroi temporaire.
    for (const slug of ["none", "label", "link", "row", "done"]) ids[slug] = await mkUser(slug, "PRODUCT_MANAGER");
    // VIEWER : rôle SANS le module VALIDATIONS par défaut → prouve qu'un validateur choisi
    // peut malgré tout ouvrir la page des validations dès qu'une étape l'attend.
    ids.viewer = await mkUser("viewer", "VIEWER");
    ids.viewerNone = await mkUser("viewerNone", "VIEWER");
    // Un validateur dont l'étape porte un module RETIRÉ — nommé par sa CLÉ, qui se résout à coup sûr.
    ids.retire = await mkUser("retire", "PRODUCT_MANAGER");
    await mkValidation(ids.label, { module: "PCH — Marchés" });
    await mkValidation(ids.link, { module: "Demandes de validations", link: "/pch/abc123?tab=bc" });
    await mkValidation(ids.row, { module: "Ventes", entityType: "SALE", entityId: "sale-xyz" });
    await mkValidation(ids.done, { module: "PCH — Marchés", status: "APPROVED", stepStatus: "APPROVED" });
    await mkValidation(ids.viewer, { module: "Demandes de validations", link: "/pch/def456" });
    await mkValidation(ids.retire, { module: "SALES", entityType: "SALE", entityId: "sale-retire" });
  });

  afterAll(async () => {
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("sans validation en attente → aucun accès PCH", async () => {
    const a = await getAccess(ids.none, "PRODUCT_MANAGER");
    expect(a.modules.has("PCH")).toBe(false);
  });

  it("validation en attente (libellé « PCH — Marchés ») → LECTURE PCH temporaire (jamais d'écriture)", async () => {
    const a = await getAccess(ids.label, "PRODUCT_MANAGER");
    const pch = a.modules.get("PCH");
    expect(pch?.actions.has("VIEW")).toBe(true);
    expect(pch?.actions.has("EXPORT")).toBe(true);
    expect(pch?.actions.has("UPDATE")).toBe(false);
    expect(pch?.actions.has("DELETE")).toBe(false);
  });

  it("validation directe (libellé générique) → module résolu via l'URL de l'objet lié", async () => {
    const a = await getAccess(ids.link, "PRODUCT_MANAGER");
    expect(a.modules.get("PCH")?.actions.has("VIEW")).toBe(true);
  });

  it("objet lié (entityType/entityId) → RowGrant temporaire sur la ligne exacte", async () => {
    const a = await getAccess(ids.row, "PRODUCT_MANAGER");
    expect(a.rowGrants.get("SALE")?.has("sale-xyz")).toBe(true);
  });

  it("étape déjà traitée → l'accès temporaire a DISPARU", async () => {
    const a = await getAccess(ids.done, "PRODUCT_MANAGER");
    expect(a.modules.has("PCH")).toBe(false);
  });

  it("un VIEWER (sans droit VALIDATIONS) avec une étape en attente PEUT ouvrir la page des validations", async () => {
    const a = await getAccess(ids.viewer, "VIEWER");
    // Cœur du correctif : sinon `requireModule(\"VALIDATIONS\")` le redirige et la demande reste invisible.
    expect(a.modules.get("VALIDATIONS")?.actions.has("VIEW")).toBe(true);
  });

  it("un VIEWER SANS étape en attente n'a toujours PAS le module VALIDATIONS", async () => {
    const a = await getAccess(ids.viewerNone, "VIEWER");
    expect(a.modules.has("VALIDATIONS")).toBe(false);
  });

  // La garde de l'accès attribué (`accesAttribue`) écartait les modules retirés ; une porte IMPLICITE les
  // rouvrait — une validation qui les nomme, ou un intérim (§118.75, §118.196). La ligne liée, elle, reste
  // accordée : le validateur peut toujours décider.
  it("une validation en attente sur un module RETIRÉ n'ouvre pas ce module — la ligne liée, si", async () => {
    expect(isRetiredModule("SALES"), "PRÉMISSE : le module est retiré").toBe(true);
    expect((MODULES as readonly string[]).includes("SALES"), "PRÉMISSE : sa clé se lit comme un module").toBe(true);
    const a = await getAccess(ids.retire, "PRODUCT_MANAGER");
    expect(a.modules.has("SALES")).toBe(false);
    expect(a.rowGrants.get("SALE")?.has("sale-retire")).toBe(true);
    expect(a.modules.get("VALIDATIONS")?.actions.has("VIEW"), "il peut décider").toBe(true);
  });
});
