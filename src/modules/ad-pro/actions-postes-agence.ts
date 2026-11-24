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
import { lienPosteAdPro, lienPosteAssistante } from "@/lib/chemins/ad-pro";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { controleRenforce, REFUS_VUE_EXACTE } from "@/lib/signature-en-ligne/second-facteur";
import { apposerSignatureEnLigne, enSuppleance, titreSignataire } from "@/lib/signature-en-ligne/signer-bc";
import { PARENTS, revalidate, audit, loadItem, REFUS_HISTORIQUE, peutTrancherSur, refusAvantPrevalidation, refusDemandeFermee, devisDuPoste, estAssistanteDuPoste, ouvrirDeclarationSiPostesValides, signalerPostesALaDeclaration, refusSiClos, reprojeterMontantDemande } from "./infra/postes/commun";
import { ecrireChoixDesAgences, defaireLesLignesRetenues, RefusChoixAgences } from "./infra/postes/scission-agence";
import { devisDesPostes, refusCategoriePourLaDemande } from "@/modules/ad-pro/api";
import { libellePosteScinde, lireLignesCochees, nomAgence, planDuChoix } from "./domaine/choix-agences";
import { decideAdProItem } from "./actions-postes-decision";
import { preparerBrouillonPoste, validerEtEnvoyerBcPoste } from "./actions-postes-lignes";

/**
 * POSTES AD & PRO — LE PARCOURS AGENCE, DE LA PROSPECTION AU BC SIGNÉ (Direction, 15/11/2026).
 *
 *   1. la Direction Marketing demande la PROSPECTION (cahier des charges, assistante) ;
 *   2. l'assistante dépose les devis des agences sur le poste (`ajouterDevisPoste`) et les TRANSMET ;
 *   3. la Direction Marketing CHOISIT : elle coche les lignes qu'elle commande dans chaque devis — un BC par agence, rien que
 *      ces lignes (23/11/2026). Une agence : le poste est accepté au total de ses lignes ; plusieurs : il est SCINDÉ, un poste
 *      par agence. Les devis sans ligne cochée sont « non retenus », chaque BC naît en brouillon chez l'assistante ;
 *   3 bis. EN PARALLÈLE, la Direction Marketing CHOISIT LE BUDGET de chaque poste (recette 24/11/2026, `setAdProItemBudget`) :
 *      le BC ne l'attend pas ; l'information médicale, si (et le paiement) ;
 *   4. l'assistante FINALISE le BC (composeur) et le SOUMET ;
 *   5. la Direction Marketing le VALIDE, le SIGNE et le CACHETTE (mot de passe + code) — il part au centre Ad & Pro au-dessus
 *      du seuil, puis à la signature des Finances.
 * Morceau de la clé `ad-pro-item-actions` (voir `actions-postes.ts`).
 */

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
  // UN POSTE TARDIF SE PROSPECTE AUSSI (recette 24/11/2026) : la déclaration ouverte, il la rejoindra une fois son agence choisie.
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
    body: `${info.ref} — « ${item.label} » : ${cahier.slice(0, 180)}`, link: lienPosteAssistante(item.id),
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

type DevisDuChoix = Parameters<typeof planDuChoix>[0][number];
type LectureDuChoix = (devis: readonly DevisDuChoix[]) => ReturnType<typeof lireLignesCochees>;

type PosteDuChoix = { id: string; label: string; supplier: string | null };

/** Le formulaire minimal d'une action sur un poste — son seul identifiant. */
const formulaireDuPoste = (id: string): FormData => {
  const fd = new FormData();
  fd.set("id", id);
  return fd;
};

/**
 * ACCORDER UN POSTE À SON AGENCE — ses lignes cochées sont déjà validées pour lui : le poste est accepté à leur total par la
 * décision ordinaire (mêmes gardes, même historique) — SANS BUDGET d'ordinaire (recette 24/11/2026 : la Direction Marketing
 * le choisit ensuite, `setAdProItemBudget`) ; un budget envoyé reste accepté. Si l'accord ne tient pas, les lignes ne
 * restent pas validées pour rien : le poste redevient « à choisir », avec ses devis.
 */
async function accorderLePoste(
  poste: PosteDuChoix, r: { pieceId: string; agence: string }, budgetCategoryId: string | null,
): Promise<{ ok: true; montant: number; fournisseur: string | null } | { ok: false; error: string }> {
  const apres = await devisDuPoste(poste.id, r.pieceId);
  const montant = apres ? (apres.entete.tvaRate === null ? apres.totalValideHt : apres.totalValideTtc) : 0;
  const fdDecision = new FormData();
  fdDecision.set("id", poste.id);
  fdDecision.set("decision", "APPROVED");
  fdDecision.set("amountGranted", String(Math.round(montant * 100) / 100));
  if (budgetCategoryId) fdDecision.set("budgetCategoryId", budgetCategoryId);
  fdDecision.set("note", `Agence retenue : ${r.agence}`);
  const decision = await decideAdProItem(undefined, fdDecision);
  if (decision.ok) return { ok: true, montant, fournisseur: apres?.fournisseur ?? null };
  await defaireLesLignesRetenues(poste.id, r.pieceId).catch(sansBloquer("ad-pro.choisirAgencePoste.annulerLignes"));
  return { ok: false, error: decision.error ?? "La décision n'a pas pu être enregistrée." };
}

/**
 * LE CHOIX DE LA DIRECTION MARKETING, ÉCRIT — un devis entier (`choisirAgencePoste`) ou des lignes cochées dans plusieurs
 * devis (`retenirLignesDesAgences`) : les mêmes gardes, le même plan (`planDuChoix`), la même écriture tout-ou-rien
 * (`ecrireChoixDesAgences`), puis chaque poste accordé à son agence. Une agence : le poste reste un poste. Plusieurs : il
 * est scindé, un poste par agence — chacune sera payée à part, avec son BC, sa réception, sa facture.
 */
async function retenirLesAgences(formData: FormData, lire: LectureDuChoix): Promise<ActionResult> {
  const user = await requireUser();
  const c = await cadreAgence(user, fdStr(formData, "id"));
  if ("error" in c) return { ok: false, error: c.error };
  const { item, owner, exec } = c;
  if (!(await marketing(user, owner))) return { ok: false, error: "L'agence se choisit par la Direction Marketing." };
  if (!exec?.devisTransmisAt) return { ok: false, error: "Les devis ne sont pas encore transmis par l'assistante." };
  if (exec.agenceRetenueAt) return { ok: false, error: "L'agence est déjà choisie pour ce poste." };
  if (item.status !== "PENDING") return { ok: false, error: "Ce poste n'attend pas de choix : rouvrez la fiche." };
  const devis: DevisDuChoix[] = ((await devisDesPostes([item.id])).get(item.id) ?? [])
    .filter((d) => !d.annule)
    .map((d) => ({ pieceId: d.pieceId, agence: nomAgence(d), entete: d.entete, lignes: d.lignes }));
  const lu = lire(devis);
  if (!lu.ok) return lu;
  // LE BUDGET N'EST PLUS EXIGÉ ICI (recette 24/11/2026) : la Direction Marketing choisit l'agence (le montant vient du devis),
  // PUIS le budget, à part. Envoyé, il est accepté et vérifié comme avant.
  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  const plan = planDuChoix(devis, lu.parDevis);
  if (!plan.ok) return plan;
  // CE QUE LA DÉCISION REFUSERAIT se lit AVANT d'écrire : une scission ne doit pas naître pour un accord impossible.
  const avant = (await refusSiClos(owner.parent, owner.id, { partir: true }))
    ?? (budgetCategoryId ? await refusCategoriePourLaDemande(budgetCategoryId, owner.parent, owner.id) : null);
  if (avant) return { ok: false, error: avant };
  // UNE SCISSION SUR UNE DEMANDE DÉCLARÉE EST PERMISE (recette 24/11/2026) : les postes nés rejoignent la déclaration.
  const scission = plan.retenues.length > 1;

  // a. Tout ou rien : les postes de la scission, les devis déplacés, les lignes cochées validées pour le poste de leur agence.
  let posteDe: Map<string, string>;
  try {
    posteDe = await ecrireChoixDesAgences({ origineId: item.id, userId: user.id, retenues: plan.retenues });
  } catch (e) {
    if (e instanceof RefusChoixAgences) return { ok: false, error: e.message };
    throw e;
  }
  if (scission) {
    // LES POSTES NÉS CHANGENT LA DEMANDE comme un poste ajouté : son montant, l'estimation déclarée, la porte du DG.
    await reprojeterMontantDemande(owner.parent, owner.id);
    const parAgence = plan.retenues.map((r, i) => `${i === 0 ? `« ${item.label} »` : `« ${libellePosteScinde(item.label, r.agence)} »`} : ${r.agence} (${r.ligneIds.length} ligne${r.ligneIds.length > 1 ? "s" : ""}, ${r.montant.toLocaleString("fr-FR")} DZD)`);
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » scindé par agence en ${plan.retenues.length} postes — ${parAgence.join(" ; ")}.${plan.ecartes.length ? ` ${plan.ecartes.length} devis non retenu${plan.ecartes.length > 1 ? "s" : ""}.` : ""}`);
  }

  // b. Chaque poste est accordé à son agence — l'origine d'abord (elle garde l'agence au plus gros total).
  const faits: string[] = [];
  const echecs: string[] = [];
  const accordes: { id: string; label: string }[] = [];
  let sansBudget = 0;
  for (const [i, r] of plan.retenues.entries()) {
    const poste = i === 0
      ? { id: item.id, label: item.label, supplier: item.supplier }
      : { id: posteDe.get(r.pieceId)!, label: libellePosteScinde(item.label, r.agence), supplier: r.agence };
    const accord = await accorderLePoste(poste, r, budgetCategoryId);
    if (!accord.ok) {
      echecs.push(`« ${poste.label} » n'est pas accordé (${accord.error}) : il reste à choisir, avec son devis.`);
      continue;
    }
    // L'agence est nommée sur le poste ; ses autres devis sont « non retenus ».
    const maintenant = new Date();
    await prisma.$transaction([
      prisma.adProItem.update({ where: { id: poste.id }, data: { supplier: accord.fournisseur ?? poste.supplier, updatedById: user.id } }),
      prisma.adProItemPiece.updateMany({ where: { itemId: poste.id, nature: "DEVIS", legalDocumentId: { not: r.pieceId }, nonRetenuAt: null }, data: { nonRetenuAt: maintenant, nonRetenuParId: user.id } }),
      prisma.adProExecutionPoste.update({ where: { itemId: poste.id }, data: { agenceDevisId: r.pieceId, agenceRetenueAt: maintenant, agenceRetenueParId: user.id } }),
    ]);
    // Le BC naît en brouillon (aucun numéro) : l'assistante, qui a déposé le devis, le finalise — elle est prévenue par la
    // préparation elle-même (« Bon de commande à finaliser », sur SA page), une seule fois, et seulement si le BC est prêt.
    // LE BC N'ATTEND PAS LE BUDGET (recette 24/11/2026) : son brouillon naît tout de suite ; le budget se choisit EN PARALLÈLE
    // (`setAdProItemBudget`) — il n'est exigé qu'au paiement, et par l'information médicale.
    const brouillon = await preparerBrouillonPoste(formulaireDuPoste(poste.id));
    const bc = brouillon.ok ? "Le BC est chez l'assistante pour finalisation." : brouillon.error ?? "";
    const avecBudget = (await prisma.adProItem.findUnique({ where: { id: poste.id }, select: { budgetCategoryId: true } }))?.budgetCategoryId ?? null;
    await audit(user, owner.parent, owner.id, "UPDATE", `Agence retenue pour le poste « ${poste.label} » : ${r.agence} — ${accord.montant.toLocaleString("fr-FR")} DZD.`);
    accordes.push({ id: poste.id, label: poste.label });
    if (!avecBudget) sansBudget += 1;
    faits.push(scission
      ? `« ${poste.label} » : ${r.agence} (${accord.montant.toLocaleString("fr-FR")} DZD)${brouillon.ok ? "" : ` — ${bc}`}.`
      : `Agence retenue : ${r.agence} (${accord.montant.toLocaleString("fr-FR")} DZD). ${bc}`.trim());
  }
  // L'AGENCE CHOISIE VALIDE LE POSTE « AGENCE » — ses lignes retenues sont son devis validé : s'il était le dernier (et son
  // budget choisi — recette 24/11/2026 : sans budget, il retient encore), la déclaration s'ouvre (Direction, 19/11/2026). Déjà
  // ouverte, ce poste tardif la rejoint quand il est prêt : son montant, et le pharmacien prévenu (recette 24/11/2026).
  const ouverte = await ouvrirDeclarationSiPostesValides(owner.parent, owner.id)
    .catch(sansBloquer("ad-pro.choisirAgencePoste.ouvrirDeclaration", null));
  if (!ouverte && accordes.length > 0) {
    await signalerPostesALaDeclaration(owner.parent, owner.id, { moment: "DEVIS", ref: c.info.ref, postes: accordes })
      .catch(sansBloquer("ad-pro.choisirAgencePoste.signalerDeclaration"));
  }
  revalidate(owner.parent, owner.id);
  revalidatePath("/agences");
  const tete = scission ? `Poste scindé en ${plan.retenues.length} postes, un BC par agence.` : "";
  // LE BUDGET RESTE À CHOISIR (recette 24/11/2026) — en parallèle du BC : c'est lui que l'information médicale attend.
  const suiteBudget = sansBudget > 0 ? [`À choisir aussi : le budget ${sansBudget > 1 ? "de chaque poste" : "du poste"} (« Choisir le budget ») — l'information médicale l'attend.`] : [];
  const message = [tete, ...faits, ...(scission && faits.length ? ["Chaque BC prêt est chez l'assistante pour finalisation."] : []), ...suiteBudget].filter(Boolean).join(" ");
  if (echecs.length > 0) return { ok: false, error: [message, ...echecs].filter(Boolean).join(" ") };
  return { ok: true, id: item.id, message };
}

/** 3. CHOISIR L'AGENCE — un devis ENTIER (toutes ses lignes) : le chemin d'avant, gardé pour ses appelants. */
export async function choisirAgencePoste(formData: FormData): Promise<ActionResult> {
  const pieceId = fdStr(formData, "pieceId");
  const toutLeDevis: LectureDuChoix = (devis) => {
    if (!pieceId) return { ok: false, error: "Choisissez le devis de l'agence retenue." };
    const d = devis.find((x) => x.pieceId === pieceId);
    if (!d || d.lignes.length === 0) return { ok: false, error: "Ce devis n'a pas de lignes lisibles : demandez à l'assistante de les saisir." };
    return { ok: true, parDevis: new Map([[pieceId, d.lignes.map((l) => l.id)]]) };
  };
  return retenirLesAgences(formData, toutLeDevis);
}

/**
 * 3 bis. RETENIR LES LIGNES DES AGENCES (Direction, 23/11/2026) — la Direction Marketing coche, dans chaque devis transmis,
 * les lignes qu'elle commande (champ `ligne` répété : « <pieceId>:<ligneId> ») : un BC par agence, rien que les lignes
 * cochées ; un devis sans ligne cochée n'est pas retenu. Plusieurs agences : le poste est scindé, un poste par agence.
 */
export async function retenirLignesDesAgences(formData: FormData): Promise<ActionResult> {
  const cochees = lireLignesCochees(formData.getAll("ligne"));
  const lignesCochees: LectureDuChoix = () => cochees;
  return retenirLesAgences(formData, lignesCochees);
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

/**
 * QUI SIGNE À LA PLACE « DIRECTION MARKETING » — elle, ou le Super Admin en SUPPLÉANCE (21/11/2026) : alors son nom et ce
 * qu'il est, au journal comme dans la phrase. « Par la Direction Marketing » sous la main d'un autre ferait croire qu'elle a signé.
 */
const parQuiMarketing = (user: SessionUser & { name?: string | null }): string =>
  enSuppleance("DIRECTION_MARKETING", user) ? `${user.name ?? "le Super Admin"} (${titreSignataire("DIRECTION_MARKETING", true)})` : "la Direction Marketing";

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
  return { ok: true, id: bcId, message: `BC ${etat.reference ?? ""} signé et cacheté par ${parQuiMarketing(user)}.`.replace("  ", " ") };
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
  await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande du poste « ${item.label} » validé${signe.ok ? ", signé et cacheté en ligne" : " (signature à reprendre)"} par ${parQuiMarketing(user)}.`);
  revalidate(owner.parent, owner.id);
  revalidatePath("/agences");
  return signe.ok
    ? { ok: true, id: item.id, message: `${emis.message ?? "BC émis."} Signé et cacheté par ${parQuiMarketing(user)}.` }
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
    await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande du poste « ${item.label} » signé et cacheté en ligne par ${parQuiMarketing(user)}.`);
    revalidate(owner.parent, owner.id);
  }
  return r;
}
