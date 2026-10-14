import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { deleteFileByKey } from "@/lib/storage";
import { createPromoMaterial } from "./promo-material-actions";
import { completePromoTrack, validatePromoStep } from "./promo-circuit-actions";
import {
  choisirLignesPromo, demanderCorrectionDevisPromo, enregistrerDevisPromo, supprimerDevisPromo, terminerRetranscriptionPromo,
} from "./promo-devis-actions";
import { enregistrerArticleDemandePromo } from "./promo-demande-actions";
import { formatDzd } from "@/lib/promo-material/devis";
import type { ActionResult } from "./types";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pdcourse__${Date.now().toString(36)}`;
const ETAPE_CHANGEE = "Ce dossier vient de changer d'étape — rechargez la fiche.";
const CHOIX_CHANGE = "La sélection a changé pendant votre validation (un autre onglet, ou un déblocage du Super Admin) : rien n'a été validé — rechargez la fiche, vérifiez les lignes retenues, puis validez.";
const LIGNE_ABSENTE = "1 ligne(s) choisie(s) ne figurent pas (ou plus) parmi les devis de ce dossier — rechargez la fiche, puis refaites votre choix.";
const CHANTIER_CHANGE = "Ce dossier vient de changer — un autre chantier vient d'être clos, ou son étape a changé : rechargez la fiche.";

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x); else fd.set(k, v);
  }
  return fd;
};
const pdf = (nom: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, nom.length])], nom, { type: "application/pdf" });
const err = (r: ActionResult) => (r.ok ? "" : r.error ?? "");
function reussi(r: ActionResult, quoi: string): ActionResult {
  if (!r.ok) throw new Error(`${quoi} : ${r.error}`);
  return r;
}
const etat = (id: string) => prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { circuitState: true, status: true } });
/** Les pièces du dossier, et les binaires rangés sous sa clé : ce qu'un geste refusé ne doit pas laisser derrière lui. */
const pieces = async (id: string) => ({
  documents: (await prisma.document.findMany({ where: { entityType: "PROMO_MATERIAL", entityId: id }, select: { id: true }, orderBy: { id: "asc" } })).map((d) => d.id),
  binaires: await prisma.storedFile.count({ where: { key: { startsWith: `PROMO_MATERIAL/${id}/` } } }),
});
const lignesDe = (quoteId: string) =>
  prisma.promoQuoteLine.findMany({ where: { quoteId }, orderBy: { position: "asc" }, select: { id: true, unitPrice: true, selected: true } })
    .then((ls) => ls.map((l) => ({ id: l.id, prix: Number(l.unitPrice), retenue: l.selected })));
const avisAuDemandeur = (userId: string, id: string) =>
  prisma.notification.count({ where: { userId, link: `/promo-material/${id}`, title: "Devis retranscrits — à vous de choisir" } });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS DU MATÉRIEL PROMOTIONNEL, SOUS COURSE — par les VRAIS points d'entrée, avec une
 * assistante et un demandeur SANS vue globale (§118.104).
 *
 * La retranscription vérifiait l'étape à la LECTURE et écrivait sans condition, scan compris
 * entre les deux : une correction tardive recréait des lignes non retenues sous le choix du
 * demandeur, ou écrivait des prix dans un dossier passé au choix, validé ou annulé ; un devis se
 * retirait sous les yeux de qui choisissait ; et la fin de la retranscription contrôlait des
 * devis qu'une correction pouvait changer avant sa bascule. Et le total HT imprimé, présenté
 * comme le contrôle de la retranscription, pouvait simplement ne pas être saisi.
 *
 *   cp    chef de produit (le demandeur)         dir   sa directrice marketing (valide la demande)
 *   ops   Direction des opérations (organigramme) asst  assistante de direction (retranscrit)
 *
 * Chaque course est JOUÉE, jamais espérée (§118.65) : la transaction du banc verrouille la ligne du
 * dossier, lance le geste, attend qu'il soit bloqué PAR ELLE, écrit elle-même le changement
 * concurrent, puis relâche.
 *
 * LOT D1b — les autres écritures d'étape du circuit 2 : le choix des lignes, sa validation, la demande
 * de correction, la fin de la retranscription et la demande au secrétariat qu'elle ferme, l'article
 * ajouté au choix, les chantiers. Deux sortes de preuves : une COURSE (le changement concurrent écrit par
 * le banc pendant que le geste attend), et une OBSERVATION d'atomicité (le banc verrouille ce que le geste
 * écrit en DERNIER, et lit, par le client global, ce qu'un tiers voit pendant l'attente : rien).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel promotionnel — la retranscription sous course, et le total imprimé contrôlé quand il est saisi", () => {
  const u: Record<string, string> = {};
  let companyId = "", fourA = "", fourB = "", catCarnet = "", catPlv = "";
  let debutBanc = new Date();

  beforeAll(async () => {
    debutBanc = new Date(Date.now() - 1_000);
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await Promise.all([mk("ops", "DIRECTION"), mk("dir", "PRODUCT_MANAGER"), mk("cp", "MEDICAL_PROMOTION_MANAGER"), mk("asst", "DIRECTION_ASSISTANT")]);
    companyId = (await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } })).id;
    // L'ORGANIGRAMME : la directrice du chef de produit est celle qui valide sa demande (§118.152).
    const emp: Record<string, string> = {};
    const e = async (k: string, managerKey: string | null) => {
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], managerId: managerKey ? emp[managerKey] : null, companyId } })).id;
    };
    await e("ops", null);
    await e("dir", "ops");
    await Promise.all([e("cp", "dir"), e("asst", null)]);
    const vague = await Promise.all([
      prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Atlas`, address: "Zone industrielle", city: "Alger", companyId: null }, select: { id: true } }),
      prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Tell`, address: "Rue 5", city: "Blida", companyId: null }, select: { id: true } }),
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}-CARNET`, nom: `${TAG} Carnet bilan`, famille: "CONSOMMABLE" }, select: { id: true } }),
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}-PLV`, nom: `${TAG} Présentoir PLV`, famille: "DURABLE" }, select: { id: true } }),
    ]);
    [fourA, fourB, catCarnet, catPlv] = vague.map((r) => r.id);
  }, 60_000);

  afterAll(async () => {
    // Le miroir Drive des devis ENREGISTRÉS part en arrière-plan : on attend qu'il se taise avant de
    // ranger, sinon il recréerait des nœuds après le nettoyage et les comptes ne partiraient plus.
    const ids = Object.values(u);
    for (let i = 0, avant = -1; i < 20; i += 1) {
      const n = await prisma.driveNode.count({ where: { ownerId: { in: ids } } });
      if (n === avant) break;
      avant = n;
      await new Promise((r) => setTimeout(r, 250));
    }
    const pmIds = (await prisma.promoMaterial.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
    const demandes = (await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: { in: pmIds } }, select: { id: true } })).map((d) => d.id);
    await prisma.comment.deleteMany({ where: { OR: [{ entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }, { entityType: "ADMIN_REQUEST", entityId: { in: demandes } }] } }).catch(() => {});
    await prisma.promoMaterial.updateMany({ where: { id: { in: pmIds } }, data: { adminRequestId: null } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { id: { in: pmIds } } }).catch(() => {});
    // Les pièces ET leurs binaires : retirer la ligne seule laisserait le blob compté (§118.159).
    const docs = await prisma.document.findMany({ where: { entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }, select: { id: true, fileKey: true } }).catch(() => []);
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    // Les avis au RÔLE (tout le secrétariat, aucune assistante n'étant nommée) atteignent des comptes qui ne
    // sont pas les nôtres : retirés par le lien, BORNÉS à ce banc (`createdAt` passe par l'index, §118.175).
    await prisma.notification.deleteMany({ where: { link: { in: pmIds.map((id) => `/promo-material/${id}`) }, createdAt: { gte: debutBanc } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 60_000);

  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!); };

  /** Un dossier de cp à l'étape « devis demandés » : demande validée par sa directrice, devis demandés. */
  async function auxDevisDemandes(titre: string): Promise<string> {
    await comme("cp");
    const r = await createPromoMaterial(undefined, form({
      title: `${TAG} ${titre}`,
      lignes: JSON.stringify([{ catalogueId: catCarnet, quantite: "500", actions: ["IMPRESSION"], commentaire: "A5" }]),
    }));
    if (!r.ok) throw new Error(r.error);
    const id = r.id!;
    await comme("dir");
    reussi(await validatePromoStep(form({ id })), "valider la demande");
    // LA DEMANDE DE DEVIS PART D'ELLE-MÊME à la validation de la demande (§118.204) : plus de geste « demander les devis ».
    if ((await prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { circuitState: true } })).circuitState !== "QUOTE_REQUESTED") throw new Error("la demande de devis n'est pas partie d'elle-même à la validation");
    return id;
  }
  const articleDe = async (id: string) => (await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: id } })).id;
  /** Le formulaire de l'éditeur, tel que l'écran l'envoie : 500 carnets au prix donné, total imprimé facultatif. */
  async function formulaireDevis(id: string, opts: { fournisseur: string; prix: string; total?: string | null; quoteId?: string; scan?: string }): Promise<FormData> {
    const fd = form({
      promoMaterialId: id, supplierId: opts.fournisseur, reference: "D-1", tvaRate: "19",
      ligneReference: ["Carnet A5"], ligneQuantite: ["500"], lignePrix: [opts.prix], ligneAction: ["IMPRESSION"], ligneArticle: [await articleDe(id)],
    });
    if (opts.total !== null) fd.set("announcedTotal", opts.total ?? String(500 * Number(opts.prix)));
    if (opts.quoteId) fd.set("quoteId", opts.quoteId);
    if (opts.scan) fd.set("scan", pdf(opts.scan));
    return fd;
  }
  /** Un devis complet, retranscrit par l'assistante : lignes, total imprimé juste, scan. */
  async function devisComplet(id: string, fournisseur = fourA): Promise<string> {
    await comme("asst");
    const r = reussi(await enregistrerDevisPromo(await formulaireDevis(id, { fournisseur, prix: "100", scan: `${TAG}-devis.pdf` })), "retranscrire un devis");
    return r.id!;
  }

  /** Ce que la transaction du banc tient pendant que les gestes attendent : UNE ligne (ou les lignes d'un dossier). */
  type Verrou = (tx: Prisma.TransactionClient) => Promise<unknown>;
  const verrouDossier = (id: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "PromoMaterial" WHERE id = ${id} FOR UPDATE`;
  /** Les lignes des devis du dossier : une sélection qui s'efface ou se coche attend derrière. */
  const verrouLignes = (id: string): Verrou => (tx) => tx.$queryRaw`
    SELECT l.id FROM "PromoQuoteLine" l JOIN "PromoQuote" q ON q.id = l."quoteId" WHERE q."promoMaterialId" = ${id} FOR UPDATE OF l`;
  /** La demande au secrétariat du dossier : sa fermeture ou sa réouverture attend derrière. */
  const verrouDemande = (demandeId: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "AdministrativeRequest" WHERE id = ${demandeId} FOR UPDATE`;
  /**
   * La fiche d'une personne : son JOURNAL attend derrière (la clé étrangère de `AuditLog.actorId`), pas ses
   * écritures sur le dossier, qui n'en portent aucune. Un choix s'enregistre donc, puis s'arrête avant sa validation.
   */
  const verrouPersonne = (userId: string): Verrou => (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

  /**
   * LA COURSE FORCÉE (§118.164e). Un verrou de LIGNE sur ce que vise le seul geste du banc le laisse LIRE et le
   * bloque à sa première écriture — et `pg_blocking_pids` dit qu'il est bloqué PAR NOUS : un verrou de table, ou
   * un filtre sur le texte des requêtes, compterait aussi les gestes des autres fichiers de la suite, et la
   * barrière s'ouvrirait avant que le nôtre y soit (§118.65, §118.193). Plusieurs gestes sont lancés UN PAR UN,
   * chacun attendu bloqué — par nous, ou derrière un geste bloqué par nous — avant le suivant : ils font la queue
   * sur la ligne dans l'ordre de leur lancement, et cet ordre est celui de leur passage (déterministe, pas
   * espéré). Puis le détenteur écrit lui-même le changement concurrent (ou lit, par le client global, ce qu'un
   * tiers voit pendant l'attente), et relâche. Un échec de barrière dit ce que faisaient les sessions.
   */
  async function pendantQueLesGestesAttendent<T>(
    verrou: Verrou, gestes: Array<() => Promise<T>>, entretemps?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<T[]> {
    const lances: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await verrou(tx);
      for (const lancer of gestes) {
        const geste = lancer();
        geste.catch(() => undefined);
        lances.push(geste);
        const debut = Date.now();
        for (;;) {
          await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
          const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
            WITH att AS (SELECT pid, pg_blocking_pids(pid) AS par FROM pg_stat_activity WHERE datname = current_database()),
                 directs AS (SELECT pid FROM att WHERE pg_backend_pid() = ANY(par))
            SELECT count(*)::int AS n FROM att
            WHERE pg_backend_pid() = ANY(par) OR par && ARRAY(SELECT pid FROM directs)`;
          if (n >= lances.length) break;
          if (Date.now() - debut > 15_000) {
            await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
            const vues = await tx.$queryRaw<{ etat: string | null; attente: string; requete: string }[]>`
              SELECT state AS etat, coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') AS attente, left(query, 90) AS requete
              FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
            throw new Error(`le geste n°${lances.length} n'a pas atteint la barrière — ${JSON.stringify(vues)}`);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      if (entretemps) await entretemps(tx);
    }, { timeout: 30_000 });
    return Promise.all(lances);
  }
  /** Un geste, le dossier tenu : la forme des courses du lot D1. */
  async function pendantQueLeGesteAttend<T>(dossierId: string, lancer: () => Promise<T>, entretemps: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    const [r] = await pendantQueLesGestesAttendent(verrouDossier(dossierId), [lancer], entretemps);
    return r as T;
  }

  /** Un dossier de cp AU CHOIX DES LIGNES : un devis complet par fournisseur, la retranscription terminée (sa demande au secrétariat close). */
  async function auChoix(titre: string, fournisseurs: string[] = [fourA]): Promise<{ id: string; lignes: string[]; demande: string }> {
    const id = await auxDevisDemandes(titre);
    const devis: string[] = [];
    for (const f of fournisseurs) devis.push(await devisComplet(id, f));
    await comme("asst");
    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "terminer la retranscription");
    const lignes: string[] = [];
    for (const q of devis) lignes.push((await lignesDe(q))[0]!.id);
    const demande = (await prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { adminRequestId: true } })).adminRequestId;
    if (!demande) throw new Error("le dossier n'a pas de demande au secrétariat");
    await comme("cp");
    return { id, lignes, demande };
  }
  const choix = (id: string, lignes: string[], valider = false) =>
    choisirLignesPromo(form({ promoMaterialId: id, lineIds: lignes, ...(valider ? { valider: "1" } : {}) }));
  const retenues = async (id: string) =>
    (await prisma.promoQuoteLine.findMany({ where: { quote: { promoMaterialId: id }, selected: true }, select: { id: true } })).map((l) => l.id).sort();
  const auditsDuChoix = (id: string) =>
    prisma.auditLog.count({ where: { entityType: "PROMO_MATERIAL", entityId: id, summary: { startsWith: "Choix des lignes" } } });
  const demandeDe = (demandeId: string) =>
    prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demandeId }, select: { status: true, completedAt: true } });
  const demandeDuDossier = async (id: string) => {
    const d = (await prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { adminRequestId: true } })).adminRequestId;
    if (!d) throw new Error("le dossier n'a pas de demande au secrétariat");
    return d;
  };
  /** Ce que la validation fige : l'étape, le montant retenu et ses fournisseurs. */
  const fige = (id: string) =>
    prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { circuitState: true, chosenAmount: true, chosenAgency: true } })
      .then((p) => ({ etape: p.circuitState, montant: p.chosenAmount == null ? null : Number(p.chosenAmount), fournisseurs: p.chosenAgency }));
  /** Ce qu'écrit une correction de la retranscription, joué par le banc : l'étape revient à l'assistante, la sélection s'efface. */
  const corrigeeParLeBanc = (id: string) => async (tx: Prisma.TransactionClient) => {
    await tx.promoMaterial.update({ where: { id }, data: { circuitState: "QUOTE_REQUESTED" } });
    await tx.promoQuoteLine.updateMany({ where: { quote: { promoMaterialId: id } }, data: { selected: false } });
  };

  it("PRÉMISSES : l'assistante et le demandeur n'ont pas la vue globale — une garde éprouvée avec elle ne pourrait pas tomber (§118.104)", async () => {
    expect(hasGlobalView((await actorFor(u.asst!)).role)).toBe(false);
    expect(hasGlobalView((await actorFor(u.cp!)).role)).toBe(false);
    const id = await auxDevisDemandes("Prémisse");
    expect((await etat(id)).circuitState).toBe("QUOTE_REQUESTED");
  });

  it("LE TOTAL IMPRIMÉ EST FACULTATIF (Direction, 07/10) — mais saisi, il contrôle : un total faux refuse la fin en nommant le devis ; corrigé, la fin passe", async () => {
    const id = await auxDevisDemandes("Total imprimé");
    await comme("asst");
    // ENREGISTRER SANS TOTAL passe : le champ n'est plus obligatoire.
    const sans = reussi(await enregistrerDevisPromo(await formulaireDevis(id, { fournisseur: fourA, prix: "100", total: null, scan: `${TAG}-atlas.pdf` })), "enregistrer sans total");
    const scanAtlas = (await prisma.promoQuote.findUniqueOrThrow({ where: { id: sans.id! } })).documentId;
    expect(scanAtlas).not.toBeNull();
    // UN TOTAL SAISI SE CONTRÔLE à un dinar près : faux, la fin est refusée.
    reussi(await enregistrerDevisPromo(await formulaireDevis(id, { fournisseur: fourA, prix: "100", total: "1", quoteId: sans.id! })), "corriger avec un total faux");
    const refus = await terminerRetranscriptionPromo(form({ promoMaterialId: id }));
    expect(err(refus)).toMatch(new RegExp(`^Retranscription incomplète : « ${TAG} Imprimerie Atlas » : les lignes font`));
    expect((await etat(id)).circuitState).toBe("QUOTE_REQUESTED");
    expect(await avisAuDemandeur(u.cp!, id)).toBe(0);

    // CORRIGÉ SANS NOUVEAU SCAN : le total entre, et la pièce du devis n'est PAS réécrite — sa valeur lue au
    // début du geste pouvait être périmée, et la réécrire détacherait le scan (§118.152c).
    reussi(await enregistrerDevisPromo(await formulaireDevis(id, { fournisseur: fourA, prix: "100", quoteId: sans.id! })), "corriger avec le total");
    expect((await prisma.promoQuote.findUniqueOrThrow({ where: { id: sans.id! } })).documentId, "le scan reste celui du devis").toBe(scanAtlas);
    // CORRIGÉ AVEC UN NOUVEAU SCAN, sans course : le nouveau est gardé, l'ancien reste dans les pièces du dossier.
    reussi(await enregistrerDevisPromo(await formulaireDevis(id, { fournisseur: fourA, prix: "100", quoteId: sans.id!, scan: `${TAG}-atlas-v2.pdf` })), "corriger avec un nouveau scan");
    const nouveau = (await prisma.promoQuote.findUniqueOrThrow({ where: { id: sans.id! } })).documentId;
    expect(nouveau).not.toBe(scanAtlas);
    expect((await pieces(id)).documents).toEqual(expect.arrayContaining([scanAtlas, nouveau]));

    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "terminer avec le total");
    expect((await etat(id)).circuitState).toBe("REVIEW_REQUESTER");
    expect(await avisAuDemandeur(u.cp!, id)).toBe(1);
  }, 60_000);

  it("UNE CORRECTION BLOQUÉE ENTRE SA LECTURE ET SON ÉCRITURE, pendant que le dossier passe au choix : refusée — le choix du demandeur intact, aucun scan orphelin", async () => {
    const id = await auxDevisDemandes("Correction croisée");
    const quoteId = await devisComplet(id);
    const avant = { lignes: await lignesDe(quoteId), pieces: await pieces(id), scan: (await prisma.promoQuote.findUniqueOrThrow({ where: { id: quoteId } })).documentId };
    await comme("asst");
    const fd = await formulaireDevis(id, { fournisseur: fourA, prix: "90", quoteId, scan: `${TAG}-tardif.pdf` });
    const r = await pendantQueLeGesteAttend(id, () => enregistrerDevisPromo(fd), async (tx) => {
      // La fin de la retranscription et le choix du demandeur passent pendant que la correction attend.
      await tx.promoMaterial.update({ where: { id }, data: { circuitState: "REVIEW_REQUESTER" } });
      await tx.promoQuoteLine.updateMany({ where: { quoteId }, data: { selected: true } });
    });
    expect(err(r)).toBe(`${ETAPE_CHANGEE} Rien n'a été enregistré, pas même le scan joint.`);
    expect(await lignesDe(quoteId), "les lignes ne sont pas recréées : le choix du demandeur tient").toEqual(avant.lignes.map((l) => ({ ...l, retenue: true })));
    expect((await prisma.promoQuote.findUniqueOrThrow({ where: { id: quoteId } })).documentId).toBe(avant.scan);
    expect(await pieces(id), "le scan déposé par le geste refusé est retiré — ligne ET binaire").toEqual(avant.pieces);
    expect((await etat(id)).circuitState).toBe("REVIEW_REQUESTER");
  }, 60_000);

  it("UNE CORRECTION DONT LE DEVIS EST RETIRÉ PENDANT QU'ELLE ATTEND : refusée, rien n'est recréé, et son scan ne reste pas", async () => {
    const id = await auxDevisDemandes("Devis retiré pendant la correction");
    const quoteId = await devisComplet(id);
    const avant = await pieces(id);
    await comme("asst");
    const fd = await formulaireDevis(id, { fournisseur: fourA, prix: "90", quoteId, scan: `${TAG}-retire.pdf` });
    const r = await pendantQueLeGesteAttend(id, () => enregistrerDevisPromo(fd), (tx) => tx.promoQuote.delete({ where: { id: quoteId } }));
    expect(err(r)).toBe("Ce devis vient d'être retiré du dossier — rechargez la fiche. Rien n'a été enregistré, pas même le scan joint.");
    expect(await prisma.promoQuote.count({ where: { promoMaterialId: id } }), "le devis retiré n'est pas recréé").toBe(0);
    expect(await pieces(id)).toEqual(avant);
  }, 60_000);

  it("UNE CORRECTION DONT L'ARTICLE RATTACHÉ EST RETIRÉ PENDANT QU'ELLE ATTEND : refusée en le disant, pas en erreur technique", async () => {
    const id = await auxDevisDemandes("Article retiré pendant la correction");
    const quoteId = await devisComplet(id);
    const avant = await pieces(id);
    const lignes = (await lignesDe(quoteId)).map((l) => ({ id: l.id, prix: l.prix }));
    const article = await articleDe(id);
    await comme("asst");
    const fd = await formulaireDevis(id, { fournisseur: fourA, prix: "90", quoteId, scan: `${TAG}-article.pdf` });
    const r = await pendantQueLeGesteAttend(id, () => enregistrerDevisPromo(fd), (tx) => tx.promoRequestItem.delete({ where: { id: article } }));
    expect(err(r)).toMatch(/^Un article demandé auquel une ligne est rattachée vient d'être retiré du dossier — rechargez la fiche\./);
    expect((await lignesDe(quoteId)).map((l) => ({ id: l.id, prix: l.prix }))).toEqual(lignes);
    expect(await pieces(id)).toEqual(avant);
  }, 60_000);

  it("UN DEVIS RETIRÉ PENDANT QUE LE DOSSIER EST ANNULÉ : refusé, le devis reste", async () => {
    const id = await auxDevisDemandes("Retrait croisé");
    const quoteId = await devisComplet(id);
    await comme("asst");
    const r = await pendantQueLeGesteAttend(id, () => supprimerDevisPromo(form({ promoMaterialId: id, quoteId })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { status: "CANCELLED", circuitState: "REFUSED" } }));
    expect(err(r)).toBe(ETAPE_CHANGEE);
    expect(await prisma.promoQuote.count({ where: { id: quoteId } }), "le devis d'un dossier qui a quitté la retranscription ne se retire plus").toBe(1);
    expect(await etat(id)).toEqual({ circuitState: "REFUSED", status: "CANCELLED" });
  }, 60_000);

  it("UN DEVIS RETIRÉ DEUX FOIS (deux onglets) : le second clic le dit, au lieu d'annoncer un retrait qu'il n'a pas fait", async () => {
    const id = await auxDevisDemandes("Double retrait");
    const quoteId = await devisComplet(id);
    await comme("asst");
    const r = await pendantQueLeGesteAttend(id, () => supprimerDevisPromo(form({ promoMaterialId: id, quoteId })), (tx) => tx.promoQuote.delete({ where: { id: quoteId } }));
    expect(err(r)).toBe("Ce devis vient d'être retiré du dossier — rechargez la fiche.");
    expect((await etat(id)).circuitState).toBe("QUOTE_REQUESTED");
  }, 60_000);

  it("LA FIN DE LA RETRANSCRIPTION LIT LES DEVIS SOUS LE VERROU : une correction passée pendant qu'elle attend est vue — la fin est refusée", async () => {
    const id = await auxDevisDemandes("Fin croisée — devis");
    const quoteId = await devisComplet(id);
    await comme("asst");
    const r = await pendantQueLeGesteAttend(id, () => terminerRetranscriptionPromo(form({ promoMaterialId: id })),
      // Une correction fait passer le carnet de 100 à 120 DZD pendant que la fin attend : 60 000 HT pour 50 000 imprimés.
      (tx) => tx.promoQuoteLine.updateMany({ where: { quoteId }, data: { unitPrice: 120 } }));
    expect(err(r)).toMatch(/^Retranscription incomplète : /);
    // La phrase lue à sa source (`formatDzd`) : retapée ici, elle divergerait au premier séparateur de milliers (§118.120).
    expect(err(r)).toContain(`les lignes font ${formatDzd(60_000)} HT, le devis annonce ${formatDzd(50_000)}`);
    expect((await etat(id)).circuitState, "la fin n'est pas déclarée sur des devis qu'elle n'a pas contrôlés").toBe("QUOTE_REQUESTED");
    expect(await avisAuDemandeur(u.cp!, id)).toBe(0);
  }, 60_000);

  it("LA FIN DE LA RETRANSCRIPTION RELIT L'ÉTAPE SOUS LE VERROU : un dossier annulé pendant qu'elle attend ne repasse pas au choix", async () => {
    const id = await auxDevisDemandes("Fin croisée — annulation");
    await devisComplet(id);
    await comme("asst");
    const r = await pendantQueLeGesteAttend(id, () => terminerRetranscriptionPromo(form({ promoMaterialId: id })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { status: "CANCELLED", circuitState: "REFUSED" } }));
    expect(err(r), "l'état d'abord : un dossier annulé ne se fait pas répondre « incomplète »").toBe(ETAPE_CHANGEE);
    expect(await etat(id)).toEqual({ circuitState: "REFUSED", status: "CANCELLED" });
    expect(await avisAuDemandeur(u.cp!, id)).toBe(0);
  }, 60_000);

  it("UN DEVIS NEUF ET UNE CORRECTION SANS COURSE : rien n'est refusé — la garde ne coûte rien au cas ordinaire", async () => {
    const id = await auxDevisDemandes("Cas ordinaire");
    const a = await devisComplet(id, fourA);
    const b = await devisComplet(id, fourB);
    const rangs = (await prisma.promoQuote.findMany({ where: { promoMaterialId: id }, orderBy: { position: "asc" }, select: { id: true, position: true } }));
    expect(rangs).toEqual([{ id: a, position: 0 }, { id: b, position: 1 }]);
    await comme("asst");
    reussi(await supprimerDevisPromo(form({ promoMaterialId: id, quoteId: b })), "retirer le second devis");
    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "terminer");
    expect((await etat(id)).circuitState).toBe("REVIEW_REQUESTER");
  }, 60_000);

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // LOT D1b — LE CHOIX DES LIGNES, SA VALIDATION, LA CORRECTION, LA FIN, L'ARTICLE AU CHOIX, LES CHANTIERS
  // ═════════════════════════════════════════════════════════════════════════════════════════════════

  it("UN CHOIX VALIDÉ PENDANT QU'UNE CORRECTION EST DEMANDÉE : refusé à l'étape — la sélection effacée par la correction le reste, rien n'est journalisé", async () => {
    const { id, lignes: [l1] } = await auChoix("Choix pendant une correction");
    const r = await pendantQueLeGesteAttend(id, () => choix(id, [l1!], true), corrigeeParLeBanc(id));
    expect(err(r)).toBe(ETAPE_CHANGEE);
    expect(await retenues(id), "le choix ne recoche pas ce que la correction vient d'effacer").toEqual([]);
    expect(await fige(id)).toEqual({ etape: "QUOTE_REQUESTED", montant: null, fournisseurs: null });
    expect(await auditsDuChoix(id), "un choix refusé n'est pas journalisé").toBe(0);
  }, 90_000);

  it("UN CHOIX DONT UNE LIGNE A ÉTÉ REFAITE PENDANT QU'IL ATTEND : refusé en le disant — rien n'est retenu en silence", async () => {
    const { id, lignes: [l1] } = await auChoix("Ligne refaite pendant le choix");
    const r = await pendantQueLeGesteAttend(id, () => choix(id, [l1!]), async (tx) => {
      // Une correction déjà refermée : l'assistante a refait la ligne (supprimée, recréée), le dossier est revenu au choix.
      const l = await tx.promoQuoteLine.findUniqueOrThrow({ where: { id: l1! } });
      await tx.promoQuoteLine.delete({ where: { id: l.id } });
      await tx.promoQuoteLine.create({
        data: { quoteId: l.quoteId, position: l.position, reference: l.reference, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, action: l.action, requestItemId: l.requestItemId },
      });
    });
    expect(err(r)).toBe(LIGNE_ABSENTE);
    expect(await retenues(id)).toEqual([]);
    expect(await auditsDuChoix(id)).toBe(0);
    expect((await etat(id)).circuitState).toBe("REVIEW_REQUESTER");
  }, 90_000);

  it("DEUX CHOIX CROISÉS (deux onglets) : celui qui valide ne valide que ce qu'il a envoyé — l'autre choix est enregistré, rien n'est figé", async () => {
    const { id, lignes: [l1, l2] } = await auChoix("Deux onglets", [fourA, fourB]);
    // A choisit l1 et valide ; B (un second onglet) choisit l2 sans valider. Le banc tient la fiche de cp : chaque
    // choix S'ENREGISTRE (sa transaction ne la touche pas) puis s'arrête à son journal — A d'abord, B ensuite. Relâchée,
    // la validation de A relit la sélection sous son verrou : c'est celle de B, enregistrée entre les deux transactions
    // de A. L'ordre est forcé, pas espéré (§118.65) : B a écrit avant que la validation de A puisse commencer.
    const [a, b] = await pendantQueLesGestesAttendent(verrouPersonne(u.cp!), [() => choix(id, [l1!], true), () => choix(id, [l2!])]);
    expect(err(a)).toBe(CHOIX_CHANGE);
    expect(b.ok, err(b)).toBe(true);
    expect(b.message).toMatch(/^Choix enregistré : 1 ligne\(s\)/);
    expect(await retenues(id)).toEqual([l2!]);
    expect(await fige(id), "aucune validation n'est passée sur une sélection que personne n'a validée").toEqual({ etape: "REVIEW_REQUESTER", montant: null, fournisseurs: null });
    expect(await prisma.notification.count({ where: { userId: u.dir!, link: `/promo-material/${id}`, title: "Devis à valider (Direction Marketing)" } })).toBe(0);
  }, 120_000);

  it("LA VALIDATION DU CHOIX LIT LA SÉLECTION SOUS SON VERROU : une ligne cochée pendant qu'elle attend est celle qu'elle fige", async () => {
    const { id, lignes: [l1, l2] } = await auChoix("Validation sous verrou", [fourA, fourB]);
    reussi(await choix(id, [l1!]), "enregistrer le choix");
    // Le chemin d'Adam : valider SANS `lignesVues` — la validation fige ce que la sélection EST quand elle tient le dossier.
    const r = await pendantQueLeGesteAttend(id, () => validatePromoStep(form({ id })),
      (tx) => tx.promoQuoteLine.updateMany({ where: { id: l2! }, data: { selected: true } }));
    reussi(r, "valider le choix");
    expect(await fige(id)).toEqual({ etape: "REVIEW_MANAGER", montant: 119_000, fournisseurs: `${TAG} Imprimerie Atlas, ${TAG} Imprimerie Tell` });
  }, 120_000);

  it("LA VALIDATION D'UN CHOIX PENDANT QU'UNE CORRECTION EST DEMANDÉE : refusée par l'étape — l'état d'abord, pas « la sélection a changé »", async () => {
    const { id, lignes: [l1] } = await auChoix("Validation pendant une correction");
    reussi(await choix(id, [l1!]), "enregistrer le choix");
    const r = await pendantQueLeGesteAttend(id, () => validatePromoStep(form({ id, lignesVues: [l1!] })), corrigeeParLeBanc(id));
    expect(err(r)).toBe(ETAPE_CHANGEE);
    expect(await fige(id)).toEqual({ etape: "QUOTE_REQUESTED", montant: null, fournisseurs: null });
  }, 90_000);

  it("UNE LIGNE ÉTRANGÈRE est refusée, et VALIDER SANS LIGNE ne touche pas au choix enregistré", async () => {
    const a = await auChoix("Ligne étrangère — A");
    const b = await auChoix("Ligne étrangère — B");
    reussi(await choix(a.id, [a.lignes[0]!]), "le choix de A");
    reussi(await choix(b.id, [b.lignes[0]!]), "le choix de B");
    expect(err(await choix(a.id, [b.lignes[0]!])), "une ligne d'un autre dossier").toBe(LIGNE_ABSENTE);
    expect(err(await choix(a.id, [], true))).toBe("Retenez au moins une ligne avant de valider votre choix.");
    expect(await retenues(a.id), "le choix enregistré de A tient").toEqual([a.lignes[0]!]);
    expect(await retenues(b.id), "celui de B aussi").toEqual([b.lignes[0]!]);
    expect(await auditsDuChoix(a.id), "deux gestes refusés n'ont rien journalisé").toBe(1);
    expect((await etat(a.id)).circuitState).toBe("REVIEW_REQUESTER");
  }, 120_000);

  it("UNE CORRECTION DEMANDÉE PENDANT QUE LE CHOIX EST VALIDÉ : refusée — rien ne bouge, ni la sélection, ni la demande au secrétariat", async () => {
    const { id, lignes: [l1], demande } = await auChoix("Correction pendant la validation");
    reussi(await choix(id, [l1!]), "enregistrer le choix");
    const r = await pendantQueLeGesteAttend(id, () => demanderCorrectionDevisPromo(form({ promoMaterialId: id, motif: "Prix du carnet" })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { circuitState: "REVIEW_MANAGER", chosenAmount: 59_500, chosenAgency: `${TAG} Imprimerie Atlas` } }));
    expect(err(r)).toBe(ETAPE_CHANGEE);
    expect((await etat(id)).circuitState).toBe("REVIEW_MANAGER");
    expect(await retenues(id)).toEqual([l1!]);
    expect((await demandeDe(demande)).status, "la demande au secrétariat reste close").toBe("DONE");
    expect(await prisma.comment.count({ where: { entityType: "PROMO_MATERIAL", entityId: id, body: { startsWith: "Correction de la retranscription demandée" } } })).toBe(0);
    expect(await prisma.notification.count({ where: { link: `/promo-material/${id}`, title: "Matériel promotionnel — retranscription à corriger", createdAt: { gte: debutBanc } } })).toBe(0);
  }, 90_000);

  it("UNE CORRECTION EST UN SEUL GESTE (1/2) : tant que la sélection n'est pas effacée, personne ne voit le dossier reparti ni la demande rouverte", async () => {
    const { id, lignes: [l1], demande } = await auChoix("Correction atomique — sélection");
    reussi(await choix(id, [l1!]), "enregistrer le choix");
    let vu: unknown = null;
    const [r] = await pendantQueLesGestesAttendent(verrouLignes(id), [() => demanderCorrectionDevisPromo(form({ promoMaterialId: id, motif: "Prix du carnet" }))],
      // L'OBSERVATEUR lit par le client global : ce qu'un tiers voit pendant que la correction attend.
      async () => { vu = { etape: (await etat(id)).circuitState, demande: (await demandeDe(demande)).status }; });
    expect(vu, "rien de ce que la correction a déjà écrit n'est visible tant qu'elle n'a pas fini").toEqual({ etape: "REVIEW_REQUESTER", demande: "DONE" });
    reussi(r, "la correction");
    expect((await etat(id)).circuitState).toBe("QUOTE_REQUESTED");
    expect(await retenues(id)).toEqual([]);
    expect((await demandeDe(demande)).status).toBe("IN_PROGRESS");
  }, 90_000);

  it("UNE CORRECTION EST UN SEUL GESTE (2/2) : la demande au secrétariat se rouvre DANS la transaction — sa raison au fil, sans date de fin", async () => {
    const { id, lignes: [l1], demande } = await auChoix("Correction atomique — demande");
    reussi(await choix(id, [l1!]), "enregistrer le choix");
    let vu: unknown = null;
    const [r] = await pendantQueLesGestesAttendent(verrouDemande(demande), [() => demanderCorrectionDevisPromo(form({ promoMaterialId: id, motif: "La TVA est à 9 %" }))],
      async () => { vu = { etape: (await etat(id)).circuitState, retenues: await retenues(id) }; });
    expect(vu, "la bascule et la sélection effacée ne se voient pas avant la réouverture").toEqual({ etape: "REVIEW_REQUESTER", retenues: [l1!] });
    reussi(r, "la correction");
    expect(await demandeDe(demande)).toEqual({ status: "IN_PROGRESS", completedAt: null });
    const fil = await prisma.comment.findFirst({ where: { entityType: "ADMIN_REQUEST", entityId: demande }, orderBy: { createdAt: "desc" }, select: { body: true } });
    expect(fil?.body).toBe("Demande rouverte — Correction de la retranscription demandée par le demandeur : La TVA est à 9 %");
  }, 90_000);

  it("LA FIN DE LA RETRANSCRIPTION NE RESSUSCITE PAS UNE DEMANDE AU SECRÉTARIAT ANNULÉE pendant qu'elle attend", async () => {
    const id = await auxDevisDemandes("Fin et demande annulée");
    await devisComplet(id);
    const demande = await demandeDuDossier(id);
    await comme("asst");
    const r = await pendantQueLeGesteAttend(id, () => terminerRetranscriptionPromo(form({ promoMaterialId: id })),
      (tx) => tx.administrativeRequest.update({ where: { id: demande }, data: { status: "CANCELLED" } }));
    reussi(r, "terminer");
    expect((await etat(id)).circuitState).toBe("REVIEW_REQUESTER");
    expect(await demandeDe(demande), "une demande annulée ne repasse pas « terminée »").toEqual({ status: "CANCELLED", completedAt: null });
  }, 90_000);

  it("LA FIN DE LA RETRANSCRIPTION ET LA FERMETURE DE SA DEMANDE SONT UN SEUL GESTE — la demande se ferme avec sa date de fin", async () => {
    const id = await auxDevisDemandes("Fin atomique");
    await devisComplet(id);
    const demande = await demandeDuDossier(id);
    const avant = (await demandeDe(demande)).status;
    expect(avant, "prémisse : la demande se traite encore").not.toBe("DONE");
    await comme("asst");
    let vu: unknown = null;
    const [r] = await pendantQueLesGestesAttendent(verrouDemande(demande), [() => terminerRetranscriptionPromo(form({ promoMaterialId: id }))],
      async () => { vu = { etape: (await etat(id)).circuitState, demande: (await demandeDe(demande)).status }; });
    expect(vu, "le dossier ne passe pas au choix avant que sa demande soit close").toEqual({ etape: "QUOTE_REQUESTED", demande: avant });
    reussi(r, "terminer");
    expect((await etat(id)).circuitState).toBe("REVIEW_REQUESTER");
    const d = await demandeDe(demande);
    expect(d.status).toBe("DONE");
    expect(d.completedAt, "« terminée » porte sa date de fin").not.toBeNull();
  }, 90_000);

  it("DEUX CHANTIERS CLOS À LA MÊME SECONDE ne s'effacent pas ; et un dossier annulé pendant qu'on clôt son dernier chantier ne repasse pas « terminé »", async () => {
    // Décor du CIRCUIT 1, créé en base : la garde est commune aux deux versions, et un chantier du circuit 2 se
    // constate sur des pièces réelles (BC signés, paiements réglés) hors de propos ici ; « visa » n'en exige aucune.
    const dossierAuxChantiers = async (titre: string, tracksDone: string | null) => (await prisma.promoMaterial.create({
      data: { reference: `${TAG}-${titre.length}-${Date.now().toString(36)}`, title: `${TAG} ${titre}`, requesterId: u.cp!, companyId, circuitVersion: 1, circuitState: "IN_EXECUTION", tracksDone },
      select: { id: true },
    })).id;
    const chantiers = (id: string) => prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { tracksDone: true, circuitState: true } });
    await comme("cp");

    const a = await dossierAuxChantiers("Chantiers croisés", null);
    const [r] = await pendantQueLesGestesAttendent(verrouDossier(a), [() => completePromoTrack(form({ id: a, track: "AD_VISA" }))],
      (tx) => tx.promoMaterial.update({ where: { id: a }, data: { tracksDone: "PAYMENT" } }));
    expect(err(r)).toBe(CHANTIER_CHANGE);
    expect(await chantiers(a), "le chantier clos par l'autre n'est pas effacé").toEqual({ tracksDone: "PAYMENT", circuitState: "IN_EXECUTION" });
    reussi(await completePromoTrack(form({ id: a, track: "AD_VISA" })), "le chantier, relu");
    expect((await chantiers(a)).tracksDone).toBe("PAYMENT,AD_VISA");

    const b = await dossierAuxChantiers("Annulé pendant la clôture", "PURCHASE_ORDER,PAYMENT");
    const [r2] = await pendantQueLesGestesAttendent(verrouDossier(b), [() => completePromoTrack(form({ id: b, track: "AD_VISA" }))],
      (tx) => tx.promoMaterial.update({ where: { id: b }, data: { status: "CANCELLED", circuitState: "REFUSED" } }));
    expect(err(r2)).toBe(CHANTIER_CHANGE);
    expect(await chantiers(b), "rien de « terminé » sur un dossier annulé").toEqual({ tracksDone: "PURCHASE_ORDER,PAYMENT", circuitState: "REFUSED" });
  }, 60_000);

  it("UN ARTICLE AJOUTÉ AU CHOIX RENVOIE À LA RETRANSCRIPTION ET ROUVRE LA DEMANDE EN UN SEUL GESTE", async () => {
    const { id, demande } = await auChoix("Article au choix");
    let vu: unknown = null;
    const [r] = await pendantQueLesGestesAttendent(verrouDemande(demande),
      [() => enregistrerArticleDemandePromo(form({ promoMaterialId: id, catalogueId: catPlv, quantite: "10", actions: ["FABRICATION"] }))],
      async () => { vu = { etape: (await etat(id)).circuitState, articles: await prisma.promoRequestItem.count({ where: { promoMaterialId: id } }) }; });
    expect(vu, "ni la bascule ni l'article ne se voient avant la réouverture").toEqual({ etape: "REVIEW_REQUESTER", articles: 1 });
    reussi(r, "ajouter l'article");
    expect((await etat(id)).circuitState).toBe("QUOTE_REQUESTED");
    expect((await demandeDe(demande)).status).toBe("IN_PROGRESS");
    expect(await prisma.promoRequestItem.count({ where: { promoMaterialId: id } })).toBe(2);
  }, 90_000);

  it("LA DEMANDE « QUI SE TRAITE ENCORE » EST LA MÊME POUR LE SECRÉTARIAT ET POUR LE DOSSIER — la copie ne diverge pas de l'original", () => {
    // `OUVERTE` vit dans un fichier « use server », qui n'exporte que des fonctions : la fermeture d'un dossier en
    // porte une COPIE. Deux définitions de la même règle finissent par diverger (§118.5) : celle-ci est comparée.
    const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const lire = (f: string) => sansCommentaires(readFileSync(join(process.cwd(), f), "utf8"));
    const original = lire("src/lib/actions/admin-request-actions.ts").match(/const OUVERTE = \{([^;]*)\}\s*satisfies/);
    expect(original, "la constante OUVERTE du bureau du secrétariat").not.toBeNull();
    const copie = lire("src/lib/promo-material/demande-secretariat.ts").match(/export async function fermerDemandeAuSecretariat[\s\S]*?where: \{([^}]*\{ notIn: \[[^\]]*\] \})/);
    expect(copie, "la condition de la fermeture d'un dossier").not.toBeNull();
    const statuts = (src: string) => [...(src.match(/notIn: \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(statuts(original![1]!).length).toBeGreaterThan(0);
    expect(statuts(copie![1]!)).toEqual(statuts(original![1]!));
    expect(original![1]).toContain("deletedAt: null");
    expect(copie![1]).toContain("deletedAt: null");
  });
});
