"use server";

import type { AdProOtherStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser, requireUserAuNomDeLaVue } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { retirerVisaEnAttente } from "@/lib/ad-pro/visa";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { createWithRetry, referenceDeSerie } from "@/lib/refs";
import { companyIdForNew } from "@/lib/company";
import { readMultiField, lireMedecinsDemande } from "@/lib/ad-pro/pickers";
import { gammeImposee } from "@/lib/ad-pro/business-unit-auto";
import { statutAutreDepuisCircuit } from "@/lib/workflow/autre-statut";
import { adProInit } from "@/lib/workflow/origin";
import {
  advanceWorkflowInstance, ensureInstance, fermerInstance, ouvrirLeCircuit, resubmitWorkflowInstance,
} from "@/lib/workflow/engine";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
import { canAccessEntity } from "@/lib/entity-access";
const PATH = "/ad-pro/autres";

/**
 * LA DEMANDE QUI N'ENTRE DANS AUCUNE CASE.
 *
 * Sans elle, une dépense de promotion inhabituelle se déclare « en sponsoring » faute de mieux —
 * et l'on perd deux choses à la fois : la lisibilité du sponsoring, qui se remplit d'objets qui
 * n'en sont pas, et la trace de la dépense, rangée sous une étiquette fausse.
 *
 * ── ELLE SUIT LE CIRCUIT COMMUN (Direction, 27/10/2026 — décision #17) ──────────────────────
 *
 * Son circuit était COURT : un demandeur, une décision de la Direction, un motif, et un visa du centre
 * Ad & Pro posé à la création au-dessus du seuil. Il est désormais celui du sponsoring, des prises en
 * charge et des événements (catégorie de circuit `OTHER`, `docs/architecture/adpro-circuit-2026-10-27.md`) :
 *   1. PRÉVALIDATION par la route de son créateur — National Sales (délégué), Directeur des opérations,
 *      puis la Direction Marketing qui prévalide (prévalidée d'office quand elle en est l'autrice) ;
 *   2. POSTES ajoutés après la prévalidation, acceptés par la Direction Marketing ;
 *   3. le DG valide le TOTAL des postes au-dessus du seuil (`ad-pro/porte-dg.ts`).
 * Le visa du centre à la création disparaît donc : le DG ne juge plus le montant DEMANDÉ, mais le total
 * réel des postes. Le statut de la ligne est PROJETÉ par le moteur (`workflow/autre-statut.ts`).
 */

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "AdProOtherRequest", prefixe: "AUT", annee: year,
    existantes: async () => (await prisma.adProOtherRequest.findMany({ where: { reference: { startsWith: `AUT-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

function revalidate(id?: string) {
  revalidatePath(PATH);
  revalidatePath("/ad-pro");
  if (id) revalidatePath(`${PATH}/${id}`);
}

async function audit(user: SessionUser, id: string, action: "CREATE" | "UPDATE" | "VALIDATE", summary: string) {
  await recordAudit({ actorId: user.id, action, module: "Ad & Pro — autres demandes", entityType: "AD_PRO_OTHER", entityId: id, summary });
}

const spectateur = (user: SessionUser & { name?: string | null }) => ({ id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name ?? null });

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

    // LA ROUTE DU CRÉATEUR (27/10/2026) — la même lecture que le sponsoring, les prises en charge et
    // l'événement (`adProInit`). Le statut d'entrée « legacy » (préliminaire, Directeur des opérations,
    // Direction Marketing) se TRADUIT en « en cours de validation » : l'étape exacte vit sur l'instance.
    const init = adProInit(user, "OTHER");
    const statutInitial = statutAutreDepuisCircuit(init.status) ?? "AWAITING_DECISION";

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
          status: statutInitial,
          requesterId: user.id,
          createdById: user.id,
          updatedById: user.id,
        },
      }),
    );

    const jointes = await attachFiles({
      files: pieces, entityType: "AD_PRO_OTHER", entityId: req.id, uploadedById: user.id, category: "SUPPORTING_DOC",
    });
    await audit(user, req.id, "CREATE", `Demande « autre » créée — ${req.reference}${jointes.saved > 0 ? ` (${jointes.saved} pièce(s) jointe(s))` : ""}`);
    // LE CIRCUIT NAÎT AVEC LA DEMANDE et prévient chaque acteur de SON parcours (décision #1, 27/10/2026) :
    // plus de rôles écrits à la main ici, plus de visa du centre à la création.
    await ouvrirLeCircuit("AD_PRO_OTHER", req.id);
    revalidate(req.id);
    return { ok: true, id: req.id, ...(jointes.error ? { message: `Demande créée. ${jointes.error}` } : {}) };
  } catch (err) {
    console.error("[ad-pro-other] createAdProOtherRequest failed", err);
    return { ok: false, error: "La demande n'a pas pu être créée. Réessayez dans un instant." };
  }
}

/**
 * TRANCHER : valider ou refuser — PAR LE CIRCUIT (27/10/2026, décision #17).
 *
 * Ce geste écrivait la décision à la main, au nom de la « Direction ». La demande « autre » suit
 * désormais le circuit commun : il n'y a plus de décision hors de lui. Le geste est donc ROUTÉ vers le
 * moteur (`advanceWorkflowInstance`) — c'est lui qui dit qui agit à l'étape courante (National Sales,
 * Directeur des opérations, Direction Marketing), ce que vaut un refus (avis défavorable avant l'étape
 * qui conclut, refus définitif à elle), et qui est prévenu. On le garde plutôt que de le retirer : Adam
 * (`decide_other_request`) et les demandes nées avant la règle l'appellent, et un geste qui refuserait
 * tout laisserait ces chemins dans l'impasse ; un geste qui contournerait le circuit le défairait.
 *
 * Le motif est EXIGÉ pour refuser (audit 360°, rapport 17 R14) — le moteur l'exige aussi.
 */
export async function decideAdProOtherRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const approve = fdStr(formData, "approve") === "1";
    const note = fdStr(formData, "note");
    if (!id) return { ok: false, error: "Demande introuvable." };

    const req = await prisma.adProOtherRequest.findUnique({ where: { id }, select: { id: true } });
    // Hors de la porte de sa fiche, la demande est introuvable — la même phrase que son absence.
    if (!req || !(await canAccessEntity(user, "AD_PRO_OTHER", id, "VIEW"))) return { ok: false, error: "Demande introuvable." };
    // `=== null` / `=== false` et non `!note` / `!approve` : la dérivation des contrats lit un `if (!x`
    // comme un champ OBLIGATOIRE — le motif le deviendrait pour VALIDER aussi, et `approve` pour tout
    // appel (§118.138 ; mesuré sur l'artefact régénéré).
    if (note === null && approve === false) {
      return { ok: false, error: "Indiquez le motif du refus : c'est sur lui que le demandeur corrigera." };
    }

    // Une demande née avant la règle n'a pas encore d'instance : elle s'ouvre ici, à l'étape que sa route
    // désigne — la même lecture qu'à l'ouverture de sa fiche.
    const instance = await ensureInstance("AD_PRO_OTHER", id);
    if (!instance) return { ok: false, error: "Le circuit de cette demande n'a pas pu être ouvert. Réessayez dans un instant." };
    if (instance.status !== "IN_PROGRESS" && instance.status !== "RETURNED") {
      return { ok: false, error: "Cette demande a déjà été tranchée par son circuit : rouvrez sa fiche pour voir la décision." };
    }
    const r = await advanceWorkflowInstance({
      viewer: spectateur(user), entityType: "AD_PRO_OTHER", entityId: id,
      action: approve ? "APPROVE" : "REJECT", note,
    });
    if (!r.ok) return { ok: false, error: r.error };
    revalidate(id);
    return { ok: true, id, message: approve ? "Avis enregistré : la demande avance dans son circuit." : "Refus enregistré dans le circuit." };
  } catch (err) {
    console.error("[ad-pro-other] decideAdProOtherRequest failed", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

/**
 * RESOUMETTRE UNE DEMANDE RENVOYÉE POUR CORRECTION — par le circuit (27/10/2026, décision #17).
 *
 * Elle resoumettait une demande REFUSÉE, en écrivant le statut à la main. Dans le circuit commun, deux
 * chemins distincts existent, et ce geste ne prend que le sien :
 *   • RENVOYÉE pour correction (« à corriger ») : elle est corrigée — description et montant, s'ils sont
 *     postés — puis resoumise ; elle revient à l'étape qui l'a renvoyée (`resubmitWorkflowInstance`) ;
 *   • REFUSÉE définitivement : on n'y revient que par l'APPEL (« Faire appel » sur le panneau du circuit,
 *     `faireAppelAdPro`), qui rouvre l'étape qui a tranché. Le refus le dit au lieu de deviner.
 * Ce qui a changé est EXIGÉ : c'est la première chose que l'étape lira.
 */
export async function resoumettreAdProOtherRequest(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Demande introuvable." };
    const req = await prisma.adProOtherRequest.findUnique({ where: { id }, select: { id: true, reference: true, requesterId: true } });
    if (!req) return { ok: false, error: "Demande introuvable." };
    if (!userCan(user, "AD_PRO_OTHER", "VIEW") || !(req.requesterId === user.id || hasGlobalView(user.role))) {
      return { ok: false, error: "Seul son demandeur resoumet une demande renvoyée pour correction." };
    }
    const instance = await ensureInstance("AD_PRO_OTHER", id);
    if (!instance) return { ok: false, error: "Le circuit de cette demande n'a pas pu être ouvert. Réessayez dans un instant." };
    if (instance.status === "REJECTED") {
      return { ok: false, error: "Cette demande a été refusée par son circuit : contestez le refus par « Faire appel » sur le panneau du circuit." };
    }
    if (instance.status !== "RETURNED") return { ok: false, error: "Cette demande n'est pas à corriger : il n'y a rien à resoumettre." };
    // L'état d'abord, le motif ensuite : on ne demande pas ce qui a changé pour une demande qui ne se
    // resoumet pas (§118.18).
    const note = fdStr(formData, "note");
    if (!note) return { ok: false, error: "Dites ce qui a changé : c'est ce que l'étape qui l'a renvoyée lira d'abord." };

    // Ce que le formulaire PORTE s'écrit ; ce qu'il ne porte pas reste ce qu'il était (§118.152c).
    const description = formData.has("description") ? fdStr(formData, "description") : undefined;
    if (description === null) return { ok: false, error: "Décrivez la demande — c'est sur cette description que la décision se prendra." };
    const montant = formData.has("amount") ? fdNum(formData, "amount") : undefined;
    if (montant !== undefined && montant !== null && !(montant >= 0)) return { ok: false, error: "Le montant doit être un nombre positif." };
    if (description !== undefined || montant !== undefined) {
      // CONDITIONNELLE : la demande doit être encore « à corriger » — une resoumission concurrente l'a déjà renvoyée au circuit.
      const ecrite = await prisma.adProOtherRequest.updateMany({
        where: { id, status: "RETURNED" },
        data: {
          updatedById: user.id,
          ...(description !== undefined ? { description } : {}),
          ...(montant !== undefined ? { amount: montant } : {}),
        },
      });
      if (ecrite.count === 0) return { ok: false, error: "Cette demande vient de changer : rouvrez sa fiche." };
    }

    const r = await resubmitWorkflowInstance({ viewer: spectateur(user), entityType: "AD_PRO_OTHER", entityId: id, note });
    if (!r.ok) return { ok: false, error: r.error };
    await audit(user, id, "UPDATE", `Demande corrigée et resoumise — ${req.reference} — ${note}`);
    revalidate(id);
    return { ok: true, id, message: `Demande resoumise — elle attend de nouveau « ${r.etape} ».` };
  } catch (err) {
    console.error("[ad-pro-other] resoumettreAdProOtherRequest failed", err);
    return { ok: false, error: "La resoumission a échoué." };
  }
}

/**
 * Clore une demande prévalidée, une fois qu'elle a été exécutée — ou l'annuler. Annulée en cours de
 * circuit, son circuit se FERME (`fermerInstance`) : le panneau ne propose plus « Approuver » sur une
 * demande annulée, et personne n'est plus attendu.
 */
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
    // Clore ce qui n'a jamais été prévalidé n'aurait pas de sens : c'est une annulation.
    if (!cancel && req.status !== "APPROVED") return { ok: false, error: "Seule une demande prévalidée peut être marquée terminée." };
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
    // ANNULÉE, ELLE N'A PLUS RIEN À FAIRE ARBITRER : son circuit se ferme, et une porte du centre héritée
    // d'avant la règle du 27/10/2026 est retirée (audit 360°, lot C3).
    if (cancel) {
      await fermerInstance({ viewer: spectateur(user), entityType: "AD_PRO_OTHER", entityId: id, motif: note ?? "Demande annulée." })
        .catch((e) => console.error("[ad-pro-other] circuit non fermé (non bloquant)", e));
    }
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
