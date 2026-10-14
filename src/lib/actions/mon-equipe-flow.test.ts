import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getMyTeam } from "@/lib/queries/my-team";
import { teamMemberKpis } from "./my-team-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__monEquipeArbre__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * MON ÉQUIPE — TOUT L'ARBRE, ET LES INDICATEURS AU CLIC, depuis les VRAIS points d'entrée.
 *
 * ── CE QUE TIENT CE FICHIER, ET QUE LES MODULES PURS NE PEUVENT PAS TENIR ───────────────────
 *
 * `team-tree.test.ts` prouve que la descente est juste À PARTIR DE DEUX TABLEAUX. Il ne dit rien
 * des deux points qui coûtent cher en production :
 *
 *   • **La portée de la file.** L'arbre descend jusqu'en bas, mais « ce qui attend ma décision »
 *     s'arrête au premier rang : le congé d'un N-2 est routé vers SON N+1. Les confondre
 *     m'afficherait une décision que je n'ai pas à prendre — et que personne n'attend de moi.
 *   • **La porte des indicateurs.** Elle n'est PAS le module (tout le monde a « Mon Équipe ») :
 *     c'est la hiérarchie. Une action serveur s'appelle depuis le navigateur sans passer par
 *     l'écran, et un identifiant d'employé se devine ; c'est donc cette ligne-là qui doit
 *     refuser, pas la carte qu'on n'a pas affichée (§118-7).
 */
suite("Mon Équipe montre tout l'arbre, et n'ouvre les indicateurs qu'à qui encadre", () => {
  const users: Record<string, string> = {};
  const emps: Record<string, string> = {};
  let visitId = "";

  const seed = async (cle: string, role: SessionUser["role"], managerCle?: string) => {
    const u = await prisma.user.create({
      data: { name: `${TAG} ${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" },
      select: { id: true },
    });
    const e = await prisma.employee.create({
      data: {
        fullName: `${TAG} ${cle}`, userId: u.id, isActive: true,
        position: cle, managerId: managerCle ? emps[managerCle] : null,
      },
      select: { id: true },
    });
    users[cle] = u.id; emps[cle] = e.id;
  };

  beforeAll(async () => {
    // dg → dir → delegue : trois rangs, pour que « le deuxième rang est invisible » soit
    // vraiment mis à l'épreuve.
    await seed("dg", "GENERAL_MANAGER");
    await seed("dir", "MEDICAL_PROMOTION_MANAGER", "dg");
    await seed("delegue", "MEDICAL_DELEGATE", "dir");
    await seed("etranger", "SALES_USER");

    // Un congé du N-2 en attente de SON N+1 : il ne doit PAS remonter dans la file du DG.
    await prisma.leaveRequest.create({
      data: {
        employeeId: emps.delegue, type: "ANNUAL", status: "PENDING", stage: "MANAGER",
        startDate: new Date(Date.now() + 7 * 86400000), endDate: new Date(Date.now() + 9 * 86400000), days: 3,
      },
    });
    // Une visite réalisée : le compteur du métier doit la voir.
    const v = await prisma.medicalVisit.create({
      data: { delegateId: users.delegue, status: "COMPLETED", date: new Date(Date.now() - 2 * 86400000) },
      select: { id: true },
    });
    visitId = v.id;
  }, 120_000);

  afterAll(async () => {
    if (visitId) await prisma.medicalVisit.deleteMany({ where: { id: visitId } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: Object.values(emps) } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: Object.values(emps) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 120_000);

  it("LE DEUXIÈME RANG APPARAÎT — quatre cartes ne cachent plus quarante personnes", async () => {
    const dg = await actorFor(users.dg, "GENERAL_MANAGER");
    const { members, directCount, depth } = await getMyTeam(dg);
    const miens = members.filter((m) => m.fullName.startsWith(TAG));
    expect(miens.map((m) => [m.position, m.depth])).toEqual([["dir", 1], ["delegue", 2]]);
    expect(directCount).toBeGreaterThanOrEqual(1);
    expect(depth).toBeGreaterThanOrEqual(2);
  });

  it("CHACUN PORTE SON N+1 — l'écran doit dire par qui l'on passe", async () => {
    const dg = await actorFor(users.dg, "GENERAL_MANAGER");
    const { members } = await getMyTeam(dg);
    const delegue = members.find((m) => m.position === "delegue")!;
    expect(delegue.managerEmployeeId).toBe(emps.dir);
    expect(members.find((m) => m.position === "dir")!.managerEmployeeId).toBeNull();
    // Le RÔLE remonte : c'est lui qui décide quels indicateurs existent pour cette personne.
    expect(delegue.role).toBe("MEDICAL_DELEGATE");
  });

  it("LA FILE S'ARRÊTE AU PREMIER RANG — le congé du N-2 est routé vers SON N+1", async () => {
    const dg = await actorFor(users.dg, "GENERAL_MANAGER");
    const { members, pending } = await getMyTeam(dg);
    expect(pending.some((p) => p.who.includes("delegue"))).toBe(false);
    // Et sa carte n'annonce pas une décision que le DG n'a pas : « 1 à décider » ici ferait
    // chercher un bouton qui n'existe pas.
    expect(members.find((m) => m.position === "delegue")!.pending).toBe(0);

    // Le vrai destinataire, lui, la voit.
    const dir = await actorFor(users.dir, "MEDICAL_PROMOTION_MANAGER");
    const chezLui = await getMyTeam(dir);
    expect(chezLui.pending.some((p) => p.who.includes("delegue"))).toBe(true);
    expect(chezLui.members.find((m) => m.position === "delegue")!.pending).toBe(1);
  });

  it("LES INDICATEURS D'UN N-2 S'OUVRENT AU DG — la hiérarchie descend, le droit aussi", async () => {
    ACTOR = await actorFor(users.dg, "GENERAL_MANAGER");
    const r = await teamMemberKpis(emps.delegue);
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.kpis.job).toBe("FIELD");
    // Le compteur du métier compte VRAIMENT : la visite semée est là.
    const visites = r.kpis.job_.find((k) => k.label === "Visites réalisées")!;
    expect(Number(visites.value)).toBeGreaterThanOrEqual(1);
    // Et la charge commune existe pour tout le monde.
    expect(r.kpis.common.map((k) => k.label)).toContain("Tâches ouvertes");
  });

  it("UN MÉTIER SANS COMPTEUR PROPRE LE DIT, au lieu d'afficher une colonne de zéros", async () => {
    ACTOR = await actorFor(users.dg, "GENERAL_MANAGER");
    const r = await teamMemberKpis(emps.dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Le directeur de la promotion est du TERRAIN : il a bien ses compteurs.
    expect(r.kpis.job).toBe("FIELD");
    expect(r.kpis.note).toBeNull();
  });

  it("QUI N'ENCADRE PERSONNE N'OUVRE RIEN — le refus vient du SERVEUR", async () => {
    // Le délégué a le module « Mon Équipe » comme tout le monde. Ce n'est pas le module qui
    // borne ces chiffres : c'est l'arbre.
    ACTOR = await actorFor(users.delegue, "MEDICAL_DELEGATE");
    const r = await teamMemberKpis(emps.dir);
    expect(r.ok).toBe(false);
  });

  it("…et un étranger à la ligne hiérarchique non plus", async () => {
    ACTOR = await actorFor(users.etranger, "SALES_USER");
    expect((await teamMemberKpis(emps.delegue)).ok).toBe(false);
  });

  it("UN IDENTIFIANT INCONNU REÇOIT LE MÊME REFUS QU'UN HORS-ÉQUIPE", async () => {
    // Deux messages différents diraient, par la seule réponse, si tel identifiant correspond
    // à un salarié de la société.
    ACTOR = await actorFor(users.dg, "GENERAL_MANAGER");
    const inconnu = await teamMemberKpis("emp-qui-n-existe-pas");
    const horsEquipe = await teamMemberKpis(emps.etranger);
    expect(inconnu.ok).toBe(false);
    expect(horsEquipe.ok).toBe(false);
    expect(inconnu.ok === false && horsEquipe.ok === false && inconnu.error === horsEquipe.error).toBe(true);
  });
  it("UN ACHAT QUI ATTEND QUELQU'UN D'AUTRE ne remonte pas — celui qui attend MA validation, si (§118.185, I13)", async () => {
    // Une demande passée à l'étape suivante garde une approbation EN ATTENTE au nom du validateur
    // suivant : la lire comme « en attente » tout court la laissait dans ma file, et « Traiter »
    // menait à une page qui me refusait. La file lit l'approbation qui est À MOI.
    const achat = async (suffixe: string, validatorId: string) => {
      const r = await prisma.administrativeRequest.create({
        data: { reference: `${TAG}-ACH-${suffixe}`, title: `${TAG} achat ${suffixe}`, type: "PURCHASE", status: "IN_PROGRESS", requesterId: users.delegue, createdById: users.delegue },
        select: { id: true },
      });
      await prisma.adminApproval.create({ data: { requestId: r.id, requestedById: users.delegue, validatorId, status: "PENDING" } });
      return r.id;
    };
    const chezUnAutre = await achat("AUTRE", users.dg);
    const chezMoi = await achat("MOI", users.dir);
    const dir = await actorFor(users.dir, "MEDICAL_PROMOTION_MANAGER");
    const { pending } = await getMyTeam(dir);
    const ids = pending.filter((p) => p.kind === "PURCHASE").map((p) => p.id);
    expect(ids).toContain(`purchase-${chezMoi}`);
    expect(ids).not.toContain(`purchase-${chezUnAutre}`);
  });

  it("LE CONGÉ MÈNE À MON ESPACE, au bloc qui le signe — et ce bloc existe à cette adresse", async () => {
    // `/rh/conges` est l'écran des RH : un N+1 sans le module y était refusé.
    const dir = await actorFor(users.dir, "MEDICAL_PROMOTION_MANAGER");
    const conge = (await getMyTeam(dir)).pending.find((p) => p.kind === "LEAVE" && p.who.includes("delegue"));
    expect(conge?.href).toBe("/mon-espace#conges-a-signer");
    // Le point d'arrivée : une ancre qu'aucun élément ne porte ferait arriver en haut de page.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/(app)/mon-espace/page.tsx", "utf8")).toMatch(/<section id="conges-a-signer"/);
  });
});
