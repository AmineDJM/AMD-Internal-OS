"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { persistUploadedDocument } from "@/lib/documents";
import { validateAttachments } from "@/lib/attach-files";
import { ETAPE_COPIE_SIGNEE, FORMATS_COPIE_SIGNEE, phraseVerdictSignature, refusCopieSignee } from "@/lib/bons-de-commande/copie-signee";
import { verifierSignatureParLuna } from "@/lib/bons-de-commande/signature-luna";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { motifNonSignable } from "@/lib/bons-de-commande/regle";
import { bcVisiblesWhere, peutSignerBC, REFUS_SIGNATURE_BC } from "@/lib/queries/bons-de-commande";
import { apresSignatureDuBCDeDemande } from "@/lib/secretariat/bc-signe";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SIGNER UN BON DE COMMANDE — le geste des signataires (§118.149), module à part (§118.176).
 *
 * « Si un BC se retrouve là-bas, c'est qu'il doit être signé. » La signature est une
 * ATTESTATION : elle engage la société au nom d'une personne, et l'audit portera son nom. Elle
 * se donne donc par un CLIC, dans une vraie session — jamais par Adam, jamais par le chemin
 * générique (le fichier est une surface humaine, §118.15, `actions/generique.ts`).
 *
 * Trois gardes, dans l'ordre où elles se lisent : le DROIT (« Modifier » sur le module « Bons de
 * commande », que le Super Admin accorde à qui il veut), la LECTURE (la même
 * portée que l'écran Legal : un BC restreint ne se signe pas par quelqu'un qui ne peut pas le
 * voir), et l'ÉTAPE — un BC qui attend encore son centre, ou qui a été refusé, ne se signe pas,
 * et le refus dit pourquoi et ce qui le lève (`motifNonSignable`). L'écriture ne pose la signature
 * que si elle manque encore : deux clics simultanés ne signent pas deux fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/*
 * LE BC SIGNÉ SUR PAPIER (Direction, 06/10) : « quand les Finances uploadent le BC signé, ça doit être
 * obligatoire, avec mention du signataire ». La signature se pose donc avec DEUX pièces exigées : la copie
 * signée (scan ou photo) et le nom de qui a signé. Luna regarde le bas de la copie ; sans signature repérée,
 * rien n'est posé. La copie devient la pièce du BC : c'est elle qu'Ad&Pro montre à la place du BC non signé.
 */
export async function signerBonDeCommande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Bon de commande non précisé." };
  if (!peutSignerBC(user)) return { ok: false, error: REFUS_SIGNATURE_BC };
  const signataire = fdStr(formData, "signataire");
  const copie = formData.getAll("copieSignee").find((v): v is File => v instanceof File && v.size > 0) ?? null;

  const visibles = await bcVisiblesWhere(user);
  const visible = visibles
    ? await prisma.legalDocument.findFirst({ where: { AND: [visibles, { id }] }, select: { id: true } })
    : null;
  if (!visible) return { ok: false, error: "Bon de commande introuvable." };

  const etat = await etatDuBC(id);
  if (!etat) return { ok: false, error: "Bon de commande introuvable." };
  if (etat.annule) return { ok: false, error: "Ce bon de commande est annulé : il ne se signe pas." };
  const motif = motifNonSignable(etat.etape, etat.porte);
  if (motif) return { ok: false, error: motif };

  // L'ÉTAT D'ABORD, LES PIÈCES ENSUITE (§118.18) : la copie signée, puis le signataire.
  if (!copie) return { ok: false, error: "Téléversez le bon de commande SIGNÉ (scan ou photo) : la signature s'enregistre avec sa copie." };
  const ext = (copie.name.split(".").pop() ?? "").toLowerCase();
  if (!(FORMATS_COPIE_SIGNEE as readonly string[]).includes(ext)) return { ok: false, error: `La copie signée se dépose en PDF ou en image (${FORMATS_COPIE_SIGNEE.join(", ")}) — pas en .${ext || "?"}.` };
  const refusFichier = await validateAttachments([copie]);
  if (refusFichier) return { ok: false, error: refusFichier };
  if (!signataire) return { ok: false, error: "Indiquez qui a signé ce bon de commande." };
  const octets = Buffer.from(await copie.arrayBuffer());
  const verdict = await verifierSignatureParLuna(octets, ext);
  const refusCopie = refusCopieSignee(verdict, etat.reference);
  if (refusCopie) return { ok: false, error: refusCopie };

  // CE QUI A ÉTÉ RELU EST CE QUI EST SIGNÉ. La pièce a pu changer entre la lecture de son étape
  // et ce clic — un montant relevé qui la renvoie à son centre, un autre fournisseur. Le verrou
  // porte donc sur sa DERNIÈRE ÉCRITURE, pas seulement sur l'absence de signature : sinon on
  // signerait un BC que la règle venait de renvoyer à la validation.
  const signe = await prisma.legalDocument.updateMany({
    where: { id, signedAt: null, updatedAt: etat.majLe },
    data: { signedAt: new Date(), signedById: user.id, signedByName: signataire.slice(0, 120), signatureCheck: verdict as unknown as Prisma.InputJsonValue },
  });
  if (signe.count === 0) {
    const deja = await prisma.legalDocument.findUnique({ where: { id }, select: { signedAt: true } });
    return {
      ok: false,
      error: deja?.signedAt
        ? "Ce bon de commande vient d'être signé."
        : "Ce bon de commande vient d'être modifié : relisez-le avant de le signer.",
    };
  }
  // LA COPIE SIGNÉE devient la pièce du BC. Sans elle, la signature ne tient pas : on la retire.
  const depot = await persistUploadedDocument(user.id, {
    entityType: "LEGAL_DOCUMENT", entityId: id, category: "OTHER", confidentiality: "INTERNAL", stepKey: ETAPE_COPIE_SIGNEE, file: copie, buffer: octets,
  }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "Dépôt impossible.", documentId: undefined }));
  if (!depot.ok) {
    await prisma.legalDocument.update({ where: { id }, data: { signedAt: null, signedById: null, signedByName: null, signatureCheck: Prisma.DbNull } });
    return { ok: false, error: `La copie signée n'a pas pu être enregistrée (${depot.error ?? "erreur"}) : rien n'est signé, réessayez.` };
  }

  const ref = etat.reference?.trim() ? etat.reference.trim() : `« ${etat.title} »`;
  const montant = etat.montant != null && etat.montant > 0 ? `${etat.montant.toLocaleString("fr-FR")} DZD` : "montant non renseigné";
  const constat = phraseVerdictSignature(verdict);
  await recordAudit({
    // L'audit nomme le MODULE de la signature, et la personne par `actorId` : « signé par les
    // Finances » serait faux sous la plume d'un signataire que le Super Admin a désigné ailleurs.
    actorId: user.id, action: "VALIDATE", module: "Bons de commande", entityType: "LEGAL_DOCUMENT", entityId: id,
    summary: `Bon de commande ${ref} signé par ${signataire} — copie signée téléversée (${montant})${etat.counterparty ? ` — ${etat.counterparty}` : ""}. ${constat}`,
  });
  // CELUI QUI A ÉTABLI LE BC EST PRÉVENU : c'est lui qui l'envoie au fournisseur, et il ne le fait
  // qu'une fois signé — puis il dépose la facture.
  if (etat.createdById && etat.createdById !== user.id) {
    await notifyUser({
      userId: etat.createdById, type: "GENERIC",
      title: "Bon de commande signé",
      body: `${ref} (${montant}) signé par ${signataire} — la copie signée est sur la pièce. Il peut partir chez le fournisseur ; la facture se dépose ensuite.`,
      link: `/legal/${id}`,
    }).catch(sansBloquer("bc-signature-actions.signerBonDeCommande.notifyUser"));
  }
  revalidatePath(CHEMIN_BC_A_SIGNER);
  revalidatePath("/legal");
  revalidatePath(`/legal/${id}`);
  revalidatePath("/ad-pro", "layout");
  // LE BC D'UNE DEMANDE AU SECRÉTARIAT revient « signé et validé » sur sa fiche : l'assistante et le demandeur le savent.
  await apresSignatureDuBCDeDemande(id, user.id, signataire).catch(sansBloquer("bc-signature-actions.signerBonDeCommande.apresSignatureDuBCDeDemande"));
  revalidatePath("/demandes", "layout");
  return { ok: true, id, message: `Bon de commande ${ref} signé par ${signataire}. ${constat} Il remplace le BC non signé, et la facture peut être déposée.` };
}

/**
 * RENVOYER UN BON DE COMMANDE À SON ÉMETTEUR — au lieu de le signer (audit 360°, R09).
 *
 * Un seul geste existait, signer : un BC erroné (mauvais fournisseur, montant faux, pièce illisible)
 * ne pouvait ni être refusé ni repartir chez son émetteur — le signataire n'avait que le silence. Il
 * le RENVOIE maintenant avec ce qu'il faut corriger : le BC quitte la file des signataires, son
 * émetteur est prévenu, et TOUTE modification de la pièce le rend à la signature (ou à son centre si
 * son montant l'y renvoie — `aiguillerBC`). Ce n'est pas un refus : rien n'est fermé, et la décision
 * du centre qui l'a validé reste acquise tant que le montant ne monte pas.
 *
 * Mêmes gardes que la signature, parce que c'est le même siège qui le fait : le droit, la lecture,
 * l'étape (« à signer », et elle seule). Le motif est EXIGÉ : renvoyer sans dire pourquoi laisse
 * l'émetteur deviner quoi corriger. L'écriture est conditionnelle à la DERNIÈRE écriture relue : ce
 * qui a été relu est ce qui est renvoyé, et deux clics ne renvoient pas deux fois.
 */
export async function renvoyerBonDeCommande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const note = fdStr(formData, "note");
  if (!id) return { ok: false, error: "Bon de commande non précisé." };
  if (!peutSignerBC(user)) return { ok: false, error: REFUS_SIGNATURE_BC };
  if (!note) return { ok: false, error: "Dites ce qu'il faut corriger : sans cela, l'émetteur ne sait pas quoi changer avant de vous le rendre." };

  const visibles = await bcVisiblesWhere(user);
  const visible = visibles
    ? await prisma.legalDocument.findFirst({ where: { AND: [visibles, { id }] }, select: { id: true } })
    : null;
  if (!visible) return { ok: false, error: "Bon de commande introuvable." };

  const etat = await etatDuBC(id);
  if (!etat) return { ok: false, error: "Bon de commande introuvable." };
  if (etat.annule) return { ok: false, error: "Ce bon de commande est annulé : il n'y a rien à renvoyer." };
  if (etat.etape === "A_CORRIGER") return { ok: false, error: "Ce bon de commande est déjà renvoyé à son émetteur." };
  // Seul un BC « à signer » se renvoie : avant, c'est son centre qui a la main ; signé, il est parti.
  const motif = motifNonSignable(etat.etape, etat.porte);
  if (motif) return { ok: false, error: motif };

  const renvoye = await prisma.legalDocument.updateMany({
    where: { id, signedAt: null, signatureReturnedAt: null, updatedAt: etat.majLe },
    data: { signatureReturnedAt: new Date(), signatureReturnedById: user.id, signatureReturnNote: note },
  });
  if (renvoye.count === 0) {
    return { ok: false, error: "Ce bon de commande vient de changer (signé, renvoyé ou modifié) : relisez-le." };
  }

  const ref = etat.reference?.trim() ? etat.reference.trim() : `« ${etat.title} »`;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Bons de commande", entityType: "LEGAL_DOCUMENT", entityId: id,
    summary: `Bon de commande ${ref} renvoyé à son émetteur pour correction — ${note}`,
  });
  // L'ÉMETTEUR EST PRÉVENU, et le geste qui le rend à la signature est NOMMÉ (§118.30). Sans émetteur
  // connu (une pièce ancienne), la phrase le DIT plutôt que de laisser croire que quelqu'un sait.
  const prevenu = Boolean(etat.createdById && etat.createdById !== user.id);
  if (prevenu) {
    await notifyUser({
      userId: etat.createdById!, type: "GENERIC",
      title: "Bon de commande renvoyé pour correction",
      body: `${ref} : « ${note} ». Modifiez-le dans Legal — sa modification le rend à la signature.`,
      link: `/legal/${id}`,
    }).catch(sansBloquer("bc-signature-actions.renvoyerBonDeCommande.notifyUser"));
  }
  revalidatePath(CHEMIN_BC_A_SIGNER);
  revalidatePath("/legal");
  revalidatePath(`/legal/${id}`);
  return {
    ok: true, id,
    message: prevenu
      ? `Bon de commande ${ref} renvoyé à son émetteur : il revient dans votre file dès qu'il est corrigé.`
      : `Bon de commande ${ref} renvoyé — aucun émetteur n'est enregistré sur la pièce : prévenez la personne qui l'a établie.`,
  };
}
