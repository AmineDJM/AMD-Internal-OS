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
import { apresSignatureDuBCDeDemande, apresSignatureDuBCDesFiches } from "@/lib/secretariat/bc-signe";
import { marquerNonRetenusDuBC } from "@/lib/bons-de-commande/retenue-bc";
import { sansBloquer } from "@/lib/journal";
import { headers } from "next/headers";
import { getBlob } from "@/lib/drive-storage";
import { clientIp } from "@/lib/device";
import { controleRenforce, REFUS_VUE_EXACTE, commencerEnrolement, confirmerEnrolement, sousLeCoffre } from "@/lib/signature-en-ligne/second-facteur";
import { qrPng } from "@/lib/qr";
import { deposerVisuel, type NatureVisuel } from "@/lib/signature-en-ligne/visuels";
import { CHEMIN_MA_SIGNATURE } from "@/lib/signature-en-ligne/partage";
import { lienPosteAssistante } from "@/lib/chemins/ad-pro";
import { apposerSignatureEnLigne, exigeSignatureMarketing, REFUS_SIGNATURE_MARKETING_ABSENTE, refusSecondeSignature, sousVerrouDesSignataires } from "@/lib/signature-en-ligne/signer-bc";

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
  // LE BC D'UN POSTE « PAR UNE AGENCE » (15/11/2026) : la Direction Marketing signe d'abord.
  if (await marketingManquante(id)) return { ok: false, error: REFUS_SIGNATURE_MARKETING_ABSENTE };
  // DEUX SIGNATURES, DEUX PERSONNES (Super Admin, 24/11/2026) : qui enregistre la copie signée tient la place des Finances —
  // refusé tôt s'il a signé pour la Direction Marketing (avant Luna), puis revérifié sous verrou à l'écriture.
  const signataireFinances = { id: user.id, role: user.role, secondaryRole: user.secondaryRole };
  const refusDouble = await refusSecondeSignature(id, "FINANCES", signataireFinances);
  if (refusDouble) return { ok: false, error: refusDouble };

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
  const pose = await sousVerrouDesSignataires(id, "FINANCES", signataireFinances, (tx) => tx.legalDocument.updateMany({
    where: { id, signedAt: null, updatedAt: etat.majLe },
    data: { signedAt: new Date(), signedById: user.id, signedByName: signataire.slice(0, 120), signatureCheck: verdict as unknown as Prisma.InputJsonValue },
  }));
  if ("refus" in pose) return { ok: false, error: pose.refus };
  if (pose.fait.count === 0) {
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
  await apresLaSignature(id, user.id, signataire);
  return { ok: true, id, message: `Bon de commande ${ref} signé par ${signataire}. ${constat} Il remplace le BC non signé, et la facture peut être déposée.` };
}

/** Ce qui suit toute signature des Finances — scan déposé ou signature en ligne : les écrans, la demande au secrétariat, les devis non retenus. */
async function apresLaSignature(id: string, userId: string, signataire: string): Promise<void> {
  revalidatePath(CHEMIN_BC_A_SIGNER);
  revalidatePath("/legal");
  revalidatePath(`/legal/${id}`);
  revalidatePath("/ad-pro", "layout");
  // LE BC D'UNE DEMANDE AU SECRÉTARIAT revient « signé et validé » sur sa fiche : l'assistante et le demandeur le savent.
  await apresSignatureDuBCDeDemande(id, userId, signataire).catch(sansBloquer("bc-signature-actions.signerBonDeCommande.apresSignatureDuBCDeDemande"));
  // LE BC D'UN POSTE À FICHES DE VOYAGE : l'assistante qui les a prises fait émettre les billets (recette du 23/11/2026).
  await apresSignatureDuBCDesFiches(id, userId, signataire).catch(sansBloquer("bc-signature-actions.signerBonDeCommande.apresSignatureDuBCDesFiches"));
  // LE BC D'UN POSTE SIGNÉ (Direction, 11/2026) : les devis du poste qui n'y ont rien fait commander sont « non retenus ».
  await marquerNonRetenusDuBC(id).catch(sansBloquer("bc-signature-actions.signerBonDeCommande.marquerNonRetenusDuBC"));
  revalidatePath("/demandes", "layout");
}

/** Un BC de poste « par une agence » que la Direction Marketing n'a pas encore signé. */
async function marketingManquante(id: string): Promise<boolean> {
  if (!(await exigeSignatureMarketing(id))) return false;
  return !(await prisma.signatureBC.findUnique({ where: { legalDocumentId_qualite: { legalDocumentId: id, qualite: "DIRECTION_MARKETING" } }, select: { id: true } }));
}

/**
 * SIGNER ET CACHETER UN BC EN LIGNE — LES FINANCES (Direction, 15/11/2026). Mêmes gardes que la copie signée (droit,
 * lecture, étape, signature de la Direction Marketing d'abord), puis le CONTRÔLE RENFORCÉ : mot de passe du compte et code
 * de l'application d'authentification. La signature et le cachet de la personne sont incrustés dans le PDF, scellé
 * (empreinte, QR de vérification) ; ce PDF devient la copie signée du BC, que tout l'aval lit déjà.
 */
export async function signerBonDeCommandeEnLigne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.impersonatedBy) return { ok: false, error: REFUS_VUE_EXACTE };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Bon de commande non précisé." };
  if (!peutSignerBC(user)) return { ok: false, error: REFUS_SIGNATURE_BC };
  const visibles = await bcVisiblesWhere(user);
  const visible = visibles ? await prisma.legalDocument.findFirst({ where: { AND: [visibles, { id }] }, select: { id: true } }) : null;
  if (!visible) return { ok: false, error: "Bon de commande introuvable." };
  const etat = await etatDuBC(id);
  if (!etat) return { ok: false, error: "Bon de commande introuvable." };
  if (etat.annule) return { ok: false, error: "Ce bon de commande est annulé : il ne se signe pas." };
  const motif = motifNonSignable(etat.etape, etat.porte);
  if (motif) return { ok: false, error: motif };
  if (await marketingManquante(id)) return { ok: false, error: REFUS_SIGNATURE_MARKETING_ABSENTE };
  // DEUX SIGNATURES, DEUX PERSONNES (24/11/2026) : refusé avant le code à usage unique ; l'apposition le revérifie sous verrou.
  const refusDouble = await refusSecondeSignature(id, "FINANCES", { id: user.id, role: user.role, secondaryRole: user.secondaryRole });
  if (refusDouble) return { ok: false, error: refusDouble };
  if (fdStr(formData, "lu") !== "oui") return { ok: false, error: "Cochez « J'ai lu ce bon de commande » : on ne signe que ce qu'on a relu." };
  const h = await headers();
  const ip = clientIp(h);
  const refus = await controleRenforce(user.id, String(formData.get("motDePasse") ?? ""), fdStr(formData, "code") ?? "", ip);
  if (refus) return { ok: false, error: refus };

  const signataire = (user.name ?? "Finances").slice(0, 120);
  const pris = await prisma.legalDocument.updateMany({
    where: { id, signedAt: null, updatedAt: etat.majLe },
    data: { signedAt: new Date(), signedById: user.id, signedByName: signataire, signatureCheck: { statut: "SIGNE_EN_LIGNE", signature: true, cachet: true } as Prisma.InputJsonValue },
  });
  if (pris.count === 0) return { ok: false, error: "Ce bon de commande vient de changer (signé ou modifié) : relisez-le avant de le signer." };
  const r = await apposerSignatureEnLigne({ legalDocumentId: id, reference: etat.reference ?? id, qualite: "FINANCES", user: { id: user.id, name: user.name ?? null }, ip, agent: h.get("user-agent"), lireBlob: getBlob });
  if (!r.ok) {
    await prisma.legalDocument.update({ where: { id }, data: { signedAt: null, signedById: null, signedByName: null, signatureCheck: Prisma.DbNull } });
    return { ok: false, error: r.error };
  }
  const ref = etat.reference?.trim() ? etat.reference.trim() : `« ${etat.title} »`;
  // LE SUPER ADMIN EN SUPPLÉANCE DES FINANCES (21/11/2026) : ce que le sceau a écrit sous son nom, repris tel quel.
  const qualiteDite = r.suppleance ? r.titre : "Finances";
  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: "Bons de commande", entityType: "LEGAL_DOCUMENT", entityId: id,
    summary: `Bon de commande ${ref} signé et cacheté EN LIGNE par ${signataire} (${qualiteDite}) — mot de passe + code à usage unique, PDF scellé (empreinte ${r.empreinte.slice(0, 16)}…).`,
  });
  if (etat.createdById && etat.createdById !== user.id) {
    await notifyUser({
      userId: etat.createdById, type: "GENERIC", title: "Bon de commande signé et cacheté",
      body: `${ref} signé et cacheté en ligne par ${signataire} (${qualiteDite}). Il peut partir chez le fournisseur.`, link: `/legal/${id}`,
    }).catch(sansBloquer("bc-signature-actions.signerBonDeCommandeEnLigne.notifyUser"));
  }
  await apresLaSignature(id, user.id, signataire);
  return { ok: true, id, message: `Bon de commande ${ref} signé et cacheté. Le PDF scellé remplace le BC non signé ; la facture peut être déposée.` };
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
  // LE BC D'UN POSTE « AGENCE » (23/11/2026) : c'est l'assistante qui prospecte le poste qui le corrige — prévenue elle aussi,
  // et sur SA page (« Prospection d'agences ») : elle n'ouvre ni Legal ni la fiche de la demande.
  const poste = await prisma.adProItemPiece.findFirst({
    where: { legalDocumentId: id, nature: "BON_DE_COMMANDE", item: { voie: "AGENCE" } },
    select: { itemId: true, item: { select: { execution: { select: { assistanteId: true } } } } },
  });
  const assistante = poste?.item.execution?.assistanteId ?? null;
  const destinataires = [...new Set([etat.createdById, assistante].filter((x): x is string => Boolean(x) && x !== user.id))];
  const prevenu = destinataires.length > 0;
  for (const userId of destinataires) {
    const surLePoste = poste && userId === assistante;
    await notifyUser({
      userId, type: "GENERIC",
      title: "Bon de commande renvoyé pour correction",
      body: `${ref} : « ${note} ». ${surLePoste ? "Corrigez-le sur le poste" : "Modifiez-le dans Legal"} — sa modification le rend à la signature.`,
      link: surLePoste ? lienPosteAssistante(poste.itemId) : `/legal/${id}`,
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

// ─────────────── MA SIGNATURE (Direction, 15/11/2026) ───────────────
//
// Ce que chaque signataire prépare UNE fois, pour lui seul : l'image de sa signature, celle de son cachet, et son code de
// signature (application d'authentification). Personne ne prépare la signature d'un autre : chaque geste porte sur le compte
// connecté, et jamais en « Vue exacte ».

export async function deposerMonVisuel(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.impersonatedBy) return { ok: false, error: REFUS_VUE_EXACTE };
  const nature = fdStr(formData, "nature") as NatureVisuel;
  const fichier = formData.get("fichier");
  if (!(fichier instanceof File)) return { ok: false, error: "Choisissez une image." };
  const refus = await deposerVisuel(user.id, nature, fichier);
  if (refus) return { ok: false, error: refus };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sécurité", summary: `${nature === "CACHET" ? "Cachet" : "Signature"} de signature en ligne déposé(e).` });
  revalidatePath(CHEMIN_MA_SIGNATURE);
  return { ok: true, message: nature === "CACHET" ? "Cachet enregistré." : "Signature enregistrée." };
}

/** Afficher le QR code à scanner : un secret neuf, pas encore actif. */
export async function commencerMonCode(): Promise<{ ok: true; qr: string; secret: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (user.impersonatedBy) return { ok: false, error: REFUS_VUE_EXACTE };
  const r = await sousLeCoffre(() => commencerEnrolement(user.id, user.email ?? user.name ?? user.id));
  if ("refusCoffre" in r) return { ok: false, error: r.refusCoffre };
  const png = await qrPng(r.adresse);
  return { ok: true, qr: `data:image/png;base64,${png.toString("base64")}`, secret: r.secret };
}

export async function confirmerMonCode(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.impersonatedBy) return { ok: false, error: REFUS_VUE_EXACTE };
  const lu = await sousLeCoffre(() => confirmerEnrolement(user.id, fdStr(formData, "code") ?? ""));
  const refus = lu && typeof lu === "object" ? lu.refusCoffre : lu;
  if (refus) return { ok: false, error: refus };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sécurité", summary: "Code de signature en ligne activé (application d'authentification)." });
  revalidatePath(CHEMIN_MA_SIGNATURE);
  return { ok: true, message: "Code de signature activé." };
}
