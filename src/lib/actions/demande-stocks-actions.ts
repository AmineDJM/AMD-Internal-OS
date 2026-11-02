"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import {
  developperDemande, lireSaisie, casesManquantes, DELAI_RELANCE_MS,
} from "@/lib/stocks/demande-stocks";
import {
  peutPiloterDemandesStocks, chargerCouvertureKams, chargerHopitauxCandidats,
} from "@/lib/queries/demande-stocks";
import { chargerPorteeStock, chargerProduitsStock } from "@/lib/queries/stock-portee";
import { porteeGlobale, etablissementDansPortee, produitDansPortee } from "@/lib/stocks/portee";
import { assurerLieuDeStock } from "@/lib/stocks/lieux";
import { ecrireEtatDuJour } from "@/lib/stocks/etat-jour";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEMANDES DE STOCKS — DO → KAM (Direction, 06/10).
 *
 * Le pilotage (lancer, relancer, clore, supprimer) appartient à qui peut déjà « Demander un état
 * de stock » (`canRequestStockState`) ; la saisie, au KAM DESTINATAIRE de la demande, et à lui
 * seul sur SES cases. Chaque geste relit ces faits ici : l'écran n'en est que le reflet.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const LISTE = "/stocks/demandes";
const fiche = (id: string) => `${LISTE}/${id}`;
const jour = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" });

/**
 * LANCER UNE DEMANDE — établissements (aucun = tous), produits par établissement (aucun = tous
 * ceux que ses KAM portent), développée ligne à ligne et adressée à chaque KAM concerné.
 *
 * Formulaire : `titre`, `echeance`, `notes` ; `hopitalId` (répété) ; les produits par paires
 * PARALLÈLES `produitHopitalId[i]` / `produitId[i]` ; `produitCommunId` (répété) — un filtre
 * commun pour les établissements sans choix propre.
 */
export async function creerDemandeStocks(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutPiloterDemandesStocks(user)) return { ok: false, error: "Réservé à la Direction des opérations / au Super Admin." };

  const titre = fdStr(formData, "titre");
  if (!titre) return { ok: false, error: "Donnez un titre à la demande." };
  const echeance = fdDate(formData, "echeance");
  const notes = fdStr(formData, "notes");
  const hopitalIds = formData.getAll("hopitalId").map(String);
  const pairesHopital = formData.getAll("produitHopitalId").map(String);
  const pairesProduit = formData.getAll("produitId").map(String);
  if (pairesHopital.length !== pairesProduit.length) return { ok: false, error: "Sélection de produits incomplète — rechargez la page." };
  const produitsChoisis: Record<string, string[]> = {};
  pairesHopital.forEach((h, i) => { (produitsChoisis[h] ??= []).push(pairesProduit[i]!); });
  const produitsCommuns = formData.getAll("produitCommunId").map(String).filter(Boolean);

  const [candidats, catalogue, couverture] = await Promise.all([
    chargerHopitauxCandidats(),
    chargerProduitsStock(user, porteeGlobale()),
    chargerCouvertureKams(),
  ]);
  const dev = developperDemande({
    hopitauxChoisis: hopitalIds,
    candidats: candidats.map((c) => c.id),
    produitsChoisis,
    produitsCommuns,
    catalogue: catalogue.map((p) => p.id),
    couverture: couverture.couverture,
    produitsParBu: couverture.produitsParBu,
  });
  if (!dev.ok) return dev;

  const etab = new Map(candidats.map((c) => [c.id, c]));
  const libelle = new Map(catalogue.map((p) => [p.id, p.label]));
  const requestId = randomUUID();
  const idHopital = new Map(dev.hopitaux.map((h) => [h.institutionId, randomUUID()]));

  await prisma.$transaction([
    prisma.stockCountRequest.create({
      data: { id: requestId, title: titre.slice(0, 180), dueDate: echeance, notes, toutHopitaux: dev.toutHopitaux, createdById: user.id },
    }),
    prisma.stockCountRequestHospital.createMany({
      data: dev.hopitaux.map((h) => ({
        id: idHopital.get(h.institutionId)!, requestId, institutionId: h.institutionId,
        name: etab.get(h.institutionId)?.name ?? "—", wilaya: etab.get(h.institutionId)?.wilaya ?? null,
        tousProduits: h.tousProduits, sansKam: h.sansKam,
      })),
    }),
    prisma.stockCountRequestLine.createMany({
      data: dev.lignes.map((l) => ({
        requestId, hospitalId: idHopital.get(l.institutionId)!, productId: l.productId,
        productLabel: libelle.get(l.productId) ?? "—", kamIds: l.kamIds,
      })),
    }),
    prisma.stockCountRequestRecipient.createMany({
      data: dev.destinataires.map((kamId) => ({ requestId, kamId })),
    }),
  ]);

  // UNE notification par KAM, qui dit CE QU'IL a à faire — pas la taille de la demande entière.
  for (const kamId of dev.destinataires) {
    const siennes = dev.lignes.filter((l) => l.kamIds.includes(kamId));
    const hop = new Set(siennes.map((l) => l.institutionId)).size;
    await notifyUser({
      userId: kamId, type: "ASSIGNMENT", title: "Demande de stocks",
      body: `${titre} — ${hop} établissement${hop > 1 ? "s" : ""}, ${siennes.length} stock${siennes.length > 1 ? "s" : ""} à renseigner${echeance ? `, avant le ${jour(echeance)}` : ""}.`.slice(0, 240),
      link: fiche(requestId),
    }).catch(sansBloquer("demande-stocks-actions.creerDemandeStocks.notifyUser"));
  }

  const sansKam = dev.hopitaux.filter((h) => h.sansKam).length;
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Stocks",
    summary: `Demande de stocks « ${titre.slice(0, 80)} » — ${dev.hopitaux.length} établissement(s)${dev.toutHopitaux ? " (tous)" : ""}, ${dev.lignes.length} case(s), ${dev.destinataires.length} KAM${sansKam ? `, ${sansKam} sans KAM` : ""}`,
  });
  revalidatePath(LISTE);
  return {
    ok: true, id: requestId, redirect: fiche(requestId),
    message: `Demande envoyée à ${dev.destinataires.length} KAM${sansKam ? ` — ${sansKam} établissement(s) sans KAM, listé(s) dans le suivi` : ""}.`,
  };
}

/**
 * LA SAISIE DU KAM — brouillon ou envoi.
 *
 * Tableaux PARALLÈLES : `hopitalId[i]` (l'établissement de l'annuaire), `produitId[i]`,
 * `quantite[i]` (boîtes, vide = pas encore), `rupture[i]` (« 1 » / « 0 »). Notes par
 * établissement : `noteHopitalId[j]` / `noteHopital[j]`. `geste` = BROUILLON | ENVOYER.
 *
 * L'ENVOI exige toutes SES cases, relit sa portée de stock (on n'écrit pas un stock qu'on ne
 * verrait pas — §118.134) et écrit l'état daté du module Stocks pour chaque case.
 */
export async function saisirStocksDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "STOCKS", "CREATE") && !userCan(user, "STOCKS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const demandeId = fdStr(formData, "demandeId");
  if (!demandeId) return { ok: false, error: "Demande manquante." };
  const geste = (fdStr(formData, "geste") ?? "BROUILLON") as "BROUILLON" | "ENVOYER";
  if (geste !== "BROUILLON" && geste !== "ENVOYER") return { ok: false, error: "Geste inconnu." };

  const saisie = lireSaisie(
    formData.getAll("hopitalId").map(String),
    formData.getAll("produitId").map(String),
    formData.getAll("quantite").map(String),
    formData.getAll("rupture").map(String),
  );
  if (!saisie.ok) return saisie;
  const notesHopital = formData.getAll("noteHopitalId").map(String);
  const notesTexte = formData.getAll("noteHopital").map(String);
  if (notesHopital.length !== notesTexte.length) return { ok: false, error: "Notes incomplètes — rechargez la page." };

  const demande = await prisma.stockCountRequest.findUnique({
    where: { id: demandeId },
    select: { id: true, title: true, status: true, createdById: true, destinataires: { select: { kamId: true, submittedAt: true } } },
  });
  if (!demande) return { ok: false, error: "Demande introuvable." };
  const moi = demande.destinataires.find((d) => d.kamId === user.id);
  if (!moi) return { ok: false, error: "Cette demande ne vous est pas adressée." };
  if (demande.status !== "OUVERTE") return { ok: false, error: "Cette demande est clôturée : elle ne se renseigne plus." };

  const lignes = await prisma.stockCountRequestLine.findMany({
    where: { requestId: demande.id, kamIds: { has: user.id } },
    select: { id: true, productId: true, quantity: true, rupture: true, hospital: { select: { id: true, institutionId: true } } },
  });
  const parCle = new Map(lignes.filter((l) => l.hospital.institutionId && l.productId).map((l) => [`${l.hospital.institutionId}|${l.productId}`, l]));
  const maintenant = new Date();
  const ecritures = [];
  for (const e of saisie.entrees) {
    const l = parCle.get(`${e.institutionId}|${e.productId}`);
    if (!l) return { ok: false, error: "Une case du formulaire ne fait pas partie de vos stocks à renseigner — rechargez la page." };
    if (l.quantity === e.quantite && l.rupture === e.rupture) continue;
    l.quantity = e.quantite; l.rupture = e.rupture;
    ecritures.push(prisma.stockCountRequestLine.update({
      where: { id: l.id }, data: { quantity: e.quantite, rupture: e.rupture, savedAt: maintenant, savedById: user.id },
    }));
  }
  const mesHopitaux = new Map(lignes.filter((l) => l.hospital.institutionId).map((l) => [l.hospital.institutionId!, l.hospital.id]));
  for (let i = 0; i < notesHopital.length; i++) {
    const hid = mesHopitaux.get(notesHopital[i]!);
    if (!hid) return { ok: false, error: "Une note vise un établissement hors de vos stocks à renseigner." };
    const texte = notesTexte[i]!.trim().slice(0, 500);
    ecritures.push(prisma.stockCountRequestHospital.update({ where: { id: hid }, data: { note: texte || null, noteById: user.id } }));
  }
  if (ecritures.length) await prisma.$transaction(ecritures);

  if (geste === "BROUILLON") {
    revalidatePath(fiche(demande.id));
    return { ok: true, message: "Brouillon enregistré." };
  }

  // ── L'ENVOI ──────────────────────────────────────────────────────────────────────────
  const vivantes = lignes.filter((l) => l.hospital.institutionId && l.productId);
  const manquantes = casesManquantes(vivantes.map((l) => ({ quantite: l.quantity, rupture: l.rupture })));
  if (manquantes > 0) {
    return { ok: false, error: `Saisie enregistrée, mais ${manquantes} stock${manquantes > 1 ? "s restent" : " reste"} à renseigner avant l'envoi (une quantité, ou « rupture »).` };
  }
  const portee = await chargerPorteeStock(user);
  const horsPortee = vivantes.filter((l) => !etablissementDansPortee(portee, l.hospital.institutionId) || !produitDansPortee(portee, l.productId!));
  if (horsPortee.length > 0) {
    return { ok: false, error: `${horsPortee.length} case(s) ne relèvent plus de votre secteur ou de votre BU depuis la demande : elles ne peuvent pas s'écrire au module Stocks. Prévenez la Direction des opérations (le secteur a sans doute changé).` };
  }

  const produits = await prisma.regulatoryProduct.findMany({
    where: { id: { in: [...new Set(vivantes.map((l) => l.productId!))] } },
    select: { id: true, companyId: true },
  });
  const entite = new Map(produits.map((p) => [p.id, p.companyId]));
  const lieux = new Map<string, string>();
  for (const l of vivantes) {
    const inst = l.hospital.institutionId!;
    if (!lieux.has(inst)) {
      const lieu = await assurerLieuDeStock(inst);
      if (!lieu.ok) return { ok: false, error: lieu.error };
      lieux.set(inst, lieu.annexId);
    }
    if (!entite.has(l.productId!)) continue; // produit retiré du référentiel entre-temps : rien à écrire.
    const etat = await ecrireEtatDuJour({
      scope: "HOSPITAL", annexId: lieux.get(inst)!, productId: l.productId!, date: maintenant,
      quantity: l.rupture ? 0 : l.quantity ?? 0, companyId: entite.get(l.productId!) ?? null, createdById: user.id,
    });
    await prisma.stockCountRequestLine.update({ where: { id: l.id }, data: { snapshotId: etat.id } });
  }
  await prisma.stockCountRequestRecipient.update({
    where: { requestId_kamId: { requestId: demande.id, kamId: user.id } },
    data: { submittedAt: maintenant },
  });

  const ruptures = vivantes.filter((l) => l.rupture).length;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Stocks",
    summary: `Stocks envoyés — « ${demande.title.slice(0, 80)} » : ${vivantes.length} case(s)${ruptures ? `, ${ruptures} rupture(s)` : ""}${moi.submittedAt ? " (renvoi corrigé)" : ""}`,
  });
  if (demande.createdById) {
    const restants = demande.destinataires.filter((d) => d.kamId !== user.id && !d.submittedAt).length;
    await notifyUser({
      userId: demande.createdById, type: "GENERIC",
      title: restants === 0 ? "Demande de stocks complète" : "Stocks reçus",
      body: `${user.name} a envoyé ses stocks — « ${demande.title} »${restants === 0 ? ". Tous les KAM ont répondu." : ` (${restants} KAM en attente).`}`.slice(0, 240),
      link: fiche(demande.id),
    }).catch(sansBloquer("demande-stocks-actions.saisirStocksDemande.notifyUser"));
  }
  revalidatePath(fiche(demande.id));
  revalidatePath(LISTE);
  revalidatePath("/stocks");
  return { ok: true, message: `Stocks envoyés (${vivantes.length} case${vivantes.length > 1 ? "s" : ""}) — ils alimentent aussi les courbes du module Stocks.` };
}

/**
 * RELANCER les KAM qui n'ont pas envoyé — tous, ou ceux cochés (`kamId`, répété). Une relance
 * par KAM et par heure au plus : au-delà, la notification devient un bruit qu'on apprend à ignorer.
 */
export async function relancerDemandeStocks(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutPiloterDemandesStocks(user)) return { ok: false, error: "Réservé à la Direction des opérations / au Super Admin." };
  const demandeId = fdStr(formData, "demandeId");
  if (!demandeId) return { ok: false, error: "Demande manquante." };
  const cibles = formData.getAll("kamId").map(String).filter(Boolean);
  const demande = await prisma.stockCountRequest.findUnique({
    where: { id: demandeId },
    select: { id: true, title: true, status: true, dueDate: true, destinataires: { select: { kamId: true, submittedAt: true, remindedAt: true } } },
  });
  if (!demande) return { ok: false, error: "Demande introuvable." };
  if (demande.status !== "OUVERTE") return { ok: false, error: "Demande clôturée : il n'y a plus personne à relancer." };
  const maintenant = Date.now();
  const enAttente = demande.destinataires.filter((d) => !d.submittedAt && (cibles.length === 0 || cibles.includes(d.kamId)));
  const relancables = enAttente.filter((d) => !d.remindedAt || maintenant - d.remindedAt.getTime() >= DELAI_RELANCE_MS);
  if (relancables.length === 0) {
    return { ok: false, error: enAttente.length === 0 ? "Aucun KAM en attente." : "Déjà relancé(s) il y a moins d'une heure." };
  }
  for (const d of relancables) {
    await prisma.stockCountRequestRecipient.update({
      where: { requestId_kamId: { requestId: demande.id, kamId: d.kamId } },
      data: { remindedAt: new Date(maintenant), remindCount: { increment: 1 } },
    });
    await notifyUser({
      userId: d.kamId, type: "DEADLINE_NEAR", title: "Relance — demande de stocks",
      body: `« ${demande.title} » attend vos stocks${demande.dueDate ? ` (échéance ${jour(demande.dueDate)})` : ""}.`.slice(0, 240),
      link: fiche(demande.id),
    }).catch(sansBloquer("demande-stocks-actions.relancerDemandeStocks.notifyUser"));
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Stocks", summary: `Demande de stocks « ${demande.title.slice(0, 80)} » — ${relancables.length} KAM relancé(s)` });
  revalidatePath(fiche(demande.id));
  const ecartes = enAttente.length - relancables.length;
  return { ok: true, message: `${relancables.length} KAM relancé(s)${ecartes ? ` — ${ecartes} déjà relancé(s) il y a moins d'une heure` : ""}.` };
}

/** CLÔTURER — la demande ne se renseigne plus et sort de « Mon espace » des KAM. Les états envoyés restent. */
export async function cloreDemandeStocks(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutPiloterDemandesStocks(user)) return { ok: false, error: "Réservé à la Direction des opérations / au Super Admin." };
  const demandeId = fdStr(formData, "demandeId");
  if (!demandeId) return { ok: false, error: "Demande manquante." };
  const d = await prisma.stockCountRequest.findUnique({ where: { id: demandeId }, select: { id: true, title: true, status: true } });
  if (!d) return { ok: false, error: "Demande introuvable." };
  if (d.status === "CLOTUREE") return { ok: true, message: "Déjà clôturée." };
  await prisma.stockCountRequest.update({ where: { id: d.id }, data: { status: "CLOTUREE", closedAt: new Date() } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Stocks", summary: `Demande de stocks clôturée — « ${d.title.slice(0, 80)} »` });
  revalidatePath(fiche(d.id));
  revalidatePath(LISTE);
  return { ok: true, message: "Demande clôturée." };
}

/**
 * SUPPRIMER — son auteur ou le Super Admin. La demande part avec ses lignes ; les états de stock
 * déjà ENVOYÉS restent au module Stocks : ce sont des comptages réels, pas des brouillons.
 */
export async function supprimerDemandeStocks(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutPiloterDemandesStocks(user)) return { ok: false, error: "Réservé à la Direction des opérations / au Super Admin." };
  const demandeId = fdStr(formData, "demandeId");
  if (!demandeId) return { ok: false, error: "Demande manquante." };
  const d = await prisma.stockCountRequest.findUnique({ where: { id: demandeId }, select: { id: true, title: true, createdById: true } });
  if (!d) return { ok: false, error: "Demande introuvable." };
  if (d.createdById !== user.id && user.role !== "SUPER_ADMIN") return { ok: false, error: "Seul son auteur (ou le Super Admin) supprime une demande de stocks." };
  await prisma.stockCountRequest.delete({ where: { id: d.id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: "Stocks", summary: `Demande de stocks supprimée — « ${d.title.slice(0, 80)} »` });
  revalidatePath(LISTE);
  return { ok: true, redirect: LISTE, message: "Demande supprimée." };
}
