import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { getManagerOf } from "@/lib/departments";
import {
  estCategorieTache, soldePrerempli, tachesDeSortie, SOURCE_TRANSFERT_SUJETS, SOURCE_TRANSFERT_TACHES,
  type CategorieTache, type LigneSolde,
} from "../domaine/depart/regles";
import { champsCertificatPreremplis } from "./depart-certificat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SORTIE D'UN SALARIÉ — LA LISTE, LE SOLDE, LES TRANSFERTS (lot rhdepart).
 *
 * À l'accord final, `preparerLaSortie` lit les DONNÉES RÉELLES — le véhicule et l'équipement dont il est responsable
 * aux Moyens généraux, le matériel promotionnel « en main » (solde de ses mouvements), ses tâches et sujets ouverts,
 * les validations qui l'attendent, ses accès propres — et écrit la liste de sortie, le solde de tout compte et le
 * brouillon du certificat. Rejouée, elle ne double rien (une ligne par source ; le solde et le certificat ne sont
 * préremplis que s'ils sont vides : ce que les RH ont saisi n'est jamais écrasé).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Echec = { ok: false; error: string };
const ETATS_FRAIS_NON_REGLES = ["PENDING", "IN_PROGRESS", "READY", "APPROVED"] as const;
const LIBELLE_ETAT_FRAIS: Record<string, string> = { PENDING: "soumise", IN_PROGRESS: "en traitement", READY: "acceptée, à rembourser", APPROVED: "accordée, à rembourser" };
const dateFr = (d: Date) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);

/** Le matériel promotionnel EN MAIN : le solde de ses mouvements, article par article (seulement ce qui reste). */
async function promoEnMain(userId: string): Promise<{ itemId: string; nom: string; quantite: number; unite: string | null }[]> {
  const soldes = await prisma.promoStockMovement.groupBy({ by: ["itemId"], where: { holderId: userId }, _sum: { delta: true } });
  const positifs = soldes.map((s) => ({ itemId: s.itemId, q: Number(s._sum.delta ?? 0) })).filter((s) => s.q > 0);
  if (positifs.length === 0) return [];
  const items = await prisma.promoStockItem.findMany({ where: { id: { in: positifs.map((p) => p.itemId) } }, select: { id: true, name: true, unit: true } });
  const parId = new Map(items.map((i) => [i.id, i]));
  return positifs.map((p) => ({ itemId: p.itemId, nom: parId.get(p.itemId)?.name ?? "Article", quantite: Math.round(p.q * 1000) / 1000, unite: parId.get(p.itemId)?.unit ?? null }));
}

/** Ce que le compte du salarié porte encore : moyens, matériel en main, travaux ouverts, accès. */
async function sourcesDuCompte(uid: string) {
  const [moyens, promo, tachesOuvertes, sujetsOuverts, validationsEnAttente, siege, accesPerso, accesEntites] = await Promise.all([
    prisma.moyenGeneral.findMany({ where: { responsableId: uid, statut: "ACTIF", type: { in: ["VEHICULE", "EQUIPEMENT"] } }, select: { id: true, type: true, libelle: true, identifiant: true, reference: true }, orderBy: { type: "asc" } }),
    promoEnMain(uid),
    prisma.task.count({ where: { assignedToId: uid, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] } } }),
    prisma.dossier.count({ where: { assignedToId: uid, status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] } } }),
    prisma.validationStep.count({ where: { validatorId: uid, status: "PENDING", request: { status: "PENDING" } } }),
    prisma.paymentCentreSeat.findUnique({ where: { userId: uid }, select: { id: true } }),
    prisma.userAccess.count({ where: { userId: uid } }),
    prisma.userCompanyAccess.count({ where: { userId: uid } }),
  ]);
  return {
    moyens: moyens.map((m) => ({ ...m, type: String(m.type) })), promo, tachesOuvertes, sujetsOuverts, validationsEnAttente,
    siege: !!siege, accesPerso, accesEntites,
  };
}

/** Écrit ce que la sortie demande, depuis les données réelles. Ne lève jamais : l'accord final est déjà acquis. */
export async function preparerLaSortie(departId: string, acteurId: string): Promise<void> {
  try {
    const d = await prisma.departSalarie.findUnique({
      where: { id: departId },
      select: {
        id: true, dateFin: true, solde: true, certificat: true, employeeId: true,
        employee: { select: { userId: true, baseSalary: true, leaveBalanceDays: true } },
      },
    });
    if (!d) return;
    const uid = d.employee.userId;
    const manager = await getManagerOf(d.employeeId);
    const src = uid ? await sourcesDuCompte(uid) : null;
    const lignes = tachesDeSortie({
      moyens: src?.moyens ?? [], promo: src?.promo ?? [], parcInformatique: null,
      tachesOuvertes: src?.tachesOuvertes ?? 0, sujetsOuverts: src?.sujetsOuverts ?? 0, validationsEnAttente: src?.validationsEnAttente ?? 0,
      siegeCentrePaiement: src?.siege ?? false, accesPersonnalises: src?.accesPerso ?? 0, accesEntites: src?.accesEntites ?? 0,
      aUnCompte: !!uid, repreneur: manager?.fullName ?? null, dateFin: dateFr(d.dateFin),
    });
    await prisma.departSalarieTache.createMany({
      data: lignes.map((l) => ({ departId, categorie: l.categorie, libelle: l.libelle, detail: l.detail, quantite: l.quantite, source: l.source, ordre: l.ordre })),
      skipDuplicates: true,
    });

    const maintenant = new Date();
    if (d.solde == null) {
      const depuis = new Date(maintenant.getTime() - 365 * 86_400_000);
      const [avances, frais] = await Promise.all([
        prisma.salaryAdvance.findMany({ where: { employeeId: d.employeeId, status: "PAID", OR: [{ paidDate: { gte: depuis } }, { paidDate: null, createdAt: { gte: depuis } }] }, select: { id: true, amount: true, paidDate: true }, orderBy: { createdAt: "asc" } }),
        prisma.hrDocumentRequest.findMany({ where: { employeeId: d.employeeId, type: "EXPENSE_REPORT", status: { in: [...ETATS_FRAIS_NON_REGLES] }, createdAt: { gte: depuis } }, select: { id: true, expenseAmount: true, expenseMonth: true, status: true }, orderBy: { createdAt: "asc" } }),
      ]);
      const solde = soldePrerempli({
        salaireBase: d.employee.baseSalary != null ? Number(d.employee.baseSalary) : null,
        joursCongesRestants: d.employee.leaveBalanceDays != null ? Number(d.employee.leaveBalanceDays) : null,
        avances: avances.map((a) => ({ id: a.id, montant: Number(a.amount), versee: a.paidDate ? dateFr(a.paidDate) : null })),
        notesDeFrais: frais.map((f) => ({ id: f.id, montant: f.expenseAmount != null ? Number(f.expenseAmount) : null, mois: f.expenseMonth, statut: `Note ${LIBELLE_ETAT_FRAIS[f.status] ?? f.status}` })),
      });
      await prisma.departSalarie.updateMany({ where: { id: departId, solde: { equals: Prisma.DbNull } }, data: { solde: solde as unknown as Prisma.InputJsonValue } });
    }
    if (d.certificat == null) {
      const champs = await champsCertificatPreremplis(departId, maintenant);
      if (champs) await prisma.departSalarie.updateMany({ where: { id: departId, certificat: { equals: Prisma.DbNull } }, data: { certificat: champs as unknown as Prisma.InputJsonValue } });
    }
    await recordAudit({
      actorId: acteurId, action: "CREATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
      field: "depart_sortie", summary: `Liste de sortie préparée (${lignes.length} ligne(s)), solde de tout compte et certificat de travail préremplis`,
    });
  } catch (err) {
    console.error("[rh] préparation de la sortie impossible", departId, err);
  }
}

/** La fin de contrat validée d'un salarié, pour un geste sur sa sortie (fermée une fois le départ annulé ou refusé). */
async function departValide(departId: string): Promise<{ id: string; employeeId: string; statut: string; employee: { fullName: string; userId: string | null } } | null> {
  const d = await prisma.departSalarie.findUnique({ where: { id: departId }, select: { id: true, employeeId: true, statut: true, employee: { select: { fullName: true, userId: true } } } });
  return d && d.statut === "VALIDE" ? d : null;
}
const REFUS_PAS_VALIDE = "La liste de sortie ne vit qu'une fois la fin de contrat validée (RH, supérieur hiérarchique, DG).";

/** COCHER / DÉCOCHER une ligne — qui, quand. */
export async function cocherTacheDeSortie(acteurId: string, tacheId: string, fait: boolean): Promise<{ ok: true; departId: string; employeeId: string } | Echec> {
  const t = await prisma.departSalarieTache.findUnique({ where: { id: tacheId }, select: { id: true, libelle: true, departId: true, faitLe: true } });
  if (!t) return { ok: false, error: "Ligne introuvable : rechargez la fiche." };
  const d = await departValide(t.departId);
  if (!d) return { ok: false, error: REFUS_PAS_VALIDE };
  const ecrit = await prisma.departSalarieTache.updateMany({
    where: { id: tacheId, faitLe: fait ? null : { not: null } },
    data: fait ? { faitLe: new Date(), faitParId: acteurId } : { faitLe: null, faitParId: null },
  });
  if (ecrit.count === 0) return { ok: false, error: fait ? "Cette ligne est déjà cochée." : "Cette ligne n'est pas cochée." };
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: "depart_tache", newValue: fait ? "fait" : "à faire", summary: `Sortie de ${d.employee.fullName} — « ${t.libelle} » ${fait ? "faite" : "remise à faire"}`,
  });
  return { ok: true, departId: d.id, employeeId: d.employeeId };
}

/** AJOUTER ou MODIFIER une ligne (libellé, détail, catégorie) — toujours modifiable. */
export async function ecrireTacheDeSortie(
  acteurId: string,
  x: { departId: string; tacheId: string | null; categorie: string; libelle: string; detail: string | null },
): Promise<{ ok: true; employeeId: string } | Echec> {
  const d = await departValide(x.departId);
  if (!d) return { ok: false, error: REFUS_PAS_VALIDE };
  const libelle = x.libelle.trim().slice(0, 200);
  if (!libelle) return { ok: false, error: "Dites ce qu'il faut récupérer ou faire." };
  const categorie: CategorieTache = estCategorieTache(x.categorie) ? x.categorie : "AUTRE";
  if (x.tacheId) {
    const ecrit = await prisma.departSalarieTache.updateMany({ where: { id: x.tacheId, departId: d.id }, data: { libelle, detail: x.detail, categorie } });
    if (ecrit.count === 0) return { ok: false, error: "Ligne introuvable : rechargez la fiche." };
  } else {
    const n = await prisma.departSalarieTache.count({ where: { departId: d.id } });
    await prisma.departSalarieTache.create({ data: { departId: d.id, categorie, libelle, detail: x.detail, ordre: 1000 + n } });
  }
  await recordAudit({
    actorId: acteurId, action: x.tacheId ? "UPDATE" : "CREATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: "depart_tache", newValue: libelle, summary: `Sortie de ${d.employee.fullName} — ligne ${x.tacheId ? "modifiée" : "ajoutée"} : « ${libelle} »`,
  });
  return { ok: true, employeeId: d.employeeId };
}

/** RETIRER une ligne de la liste (elle ne concernait pas ce départ). */
export async function retirerTacheDeSortie(acteurId: string, tacheId: string): Promise<{ ok: true; employeeId: string } | Echec> {
  const t = await prisma.departSalarieTache.findUnique({ where: { id: tacheId }, select: { id: true, libelle: true, departId: true } });
  if (!t) return { ok: false, error: "Ligne introuvable : rechargez la fiche." };
  const d = await departValide(t.departId);
  if (!d) return { ok: false, error: REFUS_PAS_VALIDE };
  await prisma.departSalarieTache.deleteMany({ where: { id: tacheId } });
  await recordAudit({
    actorId: acteurId, action: "DELETE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: "depart_tache", oldValue: t.libelle, summary: `Sortie de ${d.employee.fullName} — ligne retirée : « ${t.libelle} »`,
  });
  return { ok: true, employeeId: d.employeeId };
}

/**
 * TRANSFÉRER SES TÂCHES ET SUJETS OUVERTS AU N+1 — le geste de la ligne « Transférer ». Écriture conditionnelle
 * (seulement ce qui est encore à lui et encore ouvert), le repreneur prévenu, la ligne cochée.
 */
export async function transfererAuRepreneur(acteurId: string, tacheId: string): Promise<{ ok: true; message: string; employeeId: string } | Echec> {
  const t = await prisma.departSalarieTache.findUnique({ where: { id: tacheId }, select: { id: true, source: true, departId: true, faitLe: true } });
  if (!t || (t.source !== SOURCE_TRANSFERT_TACHES && t.source !== SOURCE_TRANSFERT_SUJETS)) return { ok: false, error: "Cette ligne ne se transfère pas : cochez-la quand c'est fait." };
  const d = await departValide(t.departId);
  if (!d) return { ok: false, error: REFUS_PAS_VALIDE };
  if (!d.employee.userId) return { ok: false, error: "Ce salarié n'a pas de compte : il n'a rien à transférer." };
  const repreneur = await getManagerOf(d.employeeId);
  if (!repreneur?.userId) return { ok: false, error: "Aucun supérieur hiérarchique n'est résolu dans l'organigramme : rattachez le salarié (ou son département) avant de transférer." };
  const de = d.employee.userId;
  const n = t.source === SOURCE_TRANSFERT_TACHES
    ? (await prisma.task.updateMany({ where: { assignedToId: de, status: { in: ["REQUESTED", "TODO", "IN_PROGRESS"] } }, data: { assignedToId: repreneur.userId } })).count
    : (await prisma.dossier.updateMany({ where: { assignedToId: de, status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] } }, data: { assignedToId: repreneur.userId } })).count;
  await prisma.departSalarieTache.updateMany({ where: { id: tacheId, faitLe: null }, data: { faitLe: new Date(), faitParId: acteurId } });
  const quoi = t.source === SOURCE_TRANSFERT_TACHES ? "tâche(s)" : "sujet(s)";
  if (n > 0) {
    await notifyUser({
      userId: repreneur.userId, type: "ASSIGNMENT", title: `${n} ${quoi} de ${d.employee.fullName} vous reviennent`,
      body: `Transférés à son départ par les RH.`, link: t.source === SOURCE_TRANSFERT_TACHES ? "/mon-espace" : "/dossiers",
    }).catch(sansBloquer("depart-sortie.transfererAuRepreneur.notifier"));
  }
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: "depart_transfert", newValue: repreneur.userId, summary: `Sortie de ${d.employee.fullName} — ${n} ${quoi} transféré(s) à ${repreneur.fullName}`,
  });
  return { ok: true, employeeId: d.employeeId, message: n > 0 ? `${n} ${quoi} transféré(s) à ${repreneur.fullName}.` : `Plus rien d'ouvert à transférer : la ligne est cochée.` };
}

/** ENREGISTRER LE SOLDE DE TOUT COMPTE — les lignes telles que les RH les ont relues (relues ici, `lireSoldeSaisi`). */
export async function enregistrerSolde(acteurId: string, departId: string, lignes: LigneSolde[]): Promise<{ ok: true; employeeId: string } | Echec> {
  const d = await departValide(departId);
  if (!d) return { ok: false, error: REFUS_PAS_VALIDE };
  await prisma.departSalarie.update({ where: { id: departId }, data: { solde: lignes as unknown as Prisma.InputJsonValue, soldeModifieLe: new Date(), soldeModifieParId: acteurId } });
  await recordAudit({
    actorId: acteurId, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: "depart_solde", summary: `Solde de tout compte de ${d.employee.fullName} modifié (${lignes.length} ligne(s))`,
  });
  return { ok: true, employeeId: d.employeeId };
}
