"use server";

import type { AdProOtherStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser, requireUserAuNomDeLaVue } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { poserVisaAdPro, blocageCentreAdPro, retirerVisaEnAttente, ajusterVisaAuMontant, phraseGesteVisa } from "@/lib/ad-pro/visa";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import { toNumber, formatDate } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { buildRef, createWithRetry } from "@/lib/refs";
import { companyIdForNew } from "@/lib/company";
import { readMultiField, lireMedecinsDemande } from "@/lib/ad-pro/pickers";
import { gammeImposee } from "@/lib/ad-pro/business-unit-auto";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
const PATH = "/ad-pro/autres";

/**
 * LA DEMANDE QUI N'ENTRE DANS AUCUNE CASE.
 *
 * Sans elle, une dépense de promotion inhabituelle se déclare « en sponsoring » faute de mieux —
 * et l'on perd deux choses à la fois : la lisibilité du sponsoring, qui se remplit d'objets qui
 * n'en sont pas, et la trace de la dépense, rangée sous une étiquette fausse.
 *
 * Le circuit est volontairement COURT. Une nature dont on ne connaît pas le contenu ne peut pas
 * avoir de parcours de validation prédéfini : elle a un demandeur, une décision, et un motif.
 * Lui inventer six étapes reviendrait à obliger tout le monde à les traverser pour rien.
 */

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.adProOtherRequest.findMany({
    where: { reference: { startsWith: `AUT-${year}-` } }, select: { reference: true },
  });
  return buildRef("AUT", year, refs.map((r) => r.reference));
}

function revalidate(id?: string) {
  revalidatePath(PATH);
  revalidatePath("/ad-pro");
  if (id) revalidatePath(`${PATH}/${id}`);
}

async function audit(user: SessionUser, id: string, action: "CREATE" | "UPDATE" | "VALIDATE", summary: string) {
  await recordAudit({ actorId: user.id, action, module: "Ad & Pro — autres demandes", entityType: "AD_PRO_OTHER", entityId: id, summary });
}

export async function createAdProOtherRequest(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUserAuNomDeLaVue();
    if (!userCan(user, "AD_PRO_OTHER", "CREATE")) return { ok: false, error: "Création réservée aux personnes habilitées." };
    // Sous « Vue exacte », la demande se crée AU NOM de la personne visualisée (test de son parcours) : voir `vue-exacte.ts`.

    const title = fdStr(formData, "title");
    if (!title) return { ok: false, error: "L'objet de la demande est obligatoire." };
    // Une demande « autre » sans explication est une case vide : c'est justement la description
    // qui permettra de trancher, puisqu'aucun formulaire ne la décrit pour nous.
    const description = fdStr(formData, "description");
    if (!description) return { ok: false, error: "Décrivez la demande — c'est sur cette description que la décision se prendra." };

    const companyId = fdStr(formData, "companyId") || (await companyIdForNew(user.id));
    // PRATICIEN ET PRODUIT concernés, FACULTATIFS par définition de la nature : « autre » ne sait
    // pas d'avance de quoi il s'agit. Sans ces champs, ils repartaient dans la description.
    const couple = {
      medecins: lireMedecinsDemande(formData.getAll("doctorIds").map(String), fdStr(formData, "doctorHorsAnnuaire"), fdStr(formData, "doctor")),
      produits: readMultiField(formData.getAll("productIds").map(String), fdStr(formData, "product")),
    };
    // Les pièces jointes (tout type sauf ce qui s'exécute) se jugent AVANT de créer : refusées après,
    // la demande existerait déjà et serait recréée au second essai.
    // Nom LITTÉRAL (= `CHAMP_PIECES_COMPLEMENTAIRES`) : le contrat des actions lit les champs dans la source.
    const pieces = formData.getAll("annexes").filter((f): f is File => f instanceof File);
    const piecesRefusees = await validateAttachments(pieces);
    if (piecesRefusees) return { ok: false, error: `${piecesRefusees} Aucune demande n'a été créée.` };

    const req = await createWithRetry(async () =>
      prisma.adProOtherRequest.create({
        data: {
          reference: await nextRef(),
          // LA GAMME — même défaut qu'au consulting, même remède : le menu était OBLIGATOIRE et
          // rien ne l'écrivait (§118.140).
          // Lue d'abord SUR LE DEMANDEUR (`gammeImposee`) : le champ ne lui est plus proposé quand
          // sa gamme se déduit, et une valeur postée n'entre pas en ligne de compte pour lui.
          businessUnitId: await gammeImposee(user, fdStr(formData, "businessUnitId") || null),
          doctor: couple.medecins,
          product: couple.produits,
          title,
          description,
          beneficiary: fdStr(formData, "beneficiary"),
          amount: fdNum(formData, "amount") ?? null,
          companyId: companyId || null,
          status: "AWAITING_DECISION",
          requesterId: user.id,
          createdById: user.id,
          updatedById: user.id,
        },
      }),
    );

    // ── LA PORTE DU CENTRE DE VALIDATION AD & PRO ────────────────────────────────────────────
    // Ici la porte se pose à la CRÉATION et non à une soumission : cette nature naît directement
    // « en attente de décision » — il n'existe pas d'étape de brouillon où le montant se
    // stabiliserait. C'est le moment où la demande est ÉNONCÉE, et c'est le seul qu'on ait.
    //
    // Elle n'avait AUCUNE porte avant ce lot : une demande « autre » de 3 M DZD était tranchée
    // par la Direction sans que le centre la voie (§118.71).
    const visaAutre = await poserVisaAdPro("AD_PRO_OTHER", req.id, fdNum(formData, "amount") ?? null);

    if (visaAutre === "PENDING") {
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro — demande au-dessus du seuil",
        body: `${req.reference} — ${title}`, link: lienLigneCentreAdPro(req.id),
      });
    } else {
      await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Demande Ad & Pro — autre",
        body: `${req.reference} — ${title}`, link: `${PATH}/${req.id}`,
      });
    }
    const jointes = await attachFiles({
      files: pieces, entityType: "AD_PRO_OTHER", entityId: req.id, uploadedById: user.id, category: "SUPPORTING_DOC",
    });
    await audit(user, req.id, "CREATE", `Demande « autre » créée — ${req.reference}${jointes.saved > 0 ? ` (${jointes.saved} pièce(s) jointe(s))` : ""}`);
    revalidate(req.id);
    return { ok: true, id: req.id, ...(jointes.error ? { message: `Demande créée. ${jointes.error}` } : {}) };
  } catch (err) {
    console.error("[ad-pro-other] createAdProOtherRequest failed", err);
    return { ok: false, error: "La demande n'a pas pu être créée. Réessayez dans un instant." };
  }
}

/**
 * TRANCHER : valider ou refuser. Le motif est EXIGÉ pour refuser (audit 360°, rapport 17 R14) — un refus
 * sans motif ne laisse au demandeur rien à corriger avant de resoumettre. Valider n'a rien à expliquer.
 */
export async function decideAdProOtherRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const approve = fdStr(formData, "approve") === "1";
    const note = fdStr(formData, "note");
    if (!id) return { ok: false, error: "Demande introuvable." };
    if (!userCan(user, "AD_PRO_OTHER", "VALIDATE")) return { ok: false, error: "La décision revient à la Direction." };

    const req = await prisma.adProOtherRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (req.status !== "AWAITING_DECISION") return { ok: false, error: "Cette demande a déjà été tranchée." };
    // `=== null` / `=== false` et non `!note` / `!approve` : la dérivation des contrats lit un `if (!x`
    // comme un champ OBLIGATOIRE — le motif le deviendrait pour VALIDER aussi, et `approve` pour tout
    // appel (§118.138 ; mesuré sur l'artefact régénéré).
    if (note === null && approve === false) {
      return { ok: false, error: "Indiquez le motif du refus : c'est sur lui que le demandeur corrigera, puis resoumettra." };
    }

    // LA PORTE DU CENTRE GARDE L'ACCORD — pas le refus, qui n'engage rien (§118.15). Sans elle, la porte
    // existerait en base et ne garderait rien ; attendre le centre pour dire non ne protégerait personne.
    if (approve) {
      const blocage = await blocageCentreAdPro("AD_PRO_OTHER", id);
      if (blocage) return { ok: false, error: blocage };
    }

    // CONDITIONNELLE : deux décisions à la même seconde — la seconde trouve la demande déjà tranchée.
    const ecrite = await prisma.adProOtherRequest.updateMany({
      where: { id, status: "AWAITING_DECISION" },
      data: {
        status: (approve ? "APPROVED" : "REFUSED") as AdProOtherStatus,
        decidedById: user.id, decidedAt: new Date(),
        decisionNote: note, updatedById: user.id,
      },
    });
    if (ecrite.count === 0) return { ok: false, error: "Cette demande vient d'être tranchée : rouvrez sa fiche pour voir la décision." };
    // REFUSÉE, ELLE N'ATTEND PLUS LE CENTRE : la porte en attente est retirée ; resoumise, la demande la
    // retrouvera sur son montant corrigé (`ajusterVisaAuMontant`).
    const portes = approve ? 0 : await retirerVisaEnAttente("AD_PRO_OTHER", id);

    if (req.requesterId) {
      await notifyUser({
        userId: req.requesterId, type: "GENERIC",
        title: approve ? "Demande validée" : "Demande refusée",
        body: approve
          ? `${req.reference} — ${req.title}${note ? ` · ${note}` : ""}`
          : `${req.reference} — motif : ${note}. Corrigez-la puis « Resoumettre la demande » sur sa fiche.`,
        link: `${PATH}/${id}`,
      });
    }
    await audit(user, id, "VALIDATE", `${approve ? "Demande validée" : "Demande refusée"} — ${req.reference}${note ? ` — ${note}` : ""}${portes ? " (sa demande au centre Ad & Pro est retirée)" : ""}`);
    revalidate(id);
    return { ok: true, id };
  } catch (err) {
    console.error("[ad-pro-other] decideAdProOtherRequest failed", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

/**
 * RESOUMETTRE UNE DEMANDE REFUSÉE (audit 360°, rapport 17 R14) — son refus était définitif : une demande
 * mal présentée ne pouvait que mourir, et son auteur la redéposait sous une autre référence, en perdant
 * l'historique et les pièces. Elle revient à la décision, avec CE QUI A CHANGÉ (exigé : c'est la première
 * chose que la Direction lira) et, s'il le faut, sa description et son montant corrigés — cette nature
 * n'a pas d'autre geste pour corriger une demande refusée. Le refus d'hier va au fil, il ne s'efface pas.
 */
export async function resoumettreAdProOtherRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.adProOtherRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!userCan(user, "AD_PRO_OTHER", "VIEW") || !(req.requesterId === user.id || hasGlobalView(user.role))) {
      return { ok: false, error: "Seul son demandeur resoumet une demande refusée." };
    }
    if (req.status !== "REFUSED") return { ok: false, error: "Seule une demande refusée se resoumet." };
    // L'état d'abord, le motif ensuite : on ne demande pas ce qui a changé pour une demande qui ne se
    // resoumet pas (§118.18).
    const note = fdStr(formData, "note");
    if (!note) return { ok: false, error: "Dites ce qui a changé depuis le refus : c'est ce que la Direction lira d'abord." };

    // Ce que le formulaire PORTE s'écrit ; ce qu'il ne porte pas reste ce qu'il était (§118.152c).
    const description = formData.has("description") ? fdStr(formData, "description") : undefined;
    if (description === null) return { ok: false, error: "Décrivez la demande — c'est sur cette description que la décision se prendra." };
    const montant = formData.has("amount") ? fdNum(formData, "amount") : undefined;
    if (montant !== undefined && montant !== null && !(montant >= 0)) return { ok: false, error: "Le montant doit être un nombre positif." };

    const ecrite = await prisma.adProOtherRequest.updateMany({
      where: { id, status: "REFUSED" },
      data: {
        status: "AWAITING_DECISION", decidedById: null, decidedAt: null, decisionNote: null, updatedById: user.id,
        ...(description !== undefined ? { description } : {}),
        ...(montant !== undefined ? { amount: montant } : {}),
      },
    });
    if (ecrite.count === 0) return { ok: false, error: "Cette demande vient de changer : rouvrez sa fiche." };

    const decideur = req.decidedById ? (await prisma.user.findUnique({ where: { id: req.decidedById }, select: { name: true } }))?.name : null;
    await ecrireAuFil({
      entityType: "AD_PRO_OTHER", entityId: id, authorId: user.id,
      body: `Resoumise après refus. Le refus${req.decidedAt ? ` du ${formatDate(req.decidedAt)}` : ""}${decideur ? ` (${decideur})` : ""} disait : « ${req.decisionNote ?? "—"} ». Ce qui a changé : ${note}`,
    });

    // LA PORTE DU CENTRE SUIT LE MONTANT de la demande resoumise (audit 360°, lot C4a).
    const montantFinal = montant !== undefined ? montant : (req.amount == null ? null : toNumber(req.amount));
    const visa = await ajusterVisaAuMontant("AD_PRO_OTHER", id, montantFinal);
    if (visa.etat === "PENDING") {
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro — demande resoumise au-dessus du seuil",
        body: `${req.reference} — ${req.title}`, link: lienLigneCentreAdPro(id),
      });
    } else if (visa.etat === "REFUSED") {
      // Sous un REFUS du centre, seul un siège peut la réexaminer : prévenir la Direction, que ce refus
      // bloque, lui demanderait une décision qu'elle ne peut pas prendre (§118.30).
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro — demande resoumise : votre refus est à réexaminer",
        body: `${req.reference} — ${req.title} · ${note}`, link: lienLigneCentreAdPro(id),
      });
    } else {
      await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Demande Ad & Pro resoumise après refus",
        body: `${req.reference} — ${req.title} · ${note}`, link: `${PATH}/${id}`,
      });
    }
    await audit(user, id, "UPDATE", `Demande resoumise après refus — ${req.reference} — ${note}`);
    revalidate(id);
    const phrase = phraseGesteVisa(visa.geste, visa.etat);
    return { ok: true, id, message: phrase ? `Demande resoumise — ${phrase}` : "Demande resoumise : elle revient à la décision de la Direction." };
  } catch (err) {
    console.error("[ad-pro-other] resoumettreAdProOtherRequest failed", err);
    return { ok: false, error: "La resoumission a échoué." };
  }
}

/** Clore une demande validée, une fois qu'elle a été exécutée — ou l'annuler. */
export async function closeAdProOtherRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const cancel = fdStr(formData, "cancel") === "1";
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.adProOtherRequest.findUnique({ where: { id } });
    if (!req) return { ok: false, error: "Demande introuvable." };

    const mine = req.requesterId === user.id || hasGlobalView(user.role);
    if (!mine && !userCan(user, "AD_PRO_OTHER", "VALIDATE")) return { ok: false, error: "Opération non autorisée." };
    if (req.status === "DONE" || req.status === "CANCELLED") return { ok: false, error: "Cette demande est déjà close." };
    // Clore ce qui n'a jamais été validé n'aurait pas de sens : c'est une annulation.
    if (!cancel && req.status !== "APPROVED") return { ok: false, error: "Seule une demande validée peut être marquée terminée." };
    // UNE ANNULATION EST DÉFINITIVE : elle dit pourquoi (audit 360°, R17). `=== null` : « terminée » n'a
    // rien à expliquer, et la dérivation ne doit pas rendre le motif obligatoire pour elle (§118.138).
    const note = fdStr(formData, "note");
    if (cancel && note === null) return { ok: false, error: "Dites pourquoi la demande est annulée : l'annulation est définitive." };

    // CONDITIONNELLE : deux clôtures à la même seconde — la seconde trouve la demande changée au lieu
    // d'écrire une seconde annulation, un second motif au fil et un second audit.
    const ecrite = await prisma.adProOtherRequest.updateMany({
      where: { id, status: req.status },
      data: { status: (cancel ? "CANCELLED" : "DONE") as AdProOtherStatus, updatedById: user.id },
    });
    if (ecrite.count === 0) return { ok: false, error: "Cette demande vient de changer d'état : rouvrez sa fiche." };
    // ANNULÉE, ELLE N'A PLUS RIEN À FAIRE ARBITRER (audit 360°, lot C3) — la même règle qu'au consulting.
    const portes = cancel ? await retirerVisaEnAttente("AD_PRO_OTHER", id) : 0;
    if (cancel && note) await ecrireAuFil({ entityType: "AD_PRO_OTHER", entityId: id, authorId: user.id, body: `Demande annulée — ${note}` });
    await audit(user, id, "UPDATE", `${cancel ? "Demande annulée" : "Demande terminée"} — ${req.reference}${cancel && note ? ` — ${note}` : ""}${portes ? " (sa demande au centre Ad & Pro est retirée)" : ""}`);
    revalidate(id);
    return { ok: true, id };
  } catch (err) {
    console.error("[ad-pro-other] closeAdProOtherRequest failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}
