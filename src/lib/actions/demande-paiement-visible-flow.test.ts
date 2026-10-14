import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { myPaymentRequests } from "@/lib/queries/my-payment-requests";
import { createPaymentRequest, addPaymentPiece } from "./payment-request-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__demandePaiementVue__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

/**
 * « J'ENVOIE MA DEMANDE DE PAIEMENT, ET JE NE LA VOIS PLUS. »
 *
 * ── LE DÉFAUT RAPPORTÉ ──────────────────────────────────────────────────────────────────────
 *
 * Les demandes de paiement n'ont plus d'entrée de menu : on les dépose depuis « Demandes de
 * validations », et le formulaire conduit ensuite sur la fiche du dossier. Mais cet écran-là ne
 * montrait AUCUNE demande de paiement. Une fois la fiche quittée, le dossier n'était plus
 * atteignable : ni pour suivre l'instruction, ni pour joindre la pièce que les Finances
 * réclament. Le demandeur voyait sa demande une fois, puis plus jamais.
 *
 * Les DROITS n'étaient pour rien dans l'affaire — c'est ce que ce fichier établit aussi : la
 * garde du dossier laisse entrer son demandeur, l'action accepte sa pièce. Ce qui manquait était
 * une PORTE. `myPaymentRequests` est cette liste, servie par l'écran où l'on dépose ET par
 * l'écran dédié — une seule définition, pour que « visible ici, absente là » ne revienne pas.
 *
 * Ce fichier part du VRAI formulaire (§118-14) et vérifie les quatre maillons :
 *
 *   • la demande part bien aux Finances ;
 *   • elle reste dans « mes demandes » — la requête que l'écran des validations affiche ;
 *   • sa fiche s'ouvre — la garde du dossier le laisse entrer ;
 *   • il peut encore JOINDRE UNE PIÈCE : un dossier qui réclame une facture n'avance que si le
 *     demandeur peut la déposer.
 */
suite("Une demande de paiement envoyée reste visible de son demandeur", () => {
  let userId = "";
  let moi: CurrentUser | null = null;

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} demandeur`, email: `${TAG}@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" },
      select: { id: true },
    });
    userId = u.id;
    moi = await actorFor(userId, "PRODUCT_MANAGER");
    ACTOR = moi;
  }, 60_000);

  afterAll(async () => {
    const reqs = await prisma.paymentRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true, expenseOrderId: true } });
    const ids = reqs.map((r) => r.id);
    await prisma.paymentPiece.deleteMany({ where: { requestId: { in: ids } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: ids } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityType: "PAYMENT_REQUEST", entityId: { in: ids } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({
      where: { id: { in: reqs.map((r) => r.expenseOrderId).filter((x): x is string => Boolean(x)) } },
    }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  /** Le formulaire « Demander un paiement », tel qu'il part — envoi direct, sans brouillon. */
  async function envoyer(titre: string): Promise<string> {
    const f = fd({
      title: titre, payee: "Fournisseur X", amount: "35000",
      paymentMethodStated: "on", deadlineNature: "IMPORTANT",
    });
    // Le dossier part avec sa facture — c'est ce que la règle exige à la transmission.
    // UNE FACTURE DISTINCTE PAR DEMANDE (Direction, 14/10) : le même fichier deux fois serait la même facture, refusée.
    f.append("files", new File([new Uint8Array([1, 2, 3]), `${Date.now()}-${Math.random()}`], "facture.pdf", { type: "application/pdf" }));
    f.set("kind_0", "INVOICE");
    const r = await createPaymentRequest(undefined, f);
    expect(r.ok, r.error).toBe(true);
    return r.id!;
  }

  it("ELLE PART BIEN AUX FINANCES — l'envoi n'est pas resté un brouillon", async () => {
    const id = await envoyer(`${TAG} Facture transporteur`);
    const req = await prisma.paymentRequest.findUniqueOrThrow({ where: { id } });
    expect(req.status).toBe("SUBMITTED");
    expect(req.requesterId).toBe(userId);
  });

  it("ET ELLE RESTE VISIBLE DE L'ÉCRAN OÙ IL L'A DÉPOSÉE — c'est la porte qui manquait", async () => {
    const id = await envoyer(`${TAG} Prestation huissier`);
    // `myPaymentRequests` est la liste servie par « Demandes de validations » (la seule porte du
    // circuit) ET par l'écran dédié. Sans elle sur le premier, le dossier sortait de la vue du
    // demandeur dès qu'il quittait sa fiche.
    const mine = await myPaymentRequests(userId);
    expect(mine.map((r) => r.id)).toContain(id);

    // Et elle n'y reste pas seulement « en cours » : un dossier transmis appartient encore à son
    // auteur — c'est lui qu'on relancera, c'est lui qui fournira la pièce manquante.
    expect(mine.find((r) => r.id === id)?.status).toBe("SUBMITTED");
  });

  it("les demandes de QUELQU'UN D'AUTRE n'y entrent pas", async () => {
    // La porte s'ouvre sur SES demandes : ce n'est pas une liste de service.
    const autre = await prisma.user.create({
      data: { name: `${TAG} autre`, email: `${TAG}autre@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" },
      select: { id: true },
    });
    const id = await envoyer(`${TAG} Pas la sienne`);
    const sienne = await myPaymentRequests(autre.id);
    expect(sienne.map((r) => r.id)).not.toContain(id);
  });

  it("SA FICHE S'OUVRE — la garde du dossier laisse entrer son demandeur", async () => {
    const id = await envoyer(`${TAG} Location salle`);
    const req = await prisma.paymentRequest.findUniqueOrThrow({ where: { id } });
    // La garde de `app/(app)/validations/paiements/[id]/page.tsx`, rejouée à l'identique.
    const isFinance = moi!.role === "FINANCE_BUDGET_MANAGER"
      || userCan(moi!, "FINANCES", "VALIDATE") || userCan(moi!, "FINANCES", "UPDATE") || hasGlobalView(moi!.role);
    const isRequester = req.requesterId === moi!.id || hasGlobalView(moi!.role);
    expect(isFinance || isRequester || req.recipientId === moi!.id).toBe(true);
  });

  it("IL PEUT ENCORE JOINDRE UNE PIÈCE une fois la demande partie", async () => {
    const id = await envoyer(`${TAG} Honoraires`);
    const f = new FormData();
    f.set("requestId", id);
    f.set("kind", "OTHER");
    f.set("file", new File([new Uint8Array([4, 5, 6])], "rib.pdf", { type: "application/pdf" }));
    const r = await addPaymentPiece(f);
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.paymentPiece.count({ where: { requestId: id } })).toBe(2);
  });

  it("ET LE TÉLÉVERSEMENT LUI EST OUVERT — c'est la porte qui gouverne le fichier lui-même", async () => {
    const id = await envoyer(`${TAG} Frais de mission`);
    expect(await canAccessEntity(moi!, "PAYMENT_REQUEST", id, "UPLOAD")).toBe(true);
    expect(await canAccessEntity(moi!, "PAYMENT_REQUEST", id, "VIEW")).toBe(true);
  });
});
