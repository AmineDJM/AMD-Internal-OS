"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { siegeAuCentreAdPro, REFUS_CENTRE_AD_PRO } from "@/modules/ad-pro/partage";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { DEFAULT_APP_SETTINGS } from "@/lib/settings";
import { reaiguillerSurChangementDeSeuil, CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { sitsOnValidationCentre } from "@/lib/validations/centre";
import type { CentreBC } from "@/lib/bons-de-commande/regle";
import { fdNum, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_APERCU_RAPPORTS, CHEMIN_RAPPORTS_TERRAIN } from "@/lib/chemins/rapports-terrain";
import { normalizeHidden } from "@/lib/modules-visibility";
import { COLONNES_REGULATORY, COLONNES_INAMOVIBLES, enTeteColonne } from "@/lib/vues/colonnes-regulatory";

/** Réglages d'instance (limites de taille d'upload). **Super Admin uniquement.** */
export async function saveAppSettings(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };

  const clamp = (v: number | null, def: number, max = 10240) => (v === null ? def : Math.max(1, Math.min(max, Math.round(v))));
  // Documents (via Server Action) : plafonné à 256 Mo = la limite de corps de Next (next.config).
  const maxUploadMb = clamp(fdNum(formData, "maxUploadMb"), DEFAULT_APP_SETTINGS.maxUploadMb, 256);
  const maxDriveUploadMb = clamp(fdNum(formData, "maxDriveUploadMb"), DEFAULT_APP_SETTINGS.maxDriveUploadMb);

  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", maxUploadMb, maxDriveUploadMb, updatedById: admin.id },
    update: { maxUploadMb, maxDriveUploadMb, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Limites d'upload — Documents ${maxUploadMb} Mo, Drive ${maxDriveUploadMb} Mo`,
  });
  revalidatePath("/admin");
  return { ok: true };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SEUIL Ad & Pro DU DIRECTEUR GÉNÉRAL — §118.138. **Super Admin uniquement.**
 *
 * « À partir de 1 000 000 DZD, la validation du DG, mais ce seuil doit pouvoir être configuré
 * par le super admin. » UN chiffre, lu par les quatre circuits configurables ET par le matériel
 * promotionnel : c'est ce qui l'empêche de valoir 1 M ici et 800 000 là (§118.5).
 *
 * ── UNE ACTION À PART DE `saveAppSettings`, ET CE N'EST PAS UN DÉTAIL ────────────────────
 *
 * Les deux n'ont pas le même objet : l'une règle des tailles de fichier, l'autre le montant à
 * partir duquel un dirigeant doit signer. Les fondre ferait écrire les deux à chaque
 * enregistrement de l'une — et une valeur par défaut écraserait le seuil le jour où quelqu'un
 * n'ajuste que les uploads.
 *
 * ── ON REFUSE, ON NE TRONQUE PAS ────────────────────────────────────────────────────────
 *
 * Un montant négatif ou illisible est REFUSÉ en nommant la borne. Le ramener silencieusement à
 * zéro enregistrerait « plus aucun contrôle du DG » — une politique que personne n'a choisie
 * (§118.16, §118.131). `0` reste écrivable EXPRÈS et signifie « aucune porte du DG » : c'est une
 * décision, tapée en toutes lettres.
 */
export async function setAdProDgThreshold(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  // LE SEUIL SE RÈGLE DEPUIS LE CENTRE — décision de la Direction (09/2026) : « on gère depuis
  // là le seuil à partir duquel il faut une validation qui passe par ce centre (géré par le PDG
  // et super admin) ». La porte s'élargit donc du Super Admin seul au SIÈGE du centre.
  //
  // UNE SEULE ACTION pour DEUX écrans (Administration › Réglages et le centre), et non une
  // seconde écriture : deux actions sur le même `AppSetting` auraient divergé sur la borne, sur
  // l'audit ou sur la phrase de refus, et c'est la copie en retard qui aurait fait foi (§118.5).
  if (!siegeAuCentreAdPro(admin)) return { ok: false, error: REFUS_CENTRE_AD_PRO };

  const brut = fdNum(formData, "adProDgThreshold");
  if (brut === null || !Number.isFinite(brut)) {
    return { ok: false, error: "Indiquez un montant en DZD (0 = aucune validation du Directeur Général)." };
  }
  if (brut < 0) return { ok: false, error: "Un seuil ne peut pas être négatif (0 = aucune validation du Directeur Général)." };
  const seuil = Math.round(brut * 100) / 100;

  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", adProDgThreshold: seuil, updatedById: admin.id },
    update: { adProDgThreshold: seuil, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: seuil > 0
      ? `Seuil Ad & Pro de validation du Directeur Général : ${seuil.toLocaleString("fr-FR")} DZD`
      : "Seuil Ad & Pro : plus aucune validation du Directeur Général",
  });
  revalidatePath("/admin");
  // Les DEUX écrans qui portent ce réglage : Administration › Réglages et le centre.
  revalidatePath("/centre-ad-pro");
  revalidatePath("/ad-pro");
  return { ok: true };
}

/**
 * LE SEUIL DES BONS DE COMMANDE (§118.149) — « tout BC supérieur à un montant configuré dans les
 * centres de validations Ad&Pro devra passer par la validation d'un des centres ».
 *
 * Réglé depuis le centre de validation Ad & Pro, par ses SIÈGES — la même porte que le seuil du
 * DG, parce que c'est la même instance qui en décide. Mais c'est un AUTRE chiffre : le seuil du
 * DG gouverne les DEMANDES (qui arbitre une opération), celui-ci les PIÈCES qui engagent la
 * société (qui valide un bon de commande avant que les Finances le signent). Les confondre ferait
 * régler l'un en croyant régler l'autre.
 *
 * `0` est écrivable et signifie « tout BC passe par un centre » — le comportement d'avant la règle.
 * Et le changement a un EFFET sur ce qui est en vol : les BC qui changent de côté se réaiguillent
 * (`reaiguillerSurChangementDeSeuil`), et la phrase dit combien.
 */
export async function setBcValidationThreshold(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!siegeAuCentreAdPro(admin)) return { ok: false, error: REFUS_CENTRE_AD_PRO };
  return reglerSeuilBC(admin.id, fdNum(formData, "bcValidationThreshold"), "AD_PRO");
}

/**
 * LE SEUIL DES BONS DE COMMANDE HORS AD & PRO (Direction, 10/2026 : « les BC hors Ad & Pro passent par le centre de
 * validation, mets-moi un seuil là-bas aussi »). Réglé depuis le centre de validations, par ses sièges (DG, Super
 * Admin) : c'est ce centre qui valide ces BC, c'est lui qui dit à partir de quel montant.
 */
export async function setBcValidationThresholdCentre(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (!sitsOnValidationCentre(admin)) return { ok: false, error: "Réservé aux sièges du centre de validations (Directeur Général, Super Admin)." };
  return reglerSeuilBC(admin.id, fdNum(formData, "bcValidationThresholdCentre"), "VALIDATION");
}

/** Le geste commun aux deux seuils : écrire, journaliser, réaiguiller les BC EN VOL de CE centre, et le dire. */
async function reglerSeuilBC(adminId: string, brut: number | null, centre: CentreBC): Promise<ActionResult> {
  const champ = centre === "AD_PRO" ? "bcValidationThreshold" : "bcValidationThresholdCentre";
  const nomCentre = centre === "AD_PRO" ? "centre Ad & Pro" : "centre de validations";
  if (brut === null || !Number.isFinite(brut)) {
    return { ok: false, error: "Indiquez un montant en DZD (0 = tout bon de commande passe par le centre)." };
  }
  if (brut < 0) return { ok: false, error: "Un seuil ne peut pas être négatif (0 = tout bon de commande passe par le centre)." };
  const seuil = Math.round(brut * 100) / 100;

  const avant = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { bcValidationThreshold: true, bcValidationThresholdCentre: true } });
  const ancien = avant ? Number(avant[champ]) : DEFAULT_APP_SETTINGS[champ];

  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", [champ]: seuil, updatedById: adminId },
    update: { [champ]: seuil, updatedById: adminId },
  });
  await recordAudit({
    actorId: adminId, action: "UPDATE", module: "Administration",
    field: champ, oldValue: String(ancien), newValue: String(seuil),
    summary: seuil > 0
      ? `Seuil des bons de commande du ${nomCentre} : ${seuil.toLocaleString("fr-FR")} DZD (au-dessus : le centre ; en deçà : directement à la signature)`
      : `Seuil des bons de commande du ${nomCentre} : aucun — tout bon de commande y passe`,
  });

  const bilan = await reaiguillerSurChangementDeSeuil(ancien, seuil, adminId, centre);

  revalidatePath("/admin");
  revalidatePath("/centre-ad-pro");
  revalidatePath("/centre-de-validations");
  revalidatePath(CHEMIN_BC_A_SIGNER);
  revalidatePath("/legal");
  const effet = bilan.reevalues === 0
    ? "Aucun bon de commande en cours n'a changé de côté du seuil."
    : [
        bilan.versLaSignature > 0 ? `${bilan.versLaSignature} passé${bilan.versLaSignature > 1 ? "s" : ""} directement à la signature des Finances` : null,
        bilan.versUnCentre > 0 ? `${bilan.versUnCentre} adressé${bilan.versUnCentre > 1 ? "s" : ""} au ${nomCentre}` : null,
      ].filter(Boolean).join(", ").replace(/^./, (c) => c.toUpperCase()) + ".";
  return {
    ok: true,
    message: `${seuil > 0 ? `Seuil fixé à ${seuil.toLocaleString("fr-FR")} DZD.` : "Aucun seuil : tout bon de commande passe par le centre."} ${effet}`
      // Borné, et DIT : la file des Finances et la signature lisent le seuil EN DIRECT, donc un
      // BC non réaiguillé ne peut pas être signé du mauvais côté — seule sa porte attend d'être
      // posée ou retirée, ce que sa prochaine modification fera.
      + (bilan.tronque ? " Seuls les 500 plus anciens bons de commande en cours ont été réaiguillés ; les suivants le seront à leur prochaine modification — la file des Finances applique déjà le nouveau seuil." : ""),
  };
}

/**
 * LA SÉPARATION DES TÂCHES AU CENTRE DE PAIEMENT (audit 27/10, ARGENT-06). **Super Admin uniquement.**
 *
 * Active par défaut : qui demande un paiement ne l'autorise pas, qui le demande ou l'autorise ne le règle pas
 * (`payments/separation.ts`). La suspendre est un geste de gouvernance — le temps de nommer un second siège,
 * par exemple — : il est journalisé avec son auteur, et l'écran dit ce qu'il ouvre.
 */
export async function setSeparationTachesPaiement(active: boolean): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const separationTachesPaiement = active === true;
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", separationTachesPaiement, updatedById: admin.id },
    update: { separationTachesPaiement, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration", field: "separationTachesPaiement",
    newValue: String(separationTachesPaiement),
    summary: separationTachesPaiement
      ? "Séparation des tâches au centre de paiement RÉTABLIE — qui demande n'autorise pas, qui demande ou autorise ne règle pas"
      : "Séparation des tâches au centre de paiement SUSPENDUE — un même compte peut demander, autoriser et régler",
  });
  revalidatePath("/admin/settings");
  return { ok: true, message: separationTachesPaiement ? "Séparation des tâches rétablie." : "Séparation des tâches suspendue." };
}

/** Débloque / masque l'onglet Regulatory « Enregistrement » (analyseur CTD). **Super Admin uniquement.** */
export async function setRegEnrollmentEnabled(enabled: boolean): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", regEnrollmentEnabled: enabled, updatedById: admin.id },
    update: { regEnrollmentEnabled: enabled, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Onglet Regulatory « Enregistrement » ${enabled ? "débloqué" : "masqué"}`,
  });
  revalidatePath("/admin");
  revalidatePath("/regulatory");
  return { ok: true };
}

/**
 * Rôles « superviseurs Regulatory » (en plus du Super Admin) : fixent priorité et dates
 * cibles, reçoivent les notifications (nouveau dossier / dépôt) et demandent des MàJ de
 * statut. **Super Admin uniquement.**
 */
export async function setRegulatorySupervisorRoles(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const roles = [...new Set(formData.getAll("roles").map(String).filter(Boolean))];
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", regulatorySupervisorRoles: roles, updatedById: admin.id },
    update: { regulatorySupervisorRoles: roles, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Superviseurs Regulatory — ${roles.length} rôle(s) configuré(s)`,
  });
  revalidatePath("/admin");
  revalidatePath("/regulatory");
  return { ok: true };
}

/**
 * Segments thérapeutiques proposés par le tableau Regulatory (menu de la colonne « Segments »).
 * Une liste VIDE rétablit la liste par défaut intégrée. **Super Admin uniquement.**
 */
export async function setRegulatoryTherapeuticSegments(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  // On dédoublonne SANS tenir compte de la casse/des espaces, mais on garde l'écriture d'origine
  // (le premier vu) : « Oncologie » et « oncologie » ne doivent pas coexister dans le menu.
  const seen = new Set<string>();
  const segments: string[] = [];
  for (const raw of formData.getAll("segments").map(String)) {
    const v = raw.replace(/\s+/g, " ").trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    segments.push(v);
  }
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", regulatoryTherapeuticSegments: segments, updatedById: admin.id },
    update: { regulatoryTherapeuticSegments: segments, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Segments thérapeutiques Regulatory — ${segments.length} segment(s)`,
  });
  revalidatePath("/admin");
  revalidatePath("/regulatory");
  revalidatePath("/regulatory/pipeline");
  return { ok: true };
}

/**
 * LES COLONNES DU TABLEAU REGULATORY — celles que la maison retire, pour tout le monde.
 *
 * À distinguer de la préférence d'affichage locale au navigateur, qui reste et qui dit « je ne
 * veux pas voir ça sur MON écran ». Celle-ci dit « cette colonne n'a pas lieu d'être dans cette
 * maison » : elle vaut sur les DEUX sous-modules (Suivi de dossiers et Pipeline) et elle survit
 * au vidage du cache.
 *
 * Le catalogue des clés vit dans `lib/regulatory/colonnes.ts` — le même que lit l'écran et que
 * lit Adam. On refuse ici ce qu'il refuse là : une clé inconnue (le formulaire ne fait pas foi)
 * et la RÉFÉRENCE, qui identifie la ligne.
 *
 * AUCUNE DONNÉE N'EST EFFACÉE : la colonne disparaît du tableau, les valeurs restent sur les
 * fiches et reviennent dès qu'on la remet.
 *
 * **Super Admin uniquement.**
 */
export async function setRegulatoryHiddenColumns(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const demandees = formData.getAll("columns").map(String).filter(Boolean);
  const cles: string[] = [];
  for (const k of demandees) {
    if (!COLONNES_REGULATORY.some((c) => c.key === k)) return { ok: false, error: `Colonne inconnue : ${k}.` };
    if (COLONNES_INAMOVIBLES.includes(k)) {
      return { ok: false, error: "La référence identifie la ligne : elle ne se masque pas." };
    }
    cles.push(k);
  }
  const colonnes = [...new Set(cles)];
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", regulatoryHiddenColumns: colonnes, updatedById: admin.id },
    update: { regulatoryHiddenColumns: colonnes, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Colonnes masquées du tableau Regulatory — ${colonnes.length === 0 ? "aucune" : colonnes.map(enTeteColonne).join(", ")}`,
  });
  revalidatePath("/admin");
  revalidatePath("/regulatory");
  revalidatePath("/regulatory/pipeline");
  return { ok: true };
}

/**
 * Rôles autorisés à CRÉER des catégories de Drive (espaces partagés en onglets), en plus du
 * Super Admin toujours autorisé. **Super Admin uniquement.**
 */
export async function setDriveSpaceCreatorRoles(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const roles = [...new Set(formData.getAll("roles").map(String).filter(Boolean))];
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", driveSpaceCreatorRoles: roles, updatedById: admin.id },
    update: { driveSpaceCreatorRoles: roles, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Créateurs de catégories Drive — ${roles.length} rôle(s) configuré(s)`,
  });
  revalidatePath("/admin");
  revalidatePath("/drive");
  return { ok: true };
}

/**
 * Rôles autorisés à ÉCRIRE les messages pré-définis de la Direction Marketing (ce que le KAM
 * doit dire au médecin, exigé sur chaque rapport terrain), en plus du Super Admin.
 *
 * ── POURQUOI UNE LISTE DE RÔLES ET NON UN DROIT DE MODULE ───────────────────────────────────
 *
 * `PRODUCT_MANAGER` (Direction Marketing) n'a que `MEDICAL: READ`. Lui donner l'écriture du
 * module lui ouvrirait aussi les praticiens et les visites : l'empreinte réelle dépasserait de
 * loin la demande (§118.16). C'est le mécanisme que ce dépôt emploie déjà pour ce genre de
 * question, et il laisse la DÉCISION DE PERMISSION au Super Admin, à qui elle appartient
 * (§118.86). **Super Admin uniquement.**
 */
export async function setPromoMessageAuthorRoles(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const roles = [...new Set(formData.getAll("roles").map(String).filter(Boolean))];
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", promoMessageAuthorRoles: roles, updatedById: admin.id },
    update: { promoMessageAuthorRoles: roles, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Auteurs des messages Direction Marketing — ${roles.length} rôle(s) configuré(s)`,
  });
  revalidatePath("/admin");
  revalidatePath("/marketing-cockpit");
  return { ok: true };
}

/**
 * Rôles autorisés à voir l'onglet « Overview » des Rapports terrain (graphes d'analyse),
 * en plus du Super Admin toujours autorisé. **Super Admin uniquement.**
 */
export async function setFieldReportsOverviewRoles(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const roles = [...new Set(formData.getAll("roles").map(String).filter(Boolean))];
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", fieldReportsOverviewRoles: roles, updatedById: admin.id },
    update: { fieldReportsOverviewRoles: roles, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Accès Overview Rapports terrain — ${roles.length} rôle(s) configuré(s)`,
  });
  revalidatePath("/admin");
  revalidatePath(CHEMIN_APERCU_RAPPORTS);
  revalidatePath(CHEMIN_RAPPORTS_TERRAIN);
  return { ok: true };
}

/**
 * Qui peut CONSULTER l'organigramme : rôles (ex. Ressources humaines) et/ou personnes nommées,
 * en plus du Super Admin toujours autorisé. La MODIFICATION (rattachements, postes, carte)
 * reste réservée au Super Admin. **Super Admin uniquement.**
 */
export async function setOrgChartViewers(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const roles = [...new Set(formData.getAll("roles").map(String).filter(Boolean))];
  const userIds = [...new Set(formData.getAll("userIds").map(String).filter(Boolean))];
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", orgChartViewerRoles: roles, orgChartViewerUserIds: userIds, updatedById: admin.id },
    update: { orgChartViewerRoles: roles, orgChartViewerUserIds: userIds, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Consultation de l'organigramme — ${roles.length} rôle(s), ${userIds.length} personne(s)`,
  });
  revalidatePath("/admin");
  revalidatePath("/organigramme");
  return { ok: true };
}

/**
 * PIPELINE — qui CONSULTE les dossiers verrouillés, et qui tient le CADENAS.
 *
 * Deux listes distinctes, et c'est le cœur du réglage : consulter un portefeuille encore
 * confidentiel est une confidence ; l'ouvrir, c'est le publier à toute l'entreprise, et cela ne
 * se reprend pas. Le Super Admin reste toujours inclus dans les deux — c'est lui qui distribue
 * ces accès, et un réglage malheureux ne doit pas pouvoir l'enfermer dehors.
 * **Super Admin uniquement.**
 */
export async function setPipelineAccess(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const viewerRoles = [...new Set(formData.getAll("viewerRoles").map(String).filter(Boolean))];
  const viewerUserIds = [...new Set(formData.getAll("viewerUserIds").map(String).filter(Boolean))];
  const managerRoles = [...new Set(formData.getAll("managerRoles").map(String).filter(Boolean))];
  const managerUserIds = [...new Set(formData.getAll("managerUserIds").map(String).filter(Boolean))];
  const data = {
    pipelineViewerRoles: viewerRoles,
    pipelineViewerUserIds: viewerUserIds,
    pipelineManagerRoles: managerRoles,
    pipelineManagerUserIds: managerUserIds,
    updatedById: admin.id,
  };
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", ...data },
    update: data,
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Accès au pipeline réglementaire — consultation : ${viewerRoles.length} rôle(s) / ${viewerUserIds.length} personne(s) ; cadenas : ${managerRoles.length} rôle(s) / ${managerUserIds.length} personne(s)`,
  });
  revalidatePath("/admin");
  revalidatePath("/regulatory");
  revalidatePath("/regulatory/pipeline");
  return { ok: true };
}

/**
 * ACCÈS DU MODULE DIRECTIVES — qui LIT les notes de service, qui en RÉDIGE.
 *
 * Ce qui ne se règle PAS ici : la PUBLICATION. Elle appartient à la direction générale et au
 * Super Admin, en dur (`lib/directives/audience.ts`). En faire un réglage reviendrait à
 * permettre qu'une case cochée par mégarde donne le pouvoir d'écrire au nom de la direction —
 * et une note lue ne se rattrape pas.
 *
 * **Super Admin uniquement.**
 */
export async function setDirectiveAccess(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const readerRoles = [...new Set(formData.getAll("readerRoles").map(String).filter(Boolean))];
  const readerUserIds = [...new Set(formData.getAll("readerUserIds").map(String).filter(Boolean))];
  const issuerRoles = [...new Set(formData.getAll("issuerRoles").map(String).filter(Boolean))];
  const issuerUserIds = [...new Set(formData.getAll("issuerUserIds").map(String).filter(Boolean))];
  const data = {
    directiveReaderRoles: readerRoles,
    directiveReaderUserIds: readerUserIds,
    directiveIssuerRoles: issuerRoles,
    directiveIssuerUserIds: issuerUserIds,
    updatedById: admin.id,
  };
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", ...data },
    update: data,
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Accès aux directives — lecture : ${readerRoles.length} rôle(s) / ${readerUserIds.length} personne(s) ; rédaction : ${issuerRoles.length} rôle(s) / ${issuerUserIds.length} personne(s)`,
  });
  revalidatePath("/admin");
  revalidatePath("/directives");
  return { ok: true };
}

/** Capacité globale du Drive + quota par utilisateur (Go). **Super Admin uniquement.** */
export async function saveDriveStorageSettings(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };

  const clampGb = (v: number | null, def: number) => (v === null ? def : Math.max(1, Math.min(10000, Math.round(v))));
  const driveCapacityGb = clampGb(fdNum(formData, "driveCapacityGb"), DEFAULT_APP_SETTINGS.driveCapacityGb);
  const driveUserQuotaGb = clampGb(fdNum(formData, "driveUserQuotaGb"), DEFAULT_APP_SETTINGS.driveUserQuotaGb);

  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", driveCapacityGb, driveUserQuotaGb, updatedById: admin.id },
    update: { driveCapacityGb, driveUserQuotaGb, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: `Stockage Drive — capacité ${driveCapacityGb} Go, quota utilisateur ${driveUserQuotaGb} Go`,
  });
  revalidatePath("/admin");
  return { ok: true };
}

/**
 * MODULES MASQUÉS — retirer un ou plusieurs modules de la plateforme. **Super Admin uniquement.**
 *
 * Ce n'est pas une permission : c'est un état de service. Rien n'est supprimé — ni les données,
 * ni les droits, ni les actions serveur. Démasquer rend le module tel qu'il était.
 *
 * La console d'administration est écartée par `normalizeHidden` : la masquer fermerait la porte
 * de l'intérieur, sans moyen de revenir autrement qu'en écrivant en base.
 */
export async function setHiddenModules(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  if (admin.role !== "SUPER_ADMIN") return { ok: false, error: "Réservé au Super Admin." };
  const hidden = normalizeHidden(formData.getAll("modules").map(String));
  await prisma.appSetting.upsert({
    where: { id: "global" },
    create: { id: "global", hiddenModules: hidden, updatedById: admin.id },
    update: { hiddenModules: hidden, updatedById: admin.id },
  });
  await recordAudit({
    actorId: admin.id, action: "UPDATE", module: "Administration",
    summary: hidden.length === 0
      ? "Modules masqués — tous les modules remis en service"
      : `Modules masqués — ${hidden.length} module(s) retiré(s) : ${hidden.join(", ")}`,
  });
  // Le menu est calculé dans le layout : sans revalidation de la racine, il resterait tel quel
  // jusqu'au prochain rechargement complet.
  revalidatePath("/", "layout");
  return { ok: true };
}
