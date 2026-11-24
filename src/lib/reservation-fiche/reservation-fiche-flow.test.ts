import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { ajouterVoyageur, modifierVoyageur, ajouterHebergement } from "@/modules/ad-pro/actions-postes-voyageurs";
import {
  envoyerFiche, envoyerFichesPretes, relancerFiche, retirerFiche, prendreFiche, signalerManque, deposerBillet, joindreDevisAgence,
} from "@/lib/actions/reservation-fiche-actions";
import { envoisDesFiches, ficheDuBureau, fichesDuBureau } from "@/lib/queries/reservations-fiches";
import { decideDocumentRequest } from "@/lib/actions/document-request-actions";
import { REFUS_AVANT_ACCORD } from "@/lib/reservation-fiche/etat";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__resafiche__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], nom, { type: "application/pdf" });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES DE VOYAGE CHEZ L'ASSISTANTE, PAR LES VRAIES ACTIONS (Direction, 14/10/2026).
 *
 * Un congrès national porte un poste « billetterie » (un voyageur), un poste « hôtellerie » (une fiche) et une
 * personne prise en charge (son billet). Le demandeur est une Direction Marketing SANS vue globale ; deux
 * assistantes de direction se disputent la même fiche. Chaque cas éprouve une garde : un seul envoi sous la
 * course, la relance trop tôt, la prise concurrente, le manque signalé, la modification après l'envoi, le
 * billet refusé avant l'accord — sur le poste Ad & Pro ET sur la prise en charge.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Fiches de voyage — envoi, relance, prise, manque, modification, dépôt", () => {
  let demId = "", a1Id = "", a2Id = "", congres = "", posteBillet = "", posteHotel = "", voyageur = "", hotel = "";
  let personne = "", billetCare = "";
  let DEM: CurrentUser, A1: CurrentUser, A2: CurrentUser;
  let demande = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n} Testeur`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    const [dem, a1, a2] = await Promise.all([mk("dem", "PRODUCT_MANAGER"), mk("assia", "DIRECTION_ASSISTANT"), mk("donna", "DIRECTION_ASSISTANT")]);
    demId = dem.id; a1Id = a1.id; a2Id = a2.id;
    DEM = await acteur(demId, "PRODUCT_MANAGER");
    A1 = await acteur(a1Id, "DIRECTION_ASSISTANT");
    A2 = await acteur(a2Id, "DIRECTION_ASSISTANT");
    congres = (await prisma.congressNational.create({ data: { name: `${TAG}Congrès de cardiologie`, requestStatus: "AWAITING_FINAL", requesterId: demId }, select: { id: true } })).id;
    posteBillet = (await prisma.adProItem.create({ data: { congressNationalId: congres, kind: "TICKETING", label: `${TAG}Prise en charge de la billetterie`, status: "PENDING", amountGranted: 124_750, supplier: "Genius Travel" } })).id;
    posteHotel = (await prisma.adProItem.create({ data: { congressNationalId: congres, kind: "ACCOMMODATION", label: `${TAG}Prise en charge de l'hôtellerie`, status: "PENDING" } })).id;

    ACTOR = DEM;
    const f = fd({
      itemId: posteBillet, nom: "Smail", prenom: "Salem", villeDepart: "Alger", villeArrivee: "Constantine",
      dateDepart: "2026-10-23", dateRetour: "2026-10-25", trajet: "ALLER_RETOUR", transport: "AVION",
    });
    f.append("passeport", pdf(`${TAG}passeport.pdf`));
    const v = await ajouterVoyageur(undefined, f);
    if (!v.ok) throw new Error(v.error);
    voyageur = v.id!;
    const h = await ajouterHebergement(undefined, fd({ itemId: posteHotel, nom: "Fennich", prenom: "Nora", ville: "Constantine", dateArrivee: "2026-10-23", dateDepart: "2026-10-25", typeChambre: "Single" }));
    if (!h.ok) throw new Error(h.error);
    hotel = h.id!;

    personne = (await prisma.careBeneficiary.create({ data: { congressNationalId: congres, firstName: "Mohamed Adel", lastName: "Chahed", status: "PROPOSED" } })).id;
    billetCare = (await prisma.careCell.create({
      data: {
        beneficiaryId: personne, kind: "SERVICE", serviceKind: "TICKET", label: "Billetterie", trajet: "ALLER_RETOUR", transport: "AVION",
        fromCity: "Ouargla", toCity: "Constantine", dateStart: new Date("2026-10-22"), dateEnd: new Date("2026-10-26"),
      },
    })).id;
  }, 60_000);

  afterAll(async () => {
    ACTOR = null;
    const sujets = [
      ...(await prisma.adProItem.findMany({ where: { id: { in: [posteBillet, posteHotel] } }, select: { reservationDossierId: true } })).map((x) => x.reservationDossierId),
      (await prisma.congressNational.findUnique({ where: { id: congres }, select: { careReservationDossierId: true } }))?.careReservationDossierId,
    ].filter((x): x is string => Boolean(x));
    const reqs = await prisma.documentRequest.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: [posteBillet, posteHotel] } }, select: { id: true, legalDocumentId: true } });
    // Les devis ACCEPTÉS sont au registre Legal (fichiers déménagés vers eux) : ils partent avec le reste.
    const legaux = reqs.map((r) => r.legalDocumentId).filter((x): x is string => Boolean(x));
    // Les fiches envoyées préviennent TOUTES les assistantes actives de la base, pas seulement celles du banc : leurs
    // notifications se retrouvent par leur lien (la fiche, la pièce, l'opération).
    const fichesIds = (await prisma.demandeReservation.findMany({ where: { OR: [{ itemId: { in: [posteBillet, posteHotel] } }, { operationId: congres }] }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    for (const cle of [...fichesIds, ...reqs.map((r) => r.id), ...sujets, congres]) await prisma.notification.deleteMany({ where: { link: { contains: cle } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { entityId: { in: [posteBillet, posteHotel, congres, ...reqs.map((r) => r.id), ...legaux] } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: [posteBillet, posteHotel] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: legaux } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => {});
    await prisma.legalFolder.deleteMany({ where: { name: { contains: TAG } } }).catch(() => {});
    await prisma.careQuote.deleteMany({ where: { congressNationalId: congres } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { congressNationalId: congres } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: congres } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { id: { in: sujets } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [demId, a1Id, a2Id] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [demId, a1Id, a2Id] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [demId, a1Id, a2Id] } } }).catch(() => {});
  }, 60_000);

  it("deux clics sur « Envoyer » : UN envoi, UNE demande, UNE ligne au fil", async () => {
    ACTOR = DEM;
    const [r1, r2] = await Promise.all([
      envoyerFiche(fd({ source: "VOYAGEUR", id: voyageur })),
      envoyerFiche(fd({ source: "VOYAGEUR", id: voyageur })),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect((r1.ok ? r2 : r1).error).toMatch(/déjà chez l'assistante/);
    const demandes = await prisma.demandeReservation.findMany({ where: { voyageurId: voyageur } });
    expect(demandes).toHaveLength(1);
    demande = demandes[0]!.id;
    expect(demandes[0]!.etat).toBe("ENVOYEE");
    expect(demandes[0]!.empreinte).toMatchObject({ Voyageur: "Salem Smail", Aller: "23/10/2026" });
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: posteBillet }, select: { reservationDossierId: true } });
    expect(poste.reservationDossierId).toBe(demandes[0]!.dossierId);
    const fil = await prisma.dossierMessage.findMany({ where: { dossierId: poste.reservationDossierId! } });
    expect(fil.filter((m) => m.body.startsWith("Fiche envoyée"))).toHaveLength(1);
    // Le sujet est ouvert aux assistantes : elles lisent le passeport et écrivent au fil.
    const sujet = await prisma.dossier.findUniqueOrThrow({ where: { id: poste.reservationDossierId! } });
    expect([sujet.assignedToId, ...sujet.participantIds]).toEqual(expect.arrayContaining([a1Id]));
    // L'écran du demandeur dit « Chez l'assistante ».
    const vue = (await envoisDesFiches({ voyageurIds: [voyageur] }))[voyageur]!;
    expect(vue.etat).toBe("ENVOYEE");
    expect(vue.libelle).toBe("Chez l'assistante");
  });

  it("la relance : refusée avant 24 h, partie après, refusée de nouveau juste après", async () => {
    ACTOR = DEM;
    const tot = await relancerFiche(fd({ id: demande }));
    expect(tot.ok).toBe(false);
    expect(tot.error).toMatch(/24 h/);
    await prisma.demandeReservation.update({ where: { id: demande }, data: { envoyeeLe: new Date(Date.now() - 25 * 3600_000) } });
    const ok = await relancerFiche(fd({ id: demande, message: "le congrès est le 23/10" }));
    expect(ok.ok, ok.error).toBe(true);
    const encore = await relancerFiche(fd({ id: demande }));
    expect(encore.ok).toBe(false);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: demande } });
    expect(d.relances).toBe(1);
    // Personne ne l'a prise : toutes les assistantes actives sont prévenues.
    const notes = await prisma.notification.findMany({ where: { userId: { in: [a1Id, a2Id] }, title: { startsWith: "Relance" } } });
    expect(new Set(notes.map((n) => n.userId))).toEqual(new Set([a1Id, a2Id]));
  });

  it("deux assistantes prennent la même fiche au même instant : une seule la prend, l'autre apprend qui", async () => {
    ACTOR = A1;
    const p1 = prendreFiche(fd({ id: demande }));
    ACTOR = A2;
    const p2 = prendreFiche(fd({ id: demande }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const perdante = r1.ok ? r2 : r1;
    expect(perdante.error).toMatch(/vient de prendre|déjà prise/);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: demande } });
    expect(d.etat).toBe("PRISE");
    expect([a1Id, a2Id]).toContain(d.priseParId);
    // Le demandeur relance plus tard : SEULE celle qui l'a prise est prévenue.
    await prisma.demandeReservation.update({ where: { id: demande }, data: { derniereRelanceLe: new Date(Date.now() - 25 * 3600_000) } });
    await prisma.notification.deleteMany({ where: { userId: { in: [a1Id, a2Id] } } });
    ACTOR = DEM;
    expect((await relancerFiche(fd({ id: demande }))).ok).toBe(true);
    const notes = await prisma.notification.findMany({ where: { userId: { in: [a1Id, a2Id] }, title: { startsWith: "Relance" } } });
    expect(notes.map((n) => n.userId)).toEqual([d.priseParId]);
    // Pour la suite : Assia la tient.
    await prisma.demandeReservation.update({ where: { id: demande }, data: { priseParId: a1Id } });
  });

  it("un billet ne se dépose pas avant l'accord du poste", async () => {
    ACTOR = A1;
    const f = fd({ id: demande, reference: "PNR123" });
    f.append("pieces", pdf(`${TAG}billet.pdf`));
    const r = await deposerBillet(f);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(REFUS_AVANT_ACCORD);
    expect((await prisma.demandeReservation.findUniqueOrThrow({ where: { id: demande } })).etat).toBe("PRISE");
  });

  it("le manque signalé : motif exigé, la fiche revient « à compléter », renvoyée elle revient à Assia", async () => {
    ACTOR = A1;
    expect((await signalerManque(fd({ id: demande }))).error).toMatch(/Dites ce qui manque/);
    const r = await signalerManque(fd({ id: demande, motif: "Il me faut l'heure du congrès pour le retour." }));
    expect(r.ok, r.error).toBe(true);
    const vue = (await envoisDesFiches({ voyageurIds: [voyageur] }))[voyageur]!;
    expect(vue.etat).toBe("MANQUE_SIGNALE");
    expect(vue.libelle).toBe("À compléter");
    expect(vue.sousEtat).toMatch(/heure du congrès/);
    expect(await prisma.notification.count({ where: { userId: demId, title: "Fiche de voyage à compléter" } })).toBe(1);
    ACTOR = DEM;
    const renvoi = await envoyerFiche(fd({ source: "VOYAGEUR", id: voyageur }));
    expect(renvoi.ok, renvoi.error).toBe(true);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: demande } });
    expect(d.etat).toBe("PRISE");
    expect(d.priseParId).toBe(a1Id);
    expect(d.envois).toBe(2);
    expect(d.manqueMotif).toBeNull();
  });

  it("modifiée après l'envoi : « à renvoyer », l'assistante voit ce qui a changé, ne réserve pas, et le renvoi la lui rend", async () => {
    ACTOR = DEM;
    const m = await modifierVoyageur(undefined, fd({ id: voyageur, dateDepart: "2026-10-24" }));
    expect(m.ok, m.error).toBe(true);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: demande } });
    expect(d.etat).toBe("MODIFIEE_APRES_ENVOI");
    const vue = (await envoisDesFiches({ voyageurIds: [voyageur] }))[voyageur]!;
    expect(vue.changements).toEqual([{ champ: "Aller", avant: "23/10/2026", apres: "24/10/2026" }]);
    expect((await relancerFiche(fd({ id: demande }))).error).toMatch(/renvoyez la mise à jour/);
    // Chez l'assistante : la ligne dit « à renvoyer » et montre le champ changé.
    ACTOR = A1;
    const ligne = (await ficheDuBureau(A1, demande))!.ligne;
    expect(ligne.etat).toBe("MODIFIEE_APRES_ENVOI");
    expect(ligne.changements.map((c) => c.champ)).toEqual(["Aller"]);
    expect((await fichesDuBureau(A1)).lignes.find((l) => l.demandeId === demande)?.etat, "la ligne du bureau aussi").toBe("MODIFIEE_APRES_ENVOI");
    expect(await prisma.notification.count({ where: { userId: a1Id, title: "Fiche modifiée après l'envoi" } })).toBe(1);
    // Le poste est accordé entre-temps : le dépôt reste refusé tant que la mise à jour n'est pas renvoyée.
    await prisma.adProItem.update({ where: { id: posteBillet }, data: { status: "APPROVED" } });
    const f = fd({ id: demande });
    f.append("pieces", pdf(`${TAG}billet.pdf`));
    expect((await deposerBillet(f)).error).toMatch(/a changé depuis l'envoi/);
    ACTOR = DEM;
    const renvoi = await envoyerFiche(fd({ source: "VOYAGEUR", id: voyageur }));
    expect(renvoi.ok, renvoi.error).toBe(true);
    const apres = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: demande } });
    expect(apres.etat).toBe("PRISE");
    expect(apres.empreinte).toMatchObject({ Aller: "24/10/2026" });
  });

  it("après l'accord : le billet (deux pièces) se dépose, la fiche est réservée et le demandeur voit le billet", async () => {
    ACTOR = A1;
    const f = fd({ id: demande, reference: "PNR123" });
    f.append("pieces", pdf(`${TAG}billet-aller.pdf`));
    f.append("pieces", pdf(`${TAG}billet-retour.pdf`));
    const r = await deposerBillet(f);
    expect(r.ok, r.error).toBe(true);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: demande } });
    expect(d.etat).toBe("RESERVEE");
    expect(d.pieceIds).toHaveLength(2);
    expect(d.referenceReservation).toBe("PNR123");
    const docs = await prisma.document.findMany({ where: { id: { in: d.pieceIds } } });
    expect(docs.every((x) => x.entityType === "AD_PRO_ITEM" && x.entityId === posteBillet && x.stepKey === voyageur)).toBe(true);
    ACTOR = DEM;
    const vue = (await envoisDesFiches({ voyageurIds: [voyageur] }))[voyageur]!;
    expect(vue.etat).toBe("RESERVEE");
    expect(vue.pieces).toHaveLength(2);
    expect((await retirerFiche(fd({ id: demande, motif: "x" }))).error).toMatch(/ne se retire plus/);
  });

  it("« Envoyer les fiches prêtes » envoie chaque fiche séparément ; le retrait d'une fiche prise exige un motif", async () => {
    ACTOR = DEM;
    const r = await envoyerFichesPretes(fd({ itemId: posteHotel }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/1 fiche envoyée, chacune séparément/);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { hebergementId: hotel } });
    expect(d.nature).toBe("HOTEL");
    // Le poste « hôtellerie » a son propre sujet (son propre fil).
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: posteHotel } })).reservationDossierId).toBe(d.dossierId);
    expect((await envoyerFichesPretes(fd({ itemId: posteHotel }))).error).toMatch(/Aucune fiche prête/);
    ACTOR = A2;
    expect((await prendreFiche(fd({ id: d.id }))).ok).toBe(true);
    ACTOR = DEM;
    expect((await retirerFiche(fd({ id: d.id }))).error).toMatch(/dites-lui pourquoi/);
    const ret = await retirerFiche(fd({ id: d.id, motif: "Elle loge chez sa famille." }));
    expect(ret.ok, ret.error).toBe(true);
    const vue = (await envoisDesFiches({ hebergementIds: [hotel] }))[hotel]!;
    expect(vue.etat).toBe("PRETE");
  });

  it("le devis de l'agence passe par la demande de pièce du poste (circuit existant) : la fiche est « devis reçu »", async () => {
    ACTOR = DEM;
    const renvoi = await envoyerFiche(fd({ source: "HEBERGEMENT", id: hotel }));
    expect(renvoi.ok, renvoi.error).toBe(true);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { hebergementId: hotel } });
    expect(d.etat).toBe("ENVOYEE");
    ACTOR = A2;
    const f = fd({ id: d.id, fournisseur: "Genius Travel", montant: "38000" });
    f.append("attachment", pdf(`${TAG}devis.pdf`));
    const r = await joindreDevisAgence(f);
    expect(r.ok, r.error).toBe(true);
    const apres = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: d.id } });
    expect(apres.etat).toBe("DEVIS_RECU");
    const piece = await prisma.documentRequest.findUniqueOrThrow({ where: { id: apres.devisRef! } });
    expect(piece).toMatchObject({ entityType: "AD_PRO_ITEM", entityId: posteHotel, kind: "QUOTE", status: "SUBMITTED", askedById: demId, askedToId: a2Id });

    // LE DEMANDEUR L'ACCEPTE DEPUIS SA FICHE (recette du 23/11/2026) : la vue de la fiche porte le devis à accepter, avec ce
    // que l'assistante a saisi…
    ACTOR = DEM;
    const vue = (await envoisDesFiches({ hebergementIds: [hotel] }))[hotel]!;
    expect(vue.devisAgence).toMatchObject({ pieceId: piece.id, statut: "A_ACCEPTER", demandeurId: demId, fournisseur: "Genius Travel", montantDzd: 38_000, fiches: 1 });
    // … et l'action de « Pièce reçue » l'accepte : la pièce Legal porte le montant et l'agence saisis — plus « montant non saisi ».
    const accepte = await decideDocumentRequest(fd({ id: piece.id, accept: "1" }));
    expect(accepte.ok, accepte.error).toBe(true);
    const classee = await prisma.documentRequest.findUniqueOrThrow({ where: { id: piece.id } });
    const legal = await prisma.legalDocument.findUniqueOrThrow({ where: { id: classee.legalDocumentId! } });
    expect(Number(legal.amount)).toBe(38_000);
    expect(legal.counterparty).toBe("Genius Travel");
    expect(await prisma.adProItemPiece.count({ where: { itemId: posteHotel, legalDocumentId: legal.id, nature: "DEVIS" } })).toBe(1);
    expect((await envoisDesFiches({ hebergementIds: [hotel] }))[hotel]!.devisAgence?.statut).toBe("ACCEPTE");
  });

  it("UN devis pour plusieurs fiches du même poste : une demande de pièce, chaque fiche « devis reçu » ; une fiche d'un autre poste est refusée", async () => {
    ACTOR = DEM;
    const fiche = (nom: string, prenom: string) => ajouterHebergement(undefined, fd({ itemId: posteHotel, nom, prenom, ville: "Constantine", dateArrivee: "2026-10-23", dateDepart: "2026-10-25", typeChambre: "Single" }));
    const [h2, h3] = [await fiche("Haddad", "Amel"), await fiche("Benali", "Karim")];
    expect(h2.ok && h3.ok, `${h2.error ?? ""} ${h3.error ?? ""}`).toBe(true);
    for (const h of [h2.id!, h3.id!]) {
      const e = await envoyerFiche(fd({ source: "HEBERGEMENT", id: h }));
      expect(e.ok, e.error).toBe(true);
    }
    const d2 = await prisma.demandeReservation.findUniqueOrThrow({ where: { hebergementId: h2.id! } });
    const d3 = await prisma.demandeReservation.findUniqueOrThrow({ where: { hebergementId: h3.id! } });
    const pieces = () => prisma.documentRequest.count({ where: { entityType: "AD_PRO_ITEM", entityId: posteHotel } });
    const avant = await pieces();
    ACTOR = A2;
    // Une fiche d'un AUTRE poste ne se coche pas : rien n'est joint.
    const dVoyageur = await prisma.demandeReservation.findUnique({ where: { voyageurId: voyageur } });
    if (dVoyageur) {
      const refus = fd({ id: d2.id, fournisseur: "Hôtel Cirta", montant: "76000" });
      refus.append("aussi", dVoyageur.id);
      refus.append("attachment", pdf(`${TAG}devis-refuse.pdf`));
      expect((await joindreDevisAgence(refus)).error).toMatch(/n'appartient pas à ce poste/);
      expect(await pieces()).toBe(avant);
    }
    const f = fd({ id: d2.id, fournisseur: "Hôtel Cirta", montant: "76000" });
    f.append("aussi", d3.id);
    f.append("attachment", pdf(`${TAG}devis-commun.pdf`));
    const r = await joindreDevisAgence(f);
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/un seul devis pour 2 fiches/);
    const a2 = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: d2.id } });
    const a3 = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: d3.id } });
    expect([a2.etat, a3.etat]).toEqual(["DEVIS_RECU", "DEVIS_RECU"]);
    expect(a3.devisRef).toBe(a2.devisRef);
    expect(await pieces(), "UNE demande de pièce pour les deux fiches").toBe(avant + 1);
    ACTOR = DEM;
    const vue = (await envoisDesFiches({ hebergementIds: [h3.id!] }))[h3.id!]!;
    expect(vue.devisAgence).toMatchObject({ pieceId: a2.devisRef, statut: "A_ACCEPTER", fiches: 2, montantDzd: 76_000, fournisseur: "Hôtel Cirta" });
    // Une fiche qui a déjà son devis ne se coche plus.
    ACTOR = A2;
    const encore = fd({ id: d2.id });
    encore.append("aussi", d3.id);
    encore.append("attachment", pdf(`${TAG}devis-bis.pdf`));
    expect((await joindreDevisAgence(encore)).error).toMatch(/n'attend plus de devis/);
  });

  it("prise en charge du congrès : même circuit — sujet de la prise en charge, dépôt refusé tant que la personne n'est pas accordée", async () => {
    ACTOR = DEM;
    const r = await envoyerFiche(fd({ source: "CARE_CELL", id: billetCare }));
    expect(r.ok, r.error).toBe(true);
    const d = await prisma.demandeReservation.findUniqueOrThrow({ where: { careCellId: billetCare } });
    expect(d).toMatchObject({ nature: "BILLET", careBeneficiaryId: personne, operationType: "CONGRESS_NATIONAL", operationId: congres });
    const req = await prisma.congressNational.findUniqueOrThrow({ where: { id: congres }, select: { careReservationDossierId: true } });
    expect(req.careReservationDossierId).toBe(d.dossierId);
    ACTOR = A1;
    expect((await prendreFiche(fd({ id: d.id }))).ok).toBe(true);
    const f = fd({ id: d.id, reference: "XK42" });
    f.append("pieces", pdf(`${TAG}ebillet.pdf`));
    expect((await deposerBillet(f)).error).toBe(REFUS_AVANT_ACCORD);
    await prisma.careBeneficiary.update({ where: { id: personne }, data: { status: "APPROVED" } });
    const g = fd({ id: d.id, reference: "XK42" });
    g.append("pieces", pdf(`${TAG}ebillet.pdf`));
    const ok = await deposerBillet(g);
    expect(ok.ok, ok.error).toBe(true);
    const cell = await prisma.careCell.findUniqueOrThrow({ where: { id: billetCare } });
    const apres = await prisma.demandeReservation.findUniqueOrThrow({ where: { id: d.id } });
    expect(cell.issuedDocumentId).toBe(apres.pieceIds[0]);
    expect(cell.bookingRef).toBe("XK42");
    // Au bureau (un seul tableau, 24/11/2026) : le poste et la prise en charge du même congrès, chacun sa ligne et son poste.
    const lignes = (await fichesDuBureau(A1)).lignes.filter((l) => [demande, d.id].includes(l.demandeId));
    expect(lignes.some((l) => l.poste.includes("Prise en charge de la billetterie"))).toBe(true);
    expect(lignes.some((l) => l.poste.includes("Billetterie"))).toBe(true);
  });
});
