"use server";

import { CHEMIN_STOCK_PROMO } from "@/lib/chemins/stock-promo";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import { fenetreRapport, refusVisiteHorsDelai } from "@/lib/sfe/tournee";
import { produitsDeLaBu, refusProduitsHorsBu } from "@/lib/sfe/produits-bu";
import { sousVerrous } from "@/lib/promo/stock-ecriture";
import { lirePotentielDuRapport } from "@/lib/segmentation/potentiel-rapport";
import { lireBesoinsDuRapport } from "@/lib/besoins-services/regles";
import { ecrireBesoinsDuRapport } from "@/lib/besoins-services/service";
import {
  dejaDansLaVisite, ecrireRemises, lireMaterielRemis, motifDeRemise, phraseMateriel, RefusRemise, toucheLeStock, verrousDuRapport,
} from "@/lib/promo/remises-visite";

/**
 * LE RAPPORT TERRAIN D'UNE VISITE PLANIFIÉE, la visite IMPRÉVUE, et celle que la Direction
 * COMMANDE.
 *
 * ── POURQUOI CE N'EST PAS `logVisit` ────────────────────────────────────────────────────────
 *
 * `logVisit` CRÉE une visite (statut `COMPLETED`) : c'est le geste de « Ma journée », où le KAM
 * saisit une visite qui n'était pas dans un plan. Rapporter une visite PLANIFIÉE est l'inverse —
 * la ligne existe déjà, il faut la METTRE À JOUR. L'appeler à sa place aurait laissé la visite
 * planifiée GRISE pour toujours et créé un doublon à côté : l'emploi du temps aurait affiché
 * « à faire » sur une visite faite, et le dénominateur aurait compté deux fois.
 *
 * ── LES 48 HEURES SONT UNE BORNE DURE, CÔTÉ SERVEUR ─────────────────────────────────────────
 *
 * La règle vit dans le module pur (`fenetreRapport`) et l'écran ne fait que l'afficher. Un
 * verrou qui ne serait qu'à l'écran se contourne en rechargeant la page.
 */

const MODULE = "MEDICAL" as const;
const PATH_JOURNEE = "/medical/ma-journee";
const PATH_TOURNEE = "/medical/plan-de-tournee";
const PATH_STOCK = CHEMIN_STOCK_PROMO;
const LECTURES_A_REFAIRE = {
  pvIa: null, pvIaRaison: null, pvIaExtrait: null, prioriteIa: null, analyseIaLe: null,
  reluLe: null, reluParId: null, reluCommentaire: null,
} as const;

/** Le KAM peut-il écrire sur cette visite ? Lui, ou une supervision qui la couvre. */
async function peutRapporter(
  user: Awaited<ReturnType<typeof requireUser>>,
  visite: { id: string; delegateId: string | null; doctorId: string | null },
): Promise<boolean> {
  if (visite.delegateId === user.id) return true;
  if (hasGlobalView(user)) return true;
  return visite.doctorId ? canAccessEntity(user, "DOCTOR", visite.doctorId, "UPDATE") : false;
}

/**
 * RAPPORTER UNE VISITE PLANIFIÉE — vocal ou écrit, en un envoi.
 *
 * ── CE QUI EST OBLIGATOIRE, ET POURQUOI CE N'EST PAS UN CAPRICE ─────────────────────────────
 *
 * Le ou les PRODUITS discutés, et le ou les MESSAGES pré-définis de la Direction Marketing. Sans
 * eux, un rapport terrain ne dit ni ce qui a été promu ni ce qui a été dit — donc ni l'effort
 * par produit ni l'efficacité d'un message ne se mesurent, et c'est précisément ce que la
 * Direction demande de savoir.
 *
 * Le CONTENU (écrit ou vocal) est obligatoire aussi : une visite « rapportée » sans un mot est
 * une case cochée, pas un compte rendu — et l'emploi du temps passerait au vert sur du vide.
 */
export async function rapporterVisite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const visitId = fdStr(formData, "visitId");
  if (!visitId) return { ok: false, error: "Visite introuvable." };
  const visite = await prisma.medicalVisit.findUnique({
    where: { id: visitId },
    select: {
      id: true, date: true, status: true, delegateId: true, doctorId: true, tourPlanId: true, origin: true, report: true,
      doctor: { select: { name: true } },
      _count: { select: { productLinks: true, messageLinks: true } },
    },
  });
  if (!visite) return { ok: false, error: "Visite introuvable." };
  if (!(await peutRapporter(user, visite))) return { ok: false, error: "Cette visite n'est pas la vôtre." };

  // ── LE VERROU DE 48 H ─────────────────────────────────────────────────────────────────────
  // Le refus dit COMBIEN il restait, pas seulement « trop tard » : sans le délai, la personne
  // découvre la borne au moment où elle ne peut plus rien (§118.30).
  const f = fenetreRapport(visite.date, new Date());
  if (!f.ouvert) {
    return {
      ok: false,
      error: `Le rapport d'une visite se fait dans les 48 h : la fenêtre de celle du ${visite.date.toLocaleDateString("fr-FR")} s'est fermée le ${f.limite.toLocaleDateString("fr-FR")} à ${f.limite.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}. `
        // LA PHRASE EST VRAIE (§118.193 — audit 360°, R13). Elle promettait « votre superviseur, qui peut la
        // régulariser » : aucun geste de régularisation n'existe, et la borne est DURE par décision de la
        // Direction (« un compte rendu écrit une semaine après est un souvenir, pas un fait »). Ouvrir une
        // exception au superviseur serait changer cette règle — une décision, pas une ligne de code.
        + (visite.status === "COMPLETED"
          ? "Passé ce délai, le rapport fait foi : il ne se corrige plus."
          : "Elle reste comptée comme non rapportée : passé ce délai, elle ne se rapporte plus, et ne se dit plus reportée ou annulée."),
    };
  }

  const rapport = fdStr(formData, "report");
  const transcription = fdStr(formData, "transcript");
  const contenu = rapport ?? transcription;
  if (!contenu) {
    return { ok: false, error: "Dictez ou écrivez le compte rendu : une visite rapportée sans un mot est une case cochée, pas un compte rendu." };
  }

  // CORRIGER N'EXIGE JAMAIS PLUS QUE CE QUE LA CRÉATION A EXIGÉ (§118.166). Une visite imprévue
  // naît sans produit ni message obligatoire (une rencontre de couloir n'a pas d'ordre de mission),
  // et la saisie rapide de « Ma journée » n'en demande pas : les exiger à la CORRECTION rendrait ces
  // visites incorrigibles — corriger une quantité remise forcerait à inventer un message. Un rapport
  // fait AVEC ses produits et ses messages, lui, les garde obligatoires.
  const imprevue = visite.origin === "UNPLANNED";
  const dejaRapportee = visite.status === "COMPLETED";
  const exigeProduits = !imprevue && !(dejaRapportee && visite._count.productLinks === 0);
  const exigeMessages = !imprevue && !(dejaRapportee && visite._count.messageLinks === 0);

  // ── LES PRODUITS — ceux de SA BU, et rien d'autre ─────────────────────────────────────────
  const productIds = [...new Set(formData.getAll("productId").map(String).filter(Boolean))];
  if (productIds.length === 0 && exigeProduits) {
    return { ok: false, error: "Choisissez le ou les produits discutés avec le médecin — sans eux, l'effort par produit ne se mesure pas." };
  }
  const gamme = await produitsDeLaBu(visite.delegateId ?? user.id);
  const horsBu = productIds.filter((id) => !gamme.admis.has(id));
  if (horsBu.length > 0) {
    return { ok: false, error: refusProduitsHorsBu(horsBu.length, gamme, "ce KAM") };
  }
  const produits = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, canonicalName: true } });

  // ── LES MESSAGES PRÉ-DÉFINIS ──────────────────────────────────────────────────────────────
  const messageIds = [...new Set(formData.getAll("messageId").map(String).filter(Boolean))];
  if (messageIds.length === 0 && exigeMessages) {
    return { ok: false, error: "Choisissez le ou les messages de la Direction Marketing que vous avez portés — c'est ce qui rend leur efficacité mesurable." };
  }
  const messages = messageIds.length
    ? await prisma.promoMessage.findMany({ where: { id: { in: messageIds }, isActive: true }, select: { id: true } })
    : [];
  if (messages.length !== messageIds.length) {
    return { ok: false, error: `${messageIds.length - messages.length} message(s) sélectionné(s) ne sont plus actifs — rechargez l'écran.` };
  }

  // ── LE POTENTIEL (Segmentation Studio) — facultatif, une seule saisie qui alimente tout ─────────
  const pot = lirePotentielDuRapport(formData);
  if (!pot.ok) return { ok: false, error: pot.error };

  // ── LE BESOIN ANNUEL DU SERVICE (décideur) — facultatif, sur le service du praticien visité ──────
  const besoins = lireBesoinsDuRapport(formData);
  if (!besoins.ok) return { ok: false, error: besoins.error };

  // ── LE MATÉRIEL REMIS (§118.166) — déduit du stock du DÉLÉGUÉ de la visite ───────────────────
  const maintenant = new Date();
  const deja = await dejaDansLaVisite(visite.id);
  const lu = await lireMaterielRemis(formData, deja, maintenant);
  if (!lu.ok) return { ok: false, error: lu.error };
  // C'EST LA VOITURE DU DÉLÉGUÉ QUI SE VIDE — même quand un superviseur rapporte à sa place.
  const detenteurId = visite.delegateId ?? user.id;
  const verrous = verrousDuRapport(lu.materiel, deja);

  try {
    await sousVerrous(verrous, async (tx, verrouilles) => {
      await tx.medicalVisit.update({
        where: { id: visite.id },
        data: {
          status: "COMPLETED",
          report: contenu,
          doctorFeedback: fdStr(formData, "doctorFeedback"),
          followUpActions: fdStr(formData, "followUpActions"),
          // Le texte hérité reste renseigné pour les écrans qui le lisent encore ; la VÉRITÉ
          // exploitable est dans les liens.
          presentedProducts: produits.map((p) => p.canonicalName).join(", ") || null,
          updatedById: user.id,
          // UN COMPTE RENDU RÉÉCRIT SE RELIT (Visite médicale 11/2026) : la lecture de l'IA et la relecture du superviseur
          // portaient sur l'ancien texte. La tâche de fond `terrain.pv-visites` le reprend ; rien ne part d'ici.
          ...(visite.report === contenu ? {} : LECTURES_A_REFAIRE),
        },
      });
      // Les liens sont REMPLACÉS : corriger un rapport dans sa fenêtre doit pouvoir retirer un
      // produit coché par erreur.
      await tx.medicalVisitProduct.deleteMany({ where: { visitId: visite.id } });
      await tx.medicalVisitProduct.createMany({
        data: productIds.map((productId) => ({ visitId: visite.id, productId })),
        skipDuplicates: true,
      });
      await tx.medicalVisitMessage.deleteMany({ where: { visitId: visite.id } });
      await tx.medicalVisitMessage.createMany({
        data: messageIds.map((messageId) => ({ visitId: visite.id, messageId })),
        skipDuplicates: true,
      });
      if (visite.doctorId) {
        // La fiche du praticien porte sa dernière visite : sans cette mise à jour, la tournée du
        // lendemain le reproposerait en tête.
        await tx.medicalDoctor.update({ where: { id: visite.doctorId }, data: { lastVisit: visite.date } });
        // LE POTENTIEL RAPPORTÉ s'historise (jamais écrasé) : la segmentation, le cycle et le cockpit le lisent.
        if (pot.valeur) {
          await tx.hcpObservation.create({
            data: {
              doctorId: visite.doctorId, productId: pot.valeur.productId, potentiel: pot.valeur.potentiel, prescriptionsSur10: pot.valeur.sur10,
              source: "TERRAIN", auteurId: user.id, observeLe: visite.date,
              commentaire: `Rapport de la visite du ${visite.date.toLocaleDateString("fr-FR")}.`,
            },
          });
        }
        await ecrireBesoinsDuRapport(tx, { doctorId: visite.doctorId, besoins: besoins.besoins, auteurId: user.id, maintenant });
      }
      // UN RAPPORT VOCAL est un `FieldReport` — l'objet du module Rapports terrain, avec sa
      // transcription et sa propre validation. On le RATTACHE à la visite (`visitId`) : sans le
      // lien, l'emploi du temps ne pourrait pas passer au vert sur un rapport dicté (§118.5 : on
      // ajoute le lien, on ne fond pas les deux objets).
      if (transcription) {
        // UNE CORRECTION NE CRÉE PAS UN SECOND RAPPORT VOCAL (§118.166) : le brouillon existant
        // prend la nouvelle transcription ; un rapport déjà VALIDÉ par le délégué n'est pas réécrit
        // dans son dos — sa relecture vaut décision.
        const existant = await tx.fieldReport.findFirst({ where: { visitId: visite.id }, select: { id: true, status: true } });
        if (!existant) {
          await tx.fieldReport.create({
            data: {
              delegateId: visite.delegateId ?? user.id,
              visitId: visite.id,
              visitDate: visite.date,
              doctorId: visite.doctorId,
              transcript: transcription,
              status: "DRAFT",
            },
          });
        } else if (existant.status === "DRAFT") {
          await tx.fieldReport.update({ where: { id: existant.id }, data: { transcript: transcription } });
        }
      }
      await ecrireRemises(tx, lu.materiel, verrouilles, {
        ancre: { visitId: visite.id }, doctorId: visite.doctorId, detenteurId, auteurId: user.id, maintenant,
        motif: motifDeRemise(visite.date, visite.doctor?.name ?? null),
      });
    });
  } catch (e) {
    if (e instanceof RefusRemise) return { ok: false, error: e.message };
    throw e;
  }

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Promotion médicale",
    entityType: "VISIT", entityId: visite.id,
    summary: `Rapport terrain — ${produits.length} produit(s), ${messageIds.length} message(s)${transcription ? " (vocal)" : ""}${phraseMateriel(lu.materiel)}`,
  });
  revalidatePath(PATH_JOURNEE);
  revalidatePath(PATH_TOURNEE);
  if (toucheLeStock(lu.materiel, deja)) revalidatePath(PATH_STOCK);
  return { ok: true, id: visite.id };
}

/**
 * UNE VISITE IMPRÉVUE — « en sortant de l'hôpital il rencontre un médecin ».
 *
 * Elle ne descend d'AUCUN plan (`tourPlanId` nul, `origin: UNPLANNED`) : c'est exactement ce qui
 * l'empêche de gonfler le dénominateur de « visitées / planifiées ». Le message est FACULTATIF
 * ici — la demande le dit, et c'est cohérent : une rencontre de couloir n'a pas d'ordre de
 * mission.
 *
 * Elle est créée DÉJÀ RAPPORTÉE : le geste est « je viens de voir quelqu'un », pas « je prévois
 * de le voir ». La créer en attente ferait une visite grise que personne ne pense à rapporter.
 */
export async function ajouterVisiteImprevue(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const doctorId = fdStr(formData, "doctorId");
  if (!doctorId) return { ok: false, error: "Choisissez le praticien rencontré." };
  const doctor = await prisma.medicalDoctor.findUnique({ where: { id: doctorId }, select: { id: true, name: true, delegateId: true } });
  if (!doctor) return { ok: false, error: "Praticien introuvable." };
  if (doctor.delegateId !== user.id && !(await canAccessEntity(user, "DOCTOR", doctorId, "UPDATE"))) {
    return { ok: false, error: "Ce praticien n'est pas dans votre panel." };
  }

  // JAMAIS DANS LE FUTUR : une visite « faite » demain n'existe pas. Et la fenêtre de 48 h
  // s'applique aussi ici — sans quoi une visite imprévue serait le moyen de contourner le
  // verrou en la datant d'il y a trois semaines.
  const maintenant = new Date();
  const saisie = fdDate(formData, "date");
  const date = saisie && saisie <= maintenant ? saisie : maintenant;
  if (!fenetreRapport(date, maintenant).ouvert) return { ok: false, error: refusVisiteHorsDelai(date) };

  const contenu = fdStr(formData, "report") ?? fdStr(formData, "transcript");
  if (!contenu) return { ok: false, error: "Dictez ou écrivez le compte rendu de cette rencontre." };
  const transcription = fdStr(formData, "transcript");

  const productIds = [...new Set(formData.getAll("productId").map(String).filter(Boolean))];
  const gamme = await produitsDeLaBu(user.id);
  const horsBu = productIds.filter((id) => !gamme.admis.has(id));
  if (horsBu.length > 0) return { ok: false, error: refusProduitsHorsBu(horsBu.length, gamme, "vous") };
  const produits = productIds.length
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, canonicalName: true } })
    : [];
  // LE MESSAGE EST FACULTATIF sur une visite imprévue (la demande le dit) — mais s'il est donné,
  // il est VÉRIFIÉ : un identifiant inconnu partirait en violation de clé étrangère.
  const messageIds = [...new Set(formData.getAll("messageId").map(String).filter(Boolean))];
  const messages = messageIds.length
    ? await prisma.promoMessage.findMany({ where: { id: { in: messageIds }, isActive: true }, select: { id: true } })
    : [];
  if (messages.length !== messageIds.length) {
    return { ok: false, error: `${messageIds.length - messages.length} message(s) ne sont plus actifs — rechargez l'écran.` };
  }

  // ── LE MATÉRIEL REMIS (§118.166) — la visite se crée avec ses remises, ou pas du tout ──────────
  const deja = await dejaDansLaVisite(null);
  const lu = await lireMaterielRemis(formData, deja, maintenant);
  if (!lu.ok) return { ok: false, error: lu.error };

  let cree: string;
  try {
    cree = await sousVerrous(verrousDuRapport(lu.materiel, deja), async (tx, verrouilles) => {
      const v = await tx.medicalVisit.create({
        data: {
          date, doctorId, delegateId: user.id,
          status: "COMPLETED", origin: "UNPLANNED", tourPlanId: null,
          report: contenu,
          followUpActions: fdStr(formData, "followUpActions"),
          presentedProducts: produits.map((p) => p.canonicalName).join(", ") || null,
          createdById: user.id, updatedById: user.id,
        },
        select: { id: true },
      });
      if (productIds.length) {
        await tx.medicalVisitProduct.createMany({ data: productIds.map((productId) => ({ visitId: v.id, productId })), skipDuplicates: true });
      }
      if (messageIds.length) {
        await tx.medicalVisitMessage.createMany({ data: messageIds.map((messageId) => ({ visitId: v.id, messageId })), skipDuplicates: true });
      }
      await tx.medicalDoctor.update({ where: { id: doctorId }, data: { lastVisit: date } });
      if (transcription) {
        await tx.fieldReport.create({
          data: { delegateId: user.id, visitId: v.id, visitDate: date, doctorId, transcript: transcription, status: "DRAFT" },
        });
      }
      await ecrireRemises(tx, lu.materiel, verrouilles, {
        ancre: { visitId: v.id }, doctorId, detenteurId: user.id, auteurId: user.id, maintenant, motif: motifDeRemise(date, doctor.name),
      });
      return v.id;
    });
  } catch (e) {
    if (e instanceof RefusRemise) return { ok: false, error: e.message };
    throw e;
  }

  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Promotion médicale",
    entityType: "VISIT", entityId: cree,
    summary: `Visite IMPRÉVUE — ${doctor.name}${produits.length ? ` (${produits.length} produit(s))` : ""}${phraseMateriel(lu.materiel)}`,
  });
  revalidatePath(PATH_JOURNEE);
  revalidatePath(PATH_TOURNEE);
  if (toucheLeStock(lu.materiel, deja)) revalidatePath(PATH_STOCK);
  return { ok: true, id: cree };
}

/**
 * LA DIRECTION COMMANDE UNE VISITE — « demain va voir Achour ».
 *
 * Elle arrive chez le KAM comme une visite à FAIRE (`PLANNED`), hors plan (`tourPlanId` nul,
 * `origin: DIRECTION`). Trois conséquences voulues :
 *  · elle apparaît dans son emploi du temps, grise, comme n'importe quelle visite prévue ;
 *  · elle ne gonfle pas le dénominateur du PLAN qu'il a fait valider — ce n'est pas lui qui l'a
 *    prévue, et l'y compter ferait baisser son taux pour une décision d'un autre ;
 *  · elle se DISTINGUE d'un imprévu du terrain : sans `origin`, « le KAM improvise beaucoup » et
 *    « la Direction envoie beaucoup de monde en urgence » se liraient pareil.
 *
 * Elle peut être datée DEMAIN — c'est tout l'objet du geste — et le verrou des 48 h ne s'y
 * applique donc pas à la création : il s'appliquera à son RAPPORT, par `rapporterVisite`.
 */
export async function commanderVisite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const repId = fdStr(formData, "repId");
  const doctorId = fdStr(formData, "doctorId");
  if (!repId || !doctorId) return { ok: false, error: "Précisez le KAM et le praticien à voir." };

  // COMMANDER UNE VISITE À QUELQU'UN D'AUTRE EST UN ACTE DE SUPERVISION : `canEditRep` répond
  // déjà à « ai-je la main sur ce KAM ? ». Se la commander à soi-même n'a pas de sens — c'est
  // une visite planifiée ordinaire, ou un imprévu.
  if (repId === user.id) {
    return { ok: false, error: "Une visite qu'on se commande à soi-même est une visite planifiée : passez par votre plan de tournée, ou par « visite imprévue »." };
  }
  const { canEditRep } = await import("@/lib/sfe");
  if (!(await canEditRep(user, repId))) {
    return { ok: false, error: "Ce KAM n'est pas dans votre périmètre de supervision." };
  }
  const [kam, doctor] = await Promise.all([
    prisma.user.findUnique({ where: { id: repId }, select: { id: true, name: true, isActive: true } }),
    prisma.medicalDoctor.findUnique({ where: { id: doctorId }, select: { id: true, name: true } }),
  ]);
  if (!kam?.isActive) return { ok: false, error: "Ce compte KAM n'est pas actif." };
  if (!doctor) return { ok: false, error: "Praticien introuvable." };

  const date = fdDate(formData, "date");
  if (!date) return { ok: false, error: "Précisez le jour de la visite (« demain »)." };

  const cree = await prisma.medicalVisit.create({
    data: {
      date, doctorId, delegateId: repId,
      status: "PLANNED", origin: "DIRECTION", tourPlanId: null,
      objective: fdStr(formData, "objective"),
      createdById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Promotion médicale",
    entityType: "VISIT", entityId: cree.id,
    summary: `Visite COMMANDÉE par la Direction — ${doctor.name} pour ${kam.name} le ${date.toLocaleDateString("fr-FR")}`,
  });
  revalidatePath(PATH_JOURNEE);
  revalidatePath(PATH_TOURNEE);
  return { ok: true, id: cree.id };
}

/**
 * DIRE QU'UNE VISITE N'A PAS EU LIEU — reportée ou annulée, motif à l'appui (§118.193 — audit 360°, M5 du KAM).
 *
 * L'état existait (`ANNULEE` / `REPORTEE` : « la visite n'a pas eu lieu et quelqu'un l'a DIT ; elle ne compte
 * donc pas comme perdue ») et AUCUN écran ne l'écrivait — `updateVisit` n'avait pas d'appelant d'écran. Un médecin
 * absent faisait donc une visite PERDUE au dénominateur : le KAM payait dans son taux une absence qu'il n'avait
 * pas causée, et le plan validé n'avait aucun moyen de le dire.
 *
 * LA MÊME FENÊTRE QUE LE RAPPORT : dans les 48 h qui suivent la visite, on dit ce qui s'est passé — le rapport, ou
 * la non-tenue. Après, c'est un souvenir (la borne est une décision de la Direction), et la visite reste comptée
 * comme non rapportée — sinon dire « annulée » une semaine après serait le moyen d'effacer ses visites perdues.
 * Une visite À VENIR se dit reportée ou annulée à tout moment. Qui peut : celui qui peut la rapporter.
 */
export async function direVisiteNonTenue(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "CREATE")) return { ok: false, error: "Non autorisé." };
  const visitId = fdStr(formData, "visitId");
  if (!visitId) return { ok: false, error: "Visite introuvable." };
  const issue = fdStr(formData, "issue");
  // Obligatoire, et dit comme tel au contrat de l'action (la dérivation lit une négation, §118.137).
  if (!issue) return { ok: false, error: "Dites si la visite est reportée ou annulée." };
  if (issue !== "POSTPONED" && issue !== "CANCELLED") return { ok: false, error: "Dites si la visite est reportée ou annulée." };
  const visite = await prisma.medicalVisit.findUnique({
    where: { id: visitId },
    select: { id: true, date: true, status: true, delegateId: true, doctorId: true, doctor: { select: { name: true } } },
  });
  if (!visite) return { ok: false, error: "Visite introuvable." };
  if (!(await peutRapporter(user, visite))) return { ok: false, error: "Cette visite n'est pas la vôtre." };
  // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18).
  if (visite.status !== "PLANNED") {
    return {
      ok: false,
      error: visite.status === "COMPLETED" ? "Cette visite est rapportée : elle a eu lieu." : "Cette visite est déjà dite reportée ou annulée.",
    };
  }
  const maintenant = new Date();
  const f = fenetreRapport(visite.date, maintenant);
  if (!f.ouvert) {
    return {
      ok: false,
      error: `La fenêtre de 48 h de la visite du ${visite.date.toLocaleDateString("fr-FR")} s'est fermée le ${f.limite.toLocaleDateString("fr-FR")} : elle reste comptée comme non rapportée.`,
    };
  }
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites pourquoi elle n'a pas eu lieu : c'est ce que lira votre superviseur." };

  // UN GESTE À LA FOIS : un rapport saisi pendant ce temps (un autre onglet, la saisie rapide) l'emporte.
  const fait = await prisma.medicalVisit.updateMany({
    where: { id: visite.id, status: "PLANNED" },
    data: { status: issue, notHeldReason: motif, notHeldAt: maintenant, notHeldById: user.id, updatedById: user.id },
  });
  if (fait.count === 0) return { ok: false, error: "Cette visite vient de changer — rouvrez « Ma journée » pour voir où elle en est." };

  const libelle = issue === "POSTPONED" ? "reportée" : "annulée";
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Promotion médicale",
    entityType: "VISIT", entityId: visite.id,
    summary: `Visite ${libelle} — ${visite.doctor?.name ?? "praticien"} le ${visite.date.toLocaleDateString("fr-FR")} : ${motif}`,
  });
  // On ne retire pas une visite de la tournée de quelqu'un sans le lui dire.
  if (visite.delegateId && visite.delegateId !== user.id) {
    await notifyUser({
      userId: visite.delegateId, type: "MEDICAL_TOUR",
      title: `Visite ${libelle} — ${visite.doctor?.name ?? "praticien"}`,
      body: `La visite du ${visite.date.toLocaleDateString("fr-FR")} est ${libelle} : « ${motif} ».`,
      link: PATH_JOURNEE,
    });
  }
  revalidatePath(PATH_JOURNEE);
  revalidatePath(PATH_TOURNEE);
  return { ok: true, id: visite.id };
}
