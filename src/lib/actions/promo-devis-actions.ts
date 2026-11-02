"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";
import { persistUploadedDocument } from "@/lib/documents";
import { deleteFileByKey, readFileByKey, validateDocumentUpload } from "@/lib/storage";
import { getAppSettings } from "@/lib/settings";
import { mirrorDocumentsToDrive } from "@/lib/drive/document-mirror";
import { resolveParties } from "@/lib/queries/company-contacts";
import { fdStr, fdNum, fdDate, fdCase, type ActionResult } from "@/lib/actions/types";
import { empreinteDe } from "@/lib/pieces-lues/lecture-fichier";
import {
  annuaireDeLecture, consignerConfirmation, exigerLectureConfirmee, proposerLecture, RefusLecture, type ConfirmationPrete,
} from "@/lib/pieces-lues/service";
import { lectureDevisPromo, lignesProposeesDevisPromo, type LectureDevisPromo } from "@/lib/pieces-lues/prerempli-devis-promo";
import { manquesDeRetranscription, totauxDeLaSelection, formatDzd, type DevisLu } from "@/lib/promo-material/devis";
import { demandeLesDevis, retranscritLesDevis, choisitLesLignes } from "@/lib/promo-material/circuit";
import { devisLu, SELECT_DEVIS } from "@/lib/queries/promo-circuit";
import { validatePromoStep } from "@/lib/actions/promo-circuit-actions";
import { ecrireAuFil } from "@/modules/ad-pro/api";
import { rouvrirDemandeAuSecretariat, fermerDemandeAuSecretariat } from "@/lib/promo-material/demande-secretariat";
import { estAction, type PromoAction } from "@/lib/promo-material/actions-fournisseur";
import { envoyerDemandeDeDevis, ouvrirDemandeDeDevis, joindreLettreDeDevis, societeDuDossier } from "@/lib/promo-automatismes";
import { phraseDepotLettre, societeDeLaLettre } from "@/lib/demande-devis-depot";
import { saisieEffective, type ReferenceProchaine } from "@/lib/references/registre";
import { etatDuRegistre } from "@/lib/references/registre-serveur";
import { natureDeLaCategorie } from "@/modules/ad-pro/partage";
import { refusDeRangement } from "@/lib/promo-material/rangement";
import { annulerDemandeSecretariat } from "@/lib/secretariat/annulation";
import { etatRetraitDemandeDevis, ramenerSiPlusDeDemandeDevis } from "@/lib/promo-material/retrait-devis";
import { sansBloquer } from "@/lib/journal";

/**
 * LES DEVIS DU MATÉRIEL PROMOTIONNEL — demande, retranscription, choix des lignes (§118.152).
 *
 * « Le demandeur clique sur « demander le devis » et les devis partent à l'assistante de
 * direction. Elle a un endroit spécial pour les mettre : un tableau à remplir elle-même —
 * référence, unité, prix unitaire et prix total, pour chaque agence ou partenaire, comme si elle
 * retranscrivait le devis sur un tableau interne d'entreprise. Le demandeur valide ensuite soit
 * un devis complet, soit les lignes d'un devis — les lignes de plusieurs devis. »
 *
 * Trois gestes, trois personnes, et chacun vérifie QUI agit :
 *   • demander les devis — le demandeur (ou la Direction), une fois la demande validée ;
 *   • retranscrire — l'assistante de direction (nommée sur le dossier, ou par son rôle : elle
 *     tient le secrétariat), la Direction en suppléance ;
 *   • choisir les lignes — le demandeur, et l'avance du circuit passe par `validatePromoStep`,
 *     l'UNIQUE écrivain des transitions de validation : deux chemins d'avance finiraient par
 *     prévenir des personnes différentes pour la même étape (§118.5).
 */

const PATH = "/promo-material";
const chemin = (id: string) => `${PATH}/${id}`;

type Dossier = {
  id: string; reference: string; title: string; circuitVersion: number; circuitState: string | null;
  requesterId: string | null; assistantId: string | null; description: string | null; companyId: string | null;
};

async function chargerDossier(id: string | null): Promise<Dossier | null> {
  if (!id) return null;
  return prisma.promoMaterial.findUnique({
    where: { id },
    select: { id: true, reference: true, title: true, circuitVersion: true, circuitState: true, requesterId: true, assistantId: true, description: true, companyId: true },
  });
}

/** L'acteur, pour les règles du module pur — la vue globale tranchée ici, où `rbac` est lisible. */
const acteur = (user: SessionUser) => ({ id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) });

/** Le demandeur, ou la Direction en suppléance : ceux qui DEMANDENT les devis (`demandeLesDevis`). */
function pilote(user: SessionUser, pm: Dossier): boolean {
  return demandeLesDevis(acteur(user), pm);
}

/**
 * QUI RETRANSCRIT — la règle du module pur (`retranscritLesDevis`) : l'assistante nommée, toute
 * assistante de direction, la Direction ; jamais le demandeur, qui choisira ensuite les lignes.
 */
function retranscrit(user: SessionUser, pm: Dossier): boolean {
  return retranscritLesDevis(acteur(user), pm);
}

function refusVersion(pm: Dossier): string | null {
  return pm.circuitVersion === 2
    ? null
    : "Ce dossier suit l'ancien circuit : les devis s'y déposent comme pièces, sans retranscription. Basculez-le sur le nouveau circuit pour retranscrire.";
}

async function audit(user: SessionUser, id: string, summary: string) {
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: id, summary });
}

/**
 * LE REFUS D'UNE ÉCRITURE QUI A PERDU LA COURSE — levé DANS la transaction pour l'annuler entière,
 * rattrapé à sa sortie pour devenir une phrase. Une exception ordinaire partirait en erreur
 * technique : la personne croirait le produit cassé, alors que le dossier a simplement avancé
 * pendant qu'elle saisissait.
 */
class RefusDevis extends Error {}

/** La phrase de toute écriture qui trouve le dossier passé à une autre étape entre sa lecture et son écriture. */
const ETAPE_CHANGEE = "Ce dossier vient de changer d'étape — rechargez la fiche.";
/** Le devis visé a disparu entre la lecture et l'écriture (retiré dans un autre onglet, par une autre assistante). */
const DEVIS_RETIRE = "Ce devis vient d'être retiré du dossier — rechargez la fiche.";

/**
 * LE SCAN D'UN DEVIS QUI N'A PAS ÉTÉ ÉCRIT — retiré des pièces du dossier ; `false` si ce n'a pas
 * été possible, et c'est alors la phrase du refus qui le dit.
 *
 * Le scan s'enregistre AVANT la transaction (une pièce qui échoue ne laisse pas un devis qui prétend
 * l'avoir). Si l'écriture perd ensuite la course, la pièce resterait au dossier sans aucun devis qui
 * la désigne : un fichier que personne ne retrouve à sa place, et que la seconde tentative, après
 * rechargement, doublerait. On retire la ligne ET le binaire — `deleteFileByKey` libère la référence
 * du blob dédupliqué : retirer la ligne seule laisserait l'octet compté pour toujours (§118.159). Le
 * miroir Drive, lui, n'existe pas encore : il ne part qu'une fois le devis écrit.
 */
async function retirerScanOrphelin(userId: string, pmId: string, documentId: string): Promise<boolean> {
  try {
    const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { name: true, fileKey: true } });
    if (!doc) return true;
    await prisma.document.delete({ where: { id: documentId } });
    if (doc.fileKey) await deleteFileByKey(doc.fileKey);
    await recordAudit({
      actorId: userId, action: "DELETE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: pmId,
      summary: `Document « ${doc.name} » retiré : le devis qu'il accompagnait n'a pas été enregistré`,
    }).catch(sansBloquer("promo-devis-actions.retirerScanOrphelin.recordAudit"));
    return true;
  } catch (err) {
    console.error("[devis promo] scan orphelin non retiré", documentId, err);
    return false;
  }
}

/**
 * LES OCTETS DU SCAN QU'UN DEVIS PORTE DÉJÀ — pour confirmer une lecture sans re-joindre le fichier
 * (lot D2-E). Seulement une pièce de CE dossier : un identifiant de document venu d'ailleurs ne se lit
 * pas. `null` quand la pièce ou son binaire manque — la garde demande alors de joindre le scan.
 */
async function octetsDuScan(pmId: string, documentId: string): Promise<Buffer | null> {
  const doc = await prisma.document.findFirst({ where: { id: documentId, entityType: "PROMO_MATERIAL", entityId: pmId }, select: { fileKey: true } });
  if (!doc?.fileKey) return null;
  return readFileByKey(doc.fileKey).catch(sansBloquer("promo-devis-actions.octetsDuScan.readFileByKey", null));
}

// ───────────────────────── 1. Le demandeur demande les devis ─────────────────────────

/**
 * (RE)GÉNÉRER LA LETTRE DE DEMANDE DE DEVIS DU DOSSIER (Direction, 07/10) — rédigée par Luna d'après les articles du
 * dossier, en PDF et Word sur papier en-tête, déposée sous l'étape « Demande de devis » (et sur la demande au secrétariat
 * en cours, s'il y en a une). Le demandeur ou la Direction (`pilote`), comme l'envoi.
 */
export async function regenererDemandeDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!pilote(user, pm)) return { ok: false, error: "Seul le demandeur (ou la Direction) génère la demande de devis de ce dossier." };
  const enCours = await prisma.promoMaterial.findUnique({ where: { id: pm.id }, select: { adminRequestId: true } });
  // La référence NNN/DG/AAAA (registre commun) : préremplie avec le prochain numéro ; modifiée, elle est vérifiée puis attribuée.
  const r = await joindreLettreDeDevis(user, pm.id, enCours?.adminRequestId ?? null, saisieEffective(fdStr(formData, "reference"), fdStr(formData, "referenceSuggeree")));
  if (!r.ok) return { ok: false, error: r.error };
  await audit(user, pm.id, "Demande de devis (lettre) générée.");
  revalidatePath(chemin(pm.id));
  return { ok: true, message: phraseDepotLettre(r) };
}

/**
 * LA RÉFÉRENCE QUE PORTERA LA LETTRE DE DEMANDE DE DEVIS DU DOSSIER (registre commun NNN/DG/AAAA, Direction 10/2026) — ce que
 * le champ « Référence » préremplit : la société du dossier (celle dont le papier en-tête habille la lettre), si elle tient le
 * registre, et son prochain numéro — PRÉVU, rien n'est réservé. Lecture seule ; mêmes personnes que la génération.
 */
export async function referenceDemandeDevisPromo(formData: FormData): Promise<ReferenceProchaine> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  if (!pilote(user, pm)) return { ok: false, error: "Seul le demandeur (ou la Direction) génère la demande de devis de ce dossier." };
  return etatDuRegistre(await societeDeLaLettre(user, await societeDuDossier(pm)));
}

/**
 * ENVOYER LA DEMANDE DE DEVIS — le REPLI (§118.204). La demande de devis part d'elle-même quand le
 * dossier arrive sur « devis à demander » (à la création, ou à la validation de la demande —
 * `envoyerDemandeDeDevis`). Ce geste reste dans la rubrique « Articles demandés » pour un dossier qui y
 * est resté (un envoi automatique qui n'a pas pu partir, un dossier d'avant) : c'est le même envoi, la
 * même demande, le même aperçu. Le demandeur (ou la Direction) seulement.
 */
export async function demanderDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!pilote(user, pm)) return { ok: false, error: "Seul le demandeur (ou la Direction) envoie la demande de devis de ce dossier." };
  const note = fdStr(formData, "note");
  const r = await envoyerDemandeDeDevis(user.id, pm.id, note);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.assistantId) await notifyUser({ userId: r.assistantId, ...r.avis });
  else await notifyRoles(["DIRECTION_ASSISTANT"], r.avis);
  const lettre = await joindreLettreDeDevis(user, pm.id, r.demande.id).catch(sansBloquer("promo-devis-actions.demanderDevisPromo.joindreLettreDeDevis", null));
  return { ok: true, id: r.demande.id, message: `Demande de devis envoyée au secrétariat (${r.demande.reference}).${lettre?.ok ? ` ${phraseDepotLettre(lettre)}` : ""}` };
}

// ───────────────────────── 2. L'assistante retranscrit ─────────────────────────

type LigneLue = {
  reference: string; unit: string | null; quantity: number; unitPrice: number; action: PromoAction; requestItemId: string | null;
  /** Le rang de la ligne LUE sur le scan dont elle vient (lot D2-E) ; `null` : saisie à la main. */
  lue: number | null;
};

/** Le libellé de l'attestation UNIQUE de l'éditeur (Direction, 07/10) — repris tel quel dans le refus. */
const CASE_COMPAREES = "J'ai comparé les lignes au devis";

/**
 * Une ligne lue du formulaire, ou le motif qui la refuse (avec son rang, pour qu'on la retrouve).
 *
 * Chaque ligne porte l'ACTION qu'elle chiffre (§118.165) — conception, impression… : c'est elle qui
 * dira, à la réception, si ce qui arrive entre au stock. Et, si elle chiffre un article DEMANDÉ, son
 * rattachement ; une ligne sans article est une ligne « en plus », que le demandeur pourra retenir.
 *
 * Préremplie depuis le scan (lot D2-E), elle porte aussi le RANG de la ligne lue dont elle vient — un
 * champ caché par rangée, aligné comme les autres (vide : saisie à la main). L'attestation, elle, est
 * UNE case pour tout le formulaire (`lignesComparees`, Direction 07/10), lue par l'action.
 */
function lireLignes(formData: FormData): { ok: true; lignes: LigneLue[] } | { ok: false; error: string } {
  const refs = formData.getAll("ligneReference").map((x) => String(x ?? "").trim());
  const unites = formData.getAll("ligneUnite").map((x) => String(x ?? "").trim());
  const quantites = formData.getAll("ligneQuantite").map((x) => String(x ?? "").trim());
  const prix = formData.getAll("lignePrix").map((x) => String(x ?? "").trim());
  const actions = formData.getAll("ligneAction").map((x) => String(x ?? "").trim());
  const articles = formData.getAll("ligneArticle").map((x) => String(x ?? "").trim());
  const rangsLus = formData.getAll("ligneLue").map((x) => String(x ?? "").trim());
  const n = Math.max(refs.length, quantites.length, prix.length);
  const lignes: LigneLue[] = [];
  const nombre = (s: string) => (s === "" ? NaN : Number(s.replace(/\s/g, "").replace(",", ".")));
  for (let i = 0; i < n; i += 1) {
    const r = refs[i] ?? "";
    const q = quantites[i] ?? "";
    const p = prix[i] ?? "";
    if (!r && !q && !p) continue; // une ligne entièrement vide : une rangée de saisie inutilisée
    const quantity = nombre(q);
    const unitPrice = nombre(p);
    if (!r) return { ok: false, error: `Ligne ${i + 1} : la référence (ou désignation) est obligatoire.` };
    if (!(quantity > 0)) return { ok: false, error: `Ligne ${i + 1} (« ${r} ») : la quantité doit être un nombre supérieur à zéro.` };
    if (!(unitPrice >= 0)) return { ok: false, error: `Ligne ${i + 1} (« ${r} ») : le prix unitaire doit être un nombre positif.` };
    const action = actions[i] ?? "";
    if (!estAction(action)) {
      return { ok: false, error: `Ligne ${i + 1} (« ${r} ») : choisissez l'action qu'elle chiffre (conception, impression, fabrication, achat, location…) — c'est elle qui dira à la réception si ce qui arrive entre au stock.` };
    }
    const rangLu = Number(rangsLus[i] ?? "");
    lignes.push({
      reference: r, unit: (unites[i] ?? "") || null, quantity, unitPrice, action, requestItemId: (articles[i] ?? "") || null,
      lue: rangsLus[i] && Number.isInteger(rangLu) && rangLu > 0 ? rangLu : null,
    });
  }
  return { ok: true, lignes };
}

/**
 * LIRE LE SCAN D'UN DEVIS (lot D2-E) — la lecture PROPOSE ce que l'assistante aurait recopié, elle
 * n'écrit rien : ni devis, ni pièce, ni confirmation. Les mêmes portes que la retranscription — la
 * lecture sert la retranscription, elle n'ouvre rien de plus : l'ancien circuit, une autre personne
 * que celle qui retranscrit (le demandeur choisira ses lignes, il ne lit pas le papier à sa place),
 * une autre étape que « devis demandés » sont refusés AVANT qu'aucun octet soit lu.
 *
 * La lecture est locale (texte du fichier, OCR sur ce serveur) ; les lignes ne partent chez le
 * fournisseur d'IA que si la Direction l'a permis (Contrôle de l'IA), une seule fois par fichier. Le
 * scan d'un devis d'agence se dépose en pièce INTERNE du dossier : sa sortie vers le modèle est donc
 * permise — une pièce confidentielle, elle, ne sort jamais (décision 5, tenue par le service).
 */
export async function lireScanDevisPromo(formData: FormData): Promise<ActionResult & { lecture?: LectureDevisPromo }> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!retranscrit(user, pm)) return { ok: false, error: "La lecture d'un scan de devis sert sa retranscription : elle revient à l'assistante de direction." };
  if (pm.circuitState !== "QUOTE_REQUESTED") {
    return { ok: false, error: "Un scan de devis ne se lit que pendant l'étape « devis demandés » — c'est elle qui retranscrit." };
  }
  const scan = formData.get("scan");
  if (!(scan instanceof File) || scan.size === 0) return { ok: false, error: "Choisissez le scan du devis à lire." };
  const invalide = validateDocumentUpload(scan.name, scan.size, (await getAppSettings()).maxUploadMb);
  if (invalide) return { ok: false, error: `Scan « ${scan.name} » : ${invalide}` };

  const octets = Buffer.from(await scan.arrayBuffer());
  const { annuaireVisible, groupe } = await annuaireDeLecture(user.id);
  const r = await proposerLecture({
    user, octets, nomFichier: scan.name,
    contexte: { cible: "PROMO_QUOTE", sortieCloudPermise: true, annuaireVisible, groupe },
  });
  if (!r.ok) return { ok: false, error: r.error };
  const lecture = lectureDevisPromo(r.proposition, annuaireVisible.map((c) => c.id));
  const n = lecture.prerempli.lignes.length;
  return {
    ok: true,
    lecture,
    message: n > 0 ? `Devis lu — ${n} ligne${n > 1 ? "s" : ""} préremplie${n > 1 ? "s" : ""}.` : "Devis lu — en-tête prérempli.",
  };
}

/**
 * ENREGISTRER UN DEVIS RETRANSCRIT — créer, ou corriger tant que la retranscription est ouverte.
 *
 * Le fournisseur est choisi DANS L'ANNUAIRE (`resolveParties` revérifie le cloisonnement : un
 * identifiant venu d'un champ caché ne se croit pas sur parole). Les lignes sont REMPLACÉES en
 * bloc, dans une transaction : une correction partielle laisserait un devis à moitié ancien.
 * Le scan, s'il est joint, devient une pièce du dossier et le devis la désigne.
 *
 * L'étape lue en haut ne se croit pas jusqu'à l'écriture : la transaction commence par une écriture
 * CONDITIONNELLE sur « devis demandés », et un geste qui a perdu la course ne laisse rien derrière
 * lui — pas même le scan qu'il venait de déposer.
 *
 * Prérempli depuis le scan (`lectureId`, lot D2-E), il exige la lecture CONFIRMÉE — le fichier lu, et,
 * dès qu'une ligne gardée vient du scan, la case unique « J'ai comparé les lignes au devis » (Direction,
 * 07/10) : elle atteste chaque ligne lue ET le total saisi (§118.7, §118.15 — une ligne lue n'entre
 * qu'attestée par une personne, une attestation globale suffit). Le total HT imprimé est FACULTATIF.
 * Qui a confirmé quoi (`LecturePieceConfirmation`) se consigne DANS la transaction du devis.
 */
export async function enregistrerDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!retranscrit(user, pm)) return { ok: false, error: "La retranscription des devis revient à l'assistante de direction." };
  if (pm.circuitState !== "QUOTE_REQUESTED") {
    return { ok: false, error: "Les devis ne se retranscrivent que pendant l'étape « devis demandés » — le demandeur peut demander une correction depuis son choix." };
  }

  const quoteId = fdStr(formData, "quoteId");
  const existant = quoteId
    ? await prisma.promoQuote.findFirst({ where: { id: quoteId, promoMaterialId: pm.id }, select: { id: true, supplierId: true, supplierName: true, documentId: true } })
    : null;
  if (quoteId && !existant) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };

  const supplierId = fdStr(formData, "supplierId");
  if (!supplierId) return { ok: false, error: "Choisissez le fournisseur dans l'annuaire : c'est lui qui donne son adresse, son RC et son NIF au bon de commande." };
  const parties = await resolveParties(user.id, [supplierId]);
  if (!parties.ok) return { ok: false, error: parties.error };

  const lues = lireLignes(formData);
  if (!lues.ok) return { ok: false, error: lues.error };
  // UN RATTACHEMENT VENU D'UN CHAMP NE SE CROIT PAS SUR PAROLE : l'article doit être un article
  // demandé de CE dossier — sinon une ligne chiffrerait l'article d'un autre dossier.
  const rattaches = [...new Set(lues.lignes.map((l) => l.requestItemId).filter((x): x is string => Boolean(x)))];
  if (rattaches.length) {
    const connus = await prisma.promoRequestItem.count({ where: { id: { in: rattaches }, promoMaterialId: pm.id } });
    if (connus !== rattaches.length) return { ok: false, error: "Une ligne est rattachée à un article qui n'est pas demandé sur ce dossier." };
  }
  const tvaSaisie = fdNum(formData, "tvaRate");
  // LA TVA SE RETRANSCRIT, ELLE NE SE DEVINE PAS (Direction, 06/10) : plus de « 19 % par défaut ». Le taux est celui
  // imprimé sur le devis ; « s'il n'y a pas de TVA renseignée, il n'y a pas de TVA » — un champ vide vaut 0.
  const tvaRate = tvaSaisie ?? 0;
  if (!(tvaRate >= 0 && tvaRate <= 100)) return { ok: false, error: "Le taux de TVA s'exprime en pour cent, entre 0 et 100." };
  const extraTaxRate = fdNum(formData, "extraTaxRate");
  if (extraTaxRate != null && !(extraTaxRate > 0 && extraTaxRate <= 100)) return { ok: false, error: "La taxe additionnelle s'exprime en pour cent, entre 0 et 100 (laissez vide s'il n'y en a pas)." };
  const extraTaxLabel = extraTaxRate != null ? (fdStr(formData, "extraTaxLabel") ?? "Taxe additionnelle") : null;
  const announcedTotal = fdNum(formData, "announcedTotal");
  if (announcedTotal != null && !(announcedTotal >= 0)) return { ok: false, error: "Le total annoncé sur le devis doit être un montant positif." };

  const scan = formData.get("scan");
  const scanJoint = scan instanceof File && scan.size > 0 ? scan : null;
  const contenuScan = scanJoint ? Buffer.from(await scanJoint.arrayBuffer()) : null;

  // LA LECTURE CONFIRMÉE (lot D2-E). L'écran a prérempli depuis le scan : la personne atteste, d'UNE
  // case, avoir comparé au papier les lignes lues qu'elle garde (et le total) — la garde passe AVANT
  // toute écriture, scan compris (P7). Sans ligne lue gardée, rien à attester : le total, s'il est saisi,
  // se contrôle de toute façon contre les lignes à un dinar près. Le fichier comparé est celui qu'on
  // joint, sinon celui que le devis porte déjà : une confirmation porte sur la pièce LUE.
  const lectureId = fdStr(formData, "lectureId");
  let confirmation: ConfirmationPrete | null = null;
  if (lectureId !== null) {
    const octetsLus = contenuScan ?? (existant?.documentId ? await octetsDuScan(pm.id, existant.documentId) : null);
    if (octetsLus === null) return { ok: false, error: "Joignez le scan qui a été lu : une lecture se confirme contre sa pièce, rien n'a été enregistré." };
    const comparees = fdCase(formData, "lignesComparees") === true;
    const luesGardees = lues.lignes.some((l) => l.lue !== null);
    const exigee = await exigerLectureConfirmee({
      lectureId,
      empreinte: empreinteDe(octetsLus),
      totalVerifie: comparees || !luesGardees || announcedTotal == null,
      soumises: lues.lignes.map((l) => ({ lue: l.lue, verifiee: comparees, designation: l.reference, quantite: l.quantity, prixUnitaire: l.unitPrice })),
      proposees: lignesProposeesDevisPromo,
      caseGlobale: CASE_COMPAREES,
    });
    if (!exigee.ok) return { ok: false, error: exigee.error };
    confirmation = exigee.confirmation;
  }

  // LE SCAN — enregistré AVANT d'écrire le devis : une pièce qui échoue ne laisse pas un devis
  // qui prétend l'avoir. Son MIROIR DRIVE attend, lui, que le devis soit écrit (plus bas) : parti
  // ici, il laisserait une copie dans le Drive d'un devis que la course a refusé.
  let scanDepose: { id: string; nom: string; contenu: Buffer; mime: string | null } | null = null;
  if (scanJoint && contenuScan) {
    const r = await persistUploadedDocument(user.id, {
      entityType: "PROMO_MATERIAL", entityId: pm.id, category: "QUOTE", confidentiality: "INTERNAL",
      stepKey: "devis", file: scanJoint, buffer: contenuScan, mirrorToDrive: false,
    });
    if (!r.ok || !r.documentId) return { ok: false, error: `Scan « ${scanJoint.name} » : ${r.error ?? "téléversement impossible"}` };
    scanDepose = { id: r.documentId, nom: scanJoint.name, contenu: contenuScan, mime: scanJoint.type || null };
  }

  const donnees = {
    supplierId, supplierName: parties.text,
    reference: fdStr(formData, "reference"),
    quoteDate: fdDate(formData, "quoteDate"),
    tvaRate: new Prisma.Decimal(tvaRate),
    extraTaxLabel, extraTaxRate: extraTaxRate != null ? new Prisma.Decimal(extraTaxRate) : null,
    announcedTotal: announcedTotal != null ? new Prisma.Decimal(announcedTotal) : null,
    note: fdStr(formData, "note"),
  };
  const lignes = lues.lignes.map((l, i) => ({
    position: i, reference: l.reference, unit: l.unit,
    quantity: new Prisma.Decimal(l.quantity), unitPrice: new Prisma.Decimal(l.unitPrice),
    action: l.action, requestItemId: l.requestItemId,
  }));
  let devis: { id: string };
  try {
    devis = await prisma.$transaction(async (tx) => {
      // LA RETRANSCRIPTION EST-ELLE ENCORE OUVERTE ? La PREMIÈRE écriture, conditionnelle sur l'étape.
      // La lecture du haut a pu précéder — scan compris, qui prend du temps — la fin de la retranscription,
      // le choix du demandeur ou une annulation : sans cette condition, une correction tardive recréait
      // les lignes avec `selected = false` (le choix du demandeur effacé sans qu'il le sache), ou écrivait
      // des prix dans un dossier validé ou annulé, et la génération des BC manquait le fournisseur sans un
      // mot. Le verrou de LIGNE qu'elle prend fait aussi passer une à une les écritures de ce dossier : le
      // rang d'un devis neuf, et les relectures ci-dessous, ne voient plus d'écriture croisée.
      const encoreOuverte = await tx.promoMaterial.updateMany({
        where: { id: pm.id, circuitVersion: 2, circuitState: "QUOTE_REQUESTED" },
        data: { updatedById: user.id },
      });
      if (encoreOuverte.count === 0) throw new RefusDevis(ETAPE_CHANGEE);
      let ecrit: { id: string };
      if (existant) {
        if ((await tx.promoQuote.count({ where: { id: existant.id, promoMaterialId: pm.id } })) === 0) throw new RefusDevis(DEVIS_RETIRE);
        await tx.promoQuoteLine.deleteMany({ where: { quoteId: existant.id } });
        // Sans scan joint, la pièce du devis n'est PAS réécrite : la valeur lue en haut a pu être
        // remplacée entre-temps par une autre correction, et la réécrire détacherait son scan (§118.152c).
        ecrit = await tx.promoQuote.update({
          where: { id: existant.id },
          data: { ...donnees, ...(scanDepose ? { documentId: scanDepose.id } : {}) },
          select: { id: true },
        });
      } else {
        const rang = await tx.promoQuote.count({ where: { promoMaterialId: pm.id } });
        ecrit = await tx.promoQuote.create({
          data: { ...donnees, documentId: scanDepose?.id ?? null, promoMaterialId: pm.id, position: rang, createdById: user.id },
          select: { id: true },
        });
      }
      // L'ATTESTATION, DANS LA TRANSACTION DU DEVIS (lot D2-E) — et AVANT les relectures qui peuvent
      // encore refuser : un refus plus bas l'annule avec le devis. Écrite à côté, elle resterait en base
      // pour un devis jamais écrit ; écrite après, un devis existerait sans dire qu'il vient d'une lecture.
      if (confirmation) await consignerConfirmation(tx, { confirmation, cibleType: "PROMO_QUOTE", cibleId: ecrit.id, confirmeeParId: user.id });
      // UN ARTICLE RETIRÉ ENTRE-TEMPS : le demandeur peut retirer un article pendant la retranscription
      // (§118.190), et son retrait prend le même verrou. Relu ici, il se dit ; écrit sans relecture, la
      // ligne visait un article disparu et la base refusait l'écriture en erreur technique.
      if (rattaches.length) {
        const encore = await tx.promoRequestItem.count({ where: { id: { in: rattaches }, promoMaterialId: pm.id } });
        if (encore !== rattaches.length) throw new RefusDevis("Un article demandé auquel une ligne est rattachée vient d'être retiré du dossier — rechargez la fiche.");
      }
      await tx.promoQuoteLine.createMany({ data: lignes.map((l) => ({ ...l, quoteId: ecrit.id })) });
      return ecrit;
    });
  } catch (e) {
    // LA COMPENSATION : rien n'a été écrit, la pièce qu'on vient de déposer ne reste pas seule au dossier.
    const retire = scanDepose ? await retirerScanOrphelin(user.id, pm.id, scanDepose.id) : true;
    if (e instanceof RefusDevis || e instanceof RefusLecture) {
      if (!scanDepose) return { ok: false, error: e.message };
      return {
        ok: false,
        error: retire
          ? `${e.message} Rien n'a été enregistré, pas même le scan joint.`
          : `${e.message} Le devis n'a pas été enregistré, mais le scan joint (« ${scanDepose.nom} ») est resté dans les pièces du dossier : retirez-le.`,
      };
    }
    throw e;
  }
  if (scanDepose) {
    const s = scanDepose;
    void mirrorDocumentsToDrive({ ownerId: user.id, entityType: "PROMO_MATERIAL", entityId: pm.id, files: [{ name: s.nom, data: s.contenu, mime: s.mime }] })
      .catch((e) => console.error("[devis promo] miroir Drive échoué (non bloquant)", e));
  }
  await audit(user, pm.id, `Devis ${existant ? "corrigé" : "retranscrit"} — ${parties.text}${donnees.reference ? ` n° ${donnees.reference}` : ""} (${lignes.length} ligne${lignes.length > 1 ? "s" : ""})${confirmation ? ` — ${confirmation.resumeAudit}` : ""}`);
  revalidatePath(chemin(pm.id));
  return { ok: true, id: devis.id, message: `Devis de ${parties.text} ${existant ? "corrigé" : "enregistré"} (${lignes.length} ligne${lignes.length > 1 ? "s" : ""})${confirmation ? " — lecture du scan confirmée" : ""}.` };
}

/** Retirer un devis retranscrit — pendant la retranscription seulement. Le scan reste au dossier. */
export async function supprimerDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!retranscrit(user, pm)) return { ok: false, error: "La retranscription des devis revient à l'assistante de direction." };
  if (pm.circuitState !== "QUOTE_REQUESTED") return { ok: false, error: "Un devis ne se retire que pendant la retranscription." };
  const quoteId = fdStr(formData, "quoteId");
  const devis = quoteId ? await prisma.promoQuote.findFirst({ where: { id: quoteId, promoMaterialId: pm.id }, select: { id: true, supplierName: true } }) : null;
  if (!devis) return { ok: false, error: "Ce devis n'appartient pas à ce dossier." };
  try {
    await prisma.$transaction(async (tx) => {
      // CONDITIONNELLE SUR L'ÉTAPE, comme la retranscription : un devis retiré après la fin de la
      // retranscription disparaissait sous les yeux du demandeur qui choisissait ses lignes — ou d'un
      // dossier annulé, validé —, et le choix déjà fait perdait ses lignes sans que personne l'ait vu.
      const retirable = await tx.promoMaterial.updateMany({
        where: { id: pm.id, circuitVersion: 2, circuitState: "QUOTE_REQUESTED" },
        data: { updatedById: user.id },
      });
      if (retirable.count === 0) throw new RefusDevis(ETAPE_CHANGEE);
      // Retiré par un second clic, dans un autre onglet : le premier l'a déjà emporté — on le dit au lieu
      // d'échouer en erreur technique sur une ligne qui n'existe plus.
      const retire = await tx.promoQuote.deleteMany({ where: { id: devis.id, promoMaterialId: pm.id } });
      if (retire.count === 0) throw new RefusDevis(DEVIS_RETIRE);
    });
  } catch (e) {
    if (e instanceof RefusDevis) return { ok: false, error: e.message };
    throw e;
  }
  await audit(user, pm.id, `Devis retiré — ${devis.supplierName}`);
  revalidatePath(chemin(pm.id));
  return { ok: true, message: `Devis de ${devis.supplierName} retiré (son scan reste dans les pièces du dossier).` };
}

/**
 * LA RETRANSCRIPTION EST TERMINÉE — au demandeur de choisir.
 *
 * Refusée tant qu'un devis manque de fournisseur, de scan ou de lignes, ou que ses lignes ne tombent pas
 * sur le total imprimé QUAND il est saisi (facultatif, Direction 07/10) : tout ce qui manque est dit en
 * UNE fois (§118.18). La
 * demande au secrétariat passe « terminée » — c'est ce que l'assistante devait faire.
 */
export async function terminerRetranscriptionPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!retranscrit(user, pm)) return { ok: false, error: "La retranscription des devis revient à l'assistante de direction." };
  if (pm.circuitState !== "QUOTE_REQUESTED") return { ok: false, error: "Ce dossier n'attend pas de retranscription." };

  let devis: DevisLu[];
  try {
    devis = await prisma.$transaction(async (tx) => {
      // LE VERROU D'ABORD, LES DEVIS ENSUITE. Lus avant le verrou, les devis pouvaient être corrigés
      // entre le contrôle et la bascule : la fin était déclarée sur des devis qu'elle n'avait pas
      // contrôlés — un écart avec le total imprimé passait au choix du demandeur, puis au BC. Toute
      // écriture d'un devis prend ce même verrou en premier (`enregistrerDevisPromo`, `supprimerDevisPromo`,
      // et pour la sélection `choisirLignesPromo`, la correction, la validation du choix) : une correction en
      // cours finit avant notre lecture, une correction
      // suivante attend notre bascule — puis la trouve et se refuse.
      // L'ÉTAPE est relue SOUS le verrou, avant les devis — l'état d'abord, le motif ensuite (§118.18) :
      // un dossier annulé pendant qu'on attendait ne se fait pas répondre « retranscription incomplète »,
      // et ne repasse surtout pas au choix du demandeur.
      const [etat] = await tx.$queryRaw<{ circuitState: string | null; circuitVersion: number }[]>`
        SELECT "circuitState", "circuitVersion" FROM "PromoMaterial" WHERE id = ${pm.id} FOR UPDATE`;
      if (!etat || etat.circuitVersion !== 2 || etat.circuitState !== "QUOTE_REQUESTED") throw new RefusDevis(ETAPE_CHANGEE);
      const lus = (await tx.promoQuote.findMany({
        where: { promoMaterialId: pm.id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: SELECT_DEVIS,
      })).map(devisLu);
      const manques = manquesDeRetranscription(lus);
      if (manques.length > 0) throw new RefusDevis(`Retranscription incomplète : ${manques.join(" ; ")}.`);
      // L'étape vient d'être lue sous le verrou : l'écriture ne peut plus la perdre.
      await tx.promoMaterial.update({ where: { id: pm.id }, data: { circuitState: "REVIEW_REQUESTER", updatedById: user.id } });
      // LA DEMANDE AU SECRÉTARIAT SE FERME DANS LA MÊME TRANSACTION (lot D1b), et seulement si elle se traite
      // encore. Fermée après coup et sans condition, elle repassait « terminée » une demande annulée entre-temps ;
      // et une correction demandée juste après la fin voyait sa demande rouverte… puis refermée par cette
      // fermeture tardive — l'assistante, prévenue, ne trouvait rien à traiter.
      await fermerDemandeAuSecretariat(tx, pm.id);
      return lus;
    }, { timeout: 15_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof RefusDevis) return { ok: false, error: e.message };
    throw e;
  }
  if (pm.requesterId && pm.requesterId !== user.id) {
    await notifyUser({ userId: pm.requesterId, type: "VALIDATION_REQUIRED", title: "Devis retranscrits — à vous de choisir", body: `${pm.reference} — ${devis.length} devis, ${devis.reduce((s, d) => s + d.lines.length, 0)} lignes`, link: chemin(pm.id) });
  }
  await audit(user, pm.id, `Retranscription terminée — ${devis.length} devis (${devis.map((d) => d.supplierName).join(", ")})`);
  revalidatePath(chemin(pm.id));
  revalidatePath("/demandes");
  return { ok: true, message: `Retranscription terminée — ${devis.length} devis sont au choix du demandeur.` };
}

/**
 * RANGER COMME DEVIS DE <AGENCE> (§118.204) — un fichier « devis » déposé sur la demande SANS fiche devient
 * un devis du circuit, rattaché à l'agence choisie dans l'annuaire. « Les fiches doivent être automatiques » :
 * un devis du dossier est une ligne du tableau « Devis », pas un fichier qui attend qu'on lui crée une fiche
 * au registre Legal (« Créer sa fiche », retiré du matériel promotionnel). Le fichier n'est NI copié NI
 * retéléversé : il est déjà une pièce du dossier, là où vivent les scans des devis — le devis le DÉSIGNE
 * (`documentId`), exactement comme un scan joint à la retranscription.
 *
 * Le fournisseur est OBLIGATOIRE : c'est lui qui donne son adresse, son RC et son NIF au bon de commande. Les
 * lignes se retranscrivent ensuite (« Corriger » sur la ligne du devis) — la fin de la retranscription les
 * exige. Écriture CONDITIONNELLE sur « devis demandés », sous le verrou du dossier : deux clics ne rangent
 * pas deux fois le même fichier.
 */
export async function rangerDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!retranscrit(user, pm)) return { ok: false, error: "Ranger un devis déposé revient à qui retranscrit les devis : l'assistante de direction (ou la Direction)." };
  const etape = refusDeRangement(pm.circuitState);
  if (etape) return { ok: false, error: etape };
  const documentId = fdStr(formData, "documentId");
  if (!documentId) return { ok: false, error: "Choisissez le fichier à ranger." };
  const supplierId = fdStr(formData, "supplierId");
  if (!supplierId) return { ok: false, error: "Choisissez dans l'annuaire l'agence (ou le partenaire) à qui appartient ce devis : c'est elle qui donnera son adresse, son RC et son NIF au bon de commande." };
  const parties = await resolveParties(user.id, [supplierId]);
  if (!parties.ok) return { ok: false, error: parties.error };
  const doc = await prisma.document.findFirst({ where: { id: documentId, entityType: "PROMO_MATERIAL", entityId: pm.id }, select: { id: true, name: true, category: true } });
  if (!doc) return { ok: false, error: "Ce fichier n'est pas une pièce de ce dossier." };
  if (natureDeLaCategorie(doc.category) !== "QUOTE") return { ok: false, error: `« ${doc.name} » n'a pas été déposé comme devis : seul un fichier « Devis » se range comme devis.` };

  let devis: { id: string };
  try {
    devis = await prisma.$transaction(async (tx) => {
      // L'ÉTAPE D'ABORD, SOUS LE VERROU DU DOSSIER — la même première écriture que la retranscription.
      const ouverte = await tx.promoMaterial.updateMany({
        where: { id: pm.id, circuitVersion: 2, circuitState: "QUOTE_REQUESTED" },
        data: { updatedById: user.id },
      });
      if (ouverte.count === 0) throw new RefusDevis(ETAPE_CHANGEE);
      // RELU SOUS LE VERROU : un second clic, ou une retranscription qui vient de joindre ce scan.
      if ((await tx.promoQuote.count({ where: { promoMaterialId: pm.id, documentId: doc.id } })) > 0) {
        throw new RefusDevis(`« ${doc.name} » est déjà le scan d'un devis de ce dossier — rechargez la fiche.`);
      }
      if ((await tx.document.count({ where: { id: doc.id, entityType: "PROMO_MATERIAL", entityId: pm.id } })) === 0) {
        throw new RefusDevis(`« ${doc.name} » vient d'être retiré du dossier — rechargez la fiche.`);
      }
      const rang = await tx.promoQuote.count({ where: { promoMaterialId: pm.id } });
      return tx.promoQuote.create({
        data: { promoMaterialId: pm.id, position: rang, supplierId, supplierName: parties.text, documentId: doc.id, createdById: user.id },
        select: { id: true },
      });
    }, { timeout: 15_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof RefusDevis) return { ok: false, error: e.message };
    throw e;
  }
  await audit(user, pm.id, `Devis de ${parties.text} rangé depuis le fichier « ${doc.name} » (à retranscrire)`);
  revalidatePath(chemin(pm.id));
  return { ok: true, id: devis.id, message: `« ${doc.name} » est rangé comme devis de ${parties.text} — retranscrivez ses lignes (« Corriger » sur sa ligne) avant de terminer la retranscription.` };
}

// ───────────────────────── 3. Le demandeur choisit ─────────────────────────

/**
 * CHOISIR LES LIGNES — un devis entier, ou des lignes de plusieurs devis.
 *
 * La sélection est REMPLACÉE en bloc (les lignes cochées, et elles seules) : c'est l'écran entier
 * que la personne a sous les yeux qui fait foi, pas une suite de clics. Avec `valider`, le choix
 * part en validation : l'avance passe par `validatePromoStep`, l'unique écrivain des transitions,
 * qui fige le montant retenu et prévient la Direction Marketing (ou le DG au-delà du seuil).
 *
 * L'ÉTAPE LUE EN HAUT NE SE CROIT PAS JUSQU'À L'ÉCRITURE (lot D1b). La sélection s'écrivait sans
 * condition : un choix parti pendant qu'une correction était demandée recochait les lignes que la
 * correction venait d'effacer — le dossier repartait chez l'assistante avec un choix fait sur des lignes
 * qu'elle allait refaire —, et un choix tardif réécrivait la sélection d'un dossier déjà parti en
 * validation, sous un montant figé qui n'était plus le sien. La transaction commence par une écriture
 * CONDITIONNELLE sur « choix des lignes », comme les devis ; le verrou qu'elle prend fait aussi passer un
 * à un deux choix croisés. Et ce que l'écran a envoyé est passé à la validation (`lignesVues`), qui ne
 * valide que cela.
 */
export async function choisirLignesPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!choisitLesLignes(acteur(user), pm)) return { ok: false, error: "Le choix des lignes revient au demandeur." };
  if (pm.circuitState !== "REVIEW_REQUESTER") return { ok: false, error: "Ce dossier n'attend pas le choix du demandeur." };

  const valider = formData.get("valider") === "1";
  const voulues = new Set(formData.getAll("lineIds").map((x) => String(x)).filter(Boolean));
  // VALIDER UN CHOIX VIDE est refusé AVANT toute écriture : un geste qui ne part pas n'efface pas la
  // sélection enregistrée — il l'effaçait, la journalisait, puis refusait.
  if (valider && voulues.size === 0) return { ok: false, error: "Retenez au moins une ligne avant de valider votre choix." };

  let totaux: ReturnType<typeof totauxDeLaSelection>;
  try {
    totaux = await prisma.$transaction(async (tx) => {
      // LE CHOIX EST-IL ENCORE OUVERT ? La PREMIÈRE écriture, conditionnelle sur l'étape lue. Une correction
      // demandée, des devis redemandés, un article ajouté, une validation passée entre la lecture et l'écriture
      // l'ont fait changer — et prennent ce même verrou en premier. La version : seuls deux écrivains la posent,
      // la création et la bascule d'un dossier sans circuit (`startPromoCircuit`), tous deux à 2 — elle ne quitte
      // jamais 2, la condition ne peut pas tomber (mesuré, lot D1b) ; elle dit l'intention, comme chez les devis.
      const ouvert = await tx.promoMaterial.updateMany({
        where: { id: pm.id, circuitVersion: 2, circuitState: "REVIEW_REQUESTER" },
        data: { updatedById: user.id },
      });
      if (ouvert.count === 0) throw new RefusDevis(ETAPE_CHANGEE);
      // LES LIGNES CHOISIES, RELUES SOUS LE VERROU : une ligne d'un autre dossier, ou d'un devis corrigé depuis
      // l'affichage (la correction recrée ses lignes), ne se retient pas en silence — la sélection enregistrée
      // serait plus petite que celle de l'écran, sans que rien le dise.
      const presentes = await tx.promoQuoteLine.count({ where: { id: { in: [...voulues] }, quote: { promoMaterialId: pm.id } } });
      if (presentes !== voulues.size) {
        throw new RefusDevis(`${voulues.size - presentes} ligne(s) choisie(s) ne figurent pas (ou plus) parmi les devis de ce dossier — rechargez la fiche, puis refaites votre choix.`);
      }
      await tx.promoQuoteLine.updateMany({ where: { quote: { promoMaterialId: pm.id }, id: { notIn: [...voulues] } }, data: { selected: false } });
      await tx.promoQuoteLine.updateMany({ where: { quote: { promoMaterialId: pm.id }, id: { in: [...voulues] } }, data: { selected: true } });
      // Les totaux de CE choix, lus sous le même verrou : lus après, ils pouvaient être ceux d'un autre.
      const lus = (await tx.promoQuote.findMany({
        where: { promoMaterialId: pm.id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: SELECT_DEVIS,
      })).map(devisLu);
      return totauxDeLaSelection(lus);
    }, { timeout: 15_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof RefusDevis) return { ok: false, error: e.message };
    throw e;
  }
  await audit(user, pm.id, `Choix des lignes : ${totaux.lignes} ligne(s) sur ${totaux.devis} devis — ${formatDzd(totaux.ttc)} TTC`);

  if (!valider) {
    revalidatePath(chemin(pm.id));
    return { ok: true, message: `Choix enregistré : ${totaux.lignes} ligne(s), ${formatDzd(totaux.ttc)} TTC. Validez-le quand il est complet.` };
  }
  const f = new FormData();
  f.set("id", pm.id);
  // CE QUE L'ÉCRAN A ENVOYÉ, et lui seul, se valide : la validation relit la sélection sous son verrou et
  // refuse si un autre choix s'est enregistré entre les deux (un autre onglet, un déblocage du Super Admin).
  for (const lineId of voulues) f.append("lignesVues", lineId);
  return validatePromoStep(f);
}

/**
 * REDEMANDER DES DEVIS (audit 360°, R06) — au choix des lignes, quand aucun devis ne convient.
 *
 * « Une seule demande de devis » laissait le demandeur entre retenir une ligne qui ne lui va pas et
 * tuer son propre dossier. Une NOUVELLE demande part au secrétariat (les devis déjà retranscrits
 * restent : on compare au lieu de recommencer), le dossier repart à la retranscription, et la
 * sélection est gardée — les lignes existantes ne changent pas. Ce qu'on cherche est exigé : sans
 * cela, l'assistante rapporterait les mêmes devis. Bascule conditionnelle APRÈS la création ; un
 * double clic perd la course, et sa demande en trop est retirée — personne ne l'a vue.
 */
export async function redemanderDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!choisitLesLignes(acteur(user), pm)) return { ok: false, error: "Redemander des devis revient au demandeur." };
  if (pm.circuitState !== "REVIEW_REQUESTER") return { ok: false, error: "Les devis se redemandent au moment de choisir les lignes : ce dossier n'en est pas là." };
  const note = fdStr(formData, "note");
  if (note === null) return { ok: false, error: "Dites ce que vous cherchez — d'autres agences, d'autres quantités, un délai : l'assistante rapporterait sinon les mêmes devis." };

  const ouverte = await ouvrirDemandeDeDevis(user.id, pm, note, true);
  if (!ouverte.ok) return { ok: false, error: ouverte.error };
  const bascule = await prisma.promoMaterial.updateMany({
    where: { id: pm.id, circuitState: "REVIEW_REQUESTER" },
    data: { circuitState: "QUOTE_REQUESTED", adminRequestId: ouverte.demande.id, updatedById: user.id },
  });
  if (bascule.count === 0) {
    await prisma.administrativeRequest.delete({ where: { id: ouverte.demande.id } }).catch(sansBloquer("promo-devis-actions.redemanderDevisPromo.administrativeRequest"));
    return { ok: false, error: "Ce dossier vient de changer d'étape — rechargez la fiche." };
  }
  await ecrireAuFil({ entityType: "PROMO_MATERIAL", entityId: pm.id, authorId: user.id, body: `Nouveaux devis demandés (${ouverte.demande.reference}) : ${note}` });
  await joindreLettreDeDevis(user, pm.id, ouverte.demande.id).catch(sansBloquer("promo-devis-actions.redemanderDevisPromo.joindreLettreDeDevis", null));
  const avis = { type: "ASSIGNMENT" as const, title: "Matériel promotionnel — nouveaux devis à demander et à retranscrire", body: `${pm.reference} — ${note.slice(0, 200)}`, link: chemin(pm.id) };
  if (pm.assistantId) await notifyUser({ userId: pm.assistantId, ...avis });
  else await notifyRoles(["DIRECTION_ASSISTANT"], avis);
  await audit(user, pm.id, `Nouveaux devis demandés au secrétariat (${ouverte.demande.reference}) — ${note.slice(0, 200)}`);
  revalidatePath(chemin(pm.id));
  revalidatePath("/demandes");
  return { ok: true, id: ouverte.demande.id, message: `Nouveaux devis demandés au secrétariat (${ouverte.demande.reference}) — les devis déjà reçus restent sur la fiche.` };
}

/**
 * RETIRER LA DEMANDE DE DEVIS DEPUIS LE DOSSIER (audit du 04/10, constat 35) — « on annule sa demande tant
 * que l'autre ne l'a pas exécutée ». Le demandeur (ou la Direction) la retirait seulement depuis
 * « Demandes », et le dossier restait sur « devis demandés ». Elle se retire ici, motif à l'appui, par
 * l'annulation COMMUNE de la demande au secrétariat (l'assistante est prévenue, la trace va à la demande),
 * puis le dossier revient à l'étape d'avant (`ramenerSiPlusDeDemandeDevis`).
 *
 * EXÉCUTÉE dès que l'assistante a commencé à RETRANSCRIRE : un devis enregistré depuis la demande est du
 * travail fait — le refus le nomme, avec les deux gestes qui restent (le retirer, ou la laisser terminer).
 * Tout ce qui refuse passe AVANT le motif (§118.18).
 */
export async function retirerDemandeDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!pilote(user, pm)) return { ok: false, error: "Seul le demandeur (ou la Direction) retire la demande de devis de ce dossier." };
  if (pm.circuitState !== "QUOTE_REQUESTED") return { ok: false, error: "Aucune demande de devis n'est en cours sur ce dossier." };
  const { demandes, refus } = await etatRetraitDemandeDevis(pm.id);
  if (refus) return { ok: false, error: refus };
  const motif = fdStr(formData, "motif");
  if (motif === null) return { ok: false, error: "Dites pourquoi vous retirez la demande de devis : c'est ce que lira l'assistante." };

  const annulees: string[] = [];
  for (const d of demandes) {
    const a = await annulerDemandeSecretariat(d.id, { acteurId: user.id, motif, cause: "depuis son dossier" });
    if (!a.ok) return { ok: false, error: a.error };
    if (a.annulee) annulees.push(a.reference);
  }
  const retour = await ramenerSiPlusDeDemandeDevis(pm.id, user.id, motif);
  if (annulees.length === 0 && !retour.ramene) {
    return { ok: false, error: "Ce dossier vient de changer (demande terminée ou dossier passé à une autre étape) : rechargez la fiche." };
  }
  await audit(user, pm.id, `Demande de devis retirée depuis le dossier${annulees.length ? ` (${annulees.join(", ")})` : ""} — ${motif.slice(0, 200)}`);
  revalidatePath(chemin(pm.id));
  revalidatePath("/demandes");
  const ou = retour.etape === "REVIEW_REQUESTER" ? "au choix des lignes — les devis déjà reçus restent" : retour.etape === "QUOTE_TO_REQUEST" ? "à « devis à demander »" : null;
  return {
    ok: true,
    message: `Demande de devis retirée${annulees.length ? ` (${annulees.join(", ")})` : ""} — l'assistante est prévenue${ou ? ` ; le dossier revient ${ou}` : ""}.`,
  };
}

/**
 * DEMANDER UNE CORRECTION DE LA RETRANSCRIPTION — le dossier revient à l'assistante, avec le motif.
 *
 * Un prix mal recopié se voit au moment du choix : le demandeur le signale au lieu de retenir
 * une ligne fausse. Sa sélection est effacée — les lignes vont changer, et un choix fait sur les
 * anciennes serait appliqué à des lignes qu'il n'a jamais vues.
 *
 * LA BASCULE ET CE QUI EN DÉPEND, DANS UNE SEULE TRANSACTION (lot D1b). La bascule était conditionnelle,
 * mais la sélection effacée, le motif au fil et la demande au secrétariat rouverte s'écrivaient après, chacun
 * de son côté : une panne entre deux laissait le dossier chez une assistante dont le bureau ne montrait rien à
 * traiter, et une fin de retranscription passée entre la bascule et la réouverture voyait la demande se rouvrir
 * sur un dossier revenu au choix. Tout s'écrit sous le verrou que la bascule prend ; l'avis à l'assistante et
 * le journal partent après.
 */
export async function demanderCorrectionDevisPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const pm = await chargerDossier(fdStr(formData, "promoMaterialId"));
  if (!pm) return { ok: false, error: "Dossier introuvable." };
  const v = refusVersion(pm);
  if (v) return { ok: false, error: v };
  if (!choisitLesLignes(acteur(user), pm)) return { ok: false, error: "La demande de correction revient au demandeur." };
  if (pm.circuitState !== "REVIEW_REQUESTER") return { ok: false, error: "Ce dossier n'attend pas le choix du demandeur." };
  const motif = fdStr(formData, "motif");
  if (!motif) return { ok: false, error: "Dites ce qui est à corriger : l'assistante reprendrait sinon à l'identique." };

  try {
    await prisma.$transaction(async (tx) => {
      const bascule = await tx.promoMaterial.updateMany({
        where: { id: pm.id, circuitVersion: 2, circuitState: "REVIEW_REQUESTER" },
        data: { circuitState: "QUOTE_REQUESTED", updatedById: user.id },
      });
      if (bascule.count === 0) throw new RefusDevis(ETAPE_CHANGEE);
      await tx.promoQuoteLine.updateMany({ where: { quote: { promoMaterialId: pm.id } }, data: { selected: false } });
      await tx.comment.create({ data: { entityType: "PROMO_MATERIAL", entityId: pm.id, body: `Correction de la retranscription demandée : ${motif}`, authorId: user.id } });
      // LA DEMANDE AU SECRÉTARIAT SE ROUVRE (audit 360°, R07) : la retranscription l'avait close, et une
      // demande close ne figure plus dans « à traiter » — l'assistante, prévenue, ne voyait rien à faire.
      await rouvrirDemandeAuSecretariat(tx, user.id, pm.id, `Correction de la retranscription demandée par le demandeur : ${motif}`);
    }, { timeout: 15_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof RefusDevis) return { ok: false, error: e.message };
    throw e;
  }
  const avis = { type: "ASSIGNMENT" as const, title: "Matériel promotionnel — retranscription à corriger", body: `${pm.reference} — ${motif.slice(0, 200)}`, link: chemin(pm.id) };
  if (pm.assistantId) await notifyUser({ userId: pm.assistantId, ...avis });
  else await notifyRoles(["DIRECTION_ASSISTANT"], avis);
  await audit(user, pm.id, `Correction de la retranscription demandée — ${motif.slice(0, 200)}`);
  revalidatePath(chemin(pm.id));
  return { ok: true, message: "Correction demandée — le dossier revient à l'assistante de direction." };
}
