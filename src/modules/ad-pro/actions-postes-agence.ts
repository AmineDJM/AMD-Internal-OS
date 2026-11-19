"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import type { SessionUser } from "@/lib/rbac";
import { hasRole } from "@/lib/rbac/roles";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { clientIp } from "@/lib/device";
import { getBlob } from "@/lib/drive-storage";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { controleRenforce, REFUS_VUE_EXACTE } from "@/lib/signature-en-ligne/second-facteur";
import { apposerSignatureEnLigne } from "@/lib/signature-en-ligne/signer-bc";
import { PARENTS, revalidate, audit, loadItem, REFUS_HISTORIQUE, peutTrancherSur, refusAvantPrevalidation, refusDemandeFermee, devisDuPoste, estAssistanteDuPoste, ouvrirDeclarationSiPostesValides } from "./infra/postes/commun";
import { decideAdProItem } from "./actions-postes-decision";
import { validerLignesDuDevis, preparerBrouillonPoste, validerEtEnvoyerBcPoste } from "./actions-postes-lignes";

/**
 * POSTES AD & PRO — LE PARCOURS AGENCE, DE LA PROSPECTION AU BC SIGNÉ (Direction, 15/11/2026).
 *
 *   1. la Direction Marketing demande la PROSPECTION (cahier des charges, assistante) ;
 *   2. l'assistante dépose les devis des agences sur le poste (`ajouterDevisPoste`) et les TRANSMET ;
 *   3. la Direction Marketing CHOISIT l'agence : les lignes du devis retenu sont validées, le poste est accepté au montant du
 *      devis avec son budget, les autres devis sont « non retenus », le BC naît en brouillon chez l'assistante ;
 *   4. l'assistante FINALISE le BC (composeur) et le SOUMET ;
 *   5. la Direction Marketing le VALIDE, le SIGNE et le CACHETTE (mot de passe + code) — il part au centre Ad & Pro au-dessus
 *      du seuil, puis à la signature des Finances.
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

const lienAssistante = (itemId: string) => `/agences/${itemId}`;

async function cadreAgence(user: SessionUser, id: string | null) {
  if (!id) return { error: "Poste non précisé." } as const;
  const found = await loadItem(id, user);
  if (!found) return { error: "Poste introuvable." } as const;
  if (found.historique) return { error: REFUS_HISTORIQUE } as const;
  const { item, owner } = found;
  if (item.voie !== "AGENCE") return { error: "Ce poste ne passe pas par une agence : choisissez d'abord « Par une agence » sur le poste." } as const;
  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { error: "Opération introuvable." } as const;
  const exec = await prisma.adProExecutionPoste.findUnique({ where: { itemId: id } });
  return { item, owner, info, exec } as const;
}

const marketing = async (user: SessionUser, owner: { parent: Parameters<typeof peutTrancherSur>[1]["parent"]; id: string }) => (await peutTrancherSur(user, owner)).marketing;

/** 1. DEMANDER LA PROSPECTION — la Direction Marketing, à une assistante de direction, avec le cahier des charges. */
export async function demanderProspection(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const c = await cadreAgence(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, info, exec } = c;
  if (!(await marketing(user, owner))) return { ok: false, error: "La prospection d'agences se demande par la Direction Marketing." };
  const avant = refusAvantPrevalidation(info) ?? refusDemandeFermee(info);
  if (avant) return { ok: false, error: avant };
  if (exec?.prospectionDemandeeAt) return { ok: false, error: "La prospection est déjà demandée pour ce poste." };
  if (!["DRAFT", "REVISION", "PENDING"].includes(item.status)) return { ok: false, error: "Ce poste est déjà décidé : la prospection n'a plus lieu d'être." };
  const assistanteId = fdStr(formData, "assistanteId");
  const cahier = fdStr(formData, "cahierDesCharges");
  if (!assistanteId) return { ok: false, error: "Choisissez l'assistante de direction qui prospecte les agences." };
  if (!cahier) return { ok: false, error: "Décrivez ce qu'il faut commander (quantités, délais, lieu) : c'est ce que l'assistante enverra aux agences." };
  const assistante = await prisma.user.findFirst({ where: { id: assistanteId, isActive: true, OR: [{ role: "DIRECTION_ASSISTANT" }, { secondaryRole: "DIRECTION_ASSISTANT" }] }, select: { id: true, name: true } });
  if (!assistante) return { ok: false, error: "Cette personne n'est pas une assistante de direction active." };
  const maintenant = new Date();
  await prisma.$transaction([
    prisma.adProExecutionPoste.upsert({
      where: { itemId: item.id },
      create: { itemId: item.id, prospectionDemandeeAt: maintenant, prospectionDemandeeParId: user.id, cahierDesCharges: cahier, assistanteId: assistante.id },
      update: { prospectionDemandeeAt: maintenant, prospectionDemandeeParId: user.id, cahierDesCharges: cahier, assistanteId: assistante.id },
    }),
    // Le poste attend désormais le CHOIX de la Direction Marketing : il est soumis, sans estimation exigée.
    prisma.adProItem.updateMany({
      where: { id: item.id, status: { in: ["DRAFT", "REVISION"] } },
      data: { status: "PENDING", submittedAt: maintenant, opsDecidedAt: maintenant, opsDecidedById: user.id, updatedById: user.id },
    }),
  ]);
  await notifyUser({
    userId: assistante.id, type: "ASSIGNMENT", title: "Prospection d'agences à faire",
    body: `${info.ref} — « ${item.label} » : ${cahier.slice(0, 180)}`, link: lienAssistante(item.id),
  }).catch(sansBloquer("ad-pro.demanderProspection.notifyUser"));
  await audit(user, owner.parent, owner.id, "UPDATE", `Prospection d'agences demandée à ${assistante.name} pour le poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/agences");
  return { ok: true, id: item.id, message: `Prospection demandée à ${assistante.name}.` };
}

/** 2. TRANSMETTRE LES DEVIS — l'assistante, quand chaque devis porte ses lignes ; elle atteste les avoir comparées au papier. */
export async function transmettreDevisAgences(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const c = await cadreAgence(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, info, exec } = c;
  if (!(await estAssistanteDuPoste(user.id, item.id)) && !hasRole(user, "SUPER_ADMIN")) return { ok: false, error: "Les devis se transmettent par l'assistante chargée de la prospection." };
  if (!exec?.prospectionDemandeeAt) return { ok: false, error: "La prospection n'a pas été demandée." };
  if (exec.devisTransmisAt) return { ok: false, error: "Les devis sont déjà transmis à la Direction Marketing." };
  if (fdStr(formData, "compare") !== "oui") return { ok: false, error: "Cochez « J'ai comparé les lignes de chaque devis au papier » : la Direction Marketing choisira sur ces lignes." };
  const devis = await prisma.adProItemPiece.findMany({
    where: { itemId: item.id, nature: "DEVIS", legalDocument: { status: { not: "CANCELLED" } } },
    select: { legalDocumentId: true, legalDocument: { select: { title: true, reference: true } } },
  });
  if (devis.length === 0) return { ok: false, error: "Déposez au moins un devis d'agence avant de transmettre." };
  for (const d of devis) {
    const vue = await devisDuPoste(item.id, d.legalDocumentId);
    if (!vue?.structure) return { ok: false, error: `${d.legalDocument.reference ?? d.legalDocument.title} n'a pas encore ses lignes : faites-le lire ou saisissez-les avant de transmettre.` };
  }
  const pris = await prisma.adProExecutionPoste.updateMany({ where: { itemId: item.id, devisTransmisAt: null }, data: { devisTransmisAt: new Date(), devisTransmisParId: user.id } });
  if (pris.count === 0) return { ok: false, error: "Les devis viennent d'être transmis." };
  if (exec.prospectionDemandeeParId) {
    await notifyUser({
      userId: exec.prospectionDemandeeParId, type: "VALIDATION_REQUIRED", title: "Devis d'agences à comparer",
      body: `${info.ref} — « ${item.label} » : ${devis.length} devis à comparer.`, link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(sansBloquer("ad-pro.transmettreDevisAgences.notifyUser"));
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `${devis.length} devis d'agences transmis à la Direction Marketing pour le poste « ${item.label} ».`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/agences");
  const peu = devis.length < 3 ? ` Seulement ${devis.length} devis : la Direction Marketing le verra.` : "";
  return { ok: true, id: item.id, message: `${devis.length} devis transmis à la Direction Marketing.${peu}` };
}

/** 3. CHOISIR L'AGENCE — la Direction Marketing : le devis retenu fait le montant accordé ; le BC naît chez l'assistante. */
export async function choisirAgencePoste(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const c = await cadreAgence(user, id);
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, info, exec } = c;
  if (!(await marketing(user, owner))) return { ok: false, error: "L'agence se choisit par la Direction Marketing." };
  if (!exec?.devisTransmisAt) return { ok: false, error: "Les devis ne sont pas encore transmis par l'assistante." };
  if (exec.agenceRetenueAt) return { ok: false, error: "L'agence est déjà choisie pour ce poste." };
  if (item.status !== "PENDING") return { ok: false, error: "Ce poste n'attend pas de choix : rouvrez la fiche." };
  const pieceId = fdStr(formData, "pieceId");
  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  if (!pieceId) return { ok: false, error: "Choisissez le devis de l'agence retenue." };
  if (!budgetCategoryId) return { ok: false, error: "Choisissez le budget qui portera ce poste." };
  const devis = await devisDuPoste(item.id, pieceId);
  if (!devis?.structure || devis.lignes.length === 0) return { ok: false, error: "Ce devis n'a pas de lignes lisibles : demandez à l'assistante de les saisir." };

  // a. Les lignes du devis retenu sont validées pour ce poste (l'assistante a attesté les avoir comparées au papier).
  const fdLignes = new FormData();
  fdLignes.set("id", item.id);
  fdLignes.set("pieceId", pieceId);
  fdLignes.set("compare", "on");
  for (const l of devis.lignes) fdLignes.append("ligneId", l.id);
  const lignes = await validerLignesDuDevis(fdLignes);
  if (!lignes.ok) return lignes;
  const apres = await devisDuPoste(item.id, pieceId);
  const montant = apres ? (apres.entete.tvaRate === null ? apres.totalValideHt : apres.totalValideTtc) : 0;
  // b. Le poste est accepté au montant du devis, avec son budget — par la décision ordinaire (mêmes gardes, même historique).
  const fdDecision = new FormData();
  fdDecision.set("id", item.id);
  fdDecision.set("decision", "APPROVED");
  fdDecision.set("amountGranted", String(Math.round(montant * 100) / 100));
  fdDecision.set("budgetCategoryId", budgetCategoryId);
  fdDecision.set("note", `Agence retenue : ${devis.fournisseur ?? devis.reference ?? devis.titre}`);
  const decision = await decideAdProItem(undefined, fdDecision);
  if (!decision.ok) {
    // L'accord n'a pas tenu : les lignes ne restent pas validées pour rien.
    const annule = new FormData();
    annule.set("id", item.id);
    annule.set("pieceId", pieceId);
    await validerLignesDuDevis(annule).catch(sansBloquer("ad-pro.choisirAgencePoste.annulerLignes"));
    return decision;
  }
  // c. L'agence est nommée sur le poste ; les autres devis sont « non retenus ».
  const maintenant = new Date();
  await prisma.$transaction([
    prisma.adProItem.update({ where: { id: item.id }, data: { supplier: devis.fournisseur ?? item.supplier, updatedById: user.id } }),
    prisma.adProItemPiece.updateMany({ where: { itemId: item.id, nature: "DEVIS", legalDocumentId: { not: pieceId }, nonRetenuAt: null }, data: { nonRetenuAt: maintenant, nonRetenuParId: user.id } }),
    prisma.adProExecutionPoste.update({ where: { itemId: item.id }, data: { agenceDevisId: pieceId, agenceRetenueAt: maintenant, agenceRetenueParId: user.id } }),
  ]);
  // d. Le BC naît en brouillon (aucun numéro) : l'assistante, qui a déposé le devis, le finalise.
  const fdBc = new FormData();
  fdBc.set("id", item.id);
  const bc = await preparerBrouillonPoste(fdBc);
  if (exec.assistanteId) {
    await notifyUser({
      userId: exec.assistanteId, type: "ASSIGNMENT", title: "Bon de commande à finaliser",
      body: `${info.ref} — « ${item.label} » : agence retenue ${devis.fournisseur ?? ""}. Finalisez le BC puis soumettez-le à la Direction Marketing.`, link: lienAssistante(item.id),
    }).catch(sansBloquer("ad-pro.choisirAgencePoste.notifyUser"));
  }
  // L'AGENCE CHOISIE VALIDE LE POSTE « AGENCE » : s'il était le dernier, la déclaration s'ouvre (Direction, 19/11/2026).
  await ouvrirDeclarationSiPostesValides(owner.parent, owner.id)
    .catch(sansBloquer("ad-pro.choisirAgencePoste.ouvrirDeclaration"));
  await audit(user, owner.parent, owner.id, "UPDATE", `Agence retenue pour le poste « ${item.label} » : ${devis.fournisseur ?? devis.titre} — ${montant.toLocaleString("fr-FR")} DZD.`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/agences");
  return { ok: true, id: item.id, message: `Agence retenue : ${devis.fournisseur ?? devis.titre} (${montant.toLocaleString("fr-FR")} DZD). ${bc.ok ? "Le BC est chez l'assistante pour finalisation." : bc.error ?? ""}`.trim() };
}

/** 4. SOUMETTRE LE BC — l'assistante, une fois le brouillon finalisé dans le composeur. */
export async function soumettreBcMarketing(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const c = await cadreAgence(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, info, exec } = c;
  if (!(await estAssistanteDuPoste(user.id, item.id)) && !hasRole(user, "SUPER_ADMIN")) return { ok: false, error: "Le BC se soumet par l'assistante qui l'a finalisé." };
  if (!exec?.agenceRetenueAt || !exec.agenceDevisId) return { ok: false, error: "L'agence n'est pas encore choisie." };
  const devis = await devisDuPoste(item.id, exec.agenceDevisId);
  if (!devis?.brouillon) return { ok: false, error: "Le brouillon du BC n'existe pas : demandez à la Direction Marketing de le préparer." };
  if (devis.brouillon.perime) return { ok: false, error: "Les lignes du devis ont changé depuis le brouillon : retirez-le et régénérez-le." };
  const pris = await prisma.adProExecutionPoste.updateMany({ where: { itemId: item.id, bcSoumisAt: null }, data: { bcSoumisAt: new Date(), bcSoumisParId: user.id } });
  if (pris.count === 0) return { ok: false, error: "Ce BC est déjà soumis à la Direction Marketing." };
  const destinataire = exec.agenceRetenueParId ?? exec.prospectionDemandeeParId;
  if (destinataire) {
    await notifyUser({
      userId: destinataire, type: "VALIDATION_REQUIRED", title: "BC à valider, signer et cacheter",
      body: `${info.ref} — « ${item.label} » : le bon de commande de ${devis.fournisseur ?? "l'agence"} est prêt.`, link: lienPosteAdPro(owner.parent, owner.id, item.id),
    }).catch(sansBloquer("ad-pro.soumettreBcMarketing.notifyUser"));
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande du poste « ${item.label} » finalisé et soumis à la Direction Marketing.`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/agences");
  return { ok: true, id: item.id, message: "BC soumis à la Direction Marketing." };
}

/** Le BC actif du poste (le plus récent non annulé). */
async function bcDuPoste(itemId: string) {
  const lien = await prisma.adProItemPiece.findFirst({
    where: { itemId, nature: "BON_DE_COMMANDE", legalDocument: { status: { not: "CANCELLED" } } },
    orderBy: { createdAt: "desc" }, select: { legalDocumentId: true },
  });
  return lien?.legalDocumentId ?? null;
}

/** La signature de la Direction Marketing sur le BC émis — mot de passe et code déjà contrôlés. */
async function signerCommeMarketing(user: SessionUser & { name?: string | null }, itemId: string, h: Headers): Promise<ActionResult> {
  const bcId = await bcDuPoste(itemId);
  if (!bcId) return { ok: false, error: "Le bon de commande n'est pas encore émis." };
  const etat = await etatDuBC(bcId);
  if (!etat || etat.annule) return { ok: false, error: "Ce bon de commande est annulé." };
  if (etat.etape === "REFUSE") return { ok: false, error: "Ce bon de commande est refusé : il ne se signe pas." };
  const r = await apposerSignatureEnLigne({ legalDocumentId: bcId, reference: etat.reference ?? bcId, qualite: "DIRECTION_MARKETING", user: { id: user.id, name: user.name ?? null }, ip: clientIp(h), agent: h.get("user-agent"), lireBlob: getBlob });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CHEMIN_BC_A_SIGNER);
  return { ok: true, id: bcId, message: `BC ${etat.reference ?? ""} signé et cacheté par la Direction Marketing.`.replace("  ", " ") };
}

/**
 * 5. VALIDER, SIGNER ET CACHETER LE BC — la Direction Marketing, en un geste : mot de passe + code, puis le BC est numéroté,
 * produit et aiguillé (`validerEtEnvoyerBcPoste`), puis signé. Si la signature échoue après l'émission, le poste montre
 * « Signer et cacheter le BC » : rien n'est perdu.
 */
export async function validerSignerBcMarketing(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.impersonatedBy) return { ok: false, error: REFUS_VUE_EXACTE };
  const c = await cadreAgence(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, exec } = c;
  if (!(await marketing(user, owner))) return { ok: false, error: "Ce bon de commande se valide et se signe par la Direction Marketing." };
  if (!exec?.bcSoumisAt || !exec.agenceDevisId) return { ok: false, error: "Le BC n'est pas encore soumis par l'assistante." };
  if (fdStr(formData, "lu") !== "oui") return { ok: false, error: "Cochez « J'ai relu ce bon de commande » : on ne signe que ce qu'on a relu." };
  const h = await headers();
  const refus = await controleRenforce(user.id, String(formData.get("motDePasse") ?? ""), fdStr(formData, "code") ?? "", clientIp(h));
  if (refus) return { ok: false, error: refus };
  const fd = new FormData();
  fd.set("id", item.id);
  fd.set("pieceId", exec.agenceDevisId);
  const emis = await validerEtEnvoyerBcPoste(fd);
  if (!emis.ok) return emis;
  const signe = await signerCommeMarketing(user, item.id, h);
  await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande du poste « ${item.label} » validé${signe.ok ? ", signé et cacheté en ligne" : " (signature à reprendre)"} par la Direction Marketing.`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/agences");
  return signe.ok
    ? { ok: true, id: item.id, message: `${emis.message ?? "BC émis."} Signé et cacheté par la Direction Marketing.` }
    : { ok: false, error: `Le BC est émis, mais la signature n'a pas été apposée : ${signe.error} — « Signer et cacheter le BC » la reprend.` };
}

/** 5 bis. SIGNER ET CACHETER UN BC DÉJÀ ÉMIS — la reprise d'une signature qui n'avait pas abouti. */
export async function signerBcMarketing(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (user.impersonatedBy) return { ok: false, error: REFUS_VUE_EXACTE };
  const c = await cadreAgence(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner } = c;
  if (!(await marketing(user, owner))) return { ok: false, error: "Ce bon de commande se signe par la Direction Marketing." };
  if (fdStr(formData, "lu") !== "oui") return { ok: false, error: "Cochez « J'ai relu ce bon de commande » : on ne signe que ce qu'on a relu." };
  const h = await headers();
  const refus = await controleRenforce(user.id, String(formData.get("motDePasse") ?? ""), fdStr(formData, "code") ?? "", clientIp(h));
  if (refus) return { ok: false, error: refus };
  const r = await signerCommeMarketing(user, item.id, h);
  if (r.ok) {
    await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande du poste « ${item.label} » signé et cacheté en ligne par la Direction Marketing.`);
    revalidate(owner.parent, owner.id);
  }
  return r;
}
