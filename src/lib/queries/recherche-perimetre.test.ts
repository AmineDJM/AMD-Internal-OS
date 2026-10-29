import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Le cookie d'entité, tel que le navigateur l'envoie — et tel qu'on peut le forger à la main.
 * Hors requête, `cookies()` lève et la portée vaut « toutes les entités » ; ce banc doit pouvoir
 * jouer le cookie FORGÉ, qui est précisément le cas que la résolution CTD ignorait (§118.177).
 */
let cookieEntite: string | null = null;
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (k: string) => (k === "amd-company" && cookieEntite ? { value: cookieEntite } : undefined) }),
  headers: () => new Headers(),
}));

import { prisma } from "@/lib/prisma";
import { getAccess, seesLockedRegulatory, type SessionUser } from "@/lib/rbac";
import { globalSearch, type SearchResult } from "@/lib/queries/search";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { resolveRegCompanyIdFor, regCan } from "@/lib/regulatory/intelligence/access";
import { canSee, clauseTachesVisibles } from "@/lib/tasks/request-flow";
import { getEvents, getCongressList } from "@/modules/ad-pro/api";
import { getRequestList } from "@/lib/queries/admin-requests";
import { getPchTenders } from "@/lib/queries/pch";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__rechper__";
/** Le mot cherché — propre à ce passage, pour qu'un résidu d'un passage interrompu ne compte pas. */
const MOT = `zq${Date.now().toString(36)}`;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RECHERCHE GLOBALE, PAR LE VRAI POINT D'ENTRÉE, AVEC DES LECTEURS CLOISONNÉS (§118.177).
 *
 * Un Super Admin voit tout le groupe : un banc joué avec lui ne peut pas tomber (§118.104). Les
 * lecteurs ici relèvent d'UNE entité et n'ont pas la vue groupe :
 *   • le Directeur Général d'Alpha — portée « toutes les lignes » sur ses modules, donc la seule
 *     chose qui le borne est l'ENTITÉ : c'est le cas qui isole le cloisonnement ;
 *   • le Responsable Réglementaire d'Alpha — le module CTD (permission + entité activée) ;
 *   • l'assistante réglementaire d'Alpha, rattachée à une GAMME de Gamma — la portée par ligne,
 *     le verrou du pipeline et la gamme ensemble ;
 *   • un lecteur des Documents, un ancien membre d'un groupe, une personne qui porte la vue
 *     globale en rôle SECONDAIRE.
 *
 * Chaque famille a ses trois lignes — Alpha, Beta, sans entité — et la réponse attendue dépend du
 * filtre de SON écran : `companyScopedWhere` garde la ligne sans entité, `platformScope` l'écarte.
 * La recherche doit rendre exactement ce que l'écran montre, ni plus (une fuite), ni moins (un
 * refus à tort, §118.27).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Recherche globale — le périmètre de chaque écran, et rien d'autre", () => {
  const ids = { companies: [] as string[], users: [] as string[] };
  let A = "", B = "", C = "";
  let gm = "", head = "", assistant = "", viewer = "", sec = "", ancien = "", actif = "", redac = "", autre = "";

  const acteur = async (id: string): Promise<SessionUser> => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true, secondaryRole: true } });
    return { id, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(id, u.role) } as unknown as SessionUser;
  };
  /** Les identifiants rendus par la recherche pour une famille. */
  const trouves = (r: SearchResult[], group: string) => r.filter((x) => x.group === group).map((x) => x.id).sort();

  /** Les lignes de chaque famille, par entité. */
  const lignes: Record<string, { a: string; b: string; n: string }> = {};

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    const companies = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const cids = companies.map((c) => c.id);
    const like = { contains: TAG };
    await prisma.message.deleteMany({ where: { body: like } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: like } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.directive.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.pchOrder.deleteMany({ where: { products: like } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.mailEntry.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: like } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: like } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: like } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: like } }).catch(() => {});
    await prisma.medicalDirectory.deleteMany({ where: { name: like } }).catch(() => {});
    await prisma.logisticsOrder.deleteMany({ where: { product: like } }).catch(() => {});
    await prisma.sale.deleteMany({ where: { product: like } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { label: like } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { institution: like } }).catch(() => {});
    await prisma.regulatoryDossier.deleteMany({ where: { title: like } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { dci: like } }).catch(() => {});
    if (cids.length) await prisma.regulatoryFeatureAccess.deleteMany({ where: { companyId: { in: cids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: like } }).catch(() => {});
    if (uids.length) await prisma.user.deleteMany({ where: { id: { in: uids } } }).catch(() => {});
    if (cids.length) await prisma.productRange.deleteMany({ where: { companyId: { in: cids } } }).catch(() => {});
    if (cids.length) await prisma.company.deleteMany({ where: { id: { in: cids } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const [ca, cb, cc] = await Promise.all(
      ["Alpha", "Beta", "Gamma"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })),
    );
    A = ca.id; B = cb.id; C = cc.id;
    ids.companies.push(A, B, C);

    const mk = (s: string, role: string, secondaryRole?: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, secondaryRole: (secondaryRole ?? null) as never, passwordHash: "x" } });
    const us = await Promise.all([
      mk("gm", "GENERAL_MANAGER"), mk("head", "HEAD_OF_REGULATORY"), mk("assistant", "REGULATORY_ASSISTANT"),
      mk("viewer", "VIEWER"), mk("sec", "SALES_USER", "DIRECTION"), mk("ancien", "SALES_USER"), mk("actif", "SALES_USER"),
      mk("redac", "DIRECTION"), mk("autre", "SALES_USER"),
    ]);
    [gm, head, assistant, viewer, sec, ancien, actif, redac, autre] = us.map((u) => u.id);
    ids.users.push(...us.map((u) => u.id));
    // L'appartenance : les trois lecteurs cloisonnés relèvent d'Alpha.
    await Promise.all([gm, head, assistant].map((userId, i) =>
      prisma.employee.create({ data: { fullName: `${TAG}salarié ${i}`, companyId: A, userId } })));
    // La gamme de Gamma ouvre Gamma à l'assistante — en lecture, et restreinte à la gamme.
    const gamme = await prisma.productRange.create({ data: { name: `${TAG}Gamme`, companyId: C } });
    await prisma.userProductRange.create({ data: { userId: assistant, rangeId: gamme.id } });

    // ── UNE LIGNE PAR ENTITÉ, PAR FAMILLE ─────────────────────────────────────────────────
    const trois = async (famille: string, creer: (companyId: string | null, k: string) => Promise<{ id: string }>) => {
      const [a, b, n] = await Promise.all([creer(A, "a"), creer(B, "b"), creer(null, "n")]);
      lignes[famille] = { a: a.id, b: b.id, n: n.id };
    };
    const nom = (k: string) => `${TAG}${MOT} ${k}`;
    await Promise.all([
      trois("Sponsoring", (companyId, k) => prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-${MOT}-${k}`, institution: nom(k), type: "CONGRES", companyId } })),
      trois("Finances", (companyId, k) => prisma.financeTransaction.create({ data: { reference: `${TAG}FIN-${MOT}-${k}`, direction: "OUT", category: "RECETTE", label: nom(k), amount: 1000, companyId } })),
      trois("RH", (companyId, k) => prisma.employee.create({ data: { fullName: nom(k), companyId } })),
      trois("Ventes", (companyId, k) => prisma.sale.create({ data: { product: nom(k), client: "Client", companyId } })),
      trois("Logistique PCH", (companyId, k) => prisma.logisticsOrder.create({ data: { reference: `${TAG}LOG-${MOT}-${k}`, product: nom(k), companyId } })),
      trois("Annuaire", (companyId, k) => prisma.medicalDoctor.create({ data: { name: nom(k), companyId } })),
      trois("Bureau du secrétariat", (companyId, k) => prisma.administrativeRequest.create({ data: { reference: `${TAG}DEM-${MOT}-${k}`, title: nom(k), type: "PURCHASE", companyId } })),
      trois("Prise en charge Internationale", (companyId, k) => prisma.congressInternational.create({ data: { name: nom(k), companyId } })),
      trois("Prise en charge Nationale", (companyId, k) => prisma.congressNational.create({ data: { name: nom(k), companyId } })),
      trois("Événements", (companyId, k) => prisma.event.create({ data: { name: nom(k), companyId } })),
      trois("Marchés PCH", (companyId, k) => prisma.pchTender.create({ data: { reference: `${TAG}AO-${MOT}-${k}`, title: nom(k), companyId } })),
      trois("Legal", (companyId, k) => prisma.legalDocument.create({ data: { title: nom(k), companyId } })),
      trois("Courriers", (companyId, k) => prisma.mailEntry.create({ data: { title: nom(k), direction: "INCOMING", companyId } })),
      trois("Regulatory", (companyId, k) => prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-${MOT}-${k}`, dci: nom(k), companyId } })),
    ]);
    // Les bons de commande PCH héritent de leur marché.
    const [oa, ob, on] = await Promise.all([lignes["Marchés PCH"].a, lignes["Marchés PCH"].b, lignes["Marchés PCH"].n].map((tenderId, i) =>
      prisma.pchOrder.create({ data: { tenderId, reference: `${TAG}BC-${i}`, products: `${TAG}${MOT} bc ${i}` } })));
    lignes["BC PCH"] = { a: oa.id, b: ob.id, n: on.id };
  });

  afterAll(async () => {
    cookieEntite = null;
    await nettoyer();
  });

  beforeEach(() => { cookieEntite = null; });

  /**
   * Les familles et le filtre d'entité de LEUR écran. `garde` = la ligne sans entité reste visible
   * (`companyScopedWhere`) ; sinon elle est écartée (`platformScope`).
   */
  const FAMILLES: { famille: string; groupe: string; garde: boolean }[] = [
    { famille: "Sponsoring", groupe: "Sponsoring", garde: false },
    { famille: "Finances", groupe: "Finances", garde: false },
    { famille: "RH", groupe: "RH", garde: false },
    { famille: "Annuaire", groupe: "Annuaire", garde: true },
    { famille: "Bureau du secrétariat", groupe: "Bureau du secrétariat", garde: false },
    { famille: "Prise en charge Internationale", groupe: "Prise en charge Internationale", garde: false },
    { famille: "Prise en charge Nationale", groupe: "Prise en charge Nationale", garde: false },
    { famille: "Événements", groupe: "Événements", garde: false },
    { famille: "Legal", groupe: "Legal", garde: true },
    { famille: "Courriers", groupe: "Courriers", garde: true },
    { famille: "Regulatory", groupe: "Regulatory", garde: true },
  ];

  it("le Directeur Général d'Alpha ne trouve que ce que SES écrans montrent — famille par famille", async () => {
    const u = await acteur(gm);
    const r = await globalSearch(u, MOT, 20);
    const ecarts: string[] = [];
    for (const { famille, groupe, garde } of FAMILLES) {
      const l = lignes[famille];
      const attendu = (garde ? [l.a, l.n] : [l.a]).sort();
      const vu = trouves(r, groupe).filter((id) => [l.a, l.b, l.n].includes(id));
      if (JSON.stringify(vu) !== JSON.stringify(attendu)) {
        ecarts.push(`${famille} : attendu ${attendu.length} (${garde ? "Alpha + sans entité" : "Alpha seul"}), vu ${vu.length}${vu.includes(l.b) ? " — DONT la ligne de Beta" : ""}`);
      }
    }
    expect(ecarts, ecarts.join("\n")).toEqual([]);
  });

  it("les modules RETIRÉS du service ne sortent pas de la recherche — pas même la ligne de son entité", async () => {
    const u = await acteur(gm);
    // PRÉMISSE : Ventes et Logistique sont retirés (`RETIRED_MODULE_KEYS`) — personne n'a leur
    // écran, donc la recherche ne doit rien en rendre, quelle que soit l'entité.
    const { userCan } = await import("@/lib/rbac");
    expect(userCan(u, "SALES", "VIEW")).toBe(false);
    expect(userCan(u, "LOGISTICS", "VIEW")).toBe(false);
    const r = await globalSearch(u, MOT, 20);
    expect(trouves(r, "Ventes")).toEqual([]);
    expect(trouves(r, "Logistique PCH")).toEqual([]);
  });

  it("les bons de commande PCH suivent leur marché : celui d'un marché de Beta ne sort pas", async () => {
    const u = await acteur(gm);
    const r = await globalSearch(u, MOT, 20);
    const l = lignes["BC PCH"];
    const vu = r.filter((x) => x.group === "Marchés PCH" && x.title.startsWith("BC ")).map((x) => x.id).filter((id) => [l.a, l.b, l.n].includes(id)).sort();
    expect(vu).toEqual([l.a, l.n].sort());
  });

  it("la recherche et l'écran répondent pareil — mêmes lignes dans la liste qu'en recherche", async () => {
    const u = await acteur(gm);
    // L'écran des événements, des prises en charge, du secrétariat et des marchés : une liste qui
    // montrerait une ligne que la recherche cache (ou l'inverse) serait la divergence qu'on ferme.
    const [events, intl, demandes, marches] = await Promise.all([
      getEvents(gm), getCongressList("INTL", u), getRequestList(u, {}).then((l) => l.rows), getPchTenders(gm),
    ]);
    const dans = (liste: { id: string }[], l: { a: string; b: string; n: string }) =>
      liste.map((x) => x.id).filter((id) => [l.a, l.b, l.n].includes(id)).sort();
    expect(dans(events, lignes["Événements"])).toEqual([lignes["Événements"].a]);
    expect(dans(intl, lignes["Prise en charge Internationale"])).toEqual([lignes["Prise en charge Internationale"].a]);
    expect(dans(demandes, lignes["Bureau du secrétariat"])).toEqual([lignes["Bureau du secrétariat"].a]);
    expect(dans(marches, lignes["Marchés PCH"])).toEqual([lignes["Marchés PCH"].a, lignes["Marchés PCH"].n].sort());
  });

  it("un praticien d'un annuaire FERMÉ ne sort pas de la recherche — ni un contrat restreint à d'autres", async () => {
    const dir = await prisma.medicalDirectory.create({ data: { name: `${TAG}Fermé`, createdById: redac } });
    await prisma.medicalDirectoryAccess.create({ data: { directoryId: dir.id, userId: autre, grantedById: redac } });
    const [ferme, restreint] = await Promise.all([
      prisma.medicalDoctor.create({ data: { name: `${TAG}${MOT} fermé`, companyId: A, directoryId: dir.id } }),
      prisma.legalDocument.create({ data: { title: `${TAG}${MOT} restreint`, companyId: A, readers: { create: [{ userId: autre }] } } }),
    ]);
    const r = await globalSearch(await acteur(gm), MOT, 20);
    expect(trouves(r, "Annuaire")).not.toContain(ferme.id);
    expect(trouves(r, "Legal")).not.toContain(restreint.id);
    // Le témoin : le praticien d'Alpha rangé nulle part, et le contrat d'Alpha sans lecteur
    // désigné, sortent bien — sans eux, une recherche qui ne rendrait plus rien passerait au vert.
    expect(trouves(r, "Annuaire")).toContain(lignes["Annuaire"].a);
    expect(trouves(r, "Legal")).toContain(lignes["Legal"].a);
  });

  it("l'assistante réglementaire : portée par ligne, verrou et gamme tiennent ENSEMBLE", async () => {
    const u = await acteur(assistant);
    // PRÉMISSES — sans elles le cas ne mesurerait rien : elle n'a ni la portée « toutes les
    // lignes », ni l'accès au pipeline, et sa gamme RESTREINT (une gamme de Gamma, entité qui
    // n'est pas la sienne).
    expect(u.access.modules.get("REGULATORY")?.scope).not.toBe("ALL");
    expect(seesLockedRegulatory(u)).toBe(false);
    const gamme = await prisma.userProductRange.findFirstOrThrow({ where: { userId: assistant }, select: { rangeId: true } });
    const [sien, pasSien, verrouille] = await Promise.all([
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-${MOT}-sien`, dci: `${TAG}${MOT} sien`, companyId: A, responsibleId: assistant } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-${MOT}-passien`, dci: `${TAG}${MOT} pas sien`, companyId: A } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-${MOT}-verrou`, dci: `${TAG}${MOT} verrouillé`, companyId: A, responsibleId: assistant, isLocked: true } }),
    ]);
    const dansGamme = await prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-${MOT}-gamme`, dci: `${TAG}${MOT} gamme`, companyId: C, rangeId: gamme.rangeId, responsibleId: assistant } });
    // L'écran : la clause UNIQUE. Avant la réparation, la clé `AND` de la gamme écrasait celle de
    // la portée, et l'assistante voyait le dossier d'un autre ET le dossier verrouillé.
    const visibles = (await prisma.regulatoryProduct.findMany({
      where: { AND: [await regulatoryVisibleWhere(u) as never, { dci: { contains: `${TAG}${MOT}` } }] },
      select: { id: true },
    })).map((p) => p.id);
    expect(visibles).toContain(sien.id);
    expect(visibles).toContain(dansGamme.id);
    expect(visibles).not.toContain(pasSien.id);
    expect(visibles).not.toContain(verrouille.id);
    // La recherche lit la même clause.
    const r = await globalSearch(u, MOT, 20);
    expect(trouves(r, "Regulatory")).toContain(sien.id);
    expect(trouves(r, "Regulatory")).not.toContain(pasSien.id);
    expect(trouves(r, "Regulatory")).not.toContain(verrouille.id);
  });

  it("dossiers CTD : la permission du module, puis l'organisation ACTIVÉE et OUVERTE à la personne", async () => {
    await prisma.regulatoryFeatureAccess.createMany({ data: [{ companyId: A, enabled: true }, { companyId: B, enabled: true }] });
    const [da, db] = await Promise.all([
      prisma.regulatoryDossier.create({ data: { companyId: A, reference: `${TAG}CTD-${MOT}-a`, title: `${TAG}${MOT} ctd a`, createdById: head } }),
      prisma.regulatoryDossier.create({ data: { companyId: B, reference: `${TAG}CTD-${MOT}-b`, title: `${TAG}${MOT} ctd b`, createdById: head } }),
    ]);
    const h = await acteur(head);
    const g = await acteur(gm);
    // PRÉMISSES : le Responsable a la permission, le Directeur Général non.
    expect(regCan(h, "regulatory.workspace.view")).toBe(true);
    expect(regCan(g, "regulatory.workspace.view")).toBe(false);

    // Sans cookie : l'entité de la personne.
    expect(await resolveRegCompanyIdFor(head)).toBe(A);
    let r = await globalSearch(h, MOT, 20);
    expect(trouves(r, "Dossiers CTD")).toEqual([da.id]);
    // Sans la permission du module : rien, quelle que soit l'entité.
    r = await globalSearch(g, MOT, 20);
    expect(trouves(r, "Dossiers CTD")).toEqual([]);

    // LE COOKIE FORGÉ : l'identifiant de Beta, écrit à la main. Avant la réparation, la seule
    // vérification était l'activation du module — et Beta l'a. Il retombe sur Alpha.
    cookieEntite = B;
    expect(await resolveRegCompanyIdFor(head)).toBe(A);
    r = await globalSearch(h, MOT, 20);
    expect(trouves(r, "Dossiers CTD")).not.toContain(db.id);
  });

  it("dossiers CTD : « toutes les entités » ne désigne jamais l'organisation activée d'une AUTRE société", async () => {
    // Seule Beta est activée ici (Alpha est désactivée le temps du cas) : avant la réparation, la
    // vue « toutes les entités » désignait l'UNIQUE organisation activée — Beta — à quelqu'un
    // d'Alpha.
    await prisma.regulatoryFeatureAccess.upsert({ where: { companyId: A }, update: { enabled: false }, create: { companyId: A, enabled: false } });
    await prisma.regulatoryFeatureAccess.upsert({ where: { companyId: B }, update: { enabled: true }, create: { companyId: B, enabled: true } });
    try {
      expect(await resolveRegCompanyIdFor(head)).toBeNull();
    } finally {
      await prisma.regulatoryFeatureAccess.update({ where: { companyId: A }, data: { enabled: true } });
    }
  });

  it("dossiers CTD : pour qui a PLUSIEURS entités, « toutes les entités » choisit parmi les SIENNES", async () => {
    // Le cas précédent ne joue que la personne MONO-entité : sa portée se résout d'office sur sa
    // société, et la branche « toutes les entités » n'est jamais atteinte — un sabotage qui la
    // rouvrait à toutes les organisations est passé au vert (§118.111). Il faut une personne à DEUX
    // entités (Alpha et Gamma), sans cookie : sa portée reste « toutes », et c'est le choix PARMI SES
    // entités qui décide.
    const pluri = await prisma.user.create({ data: { name: `${TAG}pluri`, email: `${TAG}pluri@t.dz`, role: "HEAD_OF_REGULATORY" as never, passwordHash: "x" } });
    await prisma.employee.create({ data: { fullName: `${TAG}salarié pluri`, companyId: A, userId: pluri.id } });
    await prisma.userCompanyAccess.create({ data: { userId: pluri.id, companyId: C } });
    await prisma.regulatoryFeatureAccess.upsert({ where: { companyId: A }, update: { enabled: false }, create: { companyId: A, enabled: false } });
    await prisma.regulatoryFeatureAccess.upsert({ where: { companyId: B }, update: { enabled: true }, create: { companyId: B, enabled: true } });
    try {
      // Seule Beta — qui n'est PAS la sienne — est activée : rien ne doit être désigné.
      expect(await resolveRegCompanyIdFor(pluri.id)).toBeNull();
      // Le témoin : Gamma activée, c'est l'unique organisation activée PARMI LES SIENNES.
      await prisma.regulatoryFeatureAccess.create({ data: { companyId: C, enabled: true } });
      expect(await resolveRegCompanyIdFor(pluri.id)).toBe(C);
    } finally {
      await prisma.regulatoryFeatureAccess.update({ where: { companyId: A }, data: { enabled: true } });
      await prisma.regulatoryFeatureAccess.deleteMany({ where: { companyId: C } });
    }
  });

  it("directives : la publication et l'audience, pas « personne en particulier »", async () => {
    const mkD = (k: string, data: Record<string, unknown>) => prisma.directive.create({
      data: { reference: `${TAG}DIR-${MOT}-${k}`, title: `${TAG}${MOT} directive ${k}`, body: "Note.", fromId: redac, ...data } as never,
    });
    const [brouillon, publieeTous, autreRole, sonRole] = await Promise.all([
      mkD("brouillon", { audience: "ALL", publication: "DRAFT" }),
      mkD("tous", { audience: "ALL", publication: "PUBLISHED" }),
      mkD("autrerole", { audience: "ROLE", targetRole: "SALES_USER", publication: "PUBLISHED" }),
      mkD("sonrole", { audience: "ROLE", targetRole: "GENERAL_MANAGER", publication: "PUBLISHED" }),
    ]);
    const u = await acteur(gm);
    // PRÉMISSE : sa portée sur les directives n'est PAS « toutes les lignes ».
    expect(u.access.modules.get("DIRECTIVES")?.scope).not.toBe("ALL");
    const vus = trouves(await globalSearch(u, MOT, 20), "Directives");
    expect(vus).toContain(publieeTous.id);
    expect(vus).toContain(sonRole.id);
    expect(vus).not.toContain(brouillon.id);
    expect(vus).not.toContain(autreRole.id);
  });

  it("discussions : un ancien membre ne retrouve ni le groupe, ni ses messages", async () => {
    const conv = await prisma.conversation.create({ data: { type: "GROUP", title: `${TAG}${MOT} groupe` } });
    await prisma.conversationMember.createMany({
      data: [{ conversationId: conv.id, userId: actif }, { conversationId: conv.id, userId: ancien, leftAt: new Date() }],
    });
    const msg = await prisma.message.create({ data: { conversationId: conv.id, body: `${TAG}${MOT} posté après son départ`, senderId: actif } });
    const parti = await globalSearch(await acteur(ancien), MOT, 20);
    expect(parti.filter((x) => x.group === "Discussions").map((x) => x.id)).toEqual([]);
    // Le témoin : le membre actif trouve le groupe ET le message.
    const reste = await globalSearch(await acteur(actif), MOT, 20);
    expect(reste.filter((x) => x.group === "Discussions").map((x) => x.id).sort()).toEqual([conv.id, msg.id].sort());
  });

  it("documents : le nom d'un fichier d'un module qu'on ne voit pas ne sort pas", async () => {
    const doc = await prisma.document.create({
      data: { name: `${TAG}${MOT} fichier.pdf`, entityType: "REGULATORY_PRODUCT", entityId: lignes["Regulatory"].a },
    });
    const v = await acteur(viewer);
    // PRÉMISSE : le lecteur a la bibliothèque des documents, pas Regulatory.
    expect(v.access.modules.has("DOCUMENTS")).toBe(true);
    expect(v.access.modules.has("REGULATORY")).toBe(false);
    expect(trouves(await globalSearch(v, MOT, 20), "Documents")).not.toContain(doc.id);
    // Le témoin : qui voit Regulatory le trouve.
    expect(trouves(await globalSearch(await acteur(gm), MOT, 20), "Documents")).toContain(doc.id);
  });

  it("tâches : la vue globale prêtée par un rôle SECONDAIRE n'ouvre pas la palette plus que la fiche", async () => {
    const mkT = (k: string, data: Record<string, unknown>) => prisma.task.create({ data: { title: `${TAG}${MOT} tâche ${k}`, ...data } as never });
    const [etrangere, participe, lecteur] = await Promise.all([
      mkT("étrangère", { assignedToId: autre, createdById: autre }),
      mkT("participe", { assignedToId: autre, createdById: autre, participantIds: [sec] }),
      mkT("lecteur", { assignedToId: autre, createdById: autre, readerIds: [sec] }),
    ]);
    const u = await acteur(sec);
    // PRÉMISSE : la vue globale vient du rôle SECONDAIRE seulement.
    expect(u.role).toBe("SALES_USER");
    expect(u.secondaryRole).toBe("DIRECTION");
    const vus = trouves(await globalSearch(u, MOT, 20), "Mes tâches");
    expect(vus).not.toContain(etrangere.id);
    expect(vus).toContain(participe.id);
    expect(vus).toContain(lecteur.id);
    // LA LISTE ≡ LA RÈGLE : la clause et `canSee` (la fiche) répondent pareil, tâche par tâche.
    const toutes = await prisma.task.findMany({ where: { title: { contains: `${TAG}${MOT}` } } });
    const parClause = new Set((await prisma.task.findMany({
      where: { AND: [clauseTachesVisibles(sec, false), { title: { contains: `${TAG}${MOT}` } }] }, select: { id: true },
    })).map((t) => t.id));
    for (const t of toutes) expect(parClause.has(t.id), `${t.title}`).toBe(canSee(t, sec, false));
    // Et la liste pleine est bien rendue à la vue globale du rôle PRINCIPAL.
    expect(clauseTachesVisibles(sec, true)).toEqual({});
  });
});
