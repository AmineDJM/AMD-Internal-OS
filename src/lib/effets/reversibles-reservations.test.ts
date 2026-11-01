import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10c — LES FICHES DE VOYAGE, RÉVERSIBLES : chaque action de `reservation-fiche-actions` EXÉCUTÉE (la vraie, au clic
 * de l'écran), puis ANNULÉE (le bouton « Annuler »), contre la base locale. On vérifie la fiche (état et champs
 * d'avant), le fil du sujet, les notifications (retirées non lues, rectifiées lues), le journal et l'audit ; on
 * RÉTABLIT au moins une fois ; et la CASCADE : une fiche prise depuis par l'assistante ne se « désenvoie » pas —
 * l'annulation refuse, la liste dit pourquoi, rien n'est écrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import { ajouterVoyageur, ajouterHebergement } from "@/modules/ad-pro/actions-postes-voyageurs";
import {
  envoyerFiche, envoyerFichesPretes, relancerFiche, retirerFiche, prendreFiche, signalerManque, deposerBillet, joindreDevisAgence,
} from "@/lib/actions/reservation-fiche-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zk10cresa${Date.now()}`;
let DEM: CurrentUser, A1: CurrentUser, A2: CurrentUser;
const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], nom, { type: "application/pdf" });

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false } as unknown as CurrentUser;
}
/** Le geste que l'action vient d'inscrire — `annulable.gesteId` rendu à l'écran. */
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string, qui: CurrentUser): Promise<CompteRenduAnnulation> => {
  const r = await annulerGeste(gesteId, qui);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
const retablir = async (gesteId: string, qui: CurrentUser): Promise<CompteRenduAnnulation> => {
  const r = await retablirGeste(gesteId, qui);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
/** L'annulation est au journal (qui, quand) et à l'audit. */
const traceeDe = async (gesteId: string, qui: CurrentUser) => {
  const g = await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: gesteId } });
  expect(g.annuleParId).toBe(qui.id);
  expect(g.annuleLe).toBeTruthy();
  expect(await prisma.auditLog.count({ where: { entityId: gesteId, summary: { contains: "Annulation" } } })).toBe(1);
};
const fiche = (id: string) => prisma.demandeReservation.findUniqueOrThrow({ where: { id } });
const filDe = (dossierId: string) => prisma.dossierMessage.count({ where: { dossierId } });

suite("K10c — fiches de voyage : exécuter, annuler, rétablir", () => {
  let congres = "", posteBillet = "", posteHotel = "", voyageur = "", voyageur2 = "", hotel = "", demande = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n} Testeur`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [dem, a1, a2] = await Promise.all([mk("dem", "PRODUCT_MANAGER"), mk("assia", "DIRECTION_ASSISTANT"), mk("donna", "DIRECTION_ASSISTANT")]);
    DEM = await acteur(dem.id, "PRODUCT_MANAGER");
    A1 = await acteur(a1.id, "DIRECTION_ASSISTANT");
    A2 = await acteur(a2.id, "DIRECTION_ASSISTANT");
    congres = (await prisma.congressNational.create({ data: { name: `${TAG}Congrès`, requestStatus: "AWAITING_FINAL", requesterId: dem.id }, select: { id: true } })).id;
    posteBillet = (await prisma.adProItem.create({ data: { congressNationalId: congres, kind: "TICKETING", label: `${TAG}Billetterie`, status: "APPROVED", amountGranted: 124_750, supplier: "Genius Travel" } })).id;
    posteHotel = (await prisma.adProItem.create({ data: { congressNationalId: congres, kind: "ACCOMMODATION", label: `${TAG}Hôtellerie`, status: "PENDING" } })).id;
    ACTOR = DEM;
    const f = fd({
      itemId: posteBillet, nom: "Smail", prenom: "Salem", villeDepart: "Alger", villeArrivee: "Constantine",
      dateDepart: "2026-12-03", dateRetour: "2026-12-05", trajet: "ALLER_RETOUR", transport: "AVION",
    });
    f.append("passeport", pdf(`${TAG}passeport.pdf`));
    const v = await ajouterVoyageur(undefined, f);
    if (!v.ok) throw new Error(v.error);
    voyageur = v.id!;
    const f2 = fd({
      itemId: posteBillet, nom: "Brahimi", prenom: "Lina", villeDepart: "Oran", villeArrivee: "Constantine",
      dateDepart: "2026-12-03", dateRetour: "2026-12-05", trajet: "ALLER_RETOUR", transport: "AVION",
    });
    f2.append("passeport", pdf(`${TAG}passeport2.pdf`));
    const v2 = await ajouterVoyageur(undefined, f2);
    if (!v2.ok) throw new Error(v2.error);
    voyageur2 = v2.id!;
    const h = await ajouterHebergement(undefined, fd({ itemId: posteHotel, nom: "Fennich", prenom: "Nora", ville: "Constantine", dateArrivee: "2026-12-03", dateDepart: "2026-12-05", typeChambre: "Single" }));
    if (!h.ok) throw new Error(h.error);
    hotel = h.id!;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const users = [DEM.id, A1.id, A2.id];
    const sujets = (await prisma.dossier.findMany({ where: { title: { contains: TAG } }, select: { id: true } })).map((d) => d.id);
    const items = await prisma.adProItem.findMany({ where: { id: { in: [posteBillet, posteHotel] } }, select: { reservationDossierId: true } });
    const tous = [...new Set([...sujets, ...items.map((x) => x.reservationDossierId).filter((x): x is string => !!x)])];
    const reqs = await prisma.documentRequest.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: [posteBillet, posteHotel] } }, select: { id: true } });
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: users } } }).catch(() => undefined);
    await prisma.document.deleteMany({ where: { entityId: { in: [posteBillet, posteHotel, congres, ...reqs.map((r) => r.id)] } } }).catch(() => undefined);
    await prisma.documentRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } }).catch(() => undefined);
    await prisma.adProItem.deleteMany({ where: { id: { in: [posteBillet, posteHotel] } } }).catch(() => undefined);
    await prisma.congressNational.deleteMany({ where: { id: congres } }).catch(() => undefined);
    await prisma.dossier.deleteMany({ where: { id: { in: tous } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
  }, 60_000);

  it("envoyerFiche (premier envoi) : la demande, le sujet ouvert pour elle et les notifications sont retirés", async () => {
    ACTOR = DEM;
    const g = gesteDe(await envoyerFiche(fd({ source: "VOYAGEUR", id: voyageur2 })));
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { voyageurId: voyageur2 } });
    expect(d.etat).toBe("ENVOYEE");
    const sujet = d.dossierId!;
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteBillet } })).reservationDossierId).toBe(sujet);
    // Les notifications nées de CE geste (d'autres bancs préviennent les mêmes assistantes en parallèle).
    const nees = (await prisma.assistantEffet.findMany({ where: { gesteId: g, modele: "Notification", operation: "CREATE" }, select: { enregistrementId: true } })).map((e) => e.enregistrementId!);
    expect(await prisma.notification.count({ where: { id: { in: nees }, userId: { in: [A1.id, A2.id] } } })).toBeGreaterThan(0);
    const c = await annuler(g, DEM);
    // Tout est défait dans l'ERP ; seules les notifications poussées, déjà parties, restent dites « impossibles ».
    expect(c.baseDefaite, c.resume).toBe(true);
    expect(c.details.filter((x) => x.issue === "IMPOSSIBLE").every((x) => x.externe)).toBe(true);
    expect(await prisma.demandeReservation.count({ where: { voyageurId: voyageur2 } })).toBe(0);
    expect(await prisma.dossier.count({ where: { id: sujet } })).toBe(0);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteBillet } })).reservationDossierId).toBeNull();
    expect(await prisma.notification.count({ where: { id: { in: nees } } })).toBe(0);
    await traceeDe(g, DEM);
  });

  it("prendreFiche : la fiche revient « envoyée », la notification LUE est rectifiée ; rétablir la redonne à l'assistante", async () => {
    ACTOR = DEM;
    expect((await envoyerFiche(fd({ source: "VOYAGEUR", id: voyageur }))).ok).toBe(true);
    demande = (await prisma.demandeReservation.findUniqueOrThrow({ where: { voyageurId: voyageur } })).id;
    const sujet = (await fiche(demande)).dossierId!;
    const fil = await filDe(sujet);
    ACTOR = A2;
    const prise = gesteDe(await prendreFiche(fd({ id: demande })));
    expect((await fiche(demande)).etat).toBe("PRISE");
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: DEM.id, title: { contains: "s'occupe" } }, orderBy: { createdAt: "desc" } });
    await prisma.notification.update({ where: { id: note.id }, data: { isRead: true } });
    const c = await annuler(prise, A2);
    expect(c.details.some((x) => x.issue === "COMPENSE" && /rectificatif/.test(x.pourquoi))).toBe(true);
    let d = await fiche(demande);
    expect(d.etat).toBe("ENVOYEE");
    expect(d.priseParId).toBeNull();
    expect(d.priseLe).toBeNull();
    expect(await filDe(sujet)).toBe(fil);
    expect(await prisma.notification.count({ where: { userId: DEM.id, title: { startsWith: "Rectificatif" } } })).toBe(1);
    await traceeDe(prise, A2);
    await retablir(prise, A2);
    d = await fiche(demande);
    expect(d.etat).toBe("PRISE");
    expect(d.priseParId).toBe(A2.id);
    expect(await filDe(sujet)).toBe(fil + 1);
  });

  it("relancerFiche : le compteur et la date de relance reviennent, la ligne du fil est retirée", async () => {
    await prisma.demandeReservation.update({ where: { id: demande }, data: { envoyeeLe: new Date(Date.now() - 25 * 3600_000), priseLe: new Date(Date.now() - 25 * 3600_000) } });
    const avant = await fiche(demande);
    const sujet = avant.dossierId!;
    const fil = await filDe(sujet);
    ACTOR = DEM;
    const g = gesteDe(await relancerFiche(fd({ id: demande, message: "le congrès est le 3/12" })));
    expect((await fiche(demande)).relances).toBe(avant.relances + 1);
    await annuler(g, DEM);
    const d = await fiche(demande);
    expect(d.relances).toBe(avant.relances);
    expect(d.derniereRelanceLe).toEqual(avant.derniereRelanceLe);
    expect(await filDe(sujet)).toBe(fil);
    expect(await prisma.notification.count({ where: { userId: A2.id, title: { startsWith: "Relance" } } })).toBe(0);
    await traceeDe(g, DEM);
  });

  it("signalerManque : la fiche revient « prise », motif et date du manque effacés", async () => {
    ACTOR = A2;
    const g = gesteDe(await signalerManque(fd({ id: demande, motif: "Il me faut l'heure du congrès." })));
    expect((await fiche(demande)).etat).toBe("MANQUE_SIGNALE");
    await annuler(g, A2);
    const d = await fiche(demande);
    expect(d.etat).toBe("PRISE");
    expect(d.manqueMotif).toBeNull();
    expect(d.manqueLe).toBeNull();
    expect(d.manqueParId).toBeNull();
    expect(await prisma.notification.count({ where: { userId: DEM.id, title: "Fiche de voyage à compléter" } })).toBe(0);
    await traceeDe(g, A2);
  });

  it("retirerFiche : la fiche retirée revient « prise » par la même assistante", async () => {
    ACTOR = DEM;
    const avant = await fiche(demande);
    const g = gesteDe(await retirerFiche(fd({ id: demande, motif: "Il ne vient plus." })));
    expect((await fiche(demande)).etat).toBe("RETIREE");
    await annuler(g, DEM);
    const d = await fiche(demande);
    expect(d.etat).toBe("PRISE");
    expect(d.priseParId).toBe(A2.id);
    expect(d.priseLe).toEqual(avant.priseLe);
    expect(d.retireeLe).toBeNull();
    expect(d.retraitMotif).toBeNull();
    await traceeDe(g, DEM);
  });

  it("CASCADE : une fiche prise depuis par une autre assistante ne se « renvoie » pas à l'envers — refus, liste, rien d'écrit", async () => {
    ACTOR = DEM;
    expect((await retirerFiche(fd({ id: demande, motif: "Changement de voyageur." }))).ok).toBe(true);
    const g = gesteDe(await envoyerFiche(fd({ source: "VOYAGEUR", id: voyageur })));
    expect((await fiche(demande)).etat).toBe("ENVOYEE");
    ACTOR = A1;
    expect((await prendreFiche(fd({ id: demande }))).ok).toBe(true);
    const r = await annulerGeste(g, DEM);
    expect("refus" in r ? r.refus : "").toMatch(/Rien n'est annulé/);
    expect("refus" in r ? r.bloquants?.some((b) => /r[ée]servation/i.test(b.quoi) && /vaut maintenant/.test(b.pourquoi)) : false).toBe(true);
    const d = await fiche(demande);
    expect(d.etat).toBe("PRISE");
    expect(d.priseParId).toBe(A1.id);
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: g } })).annuleLe).toBeNull();
  });

  it("deposerBillet : la fiche revient « prise », les billets déposés sont retirés", async () => {
    ACTOR = A1;
    const f = fd({ id: demande, reference: "PNR123" });
    f.append("pieces", pdf(`${TAG}billet.pdf`));
    const g = gesteDe(await deposerBillet(f));
    const reservee = await fiche(demande);
    expect(reservee.etat).toBe("RESERVEE");
    expect(reservee.pieceIds).toHaveLength(1);
    await annuler(g, A1);
    const d = await fiche(demande);
    expect(d.etat).toBe("PRISE");
    expect(d.pieceIds).toEqual([]);
    expect(d.referenceReservation).toBeNull();
    expect(d.reserveeLe).toBeNull();
    expect(await prisma.document.count({ where: { id: { in: reservee.pieceIds } } })).toBe(0);
    await traceeDe(g, A1);
  });

  it("envoyerFichesPretes : chaque fiche envoyée par le lot est retirée", async () => {
    ACTOR = DEM;
    const g = gesteDe(await envoyerFichesPretes(fd({ itemId: posteHotel })));
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { hebergementId: hotel } });
    expect(d.etat).toBe("ENVOYEE");
    await annuler(g, DEM);
    expect(await prisma.demandeReservation.count({ where: { hebergementId: hotel } })).toBe(0);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteHotel } })).reservationDossierId).toBeNull();
    await traceeDe(g, DEM);
  });

  it("joindreDevisAgence : la demande de pièce et le devis sont retirés, la fiche revient « envoyée »", async () => {
    ACTOR = DEM;
    // Envoyée (ou laissée envoyée par le cas précédent, s'il n'a pas pu la retirer).
    if (!(await prisma.demandeReservation.count({ where: { hebergementId: hotel } }))) expect((await envoyerFiche(fd({ source: "HEBERGEMENT", id: hotel }))).ok).toBe(true);
    const d0 = await prisma.demandeReservation.findUniqueOrThrow({ where: { hebergementId: hotel } });
    ACTOR = A2;
    const f = fd({ id: d0.id, fournisseur: "Genius Travel", montant: "38000" });
    f.append("attachment", pdf(`${TAG}devis.pdf`));
    const g = gesteDe(await joindreDevisAgence(f));
    const recu = await fiche(d0.id);
    expect(recu.etat).toBe("DEVIS_RECU");
    const pieceId = recu.devisRef!;
    await annuler(g, A2);
    const d = await fiche(d0.id);
    expect(d.etat).toBe("ENVOYEE");
    expect(d.devisRef).toBeNull();
    expect(d.devisRecuLe).toBeNull();
    expect(d.priseParId).toBeNull();
    expect(await prisma.documentRequest.count({ where: { id: pieceId } })).toBe(0);
    expect(await prisma.document.count({ where: { entityType: "DOCUMENT_REQUEST", entityId: pieceId } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: DEM.id, title: { in: ["Devis de l'agence reçu", "Pièce déposée"] } } })).toBe(0);
    await traceeDe(g, A2);
  });
});
